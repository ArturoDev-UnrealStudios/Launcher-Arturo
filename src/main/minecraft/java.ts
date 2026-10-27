import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { AppError } from '../../shared/errors';
import type { JavaInstallation } from '../../shared/types';
import type { Http } from '../core/http';
import type { Logger } from '../core/logger';
import { extractTarGz, extractZip } from '../core/archive';
import type { Downloader } from '../download/downloader';

const isWin = process.platform === 'win32';
const JAVA_BIN = isWin ? 'java.exe' : 'java';

export function javawFor(javaPath: string): string {
  if (!isWin) return javaPath;
  const w = path.join(path.dirname(javaPath), 'javaw.exe');
  return fs.existsSync(w) ? w : javaPath;
}

export function parseJavaProperties(output: string): { version: string; major: number; vendor?: string; arch?: string } | null {
  const prop = (k: string) => new RegExp(`^\\s*${k.replace('.', '\\.')}\\s*=\\s*(.+)$`, 'm').exec(output)?.[1]?.trim();
  let version = prop('java.version');
  if (!version) {
    const m = /version "([^"]+)"/.exec(output);
    version = m?.[1];
  }
  if (!version) return null;
  const major = version.startsWith('1.') ? Number(version.split('.')[1]) : Number(version.split(/[.+-]/)[0]);
  if (!Number.isFinite(major)) return null;
  return { version, major, vendor: prop('java.vendor'), arch: prop('os.arch') };
}

export function probeJava(javaPath: string, timeoutMs = 8000): Promise<Omit<JavaInstallation, 'source'> | null> {
  return new Promise((resolve) => {
    execFile(javaPath, ['-XshowSettings:properties', '-version'], { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
      if (err && !stderr) return resolve(null);
      const info = parseJavaProperties(`${stderr}\n${stdout}`);
      resolve(info ? { path: javaPath, ...info } : null);
    });
  });
}

/** Versión de Java que necesita una versión de Minecraft cuando el JSON no lo indica. */
export function requiredJavaMajor(declared: number | undefined): number {
  if (declared && declared > 0) return declared;
  return 8;
}

/** ¿La instalación cumple el requisito? Java 16 admite 17; el resto exige la misma versión mayor o superior compatible. */
export function javaSatisfies(installed: number, required: number): boolean {
  if (required <= 8) return installed === 8; // Forge/LaunchWrapper antiguos fallan con Java 9+
  if (required === 16) return installed === 16 || installed === 17;
  return installed === required;
}

export class JavaManager {
  private cache?: { at: number; list: JavaInstallation[] };

  constructor(
    private readonly runtimesDir: string,
    private readonly http: Http,
    private readonly downloader: Downloader,
    private readonly log: Logger,
    private readonly adoptiumApi = 'https://api.adoptium.net/v3',
    private readonly allowLocalhost = false,
  ) {}

  private candidateDirs(): string[] {
    const dirs: string[] = [];
    const add = (p?: string) => p && dirs.push(p);
    add(process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin'));
    for (const p of (process.env.PATH ?? '').split(path.delimiter)) if (p) dirs.push(p);
    const scan = (root: string, sub: string[] = ['bin']) => {
      try {
        for (const d of fs.readdirSync(root)) dirs.push(path.join(root, d, ...sub));
      } catch {
        /* no existe */
      }
    };
    if (isWin) {
      for (const pf of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
        if (!pf) continue;
        for (const vendor of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru']) scan(path.join(pf, vendor));
      }
      const local = process.env.LOCALAPPDATA;
      if (local) {
        // Runtimes del launcher oficial (Microsoft Store y clásico).
        scan(path.join(local, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'), []);
      }
    } else if (process.platform === 'darwin') {
      scan('/Library/Java/JavaVirtualMachines', ['Contents', 'Home', 'bin']);
      scan(path.join(os.homedir(), 'Library/Java/JavaVirtualMachines'), ['Contents', 'Home', 'bin']);
      dirs.push('/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin');
    } else {
      scan('/usr/lib/jvm');
      scan('/usr/java');
      scan(path.join(os.homedir(), '.sdkman', 'candidates', 'java'));
    }
    return dirs;
  }

  private async managedJavas(): Promise<string[]> {
    const out: string[] = [];
    try {
      for (const d of await fsp.readdir(this.runtimesDir)) {
        const bin = await findJavaBin(path.join(this.runtimesDir, d));
        if (bin) out.push(bin);
      }
    } catch {
      /* ninguno */
    }
    return out;
  }

  async detect(force = false, extra: string[] = []): Promise<JavaInstallation[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 60_000) return this.cache.list;
    const managed = new Set(await this.managedJavas());
    const candidates = new Set<string>([...managed, ...extra]);
    for (const d of this.candidateDirs()) {
      const p = path.join(d, JAVA_BIN);
      if (fs.existsSync(p)) candidates.add(p);
    }
    const resolved = new Map<string, string>();
    for (const c of candidates) {
      try {
        resolved.set(fs.realpathSync(c), c);
      } catch {
        /* enlace roto */
      }
    }
    const results = await Promise.all(
      [...resolved.values()].map(async (p) => {
        const info = await probeJava(p);
        if (!info) return null;
        const source: JavaInstallation['source'] = managed.has(p) ? 'managed' : extra.includes(p) ? 'custom' : 'system';
        return { ...info, source } as JavaInstallation;
      }),
    );
    const list = results.filter((x): x is JavaInstallation => !!x).sort((a, b) => b.major - a.major);
    this.cache = { at: Date.now(), list };
    return list;
  }

  /**
   * Devuelve un ejecutable Java compatible. Prioridad: ruta forzada → instalada compatible →
   * descarga automática desde Eclipse Adoptium (API documentada, SHA-256 verificado).
   */
  async ensure(required: number, opts: { forcedPath?: string; auto: boolean; signal?: AbortSignal; onProgress?: (done: number, total: number) => void }): Promise<JavaInstallation> {
    if (opts.forcedPath) {
      const info = await probeJava(opts.forcedPath);
      if (!info) throw new AppError('JAVA_NOT_FOUND', opts.forcedPath);
      if (!javaSatisfies(info.major, required)) throw new AppError('JAVA_INCOMPATIBLE', `Java ${info.major}`, { required, found: info.major });
      return { ...info, source: 'custom' };
    }
    const found = (await this.detect()).filter((j) => javaSatisfies(j.major, required));
    const pick = found.find((j) => j.source === 'managed') ?? found[0];
    if (pick) return pick;
    if (!opts.auto) throw new AppError('JAVA_NOT_FOUND', `Java ${required}`, { required });
    return this.install(required === 16 ? 17 : required, opts.signal, opts.onProgress);
  }

  async install(major: number, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<JavaInstallation> {
    const osName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x32' : 'x64';
    const url = `${this.adoptiumApi}/assets/latest/${major}/hotspot?architecture=${arch}&image_type=jre&os=${osName}&vendor=eclipse`;
    const assets = await this.http.json<Array<{ binary: { package: { link: string; checksum: string; size: number; name: string } }; release_name: string }>>(url);
    const a = assets?.[0]?.binary?.package;
    if (!a?.link || !/^[0-9a-f]{64}$/i.test(a.checksum)) throw new AppError('JAVA_NOT_FOUND', `Adoptium sin JRE ${major} para ${osName}/${arch}`);
    const host = new URL(a.link).host;
    const trusted = /(^|\.)github\.com$|(^|\.)adoptium\.net$|(^|\.)githubusercontent\.com$/.test(host) || (this.allowLocalhost && new URL(a.link).hostname === '127.0.0.1');
    if (!trusted) {
      throw new AppError('UNTRUSTED_SOURCE', host);
    }
    const tmp = path.join(this.runtimesDir, '.download', a.name.replace(/[^\w.+-]/g, '_'));
    await this.downloader.downloadAll(
      [{ url: a.link, dest: tmp, size: a.size, hash: { algo: 'sha256', value: a.checksum } }],
      (p) => onProgress?.(p.bytesDone, p.bytesTotal),
      signal,
    );
    const target = path.join(this.runtimesDir, `java-${major}`);
    const staging = `${target}.staging`;
    await fsp.rm(staging, { recursive: true, force: true });
    if (a.name.endsWith('.zip')) await extractZip(tmp, staging, { maxBytes: 1024 ** 3 });
    else await extractTarGz(tmp, staging);
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.rename(staging, target);
    await fsp.rm(tmp, { force: true });
    const bin = await findJavaBin(target);
    if (!bin) throw new AppError('JAVA_NOT_FOUND', 'JRE descargado sin ejecutable');
    if (!isWin) await fsp.chmod(bin, 0o755).catch(() => undefined);
    const info = await probeJava(bin);
    if (!info) throw new AppError('JAVA_NOT_FOUND', 'JRE descargado no responde');
    this.cache = undefined;
    this.log.info('Java instalado', { major, release: assets[0]!.release_name });
    return { ...info, source: 'managed' };
  }
}

async function findJavaBin(root: string, depth = 0): Promise<string | null> {
  if (depth > 4) return null;
  const direct = path.join(root, 'bin', JAVA_BIN);
  if (fs.existsSync(direct)) return direct;
  const mac = path.join(root, 'Contents', 'Home', 'bin', JAVA_BIN);
  if (fs.existsSync(mac)) return mac;
  try {
    for (const d of await fsp.readdir(root, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('.')) {
        const r = await findJavaBin(path.join(root, d.name), depth + 1);
        if (r) return r;
      }
    }
  } catch {
    /* ignorar */
  }
  return null;
}
