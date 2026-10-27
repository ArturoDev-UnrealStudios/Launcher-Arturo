import http from 'node:http';
import { AuthService, requirePremium, type FetchLike, type Session } from './auth';
import type { ServerConfig } from './config';
import { openDb, type DB } from './db';
import { Hub } from './hub';
import { KeyService } from './keys';
import { SocialService } from './social';
import { ApiError, RateLimiter, sha256Hex } from './util';

type Handler = (ctx: { req: http.IncomingMessage; body: Record<string, unknown>; params: Record<string, string>; query: URLSearchParams; ip: string; session: () => Session }) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
  return { method, pattern, keys, handler };
}

export interface AppHandle {
  server: http.Server;
  db: DB;
  keys: KeyService;
  auth: AuthService;
  social: SocialService;
  close(): Promise<void>;
}

export function createApp(cfg: ServerConfig, opts: { fetch?: FetchLike; db?: DB; log?: (msg: string, meta?: unknown) => void } = {}): AppHandle {
  const db = opts.db ?? openDb(cfg.dbPath);
  const log = opts.log ?? ((m, meta) => console.log(JSON.stringify({ t: new Date().toISOString(), m, ...(meta ? { d: meta } : {}) })));
  const auth = new AuthService(db, cfg, opts.fetch);
  const keys = new KeyService(db, cfg);
  const social = new SocialService(db);
  const hub = new Hub(auth, social);
  const ipLimiter = new RateLimiter(300, 60_000);
  const authLimiter = new RateLimiter(20, 60_000);

  const routes: Route[] = [
    route('GET', '/v1/health', () => ({ ok: true })),
    route('POST', '/v1/auth/challenge', ({ ip }) => {
      if (!authLimiter.hit(`ch:${ip}`)) throw new ApiError(429, 'RATE_LIMITED');
      return auth.createChallenge();
    }),
    route('POST', '/v1/auth/premium', async ({ body, ip }) => {
      if (!authLimiter.hit(`pr:${ip}`)) throw new ApiError(429, 'RATE_LIMITED');
      const r = await auth.verifyPremium(body.challengeId, body.username);
      return { token: r.token, kind: r.session.kind, uuid: r.session.uuid, name: r.session.name, expiresAt: r.session.expiresAt };
    }),
    route('POST', '/v1/auth/device', ({ body, ip }) => {
      if (!authLimiter.hit(`dv:${ip}`)) throw new ApiError(429, 'RATE_LIMITED');
      const r = auth.verifyDevice(body.challengeId, body.publicKey, body.signature);
      return { token: r.token, kind: r.session.kind, principal: r.session.principal, expiresAt: r.session.expiresAt };
    }),
    route('POST', '/v1/auth/logout', ({ req }) => {
      auth.logout(req.headers.authorization);
      return { ok: true };
    }),
    // ----------------------------- Claves -----------------------------
    route('POST', '/v1/keys/redeem', ({ session, body, ip }) => keys.redeem(session().principal, body.key, ip)),
    route('GET', '/v1/grants', ({ session }) => keys.listGrants(session().principal)),
    route('GET', '/v1/instances/:id/manifest', ({ session, params }) => ({ manifest: keys.manifestFor(session().principal, params.id!) })),
    // ----------------------------- Social -----------------------------
    route('GET', '/v1/social', ({ session }) => social.overview(requirePremium(session()))),
    route('GET', '/v1/users/search', ({ session, query }) => ({ users: social.search(requirePremium(session()), query.get('q')) })),
    route('POST', '/v1/friends/requests', ({ session, body }) => social.sendRequest(requirePremium(session()), body.to)),
    route('POST', '/v1/friends/requests/:id/accept', ({ session, params }) => (social.respond(requirePremium(session()), params.id, true), { ok: true })),
    route('POST', '/v1/friends/requests/:id/decline', ({ session, params }) => (social.respond(requirePremium(session()), params.id, false), { ok: true })),
    route('DELETE', '/v1/friends/requests/:id', ({ session, params }) => (social.cancelRequest(requirePremium(session()), params.id), { ok: true })),
    route('DELETE', '/v1/friends/:uuid', ({ session, params }) => (social.removeFriend(requirePremium(session()), params.uuid), { ok: true })),
    route('POST', '/v1/blocks', ({ session, body }) => (social.block(requirePremium(session()), body.uuid), { ok: true })),
    route('DELETE', '/v1/blocks/:uuid', ({ session, params }) => (social.unblock(requirePremium(session()), params.uuid), { ok: true })),
    route('POST', '/v1/reports', ({ session, body }) => (social.report(requirePremium(session()), body.uuid, body.reason, body.messageId), { ok: true })),
    route('GET', '/v1/messages/:peer', ({ session, params, query }) => social.history(requirePremium(session()), params.peer, query.get('before'), query.get('limit'))),
    route('POST', '/v1/messages/:peer/read', ({ session, params }) => (social.markRead(requirePremium(session()), params.peer), { ok: true })),
    route('PUT', '/v1/settings/social', ({ session, body }) => (social.updatePrivacy(requirePremium(session()), body), { ok: true })),
  ];

  const clientIp = (req: http.IncomingMessage): string => {
    if (cfg.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  };

  const readBody = (req: http.IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'DELETE') return resolve({});
      const len = req.headers['content-length'];
      if ((len === undefined || len === '0') && !req.headers['transfer-encoding']) return resolve({});
      const ct = req.headers['content-type'] ?? '';
      if (!ct.startsWith('application/json')) return reject(new ApiError(415, 'VALIDATION', 'content-type'));
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > 16 * 1024) {
          reject(new ApiError(413, 'VALIDATION', 'cuerpo demasiado grande'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(new ApiError(400, 'VALIDATION', 'json'));
        }
      });
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const ip = clientIp(req);
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    let status = 200;
    try {
      if (!ipLimiter.hit(ip)) throw new ApiError(429, 'RATE_LIMITED');
      const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
      if (!r) throw new ApiError(404, 'NOT_FOUND');
      const m = r.pattern.exec(url.pathname)!;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
      const body = await readBody(req);
      let cached: Session | undefined;
      const session = () => (cached ??= auth.authenticate(req.headers.authorization));
      const out = await r.handler({ req, body, params, query: url.searchParams, ip, session });
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(out ?? { ok: true }));
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, 'UNKNOWN');
      status = err.status;
      if (!(e instanceof ApiError)) log('error', { path: url.pathname, err: (e as Error).message });
      res.statusCode = err.status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code: err.code } }));
    } finally {
      // Registro sin tokens ni cuerpos; la IP se guarda como hash truncado.
      if (status >= 400 || url.pathname !== '/v1/health') {
        log('req', { m: req.method, p: url.pathname.replace(/[0-9a-f-]{36}/g, ':uuid'), s: status || res.statusCode, ms: Date.now() - started, ip: sha256Hex(`ip:${ip}`).slice(0, 12) });
      }
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/v1/ws' || !ipLimiter.hit(clientIp(req))) {
      socket.destroy();
      return;
    }
    hub.handleUpgrade(req, socket, head);
  });

  return {
    server,
    db,
    keys,
    auth,
    social,
    close: async () => {
      hub.close();
      await new Promise<void>((r) => server.close(() => r()));
      server.closeAllConnections?.();
      db.close();
    },
  };
}
