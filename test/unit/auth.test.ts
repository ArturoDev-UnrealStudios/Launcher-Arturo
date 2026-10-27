import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeBrowser, servicesEnv, TEST_UUID } from '../helpers/mock';

test('Microsoft: login completo con PKCE, licencia verificada y perfil real', async () => {
  const env = await servicesEnv();
  try {
    const { accounts, settings } = env.services;
    const acc = await accounts.loginMicrosoft(fakeBrowser);
    assert.equal(acc.kind, 'microsoft');
    assert.equal(acc.premium, true);
    assert.equal(acc.uuid, TEST_UUID);
    assert.equal(acc.username, 'Notch');
    // Los tokens nunca se escriben en accounts.json ni en settings.json
    const onDisk = fs.readFileSync(path.join(env.userData, 'accounts.json'), 'utf8') + JSON.stringify(settings.get());
    for (const secret of ['MS_ACCESS', 'MS_REFRESH', 'MC_ACCESS_TOKEN_SECRET']) assert.ok(!onDisk.includes(secret), `fuga de ${secret}`);
    // Pero sí en el almacén seguro
    assert.ok(env.secrets.keys().some((k) => k.startsWith('ms-')));
    const id = await accounts.launchIdentity(acc.id);
    assert.equal(id.userType, 'msa');
    assert.equal(id.accessToken, 'MC_ACCESS_TOKEN_SECRET');
  } finally {
    await env.close();
  }
});

test('Microsoft: cuenta sin licencia no se crea ni obtiene privilegios', async () => {
  const env = await servicesEnv();
  try {
    env.world.ms.entitled = false;
    env.world.ms.profile = false;
    await assert.rejects(() => env.services.accounts.loginMicrosoft(fakeBrowser), (e: any) => e.code === 'AUTH_NO_LICENSE');
    assert.equal((await env.services.accounts.list()).length, 0);
    // Con licencia pero sin perfil creado
    env.world.ms.entitled = true;
    await assert.rejects(() => env.services.accounts.loginMicrosoft(fakeBrowser), (e: any) => e.code === 'AUTH_NO_PROFILE');
  } finally {
    await env.close();
  }
});

test('Microsoft: errores XSTS y cancelación', async () => {
  const env = await servicesEnv();
  try {
    env.world.ms.xstsErr = 2148916233;
    await assert.rejects(() => env.services.accounts.loginMicrosoft(fakeBrowser), (e: any) => e.code === 'AUTH_NO_XBOX_ACCOUNT');
    env.world.ms.xstsErr = 2148916238;
    await assert.rejects(() => env.services.accounts.loginMicrosoft(fakeBrowser), (e: any) => e.code === 'AUTH_XBOX_CHILD');
    env.world.ms.xstsErr = undefined;
    // El usuario cierra el navegador → se cancela desde el launcher
    const p = env.services.accounts.loginMicrosoft(async () => {
      setTimeout(() => env.services.accounts.cancelLogin(), 50);
    });
    await assert.rejects(() => p, (e: any) => e.code === 'AUTH_CANCELLED');
    // Callback con state manipulado
    const bad = env.services.accounts.loginMicrosoft(async (url) => {
      const r = await fetch(url, { redirect: 'manual' });
      const loc = new URL(r.headers.get('location')!);
      loc.searchParams.set('state', 'atacante');
      await fetch(loc);
    });
    await assert.rejects(() => bad, (e: any) => e.code === 'AUTH_DENIED');
  } finally {
    await env.close();
  }
});

test('Microsoft: sesión expirada se renueva con refresh token; refresh inválido exige login', async () => {
  const env = await servicesEnv();
  try {
    const { accounts } = env.services;
    const acc = await accounts.loginMicrosoft(fakeBrowser);
    // Se fuerza la caducidad del token de Minecraft
    const name = env.secrets.keys().find((k) => k.startsWith('ms-'))!;
    const sec = JSON.parse((await env.secrets.get(name))!);
    sec.mcExpiresAt = Date.now() - 1000;
    await env.secrets.set(name, JSON.stringify(sec));
    (accounts as any).live.clear();
    const before = env.world.ms.refreshCount;
    const t = await accounts.premiumToken(acc.id);
    assert.equal(t.token, 'MC_ACCESS_TOKEN_SECRET');
    assert.equal(env.world.ms.refreshCount, before + 1);

    // Refresh revocado por Microsoft
    sec.mcExpiresAt = Date.now() - 1000;
    await env.secrets.set(name, JSON.stringify({ ...JSON.parse((await env.secrets.get(name))!), mcExpiresAt: Date.now() - 1000 }));
    (accounts as any).live.clear();
    env.world.ms.tokenError = 'invalid_grant';
    await assert.rejects(() => accounts.premiumToken(acc.id), (e: any) => e.code === 'AUTH_EXPIRED');
    assert.equal(await env.secrets.get(name), undefined, 'credenciales eliminadas');
    const list = await accounts.list();
    assert.equal(list[0]!.status, 'needs-login');
    assert.equal(list[0]!.premium, false, 'sin credenciales válidas no hay privilegios premium');
  } finally {
    await env.close();
  }
});

test('Offline: separado de premium, sin privilegios y sin suplantación', async () => {
  const env = await servicesEnv();
  try {
    const { accounts, skins } = env.services;
    await assert.rejects(() => accounts.addOffline('a'), (e: any) => e.code === 'VALIDATION');
    await assert.rejects(() => accounts.addOffline('nombre con espacios'), (e: any) => e.code === 'VALIDATION');
    const off = await accounts.addOffline('Steve_01');
    assert.equal(off.premium, false);
    assert.equal(off.kind, 'offline');
    assert.notEqual(off.uuid, TEST_UUID);
    const ident = await accounts.launchIdentity(off.id);
    assert.equal(ident.userType, 'legacy');
    assert.equal(ident.premium, false);
    // Funciones premium rechazadas en la lógica (no solo en la interfaz)
    await assert.rejects(() => accounts.premiumToken(off.id), (e: any) => e.code === 'PREMIUM_REQUIRED');
    await assert.rejects(() => skins.apply('0123456789abcdef', off.id), (e: any) => e.code === 'PREMIUM_REQUIRED');
    // No se puede crear una identidad offline con el nombre de una cuenta premium guardada
    await accounts.loginMicrosoft(fakeBrowser);
    await assert.rejects(() => accounts.addOffline('notch'), (e: any) => e.code === 'CONFLICT');
    // Cerrar sesión elimina credenciales
    const ms = (await accounts.list()).find((a) => a.kind === 'microsoft')!;
    await accounts.logout(ms.id);
    assert.equal(env.secrets.keys().filter((k) => k.startsWith('ms-')).length, 0);
  } finally {
    await env.close();
  }
});
