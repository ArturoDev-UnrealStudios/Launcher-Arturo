/**
 * Integración real cliente ↔ autoridad: el servidor de server/ se arranca en proceso y el
 * launcher habla con él por HTTP y WebSocket, con join/hasJoined simulando a Mojang.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../../server/src/app';
import { fakeBrowser, fakeJava, fakeWorld, servicesEnv, tmpDir, TEST_UUID } from '../helpers/mock';

async function authorityEnv() {
  const world = await fakeWorld();
  const joins = new Map<string, string>(); // serverId -> uuid sin guiones
  world.mock.on('POST', '/session/minecraft/join', (_req, res, body) => {
    const j = JSON.parse(body.toString());
    if (j.accessToken !== 'MC_ACCESS_TOKEN_SECRET') return void res.writeHead(403).end();
    joins.set(j.serverId, j.selectedProfile);
    res.writeHead(204).end();
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const seenTokens: string[] = [];
  const app = createApp(
    {
      host: '127.0.0.1', port: 0, dbPath: path.join(tmpDir(), 'a.db'), keyPepper: crypto.randomBytes(32), signingKey: privateKey,
      sessionServer: 'https://session.test', trustProxy: false, premiumSessionTtlMs: 3600_000, deviceSessionTtlMs: 3600_000, grantTtlMs: 86400_000, corsOrigins: [],
    },
    {
      log: () => {},
      fetch: (async (url: string) => {
        const u = new URL(url);
        seenTokens.push(url);
        const prof = joins.get(u.searchParams.get('serverId')!);
        if (!prof) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ id: prof, name: u.searchParams.get('username') }), { status: 200 });
      }) as never,
    },
  );
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return { world, app, url, pub, seenTokens };
}

test('claves: canje premium y offline, concesión firmada, instancia privada, manifiesto y revocación', async () => {
  const a = await authorityEnv();
  const env = await servicesEnv({ world: a.world, brand: { authority: { url: a.url, publicKeys: [a.pub] } } });
  try {
    const manifest = { version: '1.0.0', files: [{ path: 'mods/private.jar', url: `${a.world.mock.base}/private.jar`, sha256: crypto.createHash('sha256').update('PRIVADO').digest('hex'), size: 7 }] };
    a.world.mock.file('/private.jar', Buffer.from('PRIVADO'));
    a.app.keys.upsertInstance({ id: 'servidor-vip', name: 'Servidor VIP', mcVersion: a.world.versionId, loader: { kind: 'vanilla' }, manifest });
    const [k1, k2] = a.app.keys.createKeys('servidor-vip', 2);
    const { accounts, keys, instances, settings } = env.services;

    // Premium: join/hasJoined — la autoridad nunca recibe el token de Minecraft
    const acc = await accounts.loginMicrosoft(fakeBrowser);
    await settings.update({ ui: { activeAccountId: acc.id } });
    await assert.rejects(() => keys.redeem('UNRL-XXXX', acc.id), (e: any) => e.code === 'KEY_INVALID');
    const r = await keys.redeem(k1!.toLowerCase(), acc.id);
    assert.equal(r.instanceId, 'servidor-vip');
    assert.ok(!a.seenTokens.join('').includes('MC_ACCESS_TOKEN_SECRET'));
    const inst = instances.get('servidor-vip');
    assert.equal(inst.access.kind, 'private');
    assert.equal(instances.view(inst).primaryAction, 'install');
    assert.equal(keys.history()[0]!.keyHint, k1!.slice(0, 10));

    // Instalación con manifiesto privado verificado (hash firmado) y archivo privado verificado
    await instances.update('servidor-vip', { java: { path: fakeJava(tmpDir(), 21) } });
    await instances.install('servidor-vip');
    assert.equal(fs.readFileSync(path.join(instances.gameDir('servidor-vip'), 'mods', 'private.jar'), 'utf8'), 'PRIVADO');

    // Offline: identidad de dispositivo; la clave ya usada por otra cuenta se rechaza
    const off = await accounts.addOffline('Invitado');
    await assert.rejects(() => keys.redeem(k1!, off.id), (e: any) => e.code === 'KEY_ALREADY_USED');
    const r2 = await keys.redeem(k2!, off.id);
    assert.equal(r2.instanceId, 'servidor-vip');

    // Revocación: al renovar concesiones la instancia queda bloqueada y no se puede lanzar
    const grantId = (inst.access as any).grantId;
    for (const g of a.app.db.prepare('SELECT id FROM grants').all() as Array<{ id: string }>) a.app.keys.revokeGrant(g.id);
    await keys.refresh();
    const locked = instances.view(instances.get('servidor-vip'));
    assert.equal(locked.primaryAction, 'locked');
    await assert.rejects(() => instances.launch('servidor-vip', acc.id), (e: any) => e.code === 'INSTANCE_LOCKED');
    void grantId;

    // Una concesión con firma de otra clave se rechaza (autoridad suplantada)
    const evil = crypto.generateKeyPairSync('ed25519');
    const payload = JSON.stringify({ v: 1, id: 'x', instanceId: 'falsa', principal: `mc:${TEST_UUID}`, issuedAt: 1, expiresAt: Date.now() + 1e9, instance: { name: 'F', mcVersion: '1.21.1', loader: { kind: 'vanilla' } }, manifest: { sha256: 'a'.repeat(64), version: '1' } });
    assert.throws(() => (keys as any).verify(payload, crypto.sign(null, Buffer.from(payload), evil.privateKey).toString('base64')), (e: any) => e.code === 'UNTRUSTED_SOURCE');
  } finally {
    await env.close();
    await a.app.close();
  }
});

test('social: dos launchers chatean en tiempo real a través de la autoridad', async () => {
  const a = await authorityEnv();
  const env1 = await servicesEnv({ world: a.world, brand: { authority: { url: a.url, publicKeys: [a.pub] } } });
  // Segundo usuario: otro "mundo" de Microsoft que devuelve otro perfil
  const world2 = await fakeWorld();
  const U2 = '853c80ef-3c37-49fd-aa49-938b674adae6';
  world2.mock.on('GET', '/mc/profile', (_q, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: U2.replace(/-/g, ''), name: 'jeb_', skins: [] })));
  world2.mock.on('POST', '/session/minecraft/join', async (_req, res, body) => {
    // Reenvía el join al mundo 1 (el "Mojang" que consulta la autoridad)
    await fetch(`${a.world.mock.base}/session/minecraft/join`, { method: 'POST', body: new Uint8Array(body), headers: { 'content-type': 'application/json' } });
    res.writeHead(204).end();
  });
  const env2 = await servicesEnv({ world: world2, brand: { authority: { url: a.url, publicKeys: [a.pub] } } });
  try {
    const acc1 = await env1.services.accounts.loginMicrosoft(fakeBrowser);
    const acc2 = await env2.services.accounts.loginMicrosoft(fakeBrowser);
    const s1 = env1.services.social;
    const s2 = env2.services.social;
    const events2: any[] = [];
    const events1: any[] = [];
    env2.services.bus.on('social', (e) => events2.push(e));
    env1.services.bus.on('social', (e) => events1.push(e));
    await s1.start(acc1.id);
    await s2.start(acc2.id);
    const until = async (pred: () => boolean, ms = 4000) => {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > ms) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    await until(() => s1.getState().connection === 'online' && s2.getState().connection === 'online');

    const found = await s1.search('jeb_');
    assert.equal(found[0]!.uuid, U2);
    await s1.sendRequest(U2);
    await until(() => s2.getState().requests.some((r) => r.direction === 'incoming'));
    await s2.respond(s2.getState().requests[0]!.id, true);
    await until(() => s1.getState().friends.length === 1);
    assert.equal(s1.getState().friends[0]!.presence, 'online');

    s1.send(U2, 'hola desde el launcher 1', 'cid-1');
    await until(() => events1.some((e) => e.type === 'ack' && e.clientId === 'cid-1'));
    await until(() => events2.some((e) => e.type === 'message' && e.message.body === 'hola desde el launcher 1'));
    await until(() => events1.some((e) => e.type === 'delivered'));
    const hist = await s2.history(TEST_UUID);
    assert.equal(hist.messages.at(-1)!.body, 'hola desde el launcher 1');

    // Desconexión y reconexión con mensaje en cola
    s1.stop();
    await until(() => s2.getState().friends[0]?.presence === 'offline');
    await s1.start(acc1.id);
    await until(() => s1.getState().connection === 'online');
    s1.send(U2, 'tras reconectar', 'cid-2');
    await until(() => events2.some((e) => e.type === 'message' && e.message.body === 'tras reconectar'));

    // Una cuenta offline no puede usar social
    const off = await env1.services.accounts.addOffline('Pirata');
    await s1.start(off.id);
    assert.equal(s1.getState().connection, 'disabled');
    await assert.rejects(() => s1.search('jeb_'), (e: any) => e.code === 'PREMIUM_REQUIRED');
  } finally {
    await env1.close();
    await env2.close();
    await a.app.close();
  }
});
