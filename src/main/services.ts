import os from 'node:os';
import path from 'node:path';
import type { BrandConfig } from '../shared/brand';
import { AccountManager } from './auth/accountManager';
import { MicrosoftOAuth, MS_ENDPOINTS, type MicrosoftEndpoints } from './auth/microsoft';
import { MinecraftServices, MC_ENDPOINTS, type McEndpoints } from './auth/minecraftServices';
import { AuthorityClient, SESSION_SERVER_JOIN } from './authority/authorityClient';
import { SettingsService } from './config/settingsService';
import { EventBus } from './core/events';
import { Http, setUserAgent, type FetchLike } from './core/http';
import type { Logger } from './core/logger';
import { Notifications } from './core/notifications';
import { buildPaths, type AppPaths } from './core/paths';
import { Downloader } from './download/downloader';
import { InstanceManager } from './instances/instanceManager';
import { KeyService } from './keys/keyService';
import { GameInstaller } from './minecraft/installer';
import { JavaManager } from './minecraft/java';
import { MetadataService, META_ENDPOINTS, type MetaEndpoints } from './minecraft/metadata';
import type { SecretStore } from './security/secureStore';
import { SkinService } from './skins/skinService';
import { SocialClient, type WsFactory } from './social/socialClient';
import { StorageService } from './storage/storageService';
import { Updater } from './updater/updater';

export interface ServiceDeps {
  userData: string;
  appVersion: string;
  brand: BrandConfig;
  secrets: SecretStore;
  fetch: FetchLike;
  log: Logger;
  /** Endpoints sustituibles (pruebas). */
  endpoints?: { ms?: MicrosoftEndpoints; mc?: McEndpoints; meta?: MetaEndpoints; adoptium?: string; github?: string; join?: string };
  wsFactory?: WsFactory;
  allowInsecureLocalhost?: boolean;
  platformKey?: string;
}

export interface Services {
  paths: AppPaths;
  bus: EventBus;
  http: Http;
  settings: SettingsService;
  accounts: AccountManager;
  mc: MinecraftServices;
  meta: MetadataService;
  downloader: Downloader;
  java: JavaManager;
  installer: GameInstaller;
  instances: InstanceManager;
  authority: AuthorityClient;
  keys: KeyService;
  skins: SkinService;
  social: SocialClient;
  storage: StorageService;
  updater: Updater;
  notifications: Notifications;
  log: Logger;
  activeAccountId(): string | undefined;
}

export async function createServices(d: ServiceDeps): Promise<Services> {
  setUserAgent(d.appVersion);
  const bus = new EventBus();
  const http = new Http(d.fetch);
  const log = d.log;

  // La ubicación de instancias y temporales depende de la configuración.
  const base = buildPaths(d.userData);
  const settings = new SettingsService(base.settingsFile, log.child('settings'));
  const s = await settings.load();
  log.setLevel(s.advanced.logLevel);
  const paths = buildPaths(d.userData, { instancesDir: s.minecraft.instancesDir, tempDir: s.downloads.tempDir });

  const notifications = new Notifications(paths.notificationsFile, bus);
  await notifications.load();

  const downloader = new Downloader(
    d.fetch,
    {
      concurrency: s.downloads.concurrency,
      bandwidthLimit: s.downloads.bandwidthLimitKiB * 1024,
      resume: s.downloads.resume,
      tempDir: paths.temp,
      allowInsecureLocalhost: d.allowInsecureLocalhost,
    },
    log.child('download'),
  );

  const oauth = new MicrosoftOAuth(d.brand.microsoft.clientId, http, log.child('oauth'), d.endpoints?.ms ?? MS_ENDPOINTS, d.brand.microsoft.redirectPath);
  const mc = new MinecraftServices(http, d.endpoints?.mc ?? MC_ENDPOINTS);
  const accounts = new AccountManager(paths.accountsFile, d.secrets, oauth, mc, log.child('accounts'), () => bus.emit('accounts'));
  await accounts.load();

  const meta = new MetadataService(http, paths.cache, paths.versions, log.child('meta'), d.endpoints?.meta ?? META_ENDPOINTS);
  const java = new JavaManager(paths.runtimes, http, downloader, log.child('java'), d.endpoints?.adoptium, d.allowInsecureLocalhost);
  const installer = new GameInstaller(paths, meta, downloader, java, http, log.child('installer'), undefined, { allowInsecureInstallerHosts: d.allowInsecureLocalhost });
  const instances = new InstanceManager(paths, installer, java, settings, accounts, bus, log.child('instances'), d.appVersion, d.brand.shortName);
  await instances.load();

  const authority = new AuthorityClient(d.brand.authority.url.replace(/\/$/, ''), http, accounts, d.secrets, log.child('authority'), d.endpoints?.join ?? SESSION_SERVER_JOIN);
  const keys = new KeyService(paths.keysFile, authority, instances, d.brand.authority.publicKeys, log.child('keys'));
  instances.setPrivateProvider(keys);
  await keys.load();

  const skins = new SkinService(paths.skinsDir, paths.skinsIndex, accounts, mc, http, log.child('skins'));
  await skins.load();

  const social = new SocialClient(authority, accounts, (e) => bus.emit('social', e), log.child('social'), d.wsFactory);
  const storage = new StorageService(paths, instances, log.child('storage'));
  bus.on('progress', (p) => p.state !== 'running' && storage.invalidate());

  const updater = new Updater(
    {
      owner: d.brand.github.owner,
      repo: d.brand.github.repo,
      manifestAsset: d.brand.github.updateManifestAsset,
      signatureAsset: d.brand.github.updateSignatureAsset,
      publicKeys: d.brand.updatePublicKeys,
      currentVersion: d.appVersion,
      platformKey: d.platformKey ?? `${process.platform}-${process.arch}`,
      dir: paths.updatesDir,
      apiBase: d.endpoints?.github,
      allowedDownloadHosts: d.allowInsecureLocalhost ? ['127.0.0.1', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] : undefined,
    },
    http,
    downloader,
    log.child('updater'),
    (u) => bus.emit('update', u),
    s.advanced.updateChannel,
  );

  // Reacciones a cambios de configuración que deben aplicarse en caliente.
  settings.onChange((next, prev) => {
    log.setLevel(next.advanced.logLevel);
    downloader.configure({
      concurrency: next.downloads.concurrency,
      bandwidthLimit: next.downloads.bandwidthLimitKiB * 1024,
      resume: next.downloads.resume,
    });
    if (next.advanced.updateChannel !== prev.advanced.updateChannel) updater.setChannel(next.advanced.updateChannel);
    if (next.advanced.autoCheckUpdates !== prev.advanced.autoCheckUpdates) updater.schedule(next.advanced.autoCheckUpdates);
    if (next.social.presence !== prev.social.presence || next.social.friendRequests !== prev.social.friendRequests) {
      void social.updatePrivacy(next.social.presence, next.social.friendRequests === 'everyone').catch(() => undefined);
    }
  });

  return {
    paths,
    bus,
    http,
    settings,
    accounts,
    mc,
    meta,
    downloader,
    java,
    installer,
    instances,
    authority,
    keys,
    skins,
    social,
    storage,
    updater,
    notifications,
    log,
    activeAccountId: () => settings.get().ui.activeAccountId,
  };
}

export function platformTotals() {
  return { totalMemMb: Math.floor(os.totalmem() / 1048576), tmp: path.resolve(os.tmpdir()) };
}
