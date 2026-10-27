/**
 * Prueba E2E de la aplicación Electron REAL (build de dist/) con Playwright.
 * Los servicios externos (Microsoft, Xbox, Mojang, Fabric, Adoptium) se simulan con
 * servidores locales; la autoridad es el servidor real de server/ arrancado en proceso.
 *
 *   node --import tsx test/e2e/ui.e2e.ts
 * Variables: ELECTRON_PATH (binario), SCREENSHOTS (carpeta de capturas).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { _electron as electron, type Page } from 'playwright';
import { createApp } from '../../server/src/app';
import { fakeJava, fakeWorld, tmpDir } from '../helpers/mock';

const root = path.resolve(__dirname, '../..');
const shots = process.env.SCREENSHOTS ?? path.join(root, 'test-results', 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

let currentPage: Page | undefined;
async function step(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`✔ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: (e as Error).message.split('\n')[0] });
    await currentPage?.screenshot({ path: path.join(shots, `FALLO-${name.replace(/[^\w]+/g, '_').slice(0, 40)}.png`) }).catch(() => undefined);
    console.log(`✘ ${name}: ${(e as Error).message.split('\n')[0]}`);
  }
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

async function main() {
  const world = await fakeWorld();
  const B = world.mock.base;
  // join → registro para hasJoined de la autoridad
  const joins = new Map<string, string>();
  world.mock.on('POST', '/session/minecraft/join', (_q, res, body) => {
    const j = JSON.parse(body.toString());
    joins.set(j.serverId, j.selectedProfile);
    res.writeHead(204).end();
  });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const authority = createApp(
    { host: '127.0.0.1', port: 0, dbPath: path.join(tmpDir(), 'e2e.db'), keyPepper: crypto.randomBytes(32), signingKey: privateKey, sessionServer: 'https://session.test', trustProxy: false, premiumSessionTtlMs: 3600_000, deviceSessionTtlMs: 3600_000, grantTtlMs: 86400_000, corsOrigins: [] },
    {
      log: () => {},
      fetch: (async (url: string) => {
        const u = new URL(url);
        const id = joins.get(u.searchParams.get('serverId')!);
        return id ? new Response(JSON.stringify({ id, name: u.searchParams.get('username') }), { status: 200 }) : new Response(null, { status: 204 });
      }) as never,
    },
  );
  await new Promise<void>((r) => authority.server.listen(0, '127.0.0.1', () => r()));
  const authorityUrl = `http://127.0.0.1:${(authority.server.address() as AddressInfo).port}`;
  authority.keys.upsertInstance({ id: 'evento-vip', name: 'Evento VIP', mcVersion: world.versionId, loader: { kind: 'vanilla' }, manifest: { version: '1.0.0', files: [] } });
  const [key] = authority.keys.createKeys('evento-vip', 1);

  const userData = tmpDir('e2e-userdata-');
  // Java falso compatible para que la instalación y el lanzamiento no dependan del sistema.
  const java = fakeJava(tmpDir('e2e-java-'), 21);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ minecraft: { javaPath: java, autoJava: false } }));

  const app = await electron.launch({
    executablePath: process.env.ELECTRON_PATH ?? require('electron'),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', root],
    env: {
      ...process.env,
      UNREAL_USER_DATA: userData,
      UNREAL_QUIET: '1',
      UNREAL_TEST_ENDPOINTS: JSON.stringify({
        ms: { authorize: `${B}/ms/authorize`, token: `${B}/ms/token` },
        mc: { xbl: `${B}/xbl`, xsts: `${B}/xsts`, mcLogin: `${B}/mc/login`, entitlements: `${B}/mc/entitlements`, profile: `${B}/mc/profile`, skins: `${B}/mc/skins` },
        meta: { versionManifest: `${B}/mc/game/version_manifest_v2.json`, fabricMeta: `${B}/fabric/v2`, forgeMaven: `${B}/forge`, forgePromotions: `${B}/forge/p.json`, neoforgeMaven: `${B}/neoforge`, resources: `${B}/resources` },
        adoptium: `${B}/adoptium/v3`,
        github: `${B}/gh`,
        join: `${B}/session/minecraft/join`,
      }),
      UNREAL_TEST_BRAND: JSON.stringify({
        microsoft: { clientId: '00000000-0000-4000-8000-000000000000', redirectPath: '/auth/callback' },
        authority: { url: authorityUrl, publicKeys: [publicKey.export({ format: 'der', type: 'spki' }).toString('base64')] },
      }),
    },
  });
  const page = await app.firstWindow();
  currentPage = page;
  const consoleErrors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForSelector('.sidebar');

  await step('Inicio vacío con acción útil', async () => {
    await page.getByRole('heading', { name: 'Aún no tienes instancias' }).waitFor();
    await shot(page, '01-inicio-vacio');
  });

  await step('Navegación: las 8 secciones responden', async () => {
    for (const name of ['Instancias', 'Agregar clave', 'Skins', 'Social', 'Almacenamiento', 'Configuración']) {
      await page.locator('.nav-item', { hasText: name }).click();
      await page.getByRole('heading', { level: 1, name }).waitFor({ timeout: 5000 });
    }
    await page.locator('.account-chip').click();
    await page.getByRole('heading', { level: 1, name: 'Perfil y cuenta' }).waitFor();
    await page.locator('.nav-item', { hasText: 'Inicio' }).click();
  });

  await step('Perfil offline: validación y creación', async () => {
    await page.locator('.account-chip').click();
    await page.fill('#off', 'a b');
    await page.getByRole('alert').first().waitFor();
    assert.ok(await page.getByRole('button', { name: 'Crear perfil offline' }).isDisabled());
    await page.fill('#off', 'Steve_Test');
    await page.getByRole('button', { name: 'Crear perfil offline' }).click();
    await page.getByText('Identidad no verificada').first().waitFor();
    await shot(page, '02-perfil-offline');
  });

  await step('Funciones premium bloqueadas en offline (skins y social)', async () => {
    await page.locator('.nav-item', { hasText: 'Skins' }).click();
    await page.getByText('Las skins personalizadas requieren una cuenta Microsoft').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Subir PNG' }).count(), 0);
    await page.locator('.nav-item', { hasText: 'Social' }).click();
    await page.getByText('Amigos y chat requieren una cuenta Microsoft').waitFor();
  });

  await step('Crear instancia: formulario validado y descarga con progreso real', async () => {
    await page.locator('.nav-item', { hasText: 'Instancias' }).click();
    await page.getByRole('button', { name: 'Nueva instancia' }).first().click();
    const create = page.getByRole('dialog').getByRole('button', { name: 'Crear instancia' });
    assert.ok(await create.isDisabled(), 'sin nombre no se puede crear');
    await page.fill('#ni-name', 'Supervivencia');
    await page.locator('#ni-ver').selectOption(world.versionId);
    await shot(page, '03-nueva-instancia');
    await create.click();
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.locator('.play', { hasText: 'Jugar' }).waitFor({ timeout: 30000 });
    await shot(page, '04-instancia-instalada');
  });

  await step('Jugar: lanza el proceso de Java y registra la salida', async () => {
    await page.locator('.play', { hasText: 'Jugar' }).click();
    await page.getByRole('tab', { name: 'Registro del juego' }).click();
    await page.locator('.log-view', { hasText: 'Setting user' }).waitFor({ timeout: 10000 });
    const log = await page.locator('.log-view').innerText();
    assert.ok(!log.includes('MC_ACCESS_TOKEN_SECRET'));
    await shot(page, '05-registro-juego');
  });

  await step('Validación de memoria y argumentos JVM prohibidos', async () => {
    await page.getByRole('tab', { name: 'Rendimiento' }).click();
    await page.fill('#d-jvm', '-javaagent:malicioso.jar');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await page.getByText('Argumentos JVM no permitidos').waitFor();
    await page.fill('#d-jvm', '-XX:+UseG1GC');
    await page.getByRole('button', { name: 'Guardar cambios' }).click();
    await page.getByText('Cambios guardados').waitFor();
  });

  await step('Inicio con instancia: escena, estado y disco', async () => {
    await page.locator('.nav-item', { hasText: 'Inicio' }).click();
    await page.locator('.hero-title', { hasText: 'Supervivencia' }).waitFor();
    await page.getByText('libres de').waitFor({ timeout: 10000 });
    await shot(page, '06-inicio');
  });

  await step('Login Microsoft (PKCE) y licencia verificada', async () => {
    await page.locator('.account-chip').click();
    await page.getByRole('button', { name: 'Iniciar sesión con Microsoft' }).click();
    await page.getByText('Licencia verificada').first().waitFor({ timeout: 15000 });
    await page.locator('.account-row', { hasText: 'Notch' }).waitFor();
    await shot(page, '07-perfil-premium');
  });

  await step('Agregar clave: inválida, válida y desbloqueo de instancia privada', async () => {
    await page.locator('.nav-item', { hasText: 'Agregar clave' }).click();
    await page.fill('#key', 'UNRL-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
    await page.getByRole('button', { name: 'Canjear clave' }).click();
    await page.getByText('La clave no es válida').waitFor();
    await page.fill('#key', key!);
    await page.getByRole('button', { name: 'Canjear clave' }).click();
    await page.getByText('Instancia desbloqueada').waitFor({ timeout: 10000 });
    await page.getByRole('heading', { name: 'Evento VIP' }).waitFor();
    await shot(page, '08-clave-canjeada');
  });

  await step('Skins: visor 3D, carga validada y publicación premium', async () => {
    await page.locator('.nav-item', { hasText: 'Skins' }).click();
    await page.locator('.viewer canvas').waitFor();
    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#3aa0ff';
      g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#ffcc66';
      g.fillRect(8, 8, 8, 8);
      return c.toDataURL('image/png');
    });
    const buffer = Buffer.from(png.split(',')[1]!, 'base64');
    await page.locator('.dropzone').dispatchEvent('drop', {
      dataTransfer: await page.evaluateHandle(({ b64 }) => {
        const dt = new DataTransfer();
        const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        dt.items.add(new File([bin], 'azul.png', { type: 'image/png' }));
        return dt;
      }, { b64: buffer.toString('base64') }),
    });
    await page.locator('.skin-tile', { hasText: 'azul' }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Aplicar a mi cuenta' }).click();
    await page.getByText('Skin aplicada en tu perfil de Minecraft').waitFor({ timeout: 10000 });
    assert.equal(world.skinsUploaded.length, 1);
    await shot(page, '09-skins');
  });

  await step('Social premium: conectado con la autoridad', async () => {
    await page.locator('.nav-item', { hasText: 'Social' }).click();
    await page.getByRole('tab', { name: 'Buscar' }).waitFor();
    await page.getByText('Aún no tienes amigos').first().waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('Sin conexión con el servicio social').count(), 0);
    await page.getByRole('tab', { name: 'Buscar' }).click();
    await page.fill('input[aria-label="Buscar jugadores"]', 'Notch');
    await page.keyboard.press('Enter');
    await page.getByText('Sin resultados').waitFor({ timeout: 5000 }); // uno mismo no aparece en la búsqueda
    await shot(page, '10-social');
  });

  await step('Almacenamiento con datos reales y limpieza segura', async () => {
    await page.locator('.nav-item', { hasText: 'Almacenamiento' }).click();
    await page.getByText('Capacidad total').waitFor();
    await page.locator('.table', { hasText: 'Supervivencia' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: 'Revisar limpieza' }).click();
    await page.getByRole('dialog').waitFor();
    await shot(page, '11-almacenamiento-limpieza');
    await page.getByRole('dialog').getByRole('button', { name: 'Cancelar' }).click();
  });

  await step('Configuración persiste: tema claro e idioma', async () => {
    await page.locator('.nav-item', { hasText: 'Configuración' }).click();
    await page.getByRole('button', { name: 'Claro' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await shot(page, '12-configuracion-claro');
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    assert.equal(saved.general.theme, 'light');
    await page.getByRole('button', { name: 'English' }).click();
    await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor();
    await page.getByRole('button', { name: 'Español' }).click();
    await page.getByRole('button', { name: 'Oscuro' }).click();
  });

  await step('Modal de confirmación accesible (Escape y foco)', async () => {
    await page.locator('.nav-item', { hasText: 'Instancias' }).click();
    await page.locator('.inst-card', { hasText: 'Supervivencia' }).click();
    await page.getByRole('tab', { name: 'Avanzado' }).click();
    await page.getByRole('button', { name: 'Eliminar instancia' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const focusedInside = await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'));
    assert.ok(focusedInside, 'el foco entra en el modal');
    await shot(page, '13-confirmar-eliminar');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  });

  await step('Ventana pequeña: diseño adaptable sin desbordes', async () => {
    await page.setViewportSize({ width: 980, height: 640 });
    await page.locator('.nav-item', { hasText: 'Inicio' }).click();
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert.equal(overflow, false);
    await shot(page, '14-ventana-pequena');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('Sin errores de renderizado en consola', async () => {
    const relevant = consoleErrors.filter((e) => !/Autofill|DevTools|net::ERR_/.test(e));
    assert.deepEqual(relevant, []);
  });

  await app.close();
  await authority.close();
  await world.mock.close();
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(shots, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`\nE2E: ${results.length - failed.length}/${results.length} pasos correctos`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
