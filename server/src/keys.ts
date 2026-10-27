import crypto from 'node:crypto';
import type { ServerConfig } from './config';
import { tx, type DB } from './db';
import { ApiError, canonicalJson, newId, RateLimiter, sha256Hex, sign } from './util';

/**
 * Claves de canje: "UNRL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" (25 símbolos base32 = 125 bits).
 * El servidor solo guarda HMAC-SHA256(pepper, clave): ni la base de datos ni los logs contienen claves.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const KEY_RE = /^UNRL(?:-[A-Z2-7]{5}){5}$/;

export function generateKey(): string {
  const bytes = crypto.randomBytes(25);
  let s = '';
  for (let i = 0; i < 25; i++) s += B32[bytes[i]! & 31];
  return `UNRL-${s.match(/.{5}/g)!.join('-')}`;
}

export function normalizeKey(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 64) return null;
  const k = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!k.startsWith('UNRL')) return null;
  // Errores de transcripción habituales: base32 no usa 0, 1 ni 8.
  const body = k.slice(4).replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (!/^[A-Z2-7]{25}$/.test(body)) return null;
  return `UNRL-${body.match(/.{5}/g)!.join('-')}`;
}

export function keyVerifier(pepper: Buffer, key: string): string {
  return crypto.createHmac('sha256', pepper).update(key).digest('hex');
}

export interface GrantPayload {
  v: 1;
  id: string;
  instanceId: string;
  principal: string;
  issuedAt: number;
  expiresAt: number;
  instance: { name: string; mcVersion: string; loader: { kind: string; version?: string } };
  manifest: { sha256: string; version: string };
}

export interface SignedGrant {
  payload: string;
  signature: string;
}

class KeyFail extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export class KeyService {
  /** 5 fallos / 15 min por identidad; 25 fallos / 15 min por IP. */
  private readonly failuresByPrincipal = new RateLimiter(5, 15 * 60_000);
  private readonly failuresByIp = new RateLimiter(25, 15 * 60_000);

  constructor(private readonly db: DB, private readonly cfg: ServerConfig) {}

  private event(type: string, principal: string | null, ip: string, detail: string) {
    this.db
      .prepare('INSERT INTO security_events (at, type, principal, ip_hash, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), type, principal, sha256Hex(`ip:${ip}`).slice(0, 16), detail.slice(0, 200));
  }

  redeem(principal: string, rawKey: unknown, ip: string): SignedGrant {
    if (this.failuresByPrincipal.blocked(principal) || this.failuresByIp.blocked(ip)) {
      this.event('key.rate_limited', principal, ip, '');
      throw new ApiError(429, 'RATE_LIMITED');
    }
    const fail = (status: number, code: string, hint: string) => {
      this.failuresByPrincipal.hit(principal);
      this.failuresByIp.hit(ip);
      this.event(`key.${code.toLowerCase()}`, principal, ip, hint);
      return new ApiError(status, code);
    };
    const key = normalizeKey(rawKey);
    if (!key) throw fail(400, 'KEY_INVALID', 'formato');
    const hint = key.slice(0, 10);
    const verifier = keyVerifier(this.cfg.keyPepper, key);

    let grantId: string;
    try {
      grantId = tx(this.db, () => this.redeemTx(principal, verifier));
    } catch (e) {
      // El evento de seguridad se registra FUERA de la transacción revertida.
      if (e instanceof KeyFail) throw fail(e.status, e.code, hint);
      throw e;
    }
    this.failuresByPrincipal.reset(principal);
    this.event('key.redeemed', principal, ip, hint);
    return this.signGrant(grantId)!;
  }

  private redeemTx(principal: string, verifier: string): string {
    const fail = (status: number, code: string) => new KeyFail(status, code);
    {
      const k = this.db.prepare('SELECT id, instance_id, max_uses, uses, expires_at, revoked_at FROM keys WHERE verifier = ?').get(verifier) as
        | { id: string; instance_id: string; max_uses: number; uses: number; expires_at: number | null; revoked_at: number | null }
        | undefined;
      if (!k) throw fail(404, 'KEY_INVALID');
      if (k.revoked_at) throw fail(410, 'KEY_REVOKED');
      if (k.expires_at && k.expires_at < Date.now()) throw fail(410, 'KEY_EXPIRED');
      const prior = this.db.prepare('SELECT id FROM redemptions WHERE key_id = ? AND principal = ?').get(k.id, principal);
      if (!prior) {
        if (k.uses >= k.max_uses) throw fail(409, k.max_uses === 1 ? 'KEY_ALREADY_USED' : 'KEY_EXHAUSTED');
        // Incremento condicional: aunque dos canjes compitieran, solo uno puede superar el límite.
        const upd = this.db.prepare('UPDATE keys SET uses = uses + 1 WHERE id = ? AND uses < max_uses').run(k.id);
        if (Number(upd.changes) !== 1) throw fail(409, 'KEY_ALREADY_USED');
        this.db.prepare('INSERT INTO redemptions (id, key_id, principal, instance_id, created_at) VALUES (?, ?, ?, ?, ?)').run(newId(), k.id, principal, k.instance_id, Date.now());
      }
      const existing = this.db.prepare('SELECT id, revoked_at FROM grants WHERE principal = ? AND instance_id = ?').get(principal, k.instance_id) as
        | { id: string; revoked_at: number | null }
        | undefined;
      if (existing) {
        if (existing.revoked_at && prior) throw fail(410, 'KEY_REVOKED');
        if (existing.revoked_at) this.db.prepare('UPDATE grants SET revoked_at = NULL, key_id = ? WHERE id = ?').run(k.id, existing.id);
        return existing.id;
      }
      const id = newId();
      this.db.prepare('INSERT INTO grants (id, principal, instance_id, key_id, created_at) VALUES (?, ?, ?, ?, ?)').run(id, principal, k.instance_id, k.id, Date.now());
      return id;
    }
  }

  signGrant(grantId: string): SignedGrant | null {
    const g = this.db
      .prepare(
        `SELECT g.id, g.principal, g.instance_id, g.revoked_at, k.revoked_at AS key_revoked, i.name, i.mc_version, i.loader_kind, i.loader_version, i.manifest_sha256, i.manifest_version
         FROM grants g JOIN keys k ON k.id = g.key_id JOIN instances i ON i.id = g.instance_id WHERE g.id = ?`,
      )
      .get(grantId) as
      | { id: string; principal: string; instance_id: string; revoked_at: number | null; key_revoked: number | null; name: string; mc_version: string; loader_kind: string; loader_version: string | null; manifest_sha256: string; manifest_version: string }
      | undefined;
    if (!g || g.revoked_at || g.key_revoked) return null;
    const now = Date.now();
    const payload: GrantPayload = {
      v: 1,
      id: g.id,
      instanceId: g.instance_id,
      principal: g.principal,
      issuedAt: now,
      expiresAt: now + this.cfg.grantTtlMs,
      instance: { name: g.name, mcVersion: g.mc_version, loader: { kind: g.loader_kind, version: g.loader_version ?? undefined } },
      manifest: { sha256: g.manifest_sha256, version: g.manifest_version },
    };
    const s = canonicalJson(payload);
    return { payload: s, signature: sign(this.cfg.signingKey, s) };
  }

  /** Renueva todas las concesiones activas e informa de las revocadas. */
  listGrants(principal: string): { active: SignedGrant[]; revoked: string[] } {
    const rows = this.db
      .prepare('SELECT g.id, g.revoked_at, k.revoked_at AS key_revoked FROM grants g JOIN keys k ON k.id = g.key_id WHERE g.principal = ?')
      .all(principal) as Array<{ id: string; revoked_at: number | null; key_revoked: number | null }>;
    const active: SignedGrant[] = [];
    const revoked: string[] = [];
    for (const r of rows) {
      if (r.revoked_at || r.key_revoked) revoked.push(r.id);
      else {
        const s = this.signGrant(r.id);
        if (s) active.push(s);
      }
    }
    return { active, revoked };
  }

  manifestFor(principal: string, instanceId: string): string {
    const row = this.db
      .prepare(
        `SELECT i.manifest_json FROM grants g JOIN keys k ON k.id = g.key_id JOIN instances i ON i.id = g.instance_id
         WHERE g.principal = ? AND g.instance_id = ? AND g.revoked_at IS NULL AND k.revoked_at IS NULL`,
      )
      .get(principal, instanceId) as { manifest_json: string } | undefined;
    if (!row) throw new ApiError(403, 'FORBIDDEN');
    return row.manifest_json;
  }

  // ------------------------------ Administración (CLI) ------------------------------

  upsertInstance(def: { id: string; name: string; mcVersion: string; loader: { kind: string; version?: string }; manifest: unknown }): { sha256: string } {
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(def.id)) throw new Error('id de instancia inválido');
    const m = def.manifest as { version?: string; files?: unknown[] };
    if (!m || typeof m.version !== 'string' || !Array.isArray(m.files)) throw new Error('manifiesto inválido: requiere version y files[]');
    const json = JSON.stringify({ ...m, instanceId: def.id });
    const sha = sha256Hex(json);
    this.db
      .prepare(
        `INSERT INTO instances (id, name, mc_version, loader_kind, loader_version, manifest_json, manifest_sha256, manifest_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, mc_version=excluded.mc_version, loader_kind=excluded.loader_kind,
           loader_version=excluded.loader_version, manifest_json=excluded.manifest_json, manifest_sha256=excluded.manifest_sha256, manifest_version=excluded.manifest_version`,
      )
      .run(def.id, def.name, def.mcVersion, def.loader.kind, def.loader.version ?? null, json, sha, m.version, Date.now());
    return { sha256: sha };
  }

  createKeys(instanceId: string, count: number, opts: { maxUses?: number; expiresAt?: number; note?: string } = {}): string[] {
    if (!this.db.prepare('SELECT 1 FROM instances WHERE id = ?').get(instanceId)) throw new Error('instancia inexistente');
    const out: string[] = [];
    tx(this.db, () => {
      for (let i = 0; i < count; i++) {
        const key = generateKey();
        this.db
          .prepare('INSERT INTO keys (id, verifier, hint, instance_id, max_uses, expires_at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(newId(), keyVerifier(this.cfg.keyPepper, key), key.slice(0, 10), instanceId, opts.maxUses ?? 1, opts.expiresAt ?? null, opts.note ?? null, Date.now());
        out.push(key);
      }
    });
    return out;
  }

  revokeKey(key: string): boolean {
    const k = normalizeKey(key);
    if (!k) return false;
    const r = this.db.prepare('UPDATE keys SET revoked_at = ? WHERE verifier = ? AND revoked_at IS NULL').run(Date.now(), keyVerifier(this.cfg.keyPepper, k));
    return Number(r.changes) === 1;
  }

  revokeGrant(grantId: string): boolean {
    return Number(this.db.prepare('UPDATE grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), grantId).changes) === 1;
  }
}
