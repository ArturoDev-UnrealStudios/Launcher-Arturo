import crypto from 'node:crypto';
import fs from 'node:fs';

export interface ServerConfig {
  host: string;
  port: number;
  dbPath: string;
  /** Clave HMAC para derivar verificadores de claves de canje (secreta, ≥32 bytes). */
  keyPepper: Buffer;
  /** Clave privada Ed25519 para firmar concesiones. */
  signingKey: crypto.KeyObject;
  sessionServer: string;
  trustProxy: boolean;
  premiumSessionTtlMs: number;
  deviceSessionTtlMs: number;
  grantTtlMs: number;
  corsOrigins: string[];
}

function readSecret(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  return process.env[name]?.trim();
}

export function loadSigningKey(raw: string): crypto.KeyObject {
  if (raw.includes('BEGIN')) return crypto.createPrivateKey(raw);
  return crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
}

export function loadConfig(env = process.env): ServerConfig {
  const pepper = readSecret('KEY_PEPPER');
  const signing = readSecret('SIGNING_KEY');
  if (!pepper || Buffer.from(pepper, 'base64').length < 32) {
    throw new Error('KEY_PEPPER debe ser un secreto base64 de al menos 32 bytes (node cli/admin.js gen-secrets)');
  }
  if (!signing) throw new Error('SIGNING_KEY (Ed25519 PKCS#8 base64 o PEM) es obligatorio');
  const key = loadSigningKey(signing);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('SIGNING_KEY debe ser Ed25519');
  return {
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 8787),
    dbPath: env.DB_PATH ?? './data/authority.db',
    keyPepper: Buffer.from(pepper, 'base64'),
    signingKey: key,
    sessionServer: (env.SESSION_SERVER_URL ?? 'https://sessionserver.mojang.com').replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === '1',
    premiumSessionTtlMs: Number(env.PREMIUM_SESSION_TTL_H ?? 12) * 3600_000,
    deviceSessionTtlMs: Number(env.DEVICE_SESSION_TTL_D ?? 30) * 86400_000,
    grantTtlMs: Number(env.GRANT_TTL_D ?? 7) * 86400_000,
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  };
}
