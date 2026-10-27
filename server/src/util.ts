import crypto from 'node:crypto';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code);
  }
}

export function sha256Hex(s: string | Buffer): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function newId(): string {
  return crypto.randomUUID();
}

/** Serialización canónica (claves ordenadas) para firmar y verificar exactamente lo mismo. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export function sign(key: crypto.KeyObject, payload: string): string {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), key).toString('base64');
}

/** Ventana deslizante simple en memoria para limitar abusos. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}
  /** Registra un evento y devuelve false si se supera el límite. */
  hit(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.gc(now);
    return arr.length <= this.limit;
  }
  /** Comprueba sin registrar. */
  blocked(key: string, now = Date.now()): boolean {
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    return arr.length >= this.limit;
  }
  reset(key: string): void {
    this.hits.delete(key);
  }
  private gc(now: number) {
    for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k);
  }
}

/** Normaliza texto de chat: sin caracteres de control (salvo saltos de línea), recortado. */
export function sanitizeMessage(body: unknown, max = 2000): string | null {
  if (typeof body !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const clean = body.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '').trim();
  if (!clean) return null;
  if ([...clean].length > max) return null;
  if (clean.split('\n').length > 60) return null;
  return clean;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function dashUuid(u: string): string {
  const h = u.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new ApiError(400, 'VALIDATION', 'uuid');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
