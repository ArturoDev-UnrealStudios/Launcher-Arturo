/** Modelos de datos compartidos (sin dependencias de Node ni del DOM). */

export type AccountKind = 'microsoft' | 'offline';

export interface AccountSummary {
  id: string;
  kind: AccountKind;
  username: string;
  /** UUID con guiones. En offline es el UUID v3 estándar "OfflinePlayer:<nombre>". */
  uuid: string;
  /** Solo verdadero si la licencia de Java Edition fue verificada por Minecraft Services. */
  premium: boolean;
  status: 'ok' | 'needs-login' | 'expired';
  skin?: { url: string; variant: SkinVariant };
  lastValidatedAt?: number;
}

export type SkinVariant = 'classic' | 'slim';

export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge';

export type InstallState = 'not-installed' | 'installing' | 'installed' | 'needs-repair';

export type AccessState =
  | { kind: 'public' }
  | {
      kind: 'private';
      /** Concesión firmada por la autoridad (ver keys). */
      grantId: string;
      status: 'granted' | 'expired' | 'revoked' | 'pending';
      expiresAt?: number;
    };

export interface InstanceConfig {
  id: string;
  name: string;
  /** Clave de portada integrada ("grass", "nether"...) o data URL PNG/JPEG (<512 KB). */
  cover: string;
  mcVersion: string;
  /** installerTrusted: el usuario aceptó ejecutar el instalador oficial de Forge/NeoForge. */
  loader: { kind: LoaderKind; version?: string; installerTrusted?: boolean };
  java: { path?: string; major?: number };
  memory: { minMb: number; maxMb: number };
  jvmArgs: string[];
  game: { width: number; height: number; fullscreen: boolean };
  createdAt: number;
  lastPlayedAt?: number;
  installState: InstallState;
  /** La última instalación se interrumpió (cierre, cancelación o error de red): se puede reanudar. */
  installInterrupted?: boolean;
  access: AccessState;
  /** Para instancias privadas: manifiesto remoto ya verificado (archivos extra). */
  privateManifest?: { url: string; sha256: string; version: string };
  /** id de la versión resultante (p. ej. "fabric-loader-0.16.9-1.21.1"). */
  resolvedVersionId?: string;
  lastError?: { code: string; at: number; detail?: string };
}

export interface InstanceView extends InstanceConfig {
  running: boolean;
  busy: boolean;
  /** Acción principal del botón JUGAR calculada a partir del estado real. */
  primaryAction: 'play' | 'install' | 'repair' | 'resume' | 'locked' | 'running' | 'busy';
  pendingResume: boolean;
}

export interface NewInstanceInput {
  name: string;
  mcVersion: string;
  loader: { kind: LoaderKind; version?: string; installerTrusted?: boolean };
  cover?: string;
  memoryMaxMb?: number;
}

export interface McVersionInfo {
  id: string;
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha';
  releaseTime: string;
}

export interface LoaderVersionInfo {
  version: string;
  stable: boolean;
}

export interface TaskProgress {
  taskId: string;
  instanceId?: string;
  kind: 'install' | 'repair' | 'verify' | 'java' | 'update' | 'import' | 'export';
  stage: string;
  /** Archivos completados / totales (si se conocen). */
  filesDone: number;
  filesTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** bytes/s medidos en la ventana reciente. */
  speed: number;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  error?: { code: string; detail?: string };
}

export interface JavaInstallation {
  path: string;
  major: number;
  version: string;
  vendor?: string;
  arch?: string;
  source: 'system' | 'managed' | 'custom';
}

export interface DiskSummary {
  measuredAt: number;
  drive: { path: string; total: number; free: number; used: number };
  launcher: { total: number; instances: number; shared: number; runtimes: number; cache: number; temp: number; logs: number; skins: number };
  instances: Array<{
    id: string;
    name: string;
    total: number;
    mods: number;
    resourcepacks: number;
    saves: number;
    other: number;
  }>;
}

export interface LargeFile {
  path: string;
  size: number;
  category: 'instance' | 'shared' | 'runtime' | 'cache' | 'temp' | 'log' | 'other';
}

export interface CleanupPlan {
  planId: string;
  items: Array<{ path: string; size: number; reason: 'cache' | 'temp' | 'old-log' | 'partial-download' }>;
  estimatedBytes: number;
}

export interface CleanupResult {
  freedBytes: number;
  removed: number;
  failed: number;
}

export interface SkinEntry {
  id: string;
  name: string;
  variant: SkinVariant;
  /** data URL PNG validado (64x64 o 64x32). */
  dataUrl: string;
  favorite: boolean;
  addedAt: number;
  lastAppliedAt?: number;
}

export interface KeyRedemption {
  instanceId: string;
  instanceName: string;
  mcVersion: string;
  loader: { kind: LoaderKind; version?: string };
  expiresAt?: number;
  redeemedAt: number;
  keyHint: string;
}

export interface UpdateInfo {
  state: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error' | 'disabled';
  currentVersion: string;
  channel: 'stable' | 'beta';
  latest?: { version: string; notes: string; publishedAt: string; size: number };
  progress?: { bytesDone: number; bytesTotal: number };
  error?: { code: string; detail?: string };
  checkedAt?: number;
}

export interface ReleaseNote {
  version: string;
  name: string;
  body: string;
  publishedAt: string;
  prerelease: boolean;
  url: string;
}

// ---------------------------- Social ----------------------------

export type Presence = 'online' | 'away' | 'offline';

export interface SocialUser {
  uuid: string;
  name: string;
}

export interface Friend extends SocialUser {
  presence: Presence;
  lastSeenAt?: number;
  unread: number;
}

export interface FriendRequest extends SocialUser {
  id: string;
  direction: 'incoming' | 'outgoing';
  createdAt: number;
}

export interface ChatMessage {
  id: string;
  /** id temporal del cliente para casar el ack. */
  clientId?: string;
  from: string;
  to: string;
  body: string;
  sentAt: number;
  deliveredAt?: number;
  state: 'sending' | 'sent' | 'delivered' | 'failed';
}

export interface SocialState {
  connection: 'disabled' | 'connecting' | 'online' | 'offline' | 'unauthorized';
  me?: SocialUser;
  friends: Friend[];
  requests: FriendRequest[];
  blocked: SocialUser[];
}

export type SocialEvent =
  | { type: 'state'; state: SocialState }
  | { type: 'message'; message: ChatMessage }
  | { type: 'ack'; clientId: string; message: ChatMessage }
  | { type: 'delivered'; id: string; peer: string; at: number }
  | { type: 'typing'; from: string }
  | { type: 'send-failed'; clientId: string; code: string };

export interface AppInfo {
  version: string;
  productName: string;
  platform: string;
  arch: string;
  dataDir: string;
  secureStorage: 'available' | 'unavailable';
  authorityConfigured: boolean;
  microsoftConfigured: boolean;
  updatesConfigured: boolean;
  totalMemMb: number;
  /** Máximo de RAM asignable recomendado (deja margen al sistema). */
  maxMemMb: number;
}

export interface NotificationItem {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  titleKey: string;
  bodyKey?: string;
  params?: Record<string, string | number>;
  at: number;
}
