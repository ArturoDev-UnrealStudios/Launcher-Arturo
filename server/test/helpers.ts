import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { createApp, type AppHandle } from '../src/app';
import type { ServerConfig } from '../src/config';

export interface TestEnv {
  app: AppHandle;
  base: string;
  wsUrl: string;
  publicKey: crypto.KeyObject;
  cfg: ServerConfig;
  dir: string;
  /** Simula sessionserver: registra un "join" válido. */
  join(username: string, uuid: string, serverId: string): void;
  close(): Promise<void>;
}

export async function startTestServer(): Promise<TestEnv> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreal-auth-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const cfg: ServerConfig = {
    host: '127.0.0.1',
    port: 0,
    dbPath: path.join(dir, 'test.db'),
    keyPepper: crypto.randomBytes(32),
    signingKey: privateKey,
    sessionServer: 'https://sessionserver.test',
    trustProxy: false,
    premiumSessionTtlMs: 3600_000,
    deviceSessionTtlMs: 3600_000,
    grantTtlMs: 7 * 86400_000,
    corsOrigins: [],
  };
  const joins = new Map<string, { uuid: string; name: string }>();
  const fakeFetch = async (url: string) => {
    const u = new URL(url);
    const key = `${u.searchParams.get('username')?.toLowerCase()}|${u.searchParams.get('serverId')}`;
    const p = joins.get(key);
    if (!p) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: p.uuid.replace(/-/g, ''), name: p.name }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = createApp(cfg, { fetch: fakeFetch as never, log: () => {} });
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', () => r()));
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    cfg,
    dir,
    base: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/v1/ws`,
    publicKey,
    join: (username, uuid, serverId) => joins.set(`${username.toLowerCase()}|${serverId}`, { uuid, name: username }),
    close: async () => {
      await app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function api(env: TestEnv, method: string, p: string, token?: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(env.base + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

export async function premiumLogin(env: TestEnv, name: string, uuid: string): Promise<string> {
  const ch = await api(env, 'POST', '/v1/auth/challenge');
  env.join(name, uuid, ch.json.serverId);
  const r = await api(env, 'POST', '/v1/auth/premium', undefined, { challengeId: ch.json.id, username: name });
  if (r.status !== 200) throw new Error(`login ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.token;
}

export async function deviceLogin(env: TestEnv): Promise<{ token: string; principal: string }> {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const ch = await api(env, 'POST', '/v1/auth/challenge');
  const sig = crypto.sign(null, Buffer.from(`unreal-device-auth:${ch.json.id}:${ch.json.nonce}`), privateKey).toString('base64');
  const r = await api(env, 'POST', '/v1/auth/device', undefined, {
    challengeId: ch.json.id,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    signature: sig,
  });
  if (r.status !== 200) throw new Error(`device ${r.status}`);
  return { token: r.json.token, principal: r.json.principal };
}

export class WsClient {
  readonly events: any[] = [];
  private waiters: Array<{ pred: (e: any) => boolean; resolve: (e: any) => void }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const e = JSON.parse(d.toString());
      this.events.push(e);
      this.waiters = this.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true));
    });
  }
  static async connect(env: TestEnv, token: string): Promise<WsClient> {
    const ws = new WebSocket(env.wsUrl);
    await new Promise((r, j) => {
      ws.once('open', r);
      ws.once('error', j);
    });
    const c = new WsClient(ws);
    c.send({ type: 'auth', token });
    await c.next((e) => e.type === 'ready' || e.type === 'error');
    return c;
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  next(pred: (e: any) => boolean, timeoutMs = 3000): Promise<any> {
    const found = this.events.find(pred);
    if (found) {
      this.events.splice(this.events.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout esperando evento')), timeoutMs);
      this.waiters.push({
        pred,
        resolve: (e) => {
          clearTimeout(t);
          this.events.splice(this.events.indexOf(e), 1);
          resolve(e);
        },
      });
    });
  }
  close() {
    this.ws.close();
  }
}

export const U1 = '11111111-1111-4111-8111-111111111111';
export const U2 = '22222222-2222-4222-8222-222222222222';
export const U3 = '33333333-3333-4333-8333-333333333333';
