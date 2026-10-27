import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { api, deviceLogin, premiumLogin, startTestServer, U1, U2 } from './helpers';
import { generateKey, KEY_RE, normalizeKey } from '../src/keys';

const MANIFEST = { version: '1.0.0', files: [{ path: 'mods/a.jar', url: 'https://example.com/a.jar', sha256: 'a'.repeat(64), size: 10 }] };

test('formato y normalización de claves', () => {
  const k = generateKey();
  assert.match(k, KEY_RE);
  assert.equal(normalizeKey(k.toLowerCase().replace(/-/g, ' ')), k);
  assert.equal(normalizeKey('UNRL-XXXXX'), null);
  assert.equal(normalizeKey(42), null);
  // 25 símbolos base32 ≈ 125 bits de entropía
  assert.equal(k.replace(/^UNRL-|-/g, '').length, 25);
});

test('canje: válida, firma, manifiesto, reutilización, idempotencia', async () => {
  const env = await startTestServer();
  try {
    env.app.keys.upsertInstance({ id: 'privada-1', name: 'Privada', mcVersion: '1.21.1', loader: { kind: 'fabric', version: '0.16.9' }, manifest: MANIFEST });
    const [key] = env.app.keys.createKeys('privada-1', 1);
    const t1 = await premiumLogin(env, 'Alice', U1);
    const t2 = await premiumLogin(env, 'Bob', U2);

    // Sin clave en BD en texto plano
    const rows = env.app.db.prepare('SELECT * FROM keys').all() as Array<Record<string, unknown>>;
    assert.ok(!JSON.stringify(rows).includes(key!.slice(5)), 'la clave no debe almacenarse en claro');

    const r = await api(env, 'POST', '/v1/keys/redeem', t1, { key });
    assert.equal(r.status, 200);
    const ok = crypto.verify(null, Buffer.from(r.json.payload), env.publicKey, Buffer.from(r.json.signature, 'base64'));
    assert.ok(ok, 'la concesión debe estar firmada');
    const payload = JSON.parse(r.json.payload);
    assert.equal(payload.instanceId, 'privada-1');
    assert.equal(payload.principal, `mc:${U1}`);

    // El mismo usuario puede volver a canjear (idempotente) sin consumir usos
    const again = await api(env, 'POST', '/v1/keys/redeem', t1, { key });
    assert.equal(again.status, 200);
    assert.equal(JSON.parse(again.json.payload).id, payload.id);

    // Otro usuario: ya utilizada
    const r2 = await api(env, 'POST', '/v1/keys/redeem', t2, { key });
    assert.equal(r2.status, 409);
    assert.equal(r2.json.error.code, 'KEY_ALREADY_USED');

    // Manifiesto: solo con concesión
    const m1 = await api(env, 'GET', '/v1/instances/privada-1/manifest', t1);
    assert.equal(m1.status, 200);
    const sha = crypto.createHash('sha256').update(m1.json.manifest).digest('hex');
    assert.equal(sha, payload.manifest.sha256);
    const m2 = await api(env, 'GET', '/v1/instances/privada-1/manifest', t2);
    assert.equal(m2.status, 403);
  } finally {
    await env.close();
  }
});

test('canje: incorrecta, expirada, revocada, agotada y límite de intentos', async () => {
  const env = await startTestServer();
  try {
    env.app.keys.upsertInstance({ id: 'privada-2', name: 'P2', mcVersion: '1.20.1', loader: { kind: 'vanilla' }, manifest: MANIFEST });
    const [expired] = env.app.keys.createKeys('privada-2', 1, { expiresAt: Date.now() - 1000 });
    const [revoked] = env.app.keys.createKeys('privada-2', 1);
    const [multi] = env.app.keys.createKeys('privada-2', 1, { maxUses: 2 });
    env.app.keys.revokeKey(revoked!);
    const dev1 = await deviceLogin(env);
    const dev2 = await deviceLogin(env);
    const dev3 = await deviceLogin(env);

    assert.equal((await api(env, 'POST', '/v1/keys/redeem', dev1.token, { key: expired })).json.error.code, 'KEY_EXPIRED');
    assert.equal((await api(env, 'POST', '/v1/keys/redeem', dev1.token, { key: revoked })).json.error.code, 'KEY_REVOKED');
    assert.equal((await api(env, 'POST', '/v1/keys/redeem', dev1.token, { key: generateKey() })).json.error.code, 'KEY_INVALID');

    assert.equal((await api(env, 'POST', '/v1/keys/redeem', dev2.token, { key: multi })).status, 200);
    assert.equal((await api(env, 'POST', '/v1/keys/redeem', dev3.token, { key: multi })).status, 200);
    const exhausted = await api(env, 'POST', '/v1/keys/redeem', dev1.token, { key: multi });
    assert.equal(exhausted.json.error.code, 'KEY_EXHAUSTED');

    // dev1 lleva 4 fallos; el 5.º falla y el 6.º queda bloqueado por límite de intentos.
    assert.equal((await api(env, 'POST', '/v1/keys/redeem', dev1.token, { key: 'basura' })).json.error.code, 'KEY_INVALID');
    const limited = await api(env, 'POST', '/v1/keys/redeem', dev1.token, { key: multi });
    assert.equal(limited.status, 429);

    // Eventos de seguridad registrados sin la clave completa
    const ev = env.app.db.prepare('SELECT detail FROM security_events').all() as Array<{ detail: string }>;
    assert.ok(ev.length >= 6);
    for (const e of ev) assert.ok(!e.detail || e.detail.length <= 10);
  } finally {
    await env.close();
  }
});

test('revocación de concesión: manifiesto denegado y listado como revocada', async () => {
  const env = await startTestServer();
  try {
    env.app.keys.upsertInstance({ id: 'privada-3', name: 'P3', mcVersion: '1.21.1', loader: { kind: 'vanilla' }, manifest: MANIFEST });
    const [key] = env.app.keys.createKeys('privada-3', 1);
    const t = await premiumLogin(env, 'Carol', U1);
    const r = await api(env, 'POST', '/v1/keys/redeem', t, { key });
    const grantId = JSON.parse(r.json.payload).id;
    assert.ok(env.app.keys.revokeGrant(grantId));
    const list = await api(env, 'GET', '/v1/grants', t);
    assert.deepEqual(list.json.revoked, [grantId]);
    assert.equal(list.json.active.length, 0);
    assert.equal((await api(env, 'GET', '/v1/instances/privada-3/manifest', t)).status, 403);
  } finally {
    await env.close();
  }
});

test('canjes simultáneos desde varios procesos: solo uno gana', async () => {
  const env = await startTestServer();
  try {
    env.app.keys.upsertInstance({ id: 'privada-4', name: 'P4', mcVersion: '1.21.1', loader: { kind: 'vanilla' }, manifest: MANIFEST });
    const [key] = env.app.keys.createKeys('privada-4', 1);
    const workers = 8;
    const results = await Promise.all(
      Array.from({ length: workers }, (_, i) =>
        new Promise<string>((resolve, reject) => {
          const w = new Worker(path.resolve(process.cwd(), 'test', 'redeem-worker.mjs'), {
            workerData: { dbPath: env.cfg.dbPath, pepper: env.cfg.keyPepper.toString('base64'), key, principal: `dev:worker${i}` },
            execArgv: ['--import', 'tsx'],
          });
          w.once('message', resolve);
          w.once('error', reject);
        }),
      ),
    );
    assert.equal(results.filter((r) => r === 'ok').length, 1, `resultados: ${results.join(',')}`);
    assert.equal(results.filter((r) => r === 'KEY_ALREADY_USED').length, workers - 1);
    const row = env.app.db.prepare('SELECT uses FROM keys').get() as { uses: number };
    assert.equal(row.uses, 1);
  } finally {
    await env.close();
  }
});
