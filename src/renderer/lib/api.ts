import type { LauncherApi } from '../../shared/api';
import type { Result, SerializedError } from '../../shared/errors';

declare global {
  interface Window {
    launcher: LauncherApi;
    platform: { os: string };
  }
}

export const api: LauncherApi = window.launcher;

export class UiError extends Error {
  constructor(readonly error: SerializedError) {
    super(error.code);
  }
}

/** Desenvuelve un Result del proceso principal o lanza UiError. */
export async function call<T>(p: Promise<Result<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.value;
  throw new UiError(r.error);
}

export function errOf(e: unknown): SerializedError {
  if (e instanceof UiError) return e.error;
  return { code: 'UNKNOWN', detail: (e as Error)?.message };
}
