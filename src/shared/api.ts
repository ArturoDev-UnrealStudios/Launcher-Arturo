import type { Result } from './errors';
import type { Settings, SettingsPatch } from './settings';
import type {
  AccountSummary,
  AppInfo,
  ChatMessage,
  CleanupPlan,
  CleanupResult,
  DiskSummary,
  InstanceConfig,
  InstanceView,
  JavaInstallation,
  KeyRedemption,
  LargeFile,
  LoaderKind,
  LoaderVersionInfo,
  McVersionInfo,
  NewInstanceInput,
  NotificationItem,
  ReleaseNote,
  SkinEntry,
  SkinVariant,
  SocialEvent,
  SocialState,
  SocialUser,
  TaskProgress,
  UpdateInfo,
} from './types';

/**
 * Contrato IPC. Cada método se corresponde con un canal `invoke` validado en el proceso
 * principal con zod. La interfaz nunca recibe tokens ni claves completas.
 */
export interface LauncherApi {
  app: {
    info(): Promise<Result<AppInfo>>;
    openLogs(): Promise<Result<void>>;
    exportLogs(): Promise<Result<{ path: string } | null>>;
    openExternal(url: string): Promise<Result<void>>;
    notifications(): Promise<Result<NotificationItem[]>>;
    dismissNotification(id: string): Promise<Result<void>>;
    windowControl(action: 'minimize' | 'maximize' | 'close'): Promise<Result<void>>;
  };
  settings: {
    get(): Promise<Result<Settings>>;
    update(patch: SettingsPatch): Promise<Result<Settings>>;
    reset(): Promise<Result<Settings>>;
    chooseDirectory(purpose: 'instances' | 'temp'): Promise<Result<string | null>>;
    chooseJava(): Promise<Result<JavaInstallation | null>>;
  };
  accounts: {
    list(): Promise<Result<{ accounts: AccountSummary[]; activeId?: string }>>;
    loginMicrosoft(): Promise<Result<AccountSummary>>;
    cancelLogin(): Promise<Result<void>>;
    addOffline(username: string): Promise<Result<AccountSummary>>;
    setActive(id: string): Promise<Result<void>>;
    refresh(id: string): Promise<Result<AccountSummary>>;
    logout(id: string): Promise<Result<void>>;
  };
  instances: {
    list(): Promise<Result<InstanceView[]>>;
    create(input: NewInstanceInput): Promise<Result<InstanceView>>;
    update(id: string, patch: Partial<Pick<InstanceConfig, 'name' | 'cover' | 'memory' | 'jvmArgs' | 'java' | 'game'>>): Promise<Result<InstanceView>>;
    remove(id: string): Promise<Result<void>>;
    trustInstaller(id: string): Promise<Result<InstanceView>>;
    install(id: string): Promise<Result<void>>;
    repair(id: string): Promise<Result<{ repaired: number; checked: number }>>;
    verify(id: string): Promise<Result<{ ok: boolean; bad: number; checked: number }>>;
    cancelTask(id: string): Promise<Result<void>>;
    launch(id: string): Promise<Result<void>>;
    stop(id: string): Promise<Result<void>>;
    openFolder(id: string, sub?: 'mods' | 'resourcepacks' | 'saves' | 'logs' | 'root'): Promise<Result<void>>;
    exportInstance(id: string): Promise<Result<{ path: string } | null>>;
    importInstance(): Promise<Result<InstanceView | null>>;
    gameLog(id: string): Promise<Result<string[]>>;
    mcVersions(includeSnapshots: boolean): Promise<Result<McVersionInfo[]>>;
    loaderVersions(kind: LoaderKind, mcVersion: string): Promise<Result<LoaderVersionInfo[]>>;
    detectJava(): Promise<Result<JavaInstallation[]>>;
  };
  keys: {
    redeem(key: string): Promise<Result<KeyRedemption>>;
    history(): Promise<Result<KeyRedemption[]>>;
    refreshGrants(): Promise<Result<{ updated: number }>>;
  };
  skins: {
    library(): Promise<Result<SkinEntry[]>>;
    importFile(): Promise<Result<SkinEntry | null>>;
    importData(name: string, dataUrl: string, variant: SkinVariant): Promise<Result<SkinEntry>>;
    remove(id: string): Promise<Result<void>>;
    setFavorite(id: string, favorite: boolean): Promise<Result<void>>;
    setVariant(id: string, variant: SkinVariant): Promise<Result<void>>;
    apply(id: string): Promise<Result<{ appliedAt: number }>>;
    current(): Promise<Result<{ dataUrl?: string; variant: SkinVariant; url?: string } | null>>;
  };
  social: {
    state(): Promise<Result<SocialState>>;
    connect(): Promise<Result<void>>;
    search(query: string): Promise<Result<SocialUser[]>>;
    sendRequest(uuid: string): Promise<Result<void>>;
    respond(requestId: string, accept: boolean): Promise<Result<void>>;
    cancelRequest(requestId: string): Promise<Result<void>>;
    removeFriend(uuid: string): Promise<Result<void>>;
    block(uuid: string): Promise<Result<void>>;
    unblock(uuid: string): Promise<Result<void>>;
    report(uuid: string, reason: string, messageId?: string): Promise<Result<void>>;
    history(peer: string, before?: number): Promise<Result<{ messages: ChatMessage[]; hasMore: boolean }>>;
    send(peer: string, body: string, clientId: string): Promise<Result<void>>;
    typing(peer: string): Promise<Result<void>>;
    markRead(peer: string): Promise<Result<void>>;
  };
  storage: {
    summary(force?: boolean): Promise<Result<DiskSummary>>;
    largest(limit: number): Promise<Result<LargeFile[]>>;
    planCleanup(): Promise<Result<CleanupPlan>>;
    executeCleanup(planId: string): Promise<Result<CleanupResult>>;
    moveInstances(): Promise<Result<{ path: string } | null>>;
  };
  updates: {
    status(): Promise<Result<UpdateInfo>>;
    check(): Promise<Result<UpdateInfo>>;
    download(): Promise<Result<UpdateInfo>>;
    install(): Promise<Result<void>>;
    history(): Promise<Result<ReleaseNote[]>>;
  };
  on: {
    progress(cb: (p: TaskProgress) => void): () => void;
    instances(cb: (list: InstanceView[]) => void): () => void;
    accounts(cb: () => void): () => void;
    social(cb: (e: SocialEvent) => void): () => void;
    update(cb: (u: UpdateInfo) => void): () => void;
    notification(cb: (n: NotificationItem) => void): () => void;
    gameLog(cb: (e: { instanceId: string; lines: string[] }) => void): () => void;
  };
}

/** Canales de eventos main → renderer. */
export const EventChannels = {
  progress: 'evt:progress',
  instances: 'evt:instances',
  accounts: 'evt:accounts',
  social: 'evt:social',
  update: 'evt:update',
  notification: 'evt:notification',
  gameLog: 'evt:game-log',
} as const;

export type ApiNamespace = Exclude<keyof LauncherApi, 'on'>;

/** Lista explícita de canales invoke permitidos (la preload rechaza cualquier otro). */
export const InvokeChannels: { [N in ApiNamespace]: ReadonlyArray<keyof LauncherApi[N]> } = {
  app: ['info', 'openLogs', 'exportLogs', 'openExternal', 'notifications', 'dismissNotification', 'windowControl'],
  settings: ['get', 'update', 'reset', 'chooseDirectory', 'chooseJava'],
  accounts: ['list', 'loginMicrosoft', 'cancelLogin', 'addOffline', 'setActive', 'refresh', 'logout'],
  instances: [
    'list', 'create', 'update', 'remove', 'trustInstaller', 'install', 'repair', 'verify', 'cancelTask', 'launch', 'stop',
    'openFolder', 'exportInstance', 'importInstance', 'gameLog', 'mcVersions', 'loaderVersions', 'detectJava',
  ],
  keys: ['redeem', 'history', 'refreshGrants'],
  skins: ['library', 'importFile', 'importData', 'remove', 'setFavorite', 'setVariant', 'apply', 'current'],
  social: [
    'state', 'connect', 'search', 'sendRequest', 'respond', 'cancelRequest', 'removeFriend', 'block', 'unblock',
    'report', 'history', 'send', 'typing', 'markRead',
  ],
  storage: ['summary', 'largest', 'planCleanup', 'executeCleanup', 'moveInstances'],
  updates: ['status', 'check', 'download', 'install', 'history'],
};
