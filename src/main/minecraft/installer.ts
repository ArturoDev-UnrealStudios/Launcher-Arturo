import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AppError } from '../../shared/errors';
import type { InstanceConfig } from '../../shared/types';
import type { Http } from '../core/http';
import type { Logger } from '../core/logger';
import { readZipEntry } from '../core/archive';
import { isInside, safeJoin, type AppPaths } from '../core/paths';
import { fileMatches, type DownloadItem, type DownloadProgress, type Downloader } from '../download/downloader';
import { sha1Hex } from '../security/crypto';
import { javaSatisfies, requiredJavaMajor, type JavaManager } from './java';
import type { MetadataService } from './metadata';
import { currentPlatform, mergeVersions, resolveLibraries, type Platform, type VersionJson } from './versionJson';

export interface InstallReport {
  stage: 'metadata' | 'loader' | 'java' | 'libraries' | 'assets' | 'private' | 'finalize' | 'verify';
  progress?: DownloadProgress;
}

export interface PrivateManifest {
  instanceId: string;
  version: string;
  files: Array<{ path: string; url: string; sha256: string; size: number }>;
}

/** Subcarpetas de una instancia que un manifiesto privado puede escribir. */
const PRIVATE_ALLOWED = /^(mods|config|resourcepacks|shaderpacks|defaultconfigs|kubejs|scripts|datapacks|global_packs|options\.txt$|servers\.dat$)/;

const TRUSTED_INSTALLER_HOSTS = new Set(['maven.minecraftforge.net', 'maven.neoforged.net']);

export function instanceGameDir(paths: AppPaths, id: string): string {
  return safeJoin(paths.instancesDir, id, 'minecraft');
}

export class GameInstaller {
  constructor(
    private readonly paths: AppPaths,
    private readonly meta: MetadataService,
    private readonly downloader: Downloader,
    private readonly java: JavaManager,
    private readonly http: Http,
    private readonly log: Logger,
    private readonly platform: Platform = currentPlatform(),
    private readonly opts: { allowInsecureInstallerHosts?: boolean } = {},
  ) {}

  /** Resuelve (y si hace falta instala) el JSON combinado de la versión de la instancia. */
  async resolveVersion(inst: InstanceConfig, signal: AbortSignal, report: (r: InstallReport) => void, javaAuto = true): Promise<{ version: VersionJson; versionId: string }> {
    report({ stage: 'metadata' });
    const vanilla = await this.meta.vanillaVersion(inst.mcVersion);
    const kind = inst.loader.kind;
    if (kind === 'vanilla') return { version: vanilla, versionId: vanilla.id };

    report({ stage: 'loader' });
    let loaderVersion = inst.loader.version;
    if (!loaderVersion) {
      const list = await this.meta.loaderVersions(kind, inst.mcVersion);
      loaderVersion = (list.find((v) => v.stable) ?? list[0])?.version;
      if (!loaderVersion) throw new AppError('UNSUPPORTED_LOADER', `${kind} ${inst.mcVersion}`);
    }

    if (kind === 'fabric') {
      const id = inst.resolvedVersionId;
      let profile = id ? await this.meta.readLocalVersion(id) : null;
      if (!profile || profile.inheritsFrom !== inst.mcVersion) {
        profile = await this.meta.fabricProfile(inst.mcVersion, loaderVersion);
        await this.meta.saveLoaderVersion(profile);
      }
      return { version: mergeVersions(profile, vanilla), versionId: profile.id };
    }

    // Forge / NeoForge: se ejecuta su instalador oficial de forma desatendida.
    if (!inst.loader.installerTrusted) throw new AppError('UNTRUSTED_SOURCE', 'installer-consent');
    const existing = inst.resolvedVersionId ? await this.meta.readLocalVersion(inst.resolvedVersionId) : null;
    if (existing) return { version: mergeVersions(existing, vanilla), versionId: existing.id };
    const versionId = await this.runOfficialInstaller(kind, inst.mcVersion, loaderVersion, vanilla, signal, report, javaAuto);
    const child = await this.meta.readLocalVersion(versionId);
    if (!child) throw new AppError('UNSUPPORTED_LOADER', 'el instalador no generó el perfil');
    return { version: mergeVersions(child, vanilla), versionId };
  }

  private async runOfficialInstaller(
    kind: 'forge' | 'neoforge',
    mc: string,
    loader: string,
    vanilla: VersionJson,
    signal: AbortSignal,
    report: (r: InstallReport) => void,
    javaAuto: boolean,
  ): Promise<string> {
    const art = this.meta.installerArtifact(kind, mc, loader);
    const host = new URL(art.url).host;
    if (!TRUSTED_INSTALLER_HOSTS.has(host) && !this.opts.allowInsecureInstallerHosts) throw new AppError('UNTRUSTED_SOURCE', host);

    // Checksum publicado en el mismo repositorio Maven oficial (TLS). Se prefiere SHA-256.
    let hash: DownloadItem['hash'];
    for (const u of art.checksumUrls) {
      try {
        const txt = (await this.http.text(u)).trim().split(/\s+/)[0] ?? '';
        if (/^[0-9a-f]{64}$/i.test(txt)) hash = { algo: 'sha256', value: txt };
        else if (/^[0-9a-f]{40}$/i.test(txt)) hash = { algo: 'sha1', value: txt };
        if (hash) break;
      } catch {
        /* siguiente */
      }
    }
    if (!hash) throw new AppError('UNTRUSTED_SOURCE', 'instalador sin checksum publicado');
    const installer = path.join(this.paths.cache, 'installers', art.fileName);
    await this.downloader.downloadAll([{ url: art.url, dest: installer, hash }], (p) => report({ stage: 'loader', progress: p }), signal);

    const profileRaw = await readZipEntry(installer, 'install_profile.json');
    if (!profileRaw) throw new AppError('UNSUPPORTED_LOADER', 'instalador sin install_profile.json (versión no soportada)');
    const profile = JSON.parse(profileRaw.toString('utf8')) as { version?: string; versionInfo?: { id?: string } };
    const versionId = profile.version ?? profile.versionInfo?.id;
    if (!versionId || !/^[\w.+-]{1,120}$/.test(versionId)) throw new AppError('UNSUPPORTED_LOADER', 'id de versión desconocido');
    if (profile.versionInfo) throw new AppError('UNSUPPORTED_LOADER', 'instaladores Forge anteriores a 1.13 no admiten instalación desatendida');

    // El instalador necesita la versión vanilla y un launcher_profiles.json en la raíz destino.
    report({ stage: 'java' });
    const jre = await this.java.ensure(requiredJavaMajor(vanilla.javaVersion?.majorVersion), { auto: javaAuto, signal });
    await this.downloadVanillaClient(vanilla, signal, report);
    const lp = path.join(this.paths.shared, 'launcher_profiles.json');
    if (!fs.existsSync(lp)) await fsp.writeFile(lp, JSON.stringify({ profiles: {}, selectedProfile: '' }));

    report({ stage: 'loader' });
    const tryRun = (flag: string) =>
      new Promise<{ code: number; out: string }>((resolve, reject) => {
        const p = spawn(jre.path, ['-jar', installer, flag, this.paths.shared], { cwd: path.dirname(installer), windowsHide: true, signal });
        let out = '';
        const cap = (d: Buffer) => {
          out = (out + d.toString()).slice(-20000);
        };
        p.stdout.on('data', cap);
        p.stderr.on('data', cap);
        p.on('error', (e) => (signal.aborted ? reject(new AppError('CANCELLED')) : reject(e)));
        p.on('close', (code) => resolve({ code: code ?? -1, out }));
      });
    let r = await tryRun('--installClient');
    if (r.code !== 0 && /unrecognized|not a recognized option|UnrecognizedOptionException/i.test(r.out)) r = await tryRun('--install-client');
    if (r.code !== 0) {
      this.log.error('Fallo del instalador oficial', { kind, mc, loader, tail: r.out.slice(-2000) });
      throw new AppError('UNSUPPORTED_LOADER', `el instalador terminó con código ${r.code}`);
    }
    return versionId;
  }

  private async downloadVanillaClient(v: VersionJson, signal: AbortSignal, report: (r: InstallReport) => void): Promise<void> {
    const c = v.downloads?.client;
    if (!c) return;
    const dest = path.join(this.paths.versions, v.id, `${v.id}.jar`);
    await this.downloader.downloadAll(
      [{ url: c.url, dest, size: c.size, hash: { algo: 'sha1', value: c.sha1 } }],
      (p) => report({ stage: 'libraries', progress: p }),
      signal,
    );
  }

  /** Lista completa de archivos verificables de una versión ya combinada. */
  async collectFiles(v: VersionJson, signal: AbortSignal): Promise<{ libraries: DownloadItem[]; assets: DownloadItem[]; missingLocal: string[]; assetIndex?: { id: string; virtual: boolean; mapToResources: boolean; objects: Record<string, { hash: string; size: number }> } }> {
    const libs: DownloadItem[] = [];
    const missingLocal: string[] = [];
    const jarId = v.jar ?? v.id;
    const client = v.downloads?.client;
    if (client) {
      libs.push({ url: client.url, dest: path.join(this.paths.versions, jarId, `${jarId}.jar`), size: client.size, hash: { algo: 'sha1', value: client.sha1 } });
    }
    const needsSha1: DownloadItem[] = [];
    for (const l of resolveLibraries(v, this.platform)) {
      const dest = safeJoin(this.paths.libraries, l.path);
      if (!l.url) {
        // Generadas localmente por el instalador del loader (sin URL pública).
        if (!fs.existsSync(dest)) missingLocal.push(l.name);
        continue;
      }
      const item: DownloadItem = { url: l.url, dest, size: l.size || undefined, hash: l.sha1 ? { algo: 'sha1', value: l.sha1 } : undefined };
      if (!item.hash) needsSha1.push(item);
      libs.push(item);
    }
    // Librerías Maven sin hash en el perfil: se usa el .sha1 publicado junto al artefacto.
    await Promise.all(
      needsSha1.map(async (it) => {
        if (signal.aborted) return;
        try {
          const txt = (await this.http.text(`${it.url}.sha1`, {}, { timeoutMs: 10_000 })).trim().split(/\s+/)[0] ?? '';
          if (/^[0-9a-f]{40}$/i.test(txt)) it.hash = { algo: 'sha1', value: txt };
        } catch {
          /* se descarga igualmente pero se registra */
        }
        if (!it.hash) this.log.warn('Librería sin checksum verificable', { file: path.basename(it.dest) });
      }),
    );
    if (v.logging?.client?.file) {
      const f = v.logging.client.file;
      libs.push({ url: f.url, dest: path.join(this.paths.assets, 'log_configs', f.id), size: f.size, hash: { algo: 'sha1', value: f.sha1 } });
    }

    const assets: DownloadItem[] = [];
    let assetIndex: Awaited<ReturnType<GameInstaller['collectFiles']>>['assetIndex'];
    if (v.assetIndex) {
      const idxFile = path.join(this.paths.assets, 'indexes', `${v.assetIndex.id}.json`);
      let raw: Buffer | null = null;
      try {
        const b = await fsp.readFile(idxFile);
        if (sha1Hex(b) === v.assetIndex.sha1) raw = b;
      } catch {
        /* descargar */
      }
      if (!raw) {
        await this.downloader.downloadAll([{ url: v.assetIndex.url, dest: idxFile, size: v.assetIndex.size, hash: { algo: 'sha1', value: v.assetIndex.sha1 } }], () => {}, signal);
        raw = await fsp.readFile(idxFile);
      }
      const idx = JSON.parse(raw.toString('utf8')) as { objects: Record<string, { hash: string; size: number }>; virtual?: boolean; map_to_resources?: boolean };
      assetIndex = { id: v.assetIndex.id, virtual: !!idx.virtual, mapToResources: !!idx.map_to_resources, objects: idx.objects };
      const seen = new Set<string>();
      for (const o of Object.values(idx.objects)) {
        if (!/^[0-9a-f]{40}$/.test(o.hash) || seen.has(o.hash)) continue;
        seen.add(o.hash);
        const sub = `${o.hash.slice(0, 2)}/${o.hash}`;
        assets.push({ url: `${this.meta.ep.resources}/${sub}`, dest: path.join(this.paths.assets, 'objects', sub), size: o.size, hash: { algo: 'sha1', value: o.hash } });
      }
    }
    return { libraries: libs, assets, missingLocal, assetIndex };
  }

  /**
   * Instalación / reparación completa. Idempotente: los archivos ya válidos (hash correcto)
   * se omiten, por lo que reanudar una instalación interrumpida solo descarga lo que falta.
   */
  async install(
    inst: InstanceConfig,
    signal: AbortSignal,
    report: (r: InstallReport) => void,
    opts: { javaAuto: boolean; javaPath?: string; privateManifest?: PrivateManifest },
  ): Promise<{ versionId: string; javaPath: string; javaMajor: number }> {
    const { version, versionId } = await this.resolveVersion(inst, signal, report, opts.javaAuto);
    const files = await this.collectFiles(version, signal);
    if (files.missingLocal.length) {
      // Un artefacto generado por el instalador del loader falta: se fuerza su reinstalación.
      throw new AppError('INSTANCE_NOT_INSTALLED', `faltan librerías del loader: ${files.missingLocal.slice(0, 3).join(', ')}`, { reinstallLoader: true });
    }
    await this.downloader.downloadAll(files.libraries, (p) => report({ stage: 'libraries', progress: p }), signal);
    await this.downloader.downloadAll(files.assets, (p) => report({ stage: 'assets', progress: p }), signal);
    if (files.assetIndex && (files.assetIndex.virtual || files.assetIndex.mapToResources)) {
      await this.materializeLegacyAssets(inst, files.assetIndex);
    }

    report({ stage: 'java' });
    const required = requiredJavaMajor(version.javaVersion?.majorVersion);
    const jre = await this.java.ensure(required, {
      forcedPath: inst.java.path ?? opts.javaPath,
      auto: opts.javaAuto,
      signal,
      onProgress: (d, t) => report({ stage: 'java', progress: { filesDone: 0, filesTotal: 1, bytesDone: d, bytesTotal: t, speed: 0 } }),
    });

    if (opts.privateManifest) {
      report({ stage: 'private' });
      await this.installPrivateFiles(inst, opts.privateManifest, signal, (p) => report({ stage: 'private', progress: p }));
    }
    report({ stage: 'finalize' });
    await fsp.mkdir(instanceGameDir(this.paths, inst.id), { recursive: true });
    return { versionId, javaPath: jre.path, javaMajor: jre.major };
  }

  async verify(inst: InstanceConfig, signal: AbortSignal, report: (r: InstallReport) => void): Promise<{ checked: number; bad: number }> {
    const { version } = await this.resolveVersion(inst, signal, report, false);
    const files = await this.collectFiles(version, signal);
    const all = [...files.libraries, ...files.assets];
    let bad = files.missingLocal.length;
    let checked = 0;
    const total = all.length;
    const step = async (it: DownloadItem) => {
      if (signal.aborted) throw new AppError('CANCELLED');
      if (!(await fileMatches(it))) bad++;
      checked++;
      if (checked % 50 === 0 || checked === total) report({ stage: 'verify', progress: { filesDone: checked, filesTotal: total, bytesDone: 0, bytesTotal: 0, speed: 0 } });
    };
    let i = 0;
    await Promise.all(Array.from({ length: 6 }, async () => {
      while (i < all.length) await step(all[i++]!);
    }));
    return { checked: total + files.missingLocal.length, bad };
  }

  private async materializeLegacyAssets(inst: InstanceConfig, idx: NonNullable<Awaited<ReturnType<GameInstaller['collectFiles']>>['assetIndex']>): Promise<void> {
    const root = idx.mapToResources ? path.join(instanceGameDir(this.paths, inst.id), 'resources') : path.join(this.paths.assets, 'virtual', idx.id);
    for (const [name, o] of Object.entries(idx.objects)) {
      const dest = path.resolve(root, name);
      if (!isInside(root, dest)) continue;
      if (fs.existsSync(dest)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(this.paths.assets, 'objects', o.hash.slice(0, 2), o.hash), dest);
    }
  }

  async installPrivateFiles(inst: InstanceConfig, m: PrivateManifest, signal: AbortSignal, onProgress: (p: DownloadProgress) => void): Promise<void> {
    if (m.instanceId !== inst.id) throw new AppError('VALIDATION', 'manifiesto de otra instancia');
    const gameDir = instanceGameDir(this.paths, inst.id);
    const items: DownloadItem[] = m.files.map((f) => {
      const rel = f.path.replace(/\\/g, '/');
      if (!PRIVATE_ALLOWED.test(rel) || rel.includes('..')) throw new AppError('VALIDATION', `ruta no permitida: ${rel}`);
      if (!/^[0-9a-f]{64}$/i.test(f.sha256)) throw new AppError('VALIDATION', 'hash inválido');
      return { url: f.url, dest: safeJoin(gameDir, rel), size: f.size, hash: { algo: 'sha256', value: f.sha256 } };
    });
    await this.downloader.downloadAll(items, onProgress, signal);
  }

  /** Comprueba si el Java configurado de una instancia sigue siendo compatible (para el botón JUGAR). */
  static javaOk(inst: InstanceConfig, required: number): boolean {
    return !inst.java.major || javaSatisfies(inst.java.major, required);
  }
}
