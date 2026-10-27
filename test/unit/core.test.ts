import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { redact, redactString, createLogger } from '../../src/main/core/logger';
import { readJson, writeFileAtomic, writeJson } from '../../src/main/core/jsonStore';
import { OsSecretStore, type OsCipher } from '../../src/main/security/secureStore';
import { SettingsService, splitArgs, validateJvmArgs, maxAllowedMemoryMb } from '../../src/main/config/settingsService';
import { minecraftDigest, offlineUuid, pkcePair, verifyEd25519 } from '../../src/main/security/crypto';
import { isInside, safeJoin } from '../../src/main/core/paths';
import { extractZip, ZipWriter, listZip } from '../../src/main/core/archive';
import { nullLogger } from '../../src/main/core/logger';
import { InvokeChannels } from '../../src/shared/api';
import { tmpDir } from '../helpers/mock';
import crypto from 'node:crypto';

test('logger: redacta tokens, JWT, códigos OAuth y claves de canje', () => {
  const s = redactString(
    'Bearer abc.def.ghi accessToken":"SECRET123" ?code=M.C507_BAY.2.U.abcdefghijklmnopqrstuvwxyz&state=xyz --accessToken MC_TOKEN eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U UNRL-ABCDE-FGHIJ-KLMNO-PQRST-UVWXY',
  );
  for (const leaked of ['abc.def.ghi', 'SECRET123', 'MC_TOKEN', 'dozjgNryP4J3', 'FGHIJ-KLMNO', 'M.C507_BAY']) assert.ok(!s.includes(leaked), `fuga: ${leaked} en ${s}`);
  assert.ok(s.includes('UNRL-ABCDE-…'));
  const o = redact({ refresh_token: 'r', nested: { accessToken: 'a', ok: 'visible' }, list: ['Bearer zzz'] }) as Record<string, any>;
  assert.equal(o.refresh_token, '[REDACTED]');
  assert.equal(o.nested.accessToken, '[REDACTED]');
  assert.equal(o.nested.ok, 'visible');
  assert.equal(o.list[0], 'Bearer [REDACTED]');
});

test('logger: escribe archivo sin secretos', () => {
  const dir = tmpDir();
  const log = createLogger({ dir, level: 'debug' });
  log.info('login ok', { accessToken: 'TOPSECRET', user: 'Steve' });
  log.child('x').error('fallo con Bearer QQQ');
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      const f = fs.readdirSync(dir)[0]!;
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(content.includes('Steve'));
      assert.ok(!content.includes('TOPSECRET'));
      assert.ok(!content.includes('QQQ'));
      resolve();
    }, 100);
  });
});

test('jsonStore: escritura atómica y recuperación desde .bak', async () => {
  const dir = tmpDir();
  const f = path.join(dir, 'a.json');
  const schema = z.object({ v: z.number() });
  await writeJson(f, { v: 1 });
  await writeJson(f, { v: 2 });
  fs.writeFileSync(f, '{corrupto');
  const r = await readJson(f, schema, () => ({ v: 0 }));
  assert.deepEqual(r.value, { v: 1 });
  assert.equal(r.recovered, true);
  await writeFileAtomic(path.join(dir, 'b.bin'), Buffer.from('x'));
  assert.equal(fs.readdirSync(dir).filter((x) => x.endsWith('.tmp')).length, 0);
});

test('almacén seguro: cifra con el SO y nunca guarda en claro sin backend seguro', async () => {
  const key = crypto.randomBytes(32);
  const cipher: OsCipher = {
    isEncryptionAvailable: () => true,
    encryptString: (p) => {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(p, 'utf8'), c.final()]);
      return Buffer.concat([iv, c.getAuthTag(), enc]);
    },
    decryptString: (b) => {
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    },
    getSelectedStorageBackend: () => 'gnome_libsecret',
  };
  const dir = tmpDir();
  const s1 = new OsSecretStore(dir, cipher, nullLogger);
  await s1.set('ms-abc', 'refresh-token-value');
  const raw = fs.readFileSync(path.join(dir, 'ms-abc.bin'));
  assert.ok(!raw.toString('latin1').includes('refresh-token-value'));
  const s2 = new OsSecretStore(dir, cipher, nullLogger);
  assert.equal(await s2.get('ms-abc'), 'refresh-token-value');
  await s2.delete('ms-abc');
  assert.equal(fs.existsSync(path.join(dir, 'ms-abc.bin')), false);

  const dir2 = tmpDir();
  const weak = new OsSecretStore(dir2, { ...cipher, getSelectedStorageBackend: () => 'basic_text' }, nullLogger);
  assert.equal(weak.persistent, false);
  await weak.set('ms-x', 'secret');
  assert.equal(await weak.get('ms-x'), 'secret');
  assert.equal(fs.readdirSync(dir2).length, 0, 'sin backend seguro no se escribe nada en disco');
  await assert.rejects(() => weak.set('../escape', 'x'));
});

test('configuración: valida memoria y argumentos JVM, persiste y se restablece', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'settings.json');
  const s = new SettingsService(file, nullLogger, 16384);
  await s.load();
  assert.equal(s.get().general.language, 'es');
  await s.update({ general: { theme: 'light' }, downloads: { concurrency: 4 } });
  await assert.rejects(() => s.update({ minecraft: { defaultMemoryMaxMb: 16384 } }), /memory.exceedsSystem/);
  await assert.rejects(() => s.update({ minecraft: { defaultMemoryMinMb: 4096, defaultMemoryMaxMb: 2048 } }));
  await assert.rejects(() => s.update({ minecraft: { defaultJvmArgs: ['-javaagent:evil.jar'] } }), /jvmArgs.forbidden/);
  await assert.rejects(() => s.update({ downloads: { concurrency: 99 } }));
  await s.update({ minecraft: { defaultMemoryMaxMb: 8192, defaultJvmArgs: ['-XX:+UseG1GC'] }, ui: { activeAccountId: 'a1' } });
  const s2 = new SettingsService(file, nullLogger, 16384);
  await s2.load();
  assert.equal(s2.get().general.theme, 'light');
  assert.equal(s2.get().minecraft.defaultMemoryMaxMb, 8192);
  const reset = await s2.reset();
  assert.equal(reset.general.theme, 'dark');
  assert.equal(reset.ui.activeAccountId, 'a1', 'restablecer no cierra la sesión activa');
  assert.ok(maxAllowedMemoryMb(16384) <= 12288);
});

test('argumentos JVM: parser y lista de prohibidos', () => {
  assert.deepEqual(splitArgs(`-Xss2m "-Dfoo=a b" -XX:+UseZGC`), ['-Xss2m', '-Dfoo=a b', '-XX:+UseZGC']);
  assert.deepEqual(validateJvmArgs(['-XX:+UseG1GC', '-Dsun.stdout.encoding=UTF-8']), { ok: true });
  for (const bad of ['-agentpath:/x', '-XX:OnOutOfMemoryError=calc.exe', '-cp', 'notaflag', '@args.txt', '-Xmx64G', '-Djava.library.path=/tmp']) {
    assert.equal(validateJvmArgs([bad]).ok, false, bad);
  }
});

test('criptografía: UUID offline estándar, PKCE, firmas y hash de serverId', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f');
  const { verifier, challenge } = pkcePair();
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));
  assert.ok(verifier.length >= 43);
  // Vectores conocidos del protocolo de Minecraft
  assert.equal(minecraftDigest('Notch'), '4ed1f46bbe04bc756bcb17c0c7ce3e4632f06a48');
  assert.equal(minecraftDigest('jeb_'), '-7c9d5b0044c130109a5d7b5fb5c317c02b4e28c1');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const sig = crypto.sign(null, Buffer.from('hola'), privateKey).toString('base64');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.ok(verifyEd25519('hola', sig, [pub]));
  assert.ok(!verifyEd25519('hola!', sig, [pub]));
  assert.ok(!verifyEd25519('hola', 'AAAA', [pub]));
});

test('rutas: protección contra path traversal y zip-slip', async () => {
  const root = tmpDir();
  assert.ok(isInside(root, path.join(root, 'a', 'b')));
  assert.ok(!isInside(root, path.join(root, '..', 'x')));
  assert.throws(() => safeJoin(root, '..', 'etc'));
  const zf = path.join(root, 'evil.zip');
  const z = new ZipWriter(zf);
  await z.addBuffer('ok/file.txt', Buffer.from('ok'));
  await z.addBuffer('../../escape.txt', Buffer.from('evil'));
  await z.close();
  // yauzl valida los nombres al leer; extractZip además comprueba que el destino quede dentro.
  await assert.rejects(() => extractZip(zf, path.join(root, 'out')));
  await assert.rejects(() => listZip(zf));
  assert.equal(fs.existsSync(path.join(root, '..', 'escape.txt')), false);
});

test('contrato IPC: todos los canales están declarados y son únicos', () => {
  const all = Object.entries(InvokeChannels).flatMap(([ns, ms]) => (ms as readonly string[]).map((m) => `${ns}:${m}`));
  assert.equal(new Set(all).size, all.length);
  const ipcSrc = fs.readFileSync(path.join(__dirname, '../../src/main/ipc.ts'), 'utf8');
  for (const ch of all) {
    const [ns, m] = ch.split(':');
    assert.ok(new RegExp(`handle\\(\\s*'${ns}',\\s*'${m}'`).test(ipcSrc), `falta handler para ${ch}`);
  }
});
