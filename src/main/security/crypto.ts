import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Utilidades criptográficas. No se implementa ningún algoritmo propio: todo usa
 * node:crypto (OpenSSL / BoringSSL de Electron).
 */

export function sha1Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

export function sha256Hex(data: string | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export type HashAlgo = 'sha1' | 'sha256' | 'sha512';

export function hashFile(file: string, algo: HashAlgo): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo);
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a.toLowerCase(), 'hex');
  const bb = Buffer.from(b.toLowerCase(), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

/** Clave pública Ed25519 en base64 (32 bytes crudos o SPKI DER). */
export function ed25519PublicKey(b64: string): crypto.KeyObject {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length === 32) {
    const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
    return crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, raw]), format: 'der', type: 'spki' });
  }
  return crypto.createPublicKey({ key: raw, format: 'der', type: 'spki' });
}

export function verifyEd25519(data: Buffer | string, signatureB64: string, publicKeysB64: string[]): boolean {
  let sig: Buffer;
  try {
    sig = Buffer.from(signatureB64.trim(), 'base64');
  } catch {
    return false;
  }
  if (sig.length !== 64) return false;
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  for (const k of publicKeysB64) {
    try {
      if (crypto.verify(null, payload, ed25519PublicKey(k), sig)) return true;
    } catch {
      /* clave mal formada → siguiente */
    }
  }
  return false;
}

export function randomId(bytes = 16): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** UUID v3 de "OfflinePlayer:<nombre>" — el mismo algoritmo que usa el servidor vanilla en modo offline. */
export function offlineUuid(name: string): string {
  const md5 = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest();
  md5[6] = (md5[6]! & 0x0f) | 0x30;
  md5[8] = (md5[8]! & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function dashUuid(u: string): string {
  const h = u.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error('UUID inválido');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function undashUuid(u: string): string {
  return u.replace(/-/g, '').toLowerCase();
}

/** PKCE (RFC 7636) */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Hash "serverId" al estilo Minecraft (SHA-1 interpretado como entero con signo en complemento a dos).
 * Lo usa el protocolo join/hasJoined de Mojang.
 */
export function minecraftDigest(input: Buffer | string): string {
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
