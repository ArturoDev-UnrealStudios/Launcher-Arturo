import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { compareSemver } from '../../src/main/updater/updater';
import { validateSkinPng } from '../../src/main/skins/skinService';
import { fakeBrowser, servicesEnv, sha256, tmpDir } from '../helpers/mock';

function png(w: number, h: number, colorType = 6): Buffer {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = colorType;
  return b;
}

test('semver y canal', () => {
  assert.ok(compareSemver('1.2.0', '1.1.9') > 0);
  assert.ok(compareSemver('v1.2.0', '1.2.0') === 0);
  assert.ok(compareSemver('1.2.0-beta.2', '1.2.0-beta.10') < 0);
  assert.ok(compareSemver('1.2.0', '1.2.0-rc.1') > 0);
});

async function updaterEnv() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const env = await servicesEnv({ brand: { updatePublicKeys: [pub] } });
  const B = env.world.mock.base;
  const installer = Buffer.alloc(80_000, 9);
  const releases: any[] = [];
  const addRelease = (tag: string, opts: { prerelease?: boolean; tamperSig?: boolean; installer?: Buffer; manifestVersion?: string } = {}) => {
    const inst = opts.installer ?? installer;
    const manifest = JSON.stringify({
      version: opts.manifestVersion ?? tag.replace(/^v/, ''),
      channel: opts.prerelease ? 'beta' : 'stable',
      releasedAt: new Date().toISOString(),
      notes: `Notas ${tag}`,
      files: { 'linux-x64': { name: `UnrealLauncher-${tag}.AppImage`, sha256: sha256(installer), size: inst.length, kind: 'appimage' } },
    });
    let sig = crypto.sign(null, Buffer.from(manifest), privateKey).toString('base64');
    if (opts.tamperSig) sig = crypto.sign(null, Buffer.from(manifest + ' '), privateKey).toString('base64');
    env.world.mock.file(`/dl/${tag}/update-manifest.json`, Buffer.from(manifest));
    env.world.mock.file(`/dl/${tag}/update-manifest.json.sig`, Buffer.from(sig));
    env.world.mock.file(`/dl/${tag}/installer`, inst);
    releases.push({
      tag_name: tag, name: tag, body: `cuerpo ${tag}`, draft: false, prerelease: !!opts.prerelease, published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/x',
      assets: [
        { name: 'update-manifest.json', size: manifest.length, browser_download_url: `${B}/dl/${tag}/update-manifest.json` },
        { name: 'update-manifest.json.sig', size: sig.length, browser_download_url: `${B}/dl/${tag}/update-manifest.json.sig` },
        { name: `UnrealLauncher-${tag}.AppImage`, size: inst.length, browser_download_url: `${B}/dl/${tag}/installer` },
      ],
    });
  };
  let status = 200;
  env.world.mock.on('GET', '/gh/repos/owner/repo/releases', (_q, res) => {
    if (status !== 200) return void res.writeHead(status).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(releases));
  });
  return { env, addRelease, setStatus: (s: number) => (status = s), installer };
}

test('actualizador: sin actualización, nueva release firmada, descarga verificada y canal beta', async () => {
  const { env, addRelease } = await updaterEnv();
  try {
    const u = env.services.updater;
    addRelease('v0.9.0');
    assert.equal((await u.check()).state, 'not-available');
    addRelease('v1.1.0');
    addRelease('v1.2.0-beta.1', { prerelease: true });
    (u as any).releasesCache = undefined;
    const info = await u.check();
    assert.equal(info.state, 'available');
    assert.equal(info.latest?.version, '1.1.0', 'el canal estable ignora prereleases');
    const d = await u.download();
    assert.equal(d.state, 'ready');
    u.setChannel('beta');
    (u as any).releasesCache = undefined;
    assert.equal((await u.check()).latest?.version, '1.2.0-beta.1');
    const hist = await u.history();
    assert.ok(hist.length >= 3);
  } finally {
    await env.close();
  }
});

test('actualizador: firma inválida, manifiesto reutilizado, instalador manipulado y GitHub caído', async () => {
  const { env, addRelease, setStatus } = await updaterEnv();
  try {
    const u = env.services.updater;
    addRelease('v2.0.0', { tamperSig: true });
    addRelease('v1.9.0', { manifestVersion: '1.0.1' });
    assert.equal((await u.check()).state, 'not-available', 'ninguna release con firma/manifiesto válido');

    addRelease('v2.1.0', { installer: Buffer.alloc(80_000, 1) }); // hash del manifiesto ≠ contenido
    (u as any).releasesCache = undefined;
    assert.equal((await u.check()).latest?.version, '2.1.0');
    const d = await u.download();
    assert.equal(d.state, 'error');
    assert.equal(d.error?.code, 'UPDATE_SIGNATURE_INVALID');
    await assert.rejects(() => u.install(() => {}), (e: any) => e.code === 'UPDATE_FAILED');

    setStatus(503);
    (u as any).releasesCache = undefined;
    const down = await u.check();
    assert.equal(down.state, 'error', 'sin GitHub el launcher sigue funcionando');
    setStatus(403);
    (u as any).releasesCache = undefined;
    assert.equal((await u.check()).error?.code, 'RATE_LIMITED');
  } finally {
    await env.close();
  }
});

test('actualizador: instalación AppImage con recuperación y registro de versión', async () => {
  const { env, addRelease, installer } = await updaterEnv();
  try {
    const u = env.services.updater;
    addRelease('v1.5.0');
    await u.check();
    await u.download();
    const dir = tmpDir();
    const appImage = path.join(dir, 'Unreal.AppImage');
    fs.writeFileSync(appImage, 'old');
    process.env.APPIMAGE = appImage;
    let quit = false;
    const childProc = await import('node:child_process');
    const orig = childProc.spawn;
    // No se ejecuta el binario en la prueba
    (childProc as any).spawn = () => ({ unref() {} });
    try {
      await u.install(() => (quit = true));
    } finally {
      (childProc as any).spawn = orig;
      delete process.env.APPIMAGE;
    }
    assert.ok(quit);
    assert.ok(fs.readFileSync(appImage).equals(installer));
    assert.equal(fs.readFileSync(`${appImage}.old`, 'utf8'), 'old', 'se conserva la versión anterior');
    // Al reiniciar con la versión antigua (1.0.0) se detecta el fallo
    const r = await u.reconcile();
    assert.equal(r.result, 'failed');
    assert.equal(r.version, '1.5.0');
    assert.equal((await u.reconcile()).result, 'none');
  } finally {
    await env.close();
  }
});

test('almacenamiento: datos reales, limpieza segura con espacio confirmado', async () => {
  const env = await servicesEnv();
  try {
    const { storage, instances, paths } = env.services;
    const i = await instances.create({ name: 'Datos', mcVersion: env.world.versionId, loader: { kind: 'vanilla' } });
    const g = instances.gameDir(i.id);
    for (const [sub, size] of [['mods', 5000], ['saves/Mundo', 7000], ['resourcepacks', 3000]] as const) {
      fs.mkdirSync(path.join(g, sub), { recursive: true });
      fs.writeFileSync(path.join(g, sub, 'f.bin'), Buffer.alloc(size));
    }
    fs.mkdirSync(paths.cache, { recursive: true });
    fs.writeFileSync(path.join(paths.cache, 'meta.json'), Buffer.alloc(4000));
    fs.mkdirSync(path.join(paths.temp, 'parts'), { recursive: true });
    const oldPart = path.join(paths.temp, 'parts', 'old.part');
    fs.writeFileSync(oldPart, Buffer.alloc(2000));
    const past = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(oldPart, past, past);
    fs.writeFileSync(path.join(paths.temp, 'parts', 'recent.part'), Buffer.alloc(100));

    const s = await storage.summary(true);
    assert.ok(s.drive.total > 0 && s.drive.free > 0);
    const inst = s.instances.find((x) => x.id === i.id)!;
    assert.equal(inst.mods, 5000);
    assert.equal(inst.saves, 7000);
    assert.equal(inst.resourcepacks, 3000);
    assert.ok(s.launcher.cache >= 4000);

    const plan = await storage.planCleanup();
    const planned = plan.items.map((x) => x.path);
    assert.ok(planned.includes(oldPart));
    assert.ok(!planned.some((p) => p.includes('recent.part')), 'no se borran descargas en curso/recientes');
    assert.ok(!planned.some((p) => p.startsWith(paths.instancesDir)), 'nunca mundos, mods ni configuraciones');
    const res = await storage.executeCleanup(plan.planId);
    assert.equal(res.freedBytes, plan.estimatedBytes);
    assert.ok(fs.existsSync(path.join(g, 'saves', 'Mundo', 'f.bin')));
    await assert.rejects(() => storage.executeCleanup(plan.planId), (e: any) => e.code === 'NOT_FOUND', 'un plan solo se ejecuta una vez');
    const big = await storage.largest(3);
    assert.equal(big[0]!.size, 7000);
  } finally {
    await env.close();
  }
});

test('skins: validación de PNG, biblioteca y publicación solo con premium', async () => {
  const env = await servicesEnv();
  try {
    const { skins, accounts } = env.services;
    assert.throws(() => validateSkinPng(png(64, 48)), (e: any) => e.code === 'SKIN_INVALID');
    assert.throws(() => validateSkinPng(Buffer.from('GIF89a........................................')), (e: any) => e.code === 'SKIN_INVALID');
    assert.throws(() => validateSkinPng(png(64, 64, 4)), (e: any) => e.code === 'SKIN_INVALID');
    const e = await skins.add('mi-skin.png', png(64, 64), 'slim');
    assert.equal(e.name, 'mi-skin');
    await skins.patch(e.id, { favorite: true });
    assert.equal((await skins.library())[0]!.favorite, true);
    const off = await accounts.addOffline('Alex');
    await assert.rejects(() => skins.apply(e.id, off.id), (x: any) => x.code === 'PREMIUM_REQUIRED');
    assert.equal(env.world.skinsUploaded.length, 0);
    const acc = await accounts.loginMicrosoft(fakeBrowser);
    const r = await skins.apply(e.id, acc.id);
    assert.ok(r.appliedAt > 0);
    assert.equal(env.world.skinsUploaded[0]!.variant, 'slim');
    assert.equal(accounts.get(acc.id)!.skin?.variant, 'slim', 'perfil actualizado con la respuesta oficial');
  } finally {
    await env.close();
  }
});
