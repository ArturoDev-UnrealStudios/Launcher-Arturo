import { z } from 'zod';
import { AppError, isAppError } from '../../shared/errors';
import type { InstanceConfig, KeyRedemption, LoaderKind } from '../../shared/types';
import type { AuthorityClient } from '../authority/authorityClient';
import { Mutex, readJson, writeJson } from '../core/jsonStore';
import type { Logger } from '../core/logger';
import type { InstanceManager, PrivateManifestProvider } from '../instances/instanceManager';
import type { PrivateManifest } from '../minecraft/installer';
import { sha256Hex, verifyEd25519 } from '../security/crypto';

/** Validación local de formato (la autoridad decide la validez real). */
export function normalizeKey(input: string): string | null {
  const k = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!k.startsWith('UNRL')) return null;
  const body = k.slice(4).replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (!/^[A-Z2-7]{25}$/.test(body)) return null;
  return `UNRL-${body.match(/.{5}/g)!.join('-')}`;
}

const GrantPayloadSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  instanceId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  principal: z.string(),
  issuedAt: z.number(),
  expiresAt: z.number(),
  instance: z.object({
    name: z.string().max(48),
    mcVersion: z.string().regex(/^[\w.+-]{1,40}$/),
    loader: z.object({ kind: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']), version: z.string().optional() }),
  }),
  manifest: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), version: z.string() }),
});
type GrantPayload = z.infer<typeof GrantPayloadSchema>;

const StoredGrantSchema = z.object({
  payload: z.string(),
  signature: z.string(),
  accountId: z.string(),
  redeemedAt: z.number(),
  keyHint: z.string(),
  status: z.enum(['granted', 'expired', 'revoked']).default('granted'),
});
const FileSchema = z.object({ grants: z.array(StoredGrantSchema).default([]) });
type StoredGrant = z.infer<typeof StoredGrantSchema>;

const ManifestSchema = z.object({
  instanceId: z.string(),
  version: z.string(),
  files: z.array(z.object({ path: z.string().max(300), url: z.string().url(), sha256: z.string(), size: z.number().int().nonnegative() })).max(5000),
});

/**
 * Concesiones firmadas por la autoridad. La firma Ed25519 se comprueba con claves públicas
 * fijadas en la aplicación: un servidor suplantado no puede fabricar accesos.
 * Limitación documentada: el control final de una instancia ya descargada lo ejerce el cliente.
 */
export class KeyService implements PrivateManifestProvider {
  private grants: StoredGrant[] = [];
  private readonly mutex = new Mutex();

  constructor(
    private readonly file: string,
    private readonly authority: AuthorityClient,
    private readonly instances: InstanceManager,
    private readonly publicKeys: string[],
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    this.grants = (await readJson(this.file, FileSchema, () => ({ grants: [] }))).value.grants;
    await this.applyExpiry();
  }

  private verify(payload: string, signature: string): GrantPayload {
    if (!verifyEd25519(payload, signature, this.publicKeys)) throw new AppError('UNTRUSTED_SOURCE', 'firma de concesión inválida');
    return GrantPayloadSchema.parse(JSON.parse(payload));
  }

  async redeem(rawKey: string, accountId: string | undefined): Promise<KeyRedemption> {
    if (!accountId) throw new AppError('AUTH_EXPIRED', 'sin cuenta activa');
    const key = normalizeKey(rawKey);
    if (!key) throw new AppError('KEY_INVALID', 'formato');
    if (!this.publicKeys.length) throw new AppError('NOT_CONFIGURED', 'authority.publicKeys');
    const signed = await this.authority.call<{ payload: string; signature: string }>(accountId, 'POST', '/v1/keys/redeem', { key });
    const g = this.verify(signed.payload, signed.signature);
    const session = await this.authority.session(accountId);
    if (g.principal !== session.principal) throw new AppError('UNTRUSTED_SOURCE', 'concesión para otra identidad');
    const keyHint = key.slice(0, 10);

    await this.mutex.run(async () => {
      this.grants = this.grants.filter((x) => !(x.accountId === accountId && this.safePayload(x)?.instanceId === g.instanceId));
      this.grants.push({ payload: signed.payload, signature: signed.signature, accountId, redeemedAt: Date.now(), keyHint, status: 'granted' });
      await writeJson(this.file, { grants: this.grants });
    });
    await this.ensureInstance(g);
    return this.toRedemption(g, Date.now(), keyHint);
  }

  private safePayload(s: StoredGrant): GrantPayload | null {
    try {
      return GrantPayloadSchema.parse(JSON.parse(s.payload));
    } catch {
      return null;
    }
  }

  private toRedemption(g: GrantPayload, redeemedAt: number, keyHint: string): KeyRedemption {
    return {
      instanceId: g.instanceId,
      instanceName: g.instance.name,
      mcVersion: g.instance.mcVersion,
      loader: { kind: g.instance.loader.kind as LoaderKind, version: g.instance.loader.version },
      expiresAt: g.expiresAt,
      redeemedAt,
      keyHint,
    };
  }

  /** Crea la instancia privada (o actualiza su acceso) a partir de una concesión verificada. */
  private async ensureInstance(g: GrantPayload): Promise<void> {
    const access: InstanceConfig['access'] = { kind: 'private', grantId: g.id, status: 'granted', expiresAt: g.expiresAt };
    const existing = this.instances.all().find((i) => i.id === g.instanceId);
    if (existing) {
      await this.instances.setAccess(existing.id, access);
      return;
    }
    await this.instances.create(
      {
        name: g.instance.name,
        mcVersion: g.instance.mcVersion,
        // El paquete privado lo define la autoridad: su instalador se considera aceptado al canjear la clave.
        loader: { kind: g.instance.loader.kind as LoaderKind, version: g.instance.loader.version, installerTrusted: true },
      },
      { id: g.instanceId, access },
    );
  }

  history(): KeyRedemption[] {
    return this.grants
      .map((s) => {
        const p = this.safePayload(s);
        return p ? this.toRedemption(p, s.redeemedAt, s.keyHint) : null;
      })
      .filter((x): x is KeyRedemption => !!x)
      .sort((a, b) => b.redeemedAt - a.redeemedAt);
  }

  /** Marca como caducadas las concesiones vencidas (bloquea el lanzamiento hasta renovar). */
  private async applyExpiry(): Promise<void> {
    for (const s of this.grants) {
      const p = this.safePayload(s);
      if (!p) continue;
      const inst = this.instances.findByGrant(p.id);
      if (inst && s.status === 'granted' && p.expiresAt < Date.now()) {
        s.status = 'expired';
        await this.instances.setAccess(inst.id, { kind: 'private', grantId: p.id, status: 'expired', expiresAt: p.expiresAt });
      }
    }
  }

  /** Renueva concesiones con la autoridad: aplica revocaciones y extiende caducidades. */
  async refresh(): Promise<{ updated: number }> {
    if (!this.authority.configured || !this.grants.length) return { updated: 0 };
    let updated = 0;
    const accounts = [...new Set(this.grants.map((g) => g.accountId))];
    for (const accountId of accounts) {
      let res: { active: Array<{ payload: string; signature: string }>; revoked: string[] };
      try {
        res = await this.authority.call(accountId, 'GET', '/v1/grants');
      } catch (e) {
        if (isAppError(e) && (e.code === 'NETWORK' || e.code === 'TIMEOUT')) continue; // sin red: se mantiene hasta expiresAt
        this.log.warn('No se pudieron renovar concesiones', { err: e });
        continue;
      }
      await this.mutex.run(async () => {
        for (const signed of res.active) {
          let g: GrantPayload;
          try {
            g = this.verify(signed.payload, signed.signature);
          } catch {
            continue;
          }
          const idx = this.grants.findIndex((x) => x.accountId === accountId && this.safePayload(x)?.id === g.id);
          if (idx >= 0) {
            this.grants[idx] = { ...this.grants[idx]!, payload: signed.payload, signature: signed.signature, status: 'granted' };
            const inst = this.instances.findByGrant(g.id) ?? this.instances.all().find((i) => i.id === g.instanceId);
            if (inst) await this.instances.setAccess(inst.id, { kind: 'private', grantId: g.id, status: 'granted', expiresAt: g.expiresAt });
            updated++;
          }
        }
        for (const id of res.revoked) {
          const s = this.grants.find((x) => x.accountId === accountId && this.safePayload(x)?.id === id);
          if (s && s.status !== 'revoked') {
            s.status = 'revoked';
            const inst = this.instances.findByGrant(id);
            if (inst) await this.instances.setAccess(inst.id, { kind: 'private', grantId: id, status: 'revoked' });
            updated++;
          }
        }
        await writeJson(this.file, { grants: this.grants });
      });
    }
    await this.applyExpiry();
    return { updated };
  }

  /** Manifiesto privado: se descarga de la autoridad y debe coincidir con el SHA-256 firmado. */
  async fetch(inst: InstanceConfig): Promise<PrivateManifest> {
    if (inst.access.kind !== 'private') throw new AppError('VALIDATION');
    const grantId = inst.access.grantId;
    const s = this.grants.find((x) => this.safePayload(x)?.id === grantId);
    const g = s && this.verify(s.payload, s.signature);
    if (!s || !g || s.status !== 'granted') throw new AppError('INSTANCE_LOCKED');
    if (g.expiresAt < Date.now()) throw new AppError('INSTANCE_LOCKED', 'concesión caducada');
    const r = await this.authority.call<{ manifest: string }>(s.accountId, 'GET', `/v1/instances/${encodeURIComponent(g.instanceId)}/manifest`);
    if (sha256Hex(r.manifest) !== g.manifest.sha256) throw new AppError('HASH_MISMATCH', 'manifiesto privado');
    const m = ManifestSchema.parse(JSON.parse(r.manifest));
    if (m.instanceId !== inst.id) throw new AppError('VALIDATION', 'manifiesto de otra instancia');
    return m;
  }
}
