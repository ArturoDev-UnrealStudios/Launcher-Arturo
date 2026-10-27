import crypto from 'node:crypto';
import { AppError, ErrorCodes, type ErrorCode } from '../../shared/errors';
import type { AccountManager } from '../auth/accountManager';
import { httpError, type Http } from '../core/http';
import type { Logger } from '../core/logger';
import type { SecretStore } from '../security/secureStore';
import { undashUuid } from '../security/crypto';

export interface AuthoritySession {
  token: string;
  principal: string;
  kind: 'premium' | 'device';
  expiresAt: number;
}

export const SESSION_SERVER_JOIN = 'https://sessionserver.mojang.com/session/minecraft/join';

/**
 * Cliente de la autoridad (claves y social). Nunca envía el token de Minecraft a la autoridad:
 * para cuentas premium usa join (Mojang) + hasJoined (autoridad); para offline, una clave
 * Ed25519 de dispositivo guardada en el almacén seguro del sistema.
 */
export class AuthorityClient {
  private readonly sessions = new Map<string, AuthoritySession>();

  constructor(
    readonly baseUrl: string,
    private readonly http: Http,
    private readonly accounts: AccountManager,
    private readonly secrets: SecretStore,
    private readonly log: Logger,
    private readonly joinUrl = SESSION_SERVER_JOIN,
  ) {}

  get configured(): boolean {
    return /^https?:\/\//.test(this.baseUrl);
  }

  private secretName(accountId: string): string {
    return `authority-${crypto.createHash('sha256').update(accountId).digest('hex').slice(0, 24)}`;
  }

  async session(accountId: string, force = false): Promise<AuthoritySession> {
    if (!this.configured) throw new AppError('NOT_CONFIGURED', 'authority');
    if (!force) {
      const mem = this.sessions.get(accountId);
      if (mem && mem.expiresAt - Date.now() > 60_000) return mem;
      const stored = await this.secrets.get(this.secretName(accountId));
      if (stored) {
        try {
          const s = JSON.parse(stored) as AuthoritySession;
          if (s.expiresAt - Date.now() > 60_000) {
            this.sessions.set(accountId, s);
            return s;
          }
        } catch {
          /* regenerar */
        }
      }
    }
    const acc = this.accounts.get(accountId);
    if (!acc) throw new AppError('NOT_FOUND', 'cuenta');
    const s = acc.kind === 'microsoft' ? await this.premiumSession(accountId) : await this.deviceSession();
    this.sessions.set(accountId, s);
    await this.secrets.set(this.secretName(accountId), JSON.stringify(s));
    return s;
  }

  async forget(accountId: string): Promise<void> {
    const s = this.sessions.get(accountId);
    this.sessions.delete(accountId);
    await this.secrets.delete(this.secretName(accountId));
    if (s) {
      await this.http
        .request(`${this.baseUrl}/v1/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` } }, { retries: 0, timeoutMs: 5000 })
        .catch(() => undefined);
    }
  }

  private async challenge(): Promise<{ id: string; serverId: string; nonce: string }> {
    return this.http.json(`${this.baseUrl}/v1/auth/challenge`, { method: 'POST' });
  }

  private async premiumSession(accountId: string): Promise<AuthoritySession> {
    const { token, profile } = await this.accounts.premiumToken(accountId);
    const ch = await this.challenge();
    // join oficial de Mojang: prueba de posesión sin revelar el token a terceros.
    const join = await this.http.request(this.joinUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken: token, selectedProfile: undashUuid(profile.uuid), serverId: ch.serverId }),
    });
    if (join.status === 403 || join.status === 401) throw new AppError('AUTH_EXPIRED', 'join rechazado');
    if (!join.ok) throw httpError(this.joinUrl, join.status);
    const r = await this.http.json<{ token: string; expiresAt: number; uuid: string }>(`${this.baseUrl}/v1/auth/premium`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: ch.id, username: profile.username }),
    });
    return { token: r.token, principal: `mc:${r.uuid}`, kind: 'premium', expiresAt: r.expiresAt };
  }

  private async deviceKey(): Promise<crypto.KeyObject> {
    const stored = await this.secrets.get('device-key');
    if (stored) {
      try {
        return crypto.createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' });
      } catch {
        /* regenerar */
      }
    }
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    await this.secrets.set('device-key', privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'));
    return privateKey;
  }

  private async deviceSession(): Promise<AuthoritySession> {
    if (!this.secrets.persistent) this.log.warn('Identidad de dispositivo no persistente (sin almacén seguro)');
    const key = await this.deviceKey();
    const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64');
    const ch = await this.challenge();
    const signature = crypto.sign(null, Buffer.from(`unreal-device-auth:${ch.id}:${ch.nonce}`), key).toString('base64');
    const r = await this.http.json<{ token: string; expiresAt: number; principal: string }>(`${this.baseUrl}/v1/auth/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challengeId: ch.id, publicKey: pub, signature }),
    });
    return { token: r.token, principal: r.principal, kind: 'device', expiresAt: r.expiresAt };
  }

  /** Petición autenticada. Ante 401 renueva la sesión una vez. */
  async call<T>(accountId: string, method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await this.session(accountId, attempt > 0);
      const res = await this.http.request(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${s.token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      }, { retries: method === 'GET' ? 2 : 0 });
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => undefined);
        this.sessions.delete(accountId);
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as { error?: { code?: string } } & T;
      if (!res.ok) {
        const code = json?.error?.code;
        const known = code && (ErrorCodes as readonly string[]).includes(code) ? (code as ErrorCode) : undefined;
        throw new AppError(known ?? (res.status === 429 ? 'RATE_LIMITED' : res.status === 403 ? 'FORBIDDEN' : 'HTTP'), `${method} ${path.split('?')[0]} ${res.status}`, { status: res.status });
      }
      return json;
    }
    throw new AppError('AUTH_EXPIRED');
  }
}
