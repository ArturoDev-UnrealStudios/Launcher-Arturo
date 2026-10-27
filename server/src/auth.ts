import crypto from 'node:crypto';
import type { ServerConfig } from './config';
import type { DB } from './db';
import { ApiError, dashUuid, randomToken, sha256Hex } from './util';

export interface Session {
  principal: string;
  kind: 'premium' | 'device';
  /** Para sesiones premium: uuid con guiones. */
  uuid?: string;
  name?: string;
  expiresAt: number;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Hash "serverId" de Minecraft (SHA-1 con signo, complemento a dos). */
export function minecraftDigest(input: string): string {
  const d = crypto.createHash('sha1').update(input).digest();
  const negative = (d[0]! & 0x80) !== 0;
  if (negative) {
    let carry = 1;
    for (let i = d.length - 1; i >= 0; i--) {
      const v = (~d[i]! & 0xff) + carry;
      d[i] = v & 0xff;
      carry = v >> 8;
    }
  }
  const hex = d.toString('hex').replace(/^0+/, '');
  return (negative ? '-' : '') + (hex || '0');
}

export const DEVICE_AUTH_PREFIX = 'unreal-device-auth:';

/**
 * Autenticación sin recibir nunca el token de Minecraft del usuario:
 *  1) el servidor emite un desafío (serverId);
 *  2) el launcher llama a sessionserver.mojang.com/session/minecraft/join con SU token;
 *  3) el servidor pregunta a Mojang hasJoined(username, serverId): solo responde con el perfil
 *     si quien hizo join posee esa cuenta con licencia. Es el mismo protocolo que usa cualquier
 *     servidor de Minecraft en modo online.
 */
export class AuthService {
  constructor(private readonly db: DB, private readonly cfg: ServerConfig, private readonly fetchImpl: FetchLike = fetch) {}

  createChallenge(): { id: string; serverId: string; nonce: string; expiresAt: number } {
    const id = randomToken(18);
    const nonce = randomToken(24);
    const serverId = minecraftDigest(`${id}:${nonce}`);
    const expiresAt = Date.now() + 2 * 60_000;
    this.db.prepare('DELETE FROM challenges WHERE expires_at < ?').run(Date.now());
    this.db.prepare('INSERT INTO challenges (id, server_id, nonce, expires_at) VALUES (?, ?, ?, ?)').run(id, serverId, nonce, expiresAt);
    return { id, serverId, nonce, expiresAt };
  }

  private consumeChallenge(id: unknown): { server_id: string; nonce: string } {
    if (typeof id !== 'string' || id.length > 64) throw new ApiError(400, 'VALIDATION');
    const row = this.db.prepare('SELECT server_id, nonce, expires_at, used FROM challenges WHERE id = ?').get(id) as
      | { server_id: string; nonce: string; expires_at: number; used: number }
      | undefined;
    if (!row || row.used || row.expires_at < Date.now()) throw new ApiError(401, 'AUTH_EXPIRED', 'desafío inválido');
    const r = this.db.prepare('UPDATE challenges SET used = 1 WHERE id = ? AND used = 0').run(id);
    if (Number(r.changes) !== 1) throw new ApiError(401, 'AUTH_EXPIRED', 'desafío ya usado');
    return row;
  }

  async verifyPremium(challengeId: unknown, username: unknown): Promise<{ token: string; session: Session }> {
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{1,16}$/.test(username)) throw new ApiError(400, 'VALIDATION', 'username');
    const ch = this.consumeChallenge(challengeId);
    const url = `${this.cfg.sessionServer}/session/minecraft/hasJoined?username=${encodeURIComponent(username)}&serverId=${encodeURIComponent(ch.server_id)}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new ApiError(503, 'NETWORK', 'sessionserver no disponible');
    }
    if (res.status === 204) throw new ApiError(401, 'AUTH_DENIED', 'join no verificado');
    if (!res.ok) throw new ApiError(503, 'NETWORK', `sessionserver ${res.status}`);
    const profile = (await res.json()) as { id?: string; name?: string };
    if (!profile.id || !profile.name || profile.name.toLowerCase() !== username.toLowerCase()) throw new ApiError(401, 'AUTH_DENIED');
    const uuid = dashUuid(profile.id);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO users (uuid, name, name_lower, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(uuid) DO UPDATE SET name = excluded.name, name_lower = excluded.name_lower, last_seen_at = excluded.last_seen_at`,
      )
      .run(uuid, profile.name, profile.name.toLowerCase(), now, now);
    return this.issue(`mc:${uuid}`, 'premium', this.cfg.premiumSessionTtlMs, { uuid, name: profile.name });
  }

  /** Identidad seudónima por dispositivo (modo offline): clave Ed25519 generada en el equipo. */
  verifyDevice(challengeId: unknown, publicKey: unknown, signature: unknown): { token: string; session: Session } {
    if (typeof publicKey !== 'string' || typeof signature !== 'string' || publicKey.length > 200 || signature.length > 200) {
      throw new ApiError(400, 'VALIDATION');
    }
    const ch = this.consumeChallenge(challengeId);
    let key: crypto.KeyObject;
    try {
      key = crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    } catch {
      throw new ApiError(400, 'VALIDATION', 'clave pública');
    }
    if (key.asymmetricKeyType !== 'ed25519') throw new ApiError(400, 'VALIDATION', 'tipo de clave');
    const ok = crypto.verify(null, Buffer.from(`${DEVICE_AUTH_PREFIX}${challengeId as string}:${ch.nonce}`), key, Buffer.from(signature, 'base64'));
    if (!ok) throw new ApiError(401, 'AUTH_DENIED', 'firma inválida');
    const principal = `dev:${sha256Hex(Buffer.from(publicKey, 'base64')).slice(0, 32)}`;
    return this.issue(principal, 'device', this.cfg.deviceSessionTtlMs);
  }

  private issue(principal: string, kind: Session['kind'], ttl: number, extra: { uuid?: string; name?: string } = {}): { token: string; session: Session } {
    const token = randomToken(32);
    const now = Date.now();
    const expiresAt = now + ttl;
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, principal, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(sha256Hex(token), principal, kind, now, expiresAt);
    return { token, session: { principal, kind, expiresAt, ...extra } };
  }

  authenticate(header: string | undefined): Session {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header ?? '');
    if (!m) throw new ApiError(401, 'AUTH_EXPIRED', 'sin sesión');
    return this.sessionFromToken(m[1]!);
  }

  sessionFromToken(token: string): Session {
    const row = this.db.prepare('SELECT principal, kind, expires_at FROM sessions WHERE token_hash = ?').get(sha256Hex(token)) as
      | { principal: string; kind: 'premium' | 'device'; expires_at: number }
      | undefined;
    if (!row || row.expires_at < Date.now()) throw new ApiError(401, 'AUTH_EXPIRED', 'sesión caducada');
    const s: Session = { principal: row.principal, kind: row.kind, expiresAt: row.expires_at };
    if (row.kind === 'premium') {
      s.uuid = row.principal.slice(3);
      const u = this.db.prepare('SELECT name FROM users WHERE uuid = ?').get(s.uuid) as { name: string } | undefined;
      s.name = u?.name;
    }
    return s;
  }

  logout(header: string | undefined): void {
    const m = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(header ?? '');
    if (m) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(m[1]!));
  }
}

export function requirePremium(s: Session): string {
  if (s.kind !== 'premium' || !s.uuid) throw new ApiError(403, 'PREMIUM_REQUIRED');
  return s.uuid;
}
