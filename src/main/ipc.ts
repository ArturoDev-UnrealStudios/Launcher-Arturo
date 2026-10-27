import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import { z, type ZodTypeAny } from 'zod';
import { EventChannels, type ApiNamespace } from '../shared/api';
import { isAuthorityConfigured, isGithubConfigured, type BrandConfig } from '../shared/brand';
import { AppError, toSerializedError, type Result } from '../shared/errors';
import type { AppInfo } from '../shared/types';
import { ZipWriter } from './core/archive';
import { redactString } from './core/logger';
import { exportInstance, planImport } from './instances/exportImport';
import { pngFromDataUrl } from './skins/skinService';
import { maxAllowedMemoryMb, totalMemoryMb } from './config/settingsService';
import { probeJava } from './minecraft/java';
import type { Services } from './services';

type Handler = (...args: never[]) => unknown;

const id = z.string().min(1).max(128);
const loaderKind = z.enum(['vanilla', 'fabric', 'forge', 'neoforge']);
const variant = z.enum(['classic', 'slim']);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export interface IpcContext {
  services: Services;
  getWindow: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  secretsPersistent: boolean;
  brand: BrandConfig;
  openExternal: (url: string) => Promise<void>;
  relaunch: () => void;
  quit: () => void;
}

export function registerIpc(ctx: IpcContext): void {
  const { services: s, brand } = ctx;
  const handle = <T extends ZodTypeAny>(ns: ApiNamespace, method: string, schema: T, fn: (...args: Extract<z.infer<T>, unknown[]>) => unknown) => {
    ipcMain.handle(`${ns}:${method}`, async (event, ...raw: unknown[]): Promise<Result<unknown>> => {
      if (!ctx.isTrustedSender(event)) return { ok: false, error: { code: 'FORBIDDEN' } };
      const parsed = schema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: { code: 'VALIDATION', detail: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') } };
      try {
        const value = await (fn as Handler)(...(parsed.data as unknown as never[]));
        return { ok: true, value };
      } catch (e) {
        const err = toSerializedError(e);
        if (err.code === 'UNKNOWN') s.log.error(`IPC ${ns}:${method}`, e);
        if (err.detail) err.detail = redactString(err.detail);
        return { ok: false, error: err };
      }
    });
  };
  const none = z.tuple([]);
  const win = () => ctx.getWindow() ?? undefined;
  const active = () => s.activeAccountId();

  // ------------------------------- app -------------------------------
  handle('app', 'info', none, (): AppInfo => ({
    version: app.getVersion(),
    productName: brand.productName,
    platform: process.platform,
    arch: process.arch,
    dataDir: s.paths.userData,
    secureStorage: ctx.secretsPersistent ? 'available' : 'unavailable',
    authorityConfigured: isAuthorityConfigured(brand),
    microsoftConfigured: /^[0-9a-f-]{36}$/i.test(brand.microsoft.clientId),
    updatesConfigured: isGithubConfigured(brand) && brand.updatePublicKeys.length > 0,
    totalMemMb: totalMemoryMb(),
    maxMemMb: maxAllowedMemoryMb(),
  }));
  handle('app', 'openLogs', none, async () => {
    await fsp.mkdir(s.paths.logs, { recursive: true });
    await shell.openPath(s.paths.logs);
  });
  handle('app', 'exportLogs', none, async () => {
    const r = await dialog.showSaveDialog(win()!, { defaultPath: `unreal-logs-${new Date().toISOString().slice(0, 10)}.zip`, filters: [{ name: 'ZIP', extensions: ['zip'] }] });
    if (r.canceled || !r.filePath) return null;
    const zip = new ZipWriter(r.filePath);
    for (const f of (await fsp.readdir(s.paths.logs).catch(() => [] as string[])).filter((x) => x.endsWith('.log'))) {
      // Segunda pasada de redacción por si un log antiguo contuviera algo sensible.
      const content = redactString(await fsp.readFile(path.join(s.paths.logs, f), 'utf8'));
      await zip.addBuffer(f, Buffer.from(content, 'utf8'));
    }
    await zip.addBuffer('system.txt', Buffer.from(`${brand.productName} ${app.getVersion()}\n${process.platform} ${process.arch}\nElectron ${process.versions.electron}\n`));
    await zip.close();
    return { path: r.filePath };
  });
  handle('app', 'openExternal', z.tuple([z.string().url().max(2048)]), async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new AppError('VALIDATION', 'solo https');
    await ctx.openExternal(u.toString());
  });
  handle('app', 'notifications', none, () => s.notifications.list());
  handle('app', 'dismissNotification', z.tuple([id]), (nid) => s.notifications.dismiss(nid));
  handle('app', 'windowControl', z.tuple([z.enum(['minimize', 'maximize', 'close'])]), (action) => {
    const w = win();
    if (!w) return;
    if (action === 'minimize') w.minimize();
    else if (action === 'maximize') (w.isMaximized() ? w.unmaximize() : w.maximize());
    else w.close();
  });

  // ------------------------------- settings -------------------------------
  const patchSchema = z.record(z.record(z.unknown()));
  handle('settings', 'get', none, () => s.settings.get());
  handle('settings', 'update', z.tuple([patchSchema]), async (patch) => {
    const before = s.settings.get();
    const next = await s.settings.update(patch as never);
    if (patch.general && 'launchOnStartup' in patch.general && process.platform !== 'linux') {
      app.setLoginItemSettings({ openAtLogin: next.general.launchOnStartup });
    }
    if (before.ui.activeAccountId !== next.ui.activeAccountId) await s.social.start(next.ui.activeAccountId);
    return next;
  });
  handle('settings', 'reset', none, () => s.settings.reset());
  handle('settings', 'chooseDirectory', z.tuple([z.enum(['instances', 'temp'])]), async (purpose) => {
    const r = await dialog.showOpenDialog(win()!, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (purpose === 'temp') await s.settings.update({ downloads: { tempDir: r.filePaths[0] } });
    return r.filePaths[0];
  });
  handle('settings', 'chooseJava', none, async () => {
    const r = await dialog.showOpenDialog(win()!, {
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : [],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const info = await probeJava(r.filePaths[0]);
    if (!info) throw new AppError('JAVA_NOT_FOUND', path.basename(r.filePaths[0]));
    return { ...info, source: 'custom' as const };
  });

  // ------------------------------- accounts -------------------------------
  handle('accounts', 'list', none, async () => ({ accounts: await s.accounts.list(), activeId: active() }));
  handle('accounts', 'loginMicrosoft', none, async () => {
    const acc = await s.accounts.loginMicrosoft((url) => ctx.openExternal(url));
    await s.settings.update({ ui: { activeAccountId: acc.id } });
    await s.social.start(acc.id);
    ctx.getWindow()?.focus();
    return acc;
  });
  handle('accounts', 'cancelLogin', none, () => s.accounts.cancelLogin());
  handle('accounts', 'addOffline', z.tuple([z.string().max(32)]), async (name) => {
    const acc = await s.accounts.addOffline(name);
    await s.settings.update({ ui: { activeAccountId: acc.id } });
    await s.social.start(acc.id);
    return acc;
  });
  handle('accounts', 'setActive', z.tuple([id]), async (aid) => {
    if (!s.accounts.get(aid)) throw new AppError('NOT_FOUND');
    await s.settings.update({ ui: { activeAccountId: aid } });
    await s.social.start(aid);
  });
  handle('accounts', 'refresh', z.tuple([id]), (aid) => s.accounts.refresh(aid));
  handle('accounts', 'logout', z.tuple([id]), async (aid) => {
    await s.authority.forget(aid).catch(() => undefined);
    await s.accounts.logout(aid);
    if (active() === aid) {
      const next = (await s.accounts.list())[0]?.id;
      await s.settings.update({ ui: { activeAccountId: next } });
      await s.social.start(next);
    }
  });

  // ------------------------------- instances -------------------------------
  const memory = z.object({ minMb: z.number().int(), maxMb: z.number().int() });
  handle('instances', 'list', none, () => s.instances.list());
  handle(
    'instances',
    'create',
    z.tuple([
      z.object({
        name: z.string().max(48),
        mcVersion: z.string().max(40),
        loader: z.object({ kind: loaderKind, version: z.string().max(80).optional(), installerTrusted: z.boolean().optional() }),
        cover: z.string().max(700_000).optional(),
        memoryMaxMb: z.number().int().optional(),
      }),
    ]),
    (input) => s.instances.create(input),
  );
  handle(
    'instances',
    'update',
    z.tuple([
      id,
      z
        .object({
          name: z.string().max(48).optional(),
          cover: z.string().max(700_000).optional(),
          memory: memory.optional(),
          jvmArgs: z.array(z.string().max(512)).max(64).optional(),
          java: z.object({ path: z.string().max(1024).optional(), major: z.number().int().optional() }).optional(),
          game: z.object({ width: z.number().int(), height: z.number().int(), fullscreen: z.boolean() }).partial().optional(),
        })
        .strict(),
    ]),
    (iid, patch) => s.instances.update(iid, patch as never),
  );
  handle('instances', 'remove', z.tuple([id]), (iid) => s.instances.remove(iid));
  handle('instances', 'trustInstaller', z.tuple([id]), (iid) => s.instances.trustInstaller(iid));
  handle('instances', 'install', z.tuple([id]), (iid) => {
    // Se lanza en segundo plano: el progreso llega por eventos.
    s.instances.install(iid).catch(() => undefined);
  });
  handle('instances', 'repair', z.tuple([id]), (iid) => s.instances.repair(iid));
  handle('instances', 'verify', z.tuple([id]), (iid) => s.instances.verify(iid));
  handle('instances', 'cancelTask', z.tuple([id]), (iid) => s.instances.cancelTask(iid));
  handle('instances', 'launch', z.tuple([id]), async (iid) => {
    await s.instances.launch(iid, active());
    if (s.settings.get().general.hideLauncherOnGameStart) ctx.getWindow()?.minimize();
  });
  handle('instances', 'stop', z.tuple([id]), (iid) => s.instances.stop(iid));
  handle('instances', 'openFolder', z.tuple([id, z.enum(['mods', 'resourcepacks', 'saves', 'logs', 'root']).optional()]), async (iid, sub) => {
    const dir = s.instances.gameDir(iid, sub);
    await fsp.mkdir(dir, { recursive: true });
    const err = await shell.openPath(dir);
    if (err) throw new AppError('NOT_FOUND', err);
  });
  handle('instances', 'exportInstance', z.tuple([id]), async (iid) => {
    const inst = s.instances.get(iid);
    const r = await dialog.showSaveDialog(win()!, {
      defaultPath: `${inst.name.replace(/[^\w.-]+/g, '_')}.unrealpack`,
      filters: [{ name: 'Unreal Pack', extensions: ['unrealpack'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await exportInstance(inst, s.instances.gameDir(iid), r.filePath);
    return { path: r.filePath };
  });
  handle('instances', 'importInstance', none, async () => {
    const r = await dialog.showOpenDialog(win()!, { properties: ['openFile'], filters: [{ name: 'Paquetes', extensions: ['unrealpack', 'mrpack', 'zip'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const plan = await planImport(r.filePaths[0], s.downloader);
    return s.instances.importPack(plan);
  });
  handle('instances', 'gameLog', z.tuple([id]), (iid) => s.instances.gameLog(iid).slice(-1500));
  handle('instances', 'mcVersions', z.tuple([z.boolean()]), (snap) => s.meta.mcVersions(snap));
  handle('instances', 'loaderVersions', z.tuple([loaderKind, z.string().max(40)]), (k, v) => s.meta.loaderVersions(k, v));
  handle('instances', 'detectJava', none, () => s.java.detect(true, s.settings.get().minecraft.javaPath ? [s.settings.get().minecraft.javaPath!] : []));

  // ------------------------------- keys -------------------------------
  handle('keys', 'redeem', z.tuple([z.string().max(64)]), (key) => s.keys.redeem(key, active()));
  handle('keys', 'history', none, () => s.keys.history());
  handle('keys', 'refreshGrants', none, () => s.keys.refresh());

  // ------------------------------- skins -------------------------------
  handle('skins', 'library', none, () => s.skins.library());
  handle('skins', 'importFile', none, async () => {
    const r = await dialog.showOpenDialog(win()!, { properties: ['openFile'], filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (r.canceled || !r.filePaths[0]) return null;
    const st = await fsp.stat(r.filePaths[0]);
    if (st.size > 256 * 1024) throw new AppError('SKIN_INVALID', 'tamaño', { reason: 'size' });
    const buf = await fsp.readFile(r.filePaths[0]);
    return s.skins.add(path.basename(r.filePaths[0]), buf, 'classic');
  });
  handle('skins', 'importData', z.tuple([z.string().max(64), z.string().max(400_000), variant]), (name, dataUrl, v) => s.skins.add(name, pngFromDataUrl(dataUrl), v));
  handle('skins', 'remove', z.tuple([id]), (sid) => s.skins.remove(sid));
  handle('skins', 'setFavorite', z.tuple([id, z.boolean()]), (sid, f) => s.skins.patch(sid, { favorite: f }));
  handle('skins', 'setVariant', z.tuple([id, variant]), (sid, v) => s.skins.patch(sid, { variant: v }));
  handle('skins', 'apply', z.tuple([id]), (sid) => s.skins.apply(sid, active()));
  handle('skins', 'current', none, () => s.skins.current(active()));

  // ------------------------------- social -------------------------------
  handle('social', 'state', none, () => s.social.getState());
  handle('social', 'connect', none, () => s.social.start(active()));
  handle('social', 'search', z.tuple([z.string().max(32)]), (q) => s.social.search(q));
  handle('social', 'sendRequest', z.tuple([uuid]), (u) => s.social.sendRequest(u));
  handle('social', 'respond', z.tuple([id, z.boolean()]), (rid, acc) => s.social.respond(rid, acc));
  handle('social', 'cancelRequest', z.tuple([id]), (rid) => s.social.cancelRequest(rid));
  handle('social', 'removeFriend', z.tuple([uuid]), (u) => s.social.removeFriend(u));
  handle('social', 'block', z.tuple([uuid]), (u) => s.social.block(u));
  handle('social', 'unblock', z.tuple([uuid]), (u) => s.social.unblock(u));
  handle('social', 'report', z.tuple([uuid, z.string().min(1).max(500), z.string().max(64).optional()]), (u, r, m) => s.social.report(u, r, m));
  handle('social', 'history', z.tuple([uuid, z.number().int().positive().optional()]), (p, b) => s.social.history(p, b));
  handle('social', 'send', z.tuple([uuid, z.string().min(1).max(8000), z.string().regex(/^[\w-]{1,64}$/)]), (p, body, cid) => s.social.send(p, body, cid));
  handle('social', 'typing', z.tuple([uuid]), (p) => {
    if (s.settings.get().social.typingIndicator) s.social.typing(p);
  });
  handle('social', 'markRead', z.tuple([uuid]), (p) => s.social.markRead(p));

  // ------------------------------- storage -------------------------------
  handle('storage', 'summary', z.tuple([z.boolean().optional()]), (force) => s.storage.summary(!!force));
  handle('storage', 'largest', z.tuple([z.number().int().min(1).max(200)]), (n) => s.storage.largest(n));
  handle('storage', 'planCleanup', none, () => s.storage.planCleanup());
  handle('storage', 'executeCleanup', z.tuple([z.string().uuid()]), (pid) => s.storage.executeCleanup(pid));
  handle('storage', 'moveInstances', none, async () => {
    const r = await dialog.showOpenDialog(win()!, { properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    await s.storage.moveInstances(r.filePaths[0], async (dir) => {
      await s.settings.update({ minecraft: { instancesDir: dir } });
    });
    // Los servicios toman la nueva ruta al reiniciar.
    setTimeout(() => ctx.relaunch(), 600);
    return { path: r.filePaths[0] };
  });

  // ------------------------------- updates -------------------------------
  handle('updates', 'status', none, () => s.updater.status);
  handle('updates', 'check', none, () => s.updater.check());
  handle('updates', 'download', none, () => s.updater.download());
  handle('updates', 'install', none, () => s.updater.install(() => ctx.quit()));
  handle('updates', 'history', none, () => s.updater.history());

  // ------------------------------- eventos main → renderer -------------------------------
  const forward = <K extends keyof typeof EventChannels>(key: K, channel: string) =>
    s.bus.on(key as never, ((...args: unknown[]) => {
      const w = ctx.getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
    }) as never);
  forward('progress', EventChannels.progress);
  forward('instances', EventChannels.instances);
  forward('accounts', EventChannels.accounts);
  forward('social', EventChannels.social);
  forward('update', EventChannels.update);
  forward('notification', EventChannels.notification);
  forward('gameLog', EventChannels.gameLog);
}
