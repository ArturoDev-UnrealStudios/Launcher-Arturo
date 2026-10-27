import { AppError } from '../../shared/errors';

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export const USER_AGENT_BASE = 'UnrealLauncher';

let userAgent = `${USER_AGENT_BASE}/dev`;
export function setUserAgent(version: string): void {
  userAgent = `${USER_AGENT_BASE}/${version}`;
}
export function getUserAgent(): string {
  return userAgent;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new AppError('CANCELLED'));
    }, { once: true });
  });
}

/**
 * Cliente HTTP mínimo con timeout, reintentos exponenciales para errores transitorios
 * y errores tipados. Nunca incluye cuerpos de respuesta en los mensajes (podrían tener tokens).
 */
export class Http {
  constructor(private readonly fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)) {}

  get fetch(): FetchLike {
    return this.fetchImpl;
  }

  async request(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<Response> {
    const retries = opts.retries ?? 2;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      opts.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);
      try {
        const headers = new Headers(init.headers);
        if (!headers.has('user-agent')) headers.set('user-agent', userAgent);
        const res = await this.fetchImpl(url, { ...init, headers, signal: ctrl.signal });
        if ((res.status >= 500 || res.status === 429) && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await res.body?.cancel().catch(() => undefined);
          attempt++;
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 400 * 2 ** attempt, opts.signal);
          continue;
        }
        return res;
      } catch (e) {
        if (opts.signal?.aborted) throw new AppError('CANCELLED');
        const timedOut = ctrl.signal.aborted;
        if (attempt < retries) {
          attempt++;
          await sleep(400 * 2 ** attempt, opts.signal);
          continue;
        }
        throw new AppError(timedOut ? 'TIMEOUT' : 'NETWORK', `${new URL(url).host}: ${(e as Error).message ?? e}`, undefined, { cause: e });
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  async json<T>(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<T> {
    const res = await this.request(url, init, opts);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw httpError(url, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new AppError('HTTP', `${new URL(url).host}: respuesta JSON inválida`);
    }
  }

  async text(url: string, init: RequestInit = {}, opts: HttpOptions = {}): Promise<string> {
    const res = await this.request(url, init, opts);
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw httpError(url, res.status);
    }
    return res.text();
  }
}

export function httpError(url: string, status: number): AppError {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return 'host';
    }
  })();
  if (status === 404) return new AppError('NOT_FOUND', `${host} 404`, { status });
  if (status === 401) return new AppError('AUTH_EXPIRED', `${host} 401`, { status });
  if (status === 403) return new AppError('FORBIDDEN', `${host} 403`, { status });
  if (status === 429) return new AppError('RATE_LIMITED', `${host} 429`, { status });
  return new AppError('HTTP', `${host} ${status}`, { status });
}
