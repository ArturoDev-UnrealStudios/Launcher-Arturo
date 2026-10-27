import { z } from 'zod';
import { AppError, isAppError } from '../../shared/errors';
import type { AccountSummary } from '../../shared/types';
import { Mutex, readJson, writeJson } from '../core/jsonStore';
import type { Logger } from '../core/logger';
import { offlineUuid } from '../security/crypto';
import type { SecretStore } from '../security/secureStore';
import type { MicrosoftOAuth } from './microsoft';
import type { McProfile, MinecraftServices } from './minecraftServices';

const AccountSchema = z.object({
  id: z.string(),
  kind: z.enum(['microsoft', 'offline']),
  username: z.string(),
  uuid: z.string(),
  premium: z.boolean(),
  skin: z.object({ url: z.string(), variant: z.enum(['classic', 'slim']) }).optional(),
  lastValidatedAt: z.number().optional(),
});
const FileSchema = z.object({ accounts: z.array(AccountSchema).default([]) });
type StoredAccount = z.infer<typeof AccountSchema>;

interface MsSecret {
  refreshToken: string;
  mcToken?: string;
  mcExpiresAt?: number;
}

export interface LaunchIdentity {
  username: string;
  uuid: string;
  accessToken: string;
  userType: 'msa' | 'legacy';
  premium: boolean;
  /** true si no se pudo renovar el token por falta de red (solo un jugador funcionará). */
  stale?: boolean;
}

export const OFFLINE_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

export class AccountManager {
  private accounts: StoredAccount[] = [];
  private readonly mutex = new Mutex();
  private loginAbort?: AbortController;
  /** Tokens de Minecraft vigentes en memoria. */
  private readonly live = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly file: string,
    private readonly secrets: SecretStore,
    private readonly oauth: MicrosoftOAuth,
    private readonly mc: MinecraftServices,
    private readonly log: Logger,
    private readonly onChange: () => void = () => {},
  ) {}

  async load(): Promise<void> {
    const { value } = await readJson(this.file, FileSchema, () => ({ accounts: [] }));
    this.accounts = value.accounts;
    // Una cuenta premium sin secreto recuperable necesita volver a iniciar sesión.
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, { accounts: this.accounts });
    this.onChange();
  }

  async list(): Promise<AccountSummary[]> {
    const out: AccountSummary[] = [];
    for (const a of this.accounts) {
      let status: AccountSummary['status'] = 'ok';
      if (a.kind === 'microsoft') {
        const secret = await this.readSecret(a.id);
        if (!secret) status = 'needs-login';
      }
      out.push({ ...a, premium: a.kind === 'microsoft' && a.premium && status === 'ok', status });
    }
    return out;
  }

  get(id: string): StoredAccount | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  private secretName(id: string): string {
    return `ms-${id.replace(/[^a-z0-9]/gi, '')}`;
  }

  private async readSecret(id: string): Promise<MsSecret | undefined> {
    const raw = await this.secrets.get(this.secretName(id));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as MsSecret;
    } catch {
      return undefined;
    }
  }

  private async writeSecret(id: string, s: MsSecret): Promise<void> {
    await this.secrets.set(this.secretName(id), JSON.stringify(s));
  }

  cancelLogin(): void {
    this.loginAbort?.abort();
  }

  /** Inicio de sesión interactivo. Solo se crea la cuenta si la licencia queda verificada. */
  async loginMicrosoft(openBrowser: (url: string) => Promise<void>): Promise<AccountSummary> {
    if (this.loginAbort) throw new AppError('CONFLICT', 'login en curso');
    this.loginAbort = new AbortController();
    try {
      const ms = await this.oauth.login(openBrowser, this.loginAbort.signal);
      const session = await this.mc.authenticate(ms.accessToken);
      return await this.mutex.run(async () => {
        const id = `ms:${session.profile.uuid.replace(/-/g, '')}`;
        await this.writeSecret(id, { refreshToken: ms.refreshToken, mcToken: session.accessToken, mcExpiresAt: session.expiresAt });
        this.live.set(id, { token: session.accessToken, expiresAt: session.expiresAt });
        const acc = this.upsertPremium(id, session.profile);
        await this.persist();
        this.log.info('Cuenta Microsoft verificada', { username: acc.username });
        return { ...acc, status: 'ok' as const };
      });
    } finally {
      this.loginAbort = undefined;
    }
  }

  private upsertPremium(id: string, p: McProfile): StoredAccount {
    const acc: StoredAccount = {
      id,
      kind: 'microsoft',
      username: p.name,
      uuid: p.uuid,
      premium: true,
      skin: p.skin,
      lastValidatedAt: Date.now(),
    };
    const i = this.accounts.findIndex((a) => a.id === id);
    if (i >= 0) this.accounts[i] = acc;
    else this.accounts.push(acc);
    return acc;
  }

  async addOffline(username: string): Promise<AccountSummary> {
    const name = username.trim();
    if (!OFFLINE_NAME_RE.test(name)) throw new AppError('VALIDATION', 'offline.username', { field: 'username' });
    return this.mutex.run(async () => {
      // Evita confundir una identidad offline con una cuenta premium guardada en este equipo.
      if (this.accounts.some((a) => a.kind === 'microsoft' && a.username.toLowerCase() === name.toLowerCase())) {
        throw new AppError('CONFLICT', 'offline.matchesPremium', { field: 'username' });
      }
      const id = `offline:${name.toLowerCase()}`;
      const existing = this.accounts.find((a) => a.id === id);
      if (existing) return { ...existing, status: 'ok' as const };
      const acc: StoredAccount = { id, kind: 'offline', username: name, uuid: offlineUuid(name), premium: false };
      this.accounts.push(acc);
      await this.persist();
      return { ...acc, status: 'ok' as const };
    });
  }

  /**
   * Devuelve un token de Minecraft válido para una cuenta premium, renovándolo si caduca en < 5 min.
   * Es la ÚNICA fuente de verdad del estado premium: lo usan skins, social y claves.
   */
  async premiumToken(id: string, opts: { allowStale?: boolean } = {}): Promise<{ token: string; profile: StoredAccount; stale: boolean }> {
    const acc = this.get(id);
    if (!acc || acc.kind !== 'microsoft') throw new AppError('PREMIUM_REQUIRED');
    const cached = this.live.get(id);
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return { token: cached.token, profile: acc, stale: false };

    return this.mutex.run(async () => {
      const secret = await this.readSecret(id);
      if (!secret) throw new AppError('AUTH_EXPIRED', 'sin credenciales');
      if (secret.mcToken && secret.mcExpiresAt && secret.mcExpiresAt - Date.now() > 5 * 60_000) {
        this.live.set(id, { token: secret.mcToken, expiresAt: secret.mcExpiresAt });
        return { token: secret.mcToken, profile: acc, stale: false };
      }
      try {
        const ms = await this.oauth.refresh(secret.refreshToken);
        const session = await this.mc.authenticate(ms.accessToken);
        if (session.profile.uuid !== acc.uuid) throw new AppError('AUTH_DENIED', 'el perfil cambió');
        await this.writeSecret(id, { refreshToken: ms.refreshToken, mcToken: session.accessToken, mcExpiresAt: session.expiresAt });
        this.live.set(id, { token: session.accessToken, expiresAt: session.expiresAt });
        const updated = this.upsertPremium(id, session.profile);
        await this.persist();
        return { token: session.accessToken, profile: updated, stale: false };
      } catch (e) {
        const offline = isAppError(e) && (e.code === 'NETWORK' || e.code === 'TIMEOUT');
        if (offline && opts.allowStale && secret.mcToken) {
          this.log.warn('Sin red: se usará el último token (solo un jugador)');
          return { token: secret.mcToken, profile: acc, stale: true };
        }
        if (isAppError(e) && (e.code === 'AUTH_EXPIRED' || e.code === 'AUTH_NO_LICENSE' || e.code === 'AUTH_DENIED')) {
          // Credenciales inválidas o licencia perdida → se eliminan y la cuenta deja de ser premium.
          await this.secrets.delete(this.secretName(id));
          this.live.delete(id);
          if (e.code === 'AUTH_NO_LICENSE') {
            const a = this.get(id);
            if (a) a.premium = false;
            await this.persist();
          } else this.onChange();
        }
        throw e;
      }
    });
  }

  async refresh(id: string): Promise<AccountSummary> {
    const acc = this.get(id);
    if (!acc) throw new AppError('NOT_FOUND');
    if (acc.kind === 'offline') return { ...acc, status: 'ok' };
    this.live.delete(id);
    const secret = await this.readSecret(id);
    if (secret) {
      delete secret.mcToken;
      delete secret.mcExpiresAt;
      await this.writeSecret(id, secret);
    }
    const r = await this.premiumToken(id);
    return { ...r.profile, status: 'ok' };
  }

  async updateSkinCache(id: string, skin: StoredAccount['skin']): Promise<void> {
    await this.mutex.run(async () => {
      const a = this.get(id);
      if (a) a.skin = skin;
      await this.persist();
    });
  }

  async launchIdentity(id: string): Promise<LaunchIdentity> {
    const acc = this.get(id);
    if (!acc) throw new AppError('NOT_FOUND', 'cuenta');
    if (acc.kind === 'offline') {
      return { username: acc.username, uuid: acc.uuid, accessToken: '0', userType: 'legacy', premium: false };
    }
    const t = await this.premiumToken(id, { allowStale: true });
    return { username: t.profile.username, uuid: t.profile.uuid, accessToken: t.token, userType: 'msa', premium: true, stale: t.stale };
  }

  /** Cierra sesión: borra credenciales cifradas y la cuenta. */
  async logout(id: string): Promise<void> {
    await this.mutex.run(async () => {
      this.live.delete(id);
      await this.secrets.delete(this.secretName(id));
      this.accounts = this.accounts.filter((a) => a.id !== id);
      await this.persist();
    });
  }
}
