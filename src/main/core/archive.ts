import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import { AppError } from '../../shared/errors';
import { isInside } from './paths';

export interface ExtractOptions {
  /** Prefijos a excluir (p. ej. "META-INF/"). */
  exclude?: string[];
  /** Límite total descomprimido (protección contra zip bombs). */
  maxBytes?: number;
  maxEntries?: number;
  /** Filtro adicional por entrada. Devuelve la ruta destino relativa o null para omitir. */
  map?: (entryName: string) => string | null;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (err, zf) =>
      err || !zf ? reject(err ?? new Error('zip')) : resolve(zf),
    ),
  );
}

/** Lista entradas de un zip (nombre y tamaño). */
export async function listZip(file: string): Promise<Array<{ name: string; size: number }>> {
  const zf = await openZip(file);
  return new Promise((resolve, reject) => {
    const out: Array<{ name: string; size: number }> = [];
    zf.on('entry', (e: yauzl.Entry) => {
      out.push({ name: e.fileName, size: e.uncompressedSize });
      zf.readEntry();
    });
    zf.on('end', () => resolve(out));
    zf.on('error', reject);
    zf.readEntry();
  });
}

export async function readZipEntry(file: string, name: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer | null> {
  const zf = await openZip(file);
  return new Promise((resolve, reject) => {
    let found = false;
    zf.on('entry', (e: yauzl.Entry) => {
      if (e.fileName !== name) return zf.readEntry();
      found = true;
      if (e.uncompressedSize > maxBytes) {
        zf.close();
        return reject(new AppError('VALIDATION', 'entrada demasiado grande'));
      }
      zf.openReadStream(e, (err, rs) => {
        if (err || !rs) return reject(err);
        const chunks: Buffer[] = [];
        rs.on('data', (c: Buffer) => chunks.push(c));
        rs.on('end', () => {
          zf.close();
          resolve(Buffer.concat(chunks));
        });
        rs.on('error', reject);
      });
    });
    zf.on('end', () => {
      if (!found) resolve(null);
    });
    zf.on('error', reject);
    zf.readEntry();
  });
}

/** Extracción segura: impide zip-slip, enlaces y tamaños desproporcionados. */
export async function extractZip(file: string, destDir: string, opts: ExtractOptions = {}): Promise<number> {
  const maxBytes = opts.maxBytes ?? 4 * 1024 ** 3;
  const maxEntries = opts.maxEntries ?? 200_000;
  await fsp.mkdir(destDir, { recursive: true });
  const zf = await openZip(file);
  let total = 0;
  let count = 0;
  return new Promise((resolve, reject) => {
    const fail = (e: unknown) => {
      zf.close();
      reject(e);
    };
    zf.on('entry', (e: yauzl.Entry) => {
      count++;
      if (count > maxEntries) return fail(new AppError('VALIDATION', 'demasiadas entradas'));
      let name = e.fileName.replace(/\\/g, '/');
      if (opts.exclude?.some((p) => name.startsWith(p))) return zf.readEntry();
      if (opts.map) {
        const mapped = opts.map(name);
        if (mapped == null) return zf.readEntry();
        name = mapped;
      }
      const target = path.resolve(destDir, name);
      if (!isInside(destDir, target) || name.includes('\0')) return fail(new AppError('VALIDATION', `ruta insegura en zip: ${e.fileName}`));
      // Bit de tipo symlink en atributos externos (unix) → se rechaza.
      const mode = (e.externalFileAttributes >>> 16) & 0o170000;
      if (mode === 0o120000) return fail(new AppError('VALIDATION', 'enlace simbólico en zip'));
      if (/\/$/.test(name)) {
        fsp.mkdir(target, { recursive: true }).then(() => zf.readEntry(), fail);
        return;
      }
      total += e.uncompressedSize;
      if (total > maxBytes) return fail(new AppError('VALIDATION', 'contenido descomprimido demasiado grande'));
      zf.openReadStream(e, (err, rs) => {
        if (err || !rs) return fail(err);
        fsp
          .mkdir(path.dirname(target), { recursive: true })
          .then(() => {
            const ws = fs.createWriteStream(target);
            rs.on('error', fail);
            ws.on('error', fail);
            ws.on('finish', () => zf.readEntry());
            rs.pipe(ws);
          }, fail);
      });
    });
    zf.on('end', () => resolve(count));
    zf.on('error', fail);
    zf.readEntry();
  });
}

/** tar.gz mediante el binario `tar` del sistema (presente en Windows 10+, macOS y Linux). */
export async function extractTarGz(file: string, destDir: string): Promise<void> {
  await fsp.mkdir(destDir, { recursive: true });
  // Se listan primero las entradas para rechazar rutas absolutas o con "..".
  const list = await new Promise<string>((resolve, reject) => {
    const p = spawn('tar', ['-tzf', file], { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`tar -t ${c}`))));
  });
  for (const line of list.split(/\r?\n/)) {
    if (!line) continue;
    if (path.isAbsolute(line) || line.split('/').includes('..')) throw new AppError('VALIDATION', 'ruta insegura en tar');
  }
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['-xzf', file, '-C', destDir, '--no-same-owner'], { windowsHide: true });
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`tar -x ${c}`))));
  });
}

// ------------------------------------------------------------------
// Escritor ZIP mínimo (deflate) para exportar instancias y logs.
// Formato ZIP estándar (APPNOTE) usando zlib de Node; sin ZIP64 (límite 4 GB por archivo).
// ------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer, crc = 0): number {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return ~c >>> 0;
}

export class ZipWriter {
  private readonly central: Buffer[] = [];
  private offset = 0;
  private count = 0;
  private readonly out: fs.WriteStream;
  constructor(file: string) {
    this.out = fs.createWriteStream(file);
  }
  private write(b: Buffer): Promise<void> {
    this.offset += b.length;
    return new Promise((res, rej) => this.out.write(b, (e) => (e ? rej(e) : res())));
  }
  async addBuffer(name: string, data: Buffer, mtime = new Date()): Promise<void> {
    if (data.length > 0xfffffff0) throw new AppError('VALIDATION', 'archivo demasiado grande para exportar');
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const dosTime = ((mtime.getHours() << 11) | (mtime.getMinutes() << 5) | (mtime.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((mtime.getFullYear() - 1980) << 9) | ((mtime.getMonth() + 1) << 5) | mtime.getDate()) & 0xffff;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const at = this.offset;
    await this.write(Buffer.concat([local, nameBuf]));
    await this.write(comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(at, 42);
    this.central.push(Buffer.concat([cen, nameBuf]));
    this.count++;
  }
  async addFile(name: string, file: string): Promise<void> {
    const st = await fsp.stat(file);
    await this.addBuffer(name, await fsp.readFile(file), st.mtime);
  }
  async close(): Promise<void> {
    const start = this.offset;
    for (const c of this.central) await this.write(c);
    const size = this.offset - start;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.count, 8);
    end.writeUInt16LE(this.count, 10);
    end.writeUInt32LE(size, 12);
    end.writeUInt32LE(start, 16);
    await this.write(end);
    await new Promise<void>((res) => this.out.end(res));
  }
}
