import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError, isAppError } from '../../shared/errors';
import type { FetchLike } from '../core/http';
import { getUserAgent, httpError } from '../core/http';
import type { Logger } from '../core/logger';
import { hashFile, type HashAlgo } from '../security/crypto';

export interface DownloadItem {
  url: string;
  dest: string;
  size?: number;
  hash?: { algo: HashAlgo; value: string };
}

export interface DownloadProgress {
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  speed: number;
}

export interface DownloaderOptions {
  concurrency: number;
  /** bytes/s; 0 = ilimitado */
  bandwidthLimit: number;
  resume: boolean;
  tempDir: string;
  /** Permite http:// a localhost (solo pruebas). */
  allowInsecureLocalhost?: boolean;
}

/** Cubo de fichas compartido para limitar ancho de banda entre todas las descargas. */
class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private rate: number) {
    this.tokens = rate;
  }
  setRate(r: number) {
    this.rate = r;
    this.tokens = Math.min(this.tokens, r);
  }
  async take(n: number, signal?: AbortSignal): Promise<void> {
    if (this.rate <= 0) return;
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      if (this.tokens >= n || (this.tokens > 0 && n > this.rate)) {
        this.tokens -= n;
        return;
      }
      if (signal?.aborted) throw new AppError('CANCELLED');
      const waitMs = Math.min(250, Math.ceil(((n - this.tokens) / this.rate) * 1000));
      await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
    }
  }
}

export async function freeSpace(dir: string): Promise<number> {
  let d = path.resolve(dir);
  for (;;) {
    try {
      const s = await fsp.statfs(d);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      const parent = path.dirname(d);
      if (parent === d) return Number.POSITIVE_INFINITY;
      d = parent;
    }
  }
}

async function moveFile(src: string, dest: string): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      await fsp.copyFile(src, dest);
      await fsp.rm(src, { force: true });
    } else if ((e as NodeJS.ErrnoException).code === 'EPERM' || (e as NodeJS.ErrnoException).code === 'EEXIST') {
      await fsp.rm(dest, { force: true });
      await fsp.rename(src, dest);
    } else throw e;
  }
}

export async function fileMatches(item: Pick<DownloadItem, 'dest' | 'size' | 'hash'>): Promise<boolean> {
  try {
    const st = await fsp.stat(item.dest);
    if (!st.isFile()) return false;
    if (item.size != null && st.size !== item.size) return false;
    if (item.hash) return (await hashFile(item.dest, item.hash.algo)) === item.hash.value.toLowerCase();
    return item.size != null; // sin hash ni tamaño no se puede afirmar integridad
  } catch {
    return false;
  }
}

export class Downloader {
  private readonly bucket: TokenBucket;
  /** Descargas en curso por destino: evita duplicados entre tareas simultáneas. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly fetchImpl: FetchLike, private opts: DownloaderOptions, private readonly log: Logger) {
    this.bucket = new TokenBucket(opts.bandwidthLimit);
  }

  configure(opts: Partial<DownloaderOptions>): void {
    this.opts = { ...this.opts, ...opts };
    if (opts.bandwidthLimit != null) this.bucket.setRate(opts.bandwidthLimit);
  }

  private checkUrl(url: string): void {
    const u = new URL(url);
    if (u.protocol === 'https:') return;
    if (this.opts.allowInsecureLocalhost && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) return;
    throw new AppError('UNTRUSTED_SOURCE', `protocolo no permitido: ${u.protocol}`);
  }

  /**
   * Descarga un conjunto de archivos. Los ya presentes y válidos se omiten (sin red).
   * Lanza DISK_FULL antes de empezar si el espacio libre no alcanza.
   */
  async downloadAll(items: DownloadItem[], onProgress: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<{ downloaded: number; skipped: number }> {
    const unique = new Map<string, DownloadItem>();
    for (const it of items) unique.set(path.resolve(it.dest), it);
    const list = [...unique.values()];

    const prog: DownloadProgress = { filesDone: 0, filesTotal: list.length, bytesDone: 0, bytesTotal: list.reduce((s, i) => s + (i.size ?? 0), 0), speed: 0 };
    let lastEmit = 0;
    let windowBytes = 0;
    let windowStart = Date.now();
    const emit = (force = false) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        const inst = (windowBytes * 1000) / (now - windowStart);
        prog.speed = prog.speed ? prog.speed * 0.6 + inst * 0.4 : inst;
        windowBytes = 0;
        windowStart = now;
      }
      if (force || now - lastEmit > 120) {
        lastEmit = now;
        onProgress({ ...prog });
      }
    };

    // 1) Verificación local (los archivos válidos no se vuelven a descargar).
    const pending: DownloadItem[] = [];
    await this.pool(list, Math.max(2, this.opts.concurrency), async (it) => {
      if (signal?.aborted) throw new AppError('CANCELLED');
      if (await fileMatches(it)) {
        prog.filesDone++;
        prog.bytesDone += it.size ?? 0;
        emit();
      } else pending.push(it);
    });
    emit(true);
    if (!pending.length) return { downloaded: 0, skipped: list.length };

    // 2) Espacio en disco.
    const needed = pending.reduce((s, i) => s + (i.size ?? 0), 0);
    const targetDir = path.dirname(pending[0]!.dest);
    await fsp.mkdir(targetDir, { recursive: true });
    const free = await freeSpace(targetDir);
    if (needed > 0 && free < needed + 64 * 1024 * 1024) {
      throw new AppError('DISK_FULL', 'espacio insuficiente', { needed, free });
    }

    // 3) Descarga.
    await this.pool(pending, this.opts.concurrency, async (it) => {
      const key = path.resolve(it.dest);
      let p = this.inflight.get(key);
      let mine = false;
      if (!p) {
        mine = true;
        p = this.downloadOne(it, (n) => {
          prog.bytesDone += n;
          windowBytes += n;
          emit();
        }, signal).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
      }
      await p;
      if (!mine) prog.bytesDone += it.size ?? 0;
      prog.filesDone++;
      emit();
    });
    emit(true);
    return { downloaded: pending.length, skipped: list.length - pending.length };
  }

  private async pool<T>(items: T[], n: number, fn: (it: T) => Promise<void>): Promise<void> {
    let i = 0;
    let failure: unknown;
    const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length && !failure) {
        const it = items[i++]!;
        try {
          await fn(it);
        } catch (e) {
          failure ??= e;
        }
      }
    });
    await Promise.all(workers);
    if (failure) throw failure;
  }

  private partPath(dest: string): string {
    const id = crypto.createHash('sha1').update(path.resolve(dest)).digest('hex');
    return path.join(this.opts.tempDir, 'parts', `${id}.part`);
  }

  async downloadOne(it: DownloadItem, onBytes: (n: number) => void, signal?: AbortSignal): Promise<void> {
    this.checkUrl(it.url);
    const part = this.partPath(it.dest);
    await fsp.mkdir(path.dirname(part), { recursive: true });
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (signal?.aborted) throw new AppError('CANCELLED');
      let counted = 0;
      try {
        let offset = 0;
        if (this.opts.resume) {
          try {
            offset = (await fsp.stat(part)).size;
            if (it.size != null && offset > it.size) offset = 0;
          } catch {
            offset = 0;
          }
        }
        if (it.size != null && offset === it.size && offset > 0) {
          // Parcial completo: solo falta verificar.
        } else {
          const headers: Record<string, string> = { 'user-agent': getUserAgent() };
          if (offset > 0) headers.range = `bytes=${offset}-`;
          const res = await this.fetchImpl(it.url, { headers, signal, redirect: 'follow' });
          if (res.url && res.url !== it.url) this.checkUrl(res.url);
          if (res.status === 416) {
            await fsp.rm(part, { force: true });
            throw new AppError('HTTP', 'rango inválido; reinicio');
          }
          if (!res.ok || !res.body) throw httpError(it.url, res.status);
          const append = res.status === 206 && offset > 0;
          if (!append) offset = 0;
          else {
            onBytes(offset);
            counted += offset;
          }
          const out = fs.createWriteStream(part, { flags: append ? 'a' : 'w' });
          const body = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream<Uint8Array>);
          await new Promise<void>((resolve, reject) => {
            let failed = false;
            const fail = (e: unknown) => {
              if (failed) return;
              failed = true;
              body.destroy();
              out.destroy();
              reject(e);
            };
            body.on('error', fail);
            out.on('error', fail);
            body.on('data', (chunk: Buffer) => {
              body.pause();
              this.bucket
                .take(chunk.length, signal)
                .then(() => {
                  if (!out.write(chunk)) out.once('drain', () => body.resume());
                  else body.resume();
                  onBytes(chunk.length);
                  counted += chunk.length;
                })
                .catch(fail);
            });
            body.on('end', () => {
              if (failed) return;
              out.end(() => resolve());
            });
          });
        }
        // Verificación de integridad ANTES de colocar el archivo en su destino.
        if (it.size != null) {
          const st = await fsp.stat(part);
          if (st.size !== it.size) throw new AppError('HASH_MISMATCH', `tamaño ${st.size} != ${it.size}`);
        }
        if (it.hash) {
          const got = await hashFile(part, it.hash.algo);
          if (got !== it.hash.value.toLowerCase()) {
            await fsp.rm(part, { force: true });
            throw new AppError('HASH_MISMATCH', `${path.basename(it.dest)} ${it.hash.algo}`);
          }
        }
        await moveFile(part, it.dest);
        // Ajuste de contabilidad si el tamaño real difiere del anunciado.
        if (it.size != null && counted !== it.size) onBytes(it.size - counted);
        return;
      } catch (e) {
        if (signal?.aborted || (isAppError(e) && e.code === 'CANCELLED')) throw new AppError('CANCELLED');
        if (counted) onBytes(-counted);
        lastError = e;
        if (isAppError(e) && (e.code === 'NOT_FOUND' || e.code === 'FORBIDDEN' || e.code === 'UNTRUSTED_SOURCE')) break;
        if ((e as NodeJS.ErrnoException).code === 'ENOSPC') throw new AppError('DISK_FULL', 'ENOSPC');
        this.log.warn('Reintentando descarga', { file: path.basename(it.dest), attempt, err: (e as Error).message });
        await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      }
    }
    throw isAppError(lastError) ? lastError : new AppError('NETWORK', (lastError as Error)?.message);
  }
}
