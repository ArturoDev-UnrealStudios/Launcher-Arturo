import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AppError, isAppError, toSerializedError } from '../../shared/errors';
import type { ReleaseNote, UpdateInfo } from '../../shared/types';
import type { Http } from '../core/http';
import { readJson, writeJson } from '../core/jsonStore';
import type { Logger } from '../core/logger';
import type { Downloader } from '../download/downloader';
import { hashFile, verifyEd25519 } from '../security/crypto';

/** Comparación semver (major.minor.patch[-pre]). */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim());
    if (!m) return null;
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa.n[i] !== pb.n[i]) return pa.n[i]! - pb.n[i]!;
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  const xa = pa.pre.split('.');
  const xb = pb.pre.split('.');
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const s = xa[i];
    const t = xb[i];
    if (s === undefined) return -1;
    if (t === undefined) return 1;
    const ns = Number(s);
    const nt = Number(t);
    if (!Number.isNaN(ns) && !Number.isNaN(nt)) {
      if (ns !== nt) return ns - nt;
    } else if (s !== t) return s < t ? -1 : 1;
  }
  return 0;
}

export const ManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  channel: z.enum(['stable', 'beta']),
  releasedAt: z.string(),
  notes: z.string().max(20_000).default(''),
  files: z.record(
    z.object({
      name: z.string().regex(/^[\w .+-]{1,120}$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      size: z.number().int().positive(),
      kind: z.enum(['nsis', 'appimage', 'dmg', 'zip']),
    }),
  ),
});
export type UpdateManifest = z.infer<typeof ManifestSchema>;

interface GhAsset {
  name: string;
  size: number;
  browser_download_url: string;
}
interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: GhAsset[];
}

export interface UpdaterConfig {
  owner: string;
  repo: string;
  manifestAsset: string;
  signatureAsset: string;
  publicKeys: string[];
  currentVersion: string;
  platformKey: string; // p. ej. "win32-x64"
  dir: string;
  apiBase?: string;
  allowedDownloadHosts?: string[];
}

const HistorySchema = z.object({
  pending: z.object({ from: z.string(), to: z.string(), at: z.number() }).optional(),
  installed: z.array(z.object({ version: z.string(), at: z.number(), result: z.enum(['ok', 'failed']) })).default([]),
});

/**
 * Actualizador basado en GitHub Releases, sin API propia:
 *  - solo considera releases publicadas (no ramas ni commits) del canal elegido;
 *  - el manifiesto debe estar firmado con Ed25519 por una clave pública fijada en la app;
 *  - el instalador descargado se verifica por tamaño y SHA-256 antes de ejecutarse;
 *  - sin red o con GitHub caído, el launcher sigue funcionando con la versión instalada.
 */
export class Updater {
  private info: UpdateInfo;
  private manifest?: UpdateManifest;
  private release?: GhRelease;
  private downloaded?: string;
  private timer?: NodeJS.Timeout;
  private releasesCache?: { at: number; list: GhRelease[] };

  constructor(
    private readonly cfg: UpdaterConfig,
    private readonly http: Http,
    private readonly downloader: Downloader,
    private readonly log: Logger,
    private readonly onChange: (u: UpdateInfo) => void,
    channel: 'stable' | 'beta',
  ) {
    const configured = !!cfg.owner && cfg.owner !== 'CHANGE_ME' && cfg.publicKeys.length > 0;
    this.info = { state: configured ? 'idle' : 'disabled', currentVersion: cfg.currentVersion, channel };
  }

  get status(): UpdateInfo {
    return this.info;
  }

  private set(patch: Partial<UpdateInfo>): void {
    this.info = { ...this.info, ...patch };
    this.onChange(this.info);
  }

  setChannel(channel: 'stable' | 'beta'): void {
    if (channel === this.info.channel) return;
    this.manifest = undefined;
    this.release = undefined;
    this.downloaded = undefined;
    this.set({ channel, state: this.info.state === 'disabled' ? 'disabled' : 'idle', latest: undefined });
  }

  schedule(enabled: boolean, everyMs = 30 * 60_000): void {
    clearInterval(this.timer);
    if (!enabled || this.info.state === 'disabled') return;
    setTimeout(() => void this.check().catch(() => undefined), 15_000).unref?.();
    this.timer = setInterval(() => void this.check().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  private api(): string {
    return `${this.cfg.apiBase ?? 'https://api.github.com'}/repos/${encodeURIComponent(this.cfg.owner)}/${encodeURIComponent(this.cfg.repo)}`;
  }

  private async releases(): Promise<GhRelease[]> {
    if (this.releasesCache && Date.now() - this.releasesCache.at < 5 * 60_000) return this.releasesCache.list;
    const res = await this.http.request(`${this.api()}/releases?per_page=20`, { headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } }, { timeoutMs: 15_000 });
    if (res.status === 403 || res.status === 429) throw new AppError('RATE_LIMITED', 'GitHub API');
    if (res.status === 404) throw new AppError('UPDATE_NO_RELEASE', 'repositorio o releases no encontrados');
    if (!res.ok) throw new AppError('HTTP', `GitHub ${res.status}`);
    const list = ((await res.json()) as GhRelease[]).filter((r) => !r.draft);
    this.releasesCache = { at: Date.now(), list };
    return list;
  }

  private checkDownloadUrl(url: string): void {
    const u = new URL(url);
    const hosts = this.cfg.allowedDownloadHosts ?? ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1')) throw new AppError('UNTRUSTED_SOURCE', u.protocol);
    if (!hosts.includes(u.host) && !hosts.includes(u.hostname)) throw new AppError('UNTRUSTED_SOURCE', u.host);
  }

  async check(): Promise<UpdateInfo> {
    if (this.info.state === 'disabled') return this.info;
    if (this.info.state === 'downloading') return this.info;
    this.set({ state: 'checking', error: undefined });
    try {
      const list = await this.releases();
      const candidates = list
        .filter((r) => (this.info.channel === 'beta' ? true : !r.prerelease))
        .filter((r) => compareSemver(r.tag_name, this.cfg.currentVersion) > 0)
        .sort((a, b) => compareSemver(b.tag_name, a.tag_name));
      for (const rel of candidates) {
        const m = await this.loadManifest(rel).catch((e) => {
          this.log.warn('Release descartada', { tag: rel.tag_name, err: (e as Error).message });
          return null;
        });
        if (!m) continue;
        const file = m.files[this.cfg.platformKey];
        if (!file) continue;
        this.manifest = m;
        this.release = rel;
        this.set({ state: 'available', checkedAt: Date.now(), latest: { version: m.version, notes: m.notes || rel.body || '', publishedAt: rel.published_at, size: file.size } });
        return this.info;
      }
      this.set({ state: 'not-available', checkedAt: Date.now(), latest: undefined });
      return this.info;
    } catch (e) {
      // Errores de red / GitHub: el launcher sigue funcionando con la versión instalada.
      this.set({ state: 'error', checkedAt: Date.now(), error: toSerializedError(e) });
      return this.info;
    }
  }

  /** Descarga y verifica el manifiesto firmado de una release. */
  async loadManifest(rel: GhRelease): Promise<UpdateManifest> {
    const ma = rel.assets.find((a) => a.name === this.cfg.manifestAsset);
    const sa = rel.assets.find((a) => a.name === this.cfg.signatureAsset);
    if (!ma || !sa) throw new AppError('UPDATE_NO_RELEASE', 'release sin manifiesto firmado');
    if (ma.size > 256 * 1024 || sa.size > 1024) throw new AppError('UPDATE_SIGNATURE_INVALID', 'tamaño inesperado');
    this.checkDownloadUrl(ma.browser_download_url);
    this.checkDownloadUrl(sa.browser_download_url);
    const raw = await this.http.text(ma.browser_download_url, {}, { timeoutMs: 15_000 });
    const sig = await this.http.text(sa.browser_download_url, {}, { timeoutMs: 15_000 });
    if (!verifyEd25519(Buffer.from(raw, 'utf8'), sig, this.cfg.publicKeys)) throw new AppError('UPDATE_SIGNATURE_INVALID');
    const m = ManifestSchema.parse(JSON.parse(raw));
    // El manifiesto firmado debe corresponder a ESTA release (evita reutilizar uno antiguo).
    if (compareSemver(m.version, rel.tag_name) !== 0) throw new AppError('UPDATE_SIGNATURE_INVALID', 'versión del manifiesto ≠ etiqueta');
    if (m.channel === 'beta' && this.info.channel !== 'beta') throw new AppError('UPDATE_NO_RELEASE', 'canal beta');
    if (compareSemver(m.version, this.cfg.currentVersion) <= 0) throw new AppError('UPDATE_NO_RELEASE', 'no es más reciente');
    return m;
  }

  async download(signal?: AbortSignal): Promise<UpdateInfo> {
    if (!this.manifest || !this.release) {
      await this.check();
      if (!this.manifest || !this.release) return this.info;
    }
    const file = this.manifest.files[this.cfg.platformKey]!;
    const asset = this.release.assets.find((a) => a.name === file.name);
    if (!asset) {
      this.set({ state: 'error', error: { code: 'UPDATE_NO_RELEASE', detail: 'falta el instalador en la release' } });
      return this.info;
    }
    this.checkDownloadUrl(asset.browser_download_url);
    const dest = path.join(this.cfg.dir, this.manifest.version, file.name);
    this.set({ state: 'downloading', progress: { bytesDone: 0, bytesTotal: file.size }, error: undefined });
    try {
      await this.downloader.downloadAll(
        [{ url: asset.browser_download_url, dest, size: file.size, hash: { algo: 'sha256', value: file.sha256 } }],
        (p) => this.set({ progress: { bytesDone: p.bytesDone, bytesTotal: p.bytesTotal } }),
        signal,
      );
      this.downloaded = dest;
      this.set({ state: 'ready', progress: { bytesDone: file.size, bytesTotal: file.size } });
    } catch (e) {
      const ser = toSerializedError(e);
      this.set({ state: 'error', error: ser.code === 'HASH_MISMATCH' ? { code: 'UPDATE_SIGNATURE_INVALID', detail: 'hash del instalador' } : ser });
    }
    return this.info;
  }

  /**
   * Ejecuta el instalador verificado y devuelve true si la app debe cerrarse.
   * Los datos de usuario (userData) no se tocan: el instalador solo reemplaza binarios.
   */
  async install(quit: () => void): Promise<void> {
    if (this.info.state !== 'ready' || !this.downloaded || !this.manifest) throw new AppError('UPDATE_FAILED', 'no hay actualización lista');
    const file = this.manifest.files[this.cfg.platformKey]!;
    // Re-verificación justo antes de ejecutar (el archivo pudo cambiar en disco).
    if ((await hashFile(this.downloaded, 'sha256')) !== file.sha256) {
      this.set({ state: 'error', error: { code: 'UPDATE_SIGNATURE_INVALID', detail: 'el instalador cambió en disco' } });
      throw new AppError('UPDATE_SIGNATURE_INVALID');
    }
    const histFile = path.join(this.cfg.dir, 'history.json');
    const hist = (await readJson(histFile, HistorySchema, () => ({ installed: [] }))).value;
    hist.pending = { from: this.cfg.currentVersion, to: this.manifest.version, at: Date.now() };
    await writeJson(histFile, hist);

    if (file.kind === 'nsis') {
      // NSIS (electron-builder): /S silencioso; --updated conserva accesos directos; relanza al terminar.
      const child = spawn(this.downloaded, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      quit();
      return;
    }
    if (file.kind === 'appimage' && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE;
      const staged = `${target}.new`;
      await fsp.copyFile(this.downloaded, staged);
      await fsp.chmod(staged, 0o755);
      await fsp.rename(target, `${target}.old`).catch(() => undefined);
      try {
        await fsp.rename(staged, target);
      } catch (e) {
        // Recuperación: se restaura el binario anterior.
        await fsp.rename(`${target}.old`, target).catch(() => undefined);
        throw new AppError('UPDATE_FAILED', (e as Error).message);
      }
      spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
      quit();
      return;
    }
    // macOS / formatos sin instalación automática: se abre el paquete verificado para el usuario.
    const { shell } = await import('electron');
    await shell.openPath(this.downloaded);
  }

  /** Al arrancar: registra el resultado de una actualización pendiente (recuperación ante fallo). */
  async reconcile(): Promise<{ result: 'none' | 'ok' | 'failed'; version?: string }> {
    const histFile = path.join(this.cfg.dir, 'history.json');
    const { value: hist } = await readJson(histFile, HistorySchema, () => ({ installed: [] }));
    if (!hist.pending) return { result: 'none' };
    const ok = compareSemver(this.cfg.currentVersion, hist.pending.to) >= 0;
    hist.installed.unshift({ version: hist.pending.to, at: Date.now(), result: ok ? 'ok' : 'failed' });
    hist.installed = hist.installed.slice(0, 30);
    const to = hist.pending.to;
    hist.pending = undefined;
    await writeJson(histFile, hist);
    if (ok) {
      // Limpieza de instaladores antiguos ya aplicados.
      for (const d of await fsp.readdir(this.cfg.dir).catch(() => [] as string[])) {
        if (d !== 'history.json' && compareSemver(d, this.cfg.currentVersion) <= 0) await fsp.rm(path.join(this.cfg.dir, d), { recursive: true, force: true });
      }
    }
    return { result: ok ? 'ok' : 'failed', version: to };
  }

  async history(): Promise<ReleaseNote[]> {
    if (this.info.state === 'disabled') return [];
    try {
      return (await this.releases()).map((r) => ({
        version: r.tag_name.replace(/^v/, ''),
        name: r.name ?? r.tag_name,
        body: (r.body ?? '').slice(0, 20_000),
        publishedAt: r.published_at,
        prerelease: r.prerelease,
        url: r.html_url,
      }));
    } catch (e) {
      if (isAppError(e)) throw e;
      throw new AppError('NETWORK');
    }
  }

  exists(): boolean {
    return !!this.downloaded && fs.existsSync(this.downloaded);
  }
}
