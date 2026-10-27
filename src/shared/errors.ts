/**
 * Errores tipados compartidos entre el proceso principal y la interfaz.
 * Los mensajes son códigos; la interfaz los traduce. `detail` nunca contiene secretos
 * (el logger y el serializador IPC pasan por `redact`).
 */
export const ErrorCodes = [
  'UNKNOWN',
  'VALIDATION',
  'NETWORK',
  'TIMEOUT',
  'HTTP',
  'CANCELLED',
  'NOT_FOUND',
  'CONFLICT',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NOT_CONFIGURED',
  // Autenticación
  'AUTH_CANCELLED',
  'AUTH_DENIED',
  'AUTH_EXPIRED',
  'AUTH_NO_XBOX_ACCOUNT',
  'AUTH_XBOX_REGION',
  'AUTH_XBOX_CHILD',
  'AUTH_NO_LICENSE',
  'AUTH_NO_PROFILE',
  'AUTH_APP_NOT_APPROVED',
  'PREMIUM_REQUIRED',
  'SECURE_STORAGE_UNAVAILABLE',
  // Instancias
  'INSTANCE_BUSY',
  'INSTANCE_LOCKED',
  'INSTANCE_NOT_INSTALLED',
  'INSTANCE_RUNNING',
  'HASH_MISMATCH',
  'DISK_FULL',
  'JAVA_NOT_FOUND',
  'JAVA_INCOMPATIBLE',
  'LAUNCH_FAILED',
  'UNTRUSTED_SOURCE',
  'UNSUPPORTED_LOADER',
  // Claves
  'KEY_INVALID',
  'KEY_EXPIRED',
  'KEY_REVOKED',
  'KEY_ALREADY_USED',
  'KEY_EXHAUSTED',
  // Skins
  'SKIN_INVALID',
  // Social
  'SOCIAL_BLOCKED',
  'SOCIAL_NOT_FRIENDS',
  'SOCIAL_DISCONNECTED',
  // Actualizador
  'UPDATE_SIGNATURE_INVALID',
  'UPDATE_NO_RELEASE',
  'UPDATE_FAILED',
] as const;

export type ErrorCode = (typeof ErrorCodes)[number];

export interface SerializedError {
  code: ErrorCode;
  /** Mensaje técnico corto y sin secretos (para logs / detalles). */
  detail?: string;
  /** Datos estructurados opcionales para la interfaz (p. ej. bytes necesarios). */
  data?: Record<string, unknown>;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly data?: Record<string, unknown>;
  constructor(code: ErrorCode, detail?: string, data?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(detail ?? code, options);
    this.name = 'AppError';
    this.code = code;
    this.data = data;
  }
  toJSON(): SerializedError {
    return { code: this.code, detail: this.message, data: this.data };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function toSerializedError(e: unknown): SerializedError {
  if (isAppError(e)) return e.toJSON();
  if (e && typeof e === 'object' && 'name' in e && (e as Error).name === 'AbortError') {
    return { code: 'CANCELLED' };
  }
  const err = e as { code?: string; message?: string } | undefined;
  if (err?.code === 'ENOSPC') return { code: 'DISK_FULL', detail: 'ENOSPC' };
  return { code: 'UNKNOWN', detail: err?.message ? String(err.message).slice(0, 300) : undefined };
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: SerializedError };
