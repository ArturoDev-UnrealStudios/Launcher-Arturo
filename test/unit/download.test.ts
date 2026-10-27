import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Downloader } from '../../src/main/download/downloader';
import { nullLogger } from '../../src/main/core/logger';
import { MockServer, sha1, sha256, tmpDir } from '../helpers/mock';

function dl(temp: string, extra: Partial<ConstructorParameters<typeof Downloader>[1]> = {}) {
  return new Downloader(globalThis.fetch.bind(globalThis), { concurrency: 4, bandwidthLimit: 0, resume: true, tempDir: temp, allowInsecureLocalhost: true, ...extra }, nullLogger);
}

test('descarga verificada, omisión de archivos válidos y deduplicación', async () => {
  const m = await new MockServer().start();
  try {
    const data = Buffer.alloc(200_000, 7);
    m.file('/a.bin', data);
    const dir = tmpDir();
    const d = dl(path.join(dir, 'tmp'));
    const item = { url: `${m.base}/a.bin`, dest: path.join(dir, 'out', 'a.bin'), size: data.length, hash: { algo: 'sha1' as const, value: sha1(data) } };
    const prog: number[] = [];
    const r = await d.downloadAll([item, { ...item }], (p) => prog.push(p.bytesDone));
    assert.equal(r.downloaded, 1, 'el mismo destino solo se descarga una vez');
    assert.ok(fs.readFileSync(item.dest).equals(data));
    assert.equal(prog.at(-1), data.length, 'el progreso refleja bytes reales');
    const hitsBefore = m.hits.length;
    const r2 = await d.downloadAll([item], () => {});
    assert.equal(r2.skipped, 1);
    assert.equal(m.hits.length, hitsBefore, 'un archivo válido no genera peticiones');
  } finally {
    await m.close();
  }
});

test('hash incorrecto: no se instala el archivo', async () => {
  const m = await new MockServer().start();
  try {
    m.file('/evil.jar', Buffer.from('contenido manipulado'));
    const dir = tmpDir();
    const dest = path.join(dir, 'lib.jar');
    await assert.rejects(
      () => dl(path.join(dir, 'tmp')).downloadAll([{ url: `${m.base}/evil.jar`, dest, hash: { algo: 'sha256', value: sha256('original') } }], () => {}),
      (e: any) => e.code === 'HASH_MISMATCH',
    );
    assert.equal(fs.existsSync(dest), false);
  } finally {
    await m.close();
  }
});

test('descarga interrumpida se reanuda con Range', async () => {
  const m = await new MockServer().start();
  try {
    const data = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    m.file('/big.bin', data);
    m.cutOnce.set('/big.bin', 120_000);
    const dir = tmpDir();
    const dest = path.join(dir, 'big.bin');
    await dl(path.join(dir, 'tmp')).downloadAll([{ url: `${m.base}/big.bin`, dest, size: data.length, hash: { algo: 'sha256', value: sha256(data) } }], () => {});
    assert.ok(fs.readFileSync(dest).equals(data));
    assert.ok(m.hits.filter((h) => h === 'GET /big.bin').length >= 2, 'hubo reintento');
  } finally {
    await m.close();
  }
});

test('falta de espacio: se detecta antes de descargar', async () => {
  const dir = tmpDir();
  await assert.rejects(
    () => dl(path.join(dir, 'tmp')).downloadAll([{ url: 'http://127.0.0.1:1/x', dest: path.join(dir, 'x'), size: 10 * 1024 ** 5 }], () => {}),
    (e: any) => e.code === 'DISK_FULL' && e.data.needed > e.data.free,
  );
});

test('protocolos inseguros rechazados y límite de ancho de banda', async () => {
  const dir = tmpDir();
  const strict = new Downloader(globalThis.fetch.bind(globalThis), { concurrency: 1, bandwidthLimit: 0, resume: true, tempDir: dir }, nullLogger);
  await assert.rejects(() => strict.downloadAll([{ url: 'http://example.com/a', dest: path.join(dir, 'a') }], () => {}), (e: any) => e.code === 'UNTRUSTED_SOURCE');

  const m = await new MockServer().start();
  try {
    const data = Buffer.alloc(150_000, 1);
    m.file('/slow.bin', data);
    const limited = dl(path.join(dir, 'tmp2'), { bandwidthLimit: 100_000 });
    const t0 = Date.now();
    await limited.downloadAll([{ url: `${m.base}/slow.bin`, dest: path.join(dir, 'slow.bin'), size: data.length }], () => {});
    const elapsed = Date.now() - t0;
    assert.ok(elapsed >= 400, `debería tardar ~0.5 s con 100 KB/s (tardó ${elapsed} ms)`);
  } finally {
    await m.close();
  }
});

test('cancelación', async () => {
  const m = await new MockServer().start();
  try {
    m.file('/c.bin', Buffer.alloc(500_000, 3));
    const dir = tmpDir();
    const ctrl = new AbortController();
    const d = dl(path.join(dir, 'tmp'), { bandwidthLimit: 50_000 });
    setTimeout(() => ctrl.abort(), 100);
    await assert.rejects(() => d.downloadAll([{ url: `${m.base}/c.bin`, dest: path.join(dir, 'c.bin'), size: 500_000 }], () => {}, ctrl.signal), (e: any) => e.code === 'CANCELLED');
    assert.equal(fs.existsSync(path.join(dir, 'c.bin')), false);
  } finally {
    await m.close();
  }
});
