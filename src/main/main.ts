import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog, Menu, net, nativeImage, nativeTheme, Notification, powerMonitor, protocol, safeStorage, session, shell, Tray } from 'electron';
import { brand } from '../shared/brand';
import { createLogger } from './core/logger';
import { registerIpc } from './ipc';
import { OsSecretStore } from './security/secureStore';
import { createServices, type ServiceDeps, type Services } from './services';

const APP_HOST = 'launcher';
const APP_ORIGIN = `app://${APP_HOST}`;
const isDev = !app.isPackaged;

app.setName(brand.productName);
if (process.platform === 'win32') app.setAppUserModelId(brand.appId);
// Permite ejecutar pruebas aisladas con un perfil temporal.
if (process.env.UNREAL_USER_DATA && isDev) app.setPath('userData', process.env.UNREAL_USER_DATA);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false } }]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
let services: Services | null = null;
let tray: Tray | null = null;
let quitting = false;

const rendererRoot = path.join(__dirname, '..', 'renderer');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

function registerAppProtocol(): void {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(rendererRoot, rel));
    if (!file.startsWith(rendererRoot + path.sep)) return new Response('forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, {
        headers: {
          'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
          'content-security-policy': CSP,
          'x-content-type-options': 'nosniff',
          'cross-origin-opener-policy': 'same-origin',
        },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

function createWindow(): BrowserWindow {
  const iconPath = path.join(rendererRoot, 'assets', 'icon.png');
  const w = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0b0b10',
    title: brand.productName,
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay: process.platform === 'win32' ? { color: '#00000000', symbolColor: '#c9c9d6', height: 40 } : undefined,
    frame: process.platform === 'darwin' ? undefined : process.platform === 'win32',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: isDev,
      backgroundThrottling: true,
    },
  });
  w.once('ready-to-show', () => {
    if (process.env.UNREAL_HIDDEN !== '1') w.show();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN)) e.preventDefault();
  });
  w.webContents.on('will-attach-webview', (e) => e.preventDefault());
  w.on('close', (e) => {
    if (!quitting && services?.settings.get().general.minimizeToTrayOnClose && tray) {
      e.preventDefault();
      w.hide();
    }
  });
  w.on('closed', () => {
    mainWindow = null;
  });
  void w.loadURL(`${APP_ORIGIN}/index.html`);
  return w;
}

function setupTray(): void {
  if (tray) return;
  const iconPath = path.join(rendererRoot, 'assets', 'tray.png');
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip(brand.productName);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir', click: () => (mainWindow ?? (mainWindow = createWindow())).show() },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => (mainWindow ?? (mainWindow = createWindow())).show());
}

/** Endpoints de prueba: solo en builds no empaquetadas (nunca en producción). */
function testEndpoints(): Pick<ServiceDeps, 'endpoints' | 'allowInsecureLocalhost'> {
  if (!isDev || !process.env.UNREAL_TEST_ENDPOINTS) return {};
  const e = JSON.parse(process.env.UNREAL_TEST_ENDPOINTS) as ServiceDeps['endpoints'];
  return { endpoints: e, allowInsecureLocalhost: true };
}

async function boot(): Promise<void> {
  const log = createLogger({ dir: path.join(app.getPath('userData'), 'logs'), level: 'info', console: isDev && process.env.UNREAL_QUIET !== '1' });
  log.info('Inicio', { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron });
  process.on('uncaughtException', (e) => log.error('uncaughtException', e));
  process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

  // Sin permisos de cámara, micrófono, notificaciones web, etc. para el contenido web.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  registerAppProtocol();

  const secrets = new OsSecretStore(path.join(app.getPath('userData'), 'secrets'), safeStorage, log.child('secrets'));
  const brandOverride = isDev && process.env.UNREAL_TEST_BRAND ? { ...brand, ...JSON.parse(process.env.UNREAL_TEST_BRAND) } : brand;
  services = await createServices({
    userData: app.getPath('userData'),
    appVersion: app.getVersion(),
    brand: brandOverride,
    secrets,
    // net.fetch usa la pila de red de Chromium (proxies del sistema, certificados del SO).
    fetch: isDev && process.env.UNREAL_TEST_ENDPOINTS ? globalThis.fetch.bind(globalThis) : (input, init) => net.fetch(String(input), init as RequestInit),
    log,
    ...testEndpoints(),
  });
  const s = services;
  nativeTheme.themeSource = s.settings.get().general.theme;
  s.settings.onChange((n) => {
    nativeTheme.themeSource = n.general.theme;
    if (n.general.minimizeToTrayOnClose) setupTray();
  });
  if (s.settings.get().general.minimizeToTrayOnClose) setupTray();

  registerIpc({
    services: s,
    getWindow: () => mainWindow,
    isTrustedSender: (e) => {
      const url = e.senderFrame?.url ?? '';
      return url.startsWith(`${APP_ORIGIN}/`) && e.sender === mainWindow?.webContents;
    },
    secretsPersistent: secrets.persistent,
    brand: brandOverride,
    openExternal: async (url) => {
      // Pruebas E2E (solo builds no empaquetadas): un "navegador" simulado sigue la redirección OAuth.
      if (isDev && process.env.UNREAL_TEST_ENDPOINTS && /^http:\/\/127\.0\.0\.1:/.test(url)) {
        const r = await fetch(url, { redirect: 'manual' });
        const loc = r.headers.get('location');
        if (loc) await fetch(loc);
        return;
      }
      await shell.openExternal(url);
    },
    relaunch: () => {
      app.relaunch();
      quitting = true;
      app.quit();
    },
    quit: () => {
      quitting = true;
      app.quit();
    },
  });

  mainWindow = createWindow();

  // Tareas de fondo: concesiones, actualizaciones, social, presencia.
  const reconciled = await s.updater.reconcile().catch(() => ({ result: 'none' as const }));
  if (reconciled.result === 'failed') s.notifications.push({ level: 'error', titleKey: 'notify.updateFailed', params: { version: reconciled.version ?? '' } });
  if (reconciled.result === 'ok') s.notifications.push({ level: 'success', titleKey: 'notify.updated', params: { version: app.getVersion() } });
  s.updater.schedule(s.settings.get().advanced.autoCheckUpdates);
  s.bus.on('update', (u) => {
    if (u.state === 'available' && s.settings.get().advanced.autoDownloadUpdates) void s.updater.download();
  });
  void s.keys.refresh().catch(() => undefined);
  setInterval(() => void s.keys.refresh().catch(() => undefined), 6 * 3600_000).unref();
  void s.social.start(s.activeAccountId());
  setInterval(() => s.social.setPresence(powerMonitor.getSystemIdleTime() > 300 ? 'away' : 'online'), 30_000).unref();

  s.bus.on('social', (e) => {
    if (e.type !== 'message') return;
    const st = s.settings.get();
    const me = s.social.getState().me?.uuid;
    if (!st.social.messageNotifications || !st.general.notifications || e.message.from === me) return;
    if (mainWindow?.isFocused()) return;
    const friend = s.social.getState().friends.find((f) => f.uuid === e.message.from);
    if (Notification.isSupported()) {
      const n = new Notification({ title: friend?.name ?? 'Mensaje nuevo', body: e.message.body.slice(0, 120), silent: false });
      n.on('click', () => mainWindow?.show());
      n.show();
    }
  });
  s.bus.on('notification', (n) => {
    if (n.level === 'error' && !mainWindow?.isFocused() && s.settings.get().general.notifications && Notification.isSupported()) {
      new Notification({ title: brand.productName, body: n.titleKey === 'notify.gameCrashed' ? `Minecraft se cerró inesperadamente (${n.params?.name ?? ''})` : 'Hay una notificación nueva' }).show();
    }
  });
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', (e) => {
  if (quitting || !services?.instances.anyRunning()) {
    quitting = true;
    services?.social.stop();
    return;
  }
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(mainWindow ?? undefined!, {
    type: 'question',
    buttons: ['Cerrar solo el launcher', 'Cerrar también Minecraft', 'Cancelar'],
    defaultId: 0,
    cancelId: 2,
    title: brand.productName,
    message: 'Minecraft sigue abierto.',
    detail: 'Puedes seguir jugando aunque cierres el launcher.',
  });
  if (choice === 2) return;
  if (choice === 1) services.instances.stopAll();
  quitting = true;
  services.social.stop();
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('activate', () => {
  if (!mainWindow && services) mainWindow = createWindow();
});

app.whenReady().then(boot).catch((e) => {
  dialog.showErrorBox(brand.productName, `No se pudo iniciar: ${(e as Error).message}`);
  app.quit();
});
