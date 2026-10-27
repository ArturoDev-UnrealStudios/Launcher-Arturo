import http from 'node:http';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { AppError } from '../../shared/errors';
import { Http } from '../core/http';
import { pkcePair } from '../security/crypto';
import type { Logger } from '../core/logger';

/**
 * OAuth 2.0 Authorization Code + PKCE para clientes públicos nativos (RFC 8252):
 * el navegador del sistema abre la página oficial de Microsoft y la respuesta vuelve a un
 * servidor loopback efímero en 127.0.0.1. El launcher nunca ve la contraseña.
 */
export interface MicrosoftEndpoints {
  authorize: string;
  token: string;
}

export const MS_ENDPOINTS: MicrosoftEndpoints = {
  authorize: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
};

export const MS_SCOPES = ['XboxLive.signin', 'offline_access'];

export interface MsTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

const CALLBACK_HTML = (ok: boolean) => `<!doctype html><html lang="es"><meta charset="utf-8"><title>Unreal Launcher</title>
<style>body{font:16px system-ui,sans-serif;background:#0d0d12;color:#e7e7ee;display:grid;place-items:center;height:100vh;margin:0}
div{text-align:center;max-width:420px}h1{font-size:20px;margin:0 0 8px}p{color:#9a9aae}</style>
<div><h1>${ok ? 'Sesión recibida' : 'No se completó el inicio de sesión'}</h1>
<p>${ok ? 'Puedes cerrar esta pestaña y volver al launcher.' : 'Vuelve al launcher para ver el detalle e intentarlo de nuevo.'}</p></div></html>`;

export class MicrosoftOAuth {
  constructor(
    private readonly clientId: string,
    private readonly http: Http,
    private readonly log: Logger,
    private readonly endpoints: MicrosoftEndpoints = MS_ENDPOINTS,
    private readonly redirectPath = '/auth/callback',
  ) {}

  get configured(): boolean {
    return /^[0-9a-f-]{36}$/i.test(this.clientId);
  }

  /**
   * Ejecuta el flujo interactivo completo. `openBrowser` abre la URL en el navegador del sistema.
   * Se cancela con `signal` o tras 5 minutos.
   */
  async login(openBrowser: (url: string) => Promise<void>, signal: AbortSignal, timeoutMs = 5 * 60_000): Promise<MsTokens> {
    if (!this.configured) throw new AppError('NOT_CONFIGURED', 'microsoft.clientId');
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(24).toString('base64url');

    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://localhost:${port}${this.redirectPath}`;

    try {
      const codePromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new AppError('AUTH_CANCELLED', 'timeout')), timeoutMs);
        const abort = () => {
          clearTimeout(timer);
          reject(new AppError('AUTH_CANCELLED'));
        };
        signal.addEventListener('abort', abort, { once: true });
        server.on('request', (req, res) => {
          const url = new URL(req.url ?? '/', `http://localhost:${port}`);
          if (url.pathname !== this.redirectPath) {
            res.writeHead(404).end();
            return;
          }
          const got = url.searchParams.get('state') ?? '';
          const code = url.searchParams.get('code');
          const err = url.searchParams.get('error');
          const stateOk = got.length === state.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(state));
          const ok = !!code && stateOk && !err;
          res.writeHead(ok ? 200 : 400, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
          });
          res.end(CALLBACK_HTML(ok));
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (!stateOk) reject(new AppError('AUTH_DENIED', 'state mismatch'));
          else if (err === 'access_denied') reject(new AppError('AUTH_CANCELLED', 'access_denied'));
          else if (err) reject(new AppError('AUTH_DENIED', err.slice(0, 80)));
          else if (code) resolve(code);
          else reject(new AppError('AUTH_DENIED', 'no code'));
        });
      });

      // La respuesta puede llegar antes de que openBrowser termine: se evita un rechazo "no gestionado".
      codePromise.catch(() => undefined);
      const authUrl = new URL(this.endpoints.authorize);
      authUrl.search = new URLSearchParams({
        client_id: this.clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: MS_SCOPES.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      }).toString();
      await openBrowser(authUrl.toString());
      const code = await codePromise;
      this.log.info('Código de autorización recibido');
      return await this.exchange({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
    } finally {
      server.close();
      server.closeAllConnections?.();
    }
  }

  refresh(refreshToken: string): Promise<MsTokens> {
    return this.exchange({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  private async exchange(params: Record<string, string>): Promise<MsTokens> {
    const body = new URLSearchParams({ client_id: this.clientId, scope: MS_SCOPES.join(' '), ...params });
    const res = await this.http.request(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { error?: string };
    if (!res.ok || !json.access_token) {
      const err = json.error ?? `status ${res.status}`;
      if (err === 'invalid_grant') throw new AppError('AUTH_EXPIRED', 'invalid_grant');
      if (err === 'unauthorized_client' || err === 'invalid_client') throw new AppError('NOT_CONFIGURED', err);
      throw new AppError('AUTH_DENIED', String(err).slice(0, 80));
    }
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? params.refresh_token ?? '',
      expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
  }
}
