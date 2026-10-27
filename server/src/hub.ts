import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AuthService } from './auth';
import { ApiError, RateLimiter } from './util';
import type { Notifier, Presence, SocialService } from './social';

interface Conn {
  ws: WebSocket;
  uuid?: string;
  status: 'online' | 'away';
  alive: boolean;
}

/**
 * Canal de tiempo real. El token de sesión viaja en el primer mensaje (no en la URL, para
 * que no quede en logs de proxies). Cada operación vuelve a pasar por SocialService.
 */
export class Hub implements Notifier {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 });
  private readonly byUser = new Map<string, Set<Conn>>();
  private readonly frameLimiter = new RateLimiter(40, 10_000);
  private readonly typingLimiter = new RateLimiter(6, 5_000);
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly auth: AuthService, private readonly social: SocialService) {
    social.notifier = this;
    this.heartbeat = setInterval(() => this.sweep(), 30_000);
    this.heartbeat.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
  }

  close(): void {
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  private send(ws: WebSocket, ev: Record<string, unknown>): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(ev));
  }

  toUser(uuid: string, event: Record<string, unknown>): boolean {
    const set = this.byUser.get(uuid);
    if (!set?.size) return false;
    for (const c of set) this.send(c.ws, event);
    return true;
  }

  presenceOf(uuid: string): Presence {
    const set = this.byUser.get(uuid);
    if (!set?.size) return 'offline';
    return [...set].some((c) => c.status === 'online') ? 'online' : 'away';
  }

  private broadcastPresence(uuid: string): void {
    if (this.social.presenceVisibility(uuid) === 'nobody') return;
    const presence = this.presenceOf(uuid);
    for (const f of this.social.friendsOf(uuid)) this.toUser(f, { type: 'presence', uuid, presence, at: Date.now() });
  }

  private sweep(): void {
    for (const c of this.wss.clients as Set<WebSocket & { __conn?: Conn }>) {
      const conn = c.__conn;
      if (!conn) continue;
      if (!conn.alive) {
        c.terminate();
        continue;
      }
      conn.alive = false;
      c.ping();
    }
  }

  private onConnection(ws: WebSocket & { __conn?: Conn }): void {
    const conn: Conn = { ws, status: 'online', alive: true };
    ws.__conn = conn;
    const authTimer = setTimeout(() => {
      if (!conn.uuid) ws.close(4401, 'auth timeout');
    }, 5_000);
    ws.on('pong', () => (conn.alive = true));
    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!conn.uuid) return;
      const set = this.byUser.get(conn.uuid);
      set?.delete(conn);
      if (set && !set.size) this.byUser.delete(conn.uuid);
      if (this.closed) return;
      try {
        if (!this.byUser.has(conn.uuid)) this.social.touch(conn.uuid);
        this.broadcastPresence(conn.uuid);
      } catch {
        /* un fallo al cerrar una conexión nunca debe tumbar el servidor */
      }
    });
    ws.on('message', (data, isBinary) => {
      conn.alive = true;
      if (isBinary) return ws.close(4400, 'binary');
      const key = conn.uuid ?? 'anon';
      if (!this.frameLimiter.hit(`${key}:${(ws as unknown as { _socket?: { remoteAddress?: string } })._socket?.remoteAddress ?? ''}`)) {
        this.send(ws, { type: 'error', code: 'RATE_LIMITED' });
        return;
      }
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object') throw new Error();
      } catch {
        return this.send(ws, { type: 'error', code: 'VALIDATION' });
      }
      try {
        this.handle(conn, msg, authTimer);
      } catch (e) {
        const code = e instanceof ApiError ? e.code : 'UNKNOWN';
        this.send(ws, { type: 'error', code, clientId: typeof msg.clientId === 'string' ? msg.clientId : undefined });
        if (code === 'AUTH_EXPIRED' || code === 'PREMIUM_REQUIRED') ws.close(4401, code);
      }
    });
  }

  private handle(conn: Conn, msg: Record<string, unknown>, authTimer: NodeJS.Timeout): void {
    if (msg.type === 'auth') {
      if (conn.uuid) return;
      if (typeof msg.token !== 'string') throw new ApiError(400, 'VALIDATION');
      const s = this.auth.sessionFromToken(msg.token);
      if (s.kind !== 'premium' || !s.uuid) throw new ApiError(403, 'PREMIUM_REQUIRED');
      clearTimeout(authTimer);
      conn.uuid = s.uuid;
      const set = this.byUser.get(s.uuid) ?? new Set();
      set.add(conn);
      this.byUser.set(s.uuid, set);
      this.social.touch(s.uuid);
      this.send(conn.ws, { type: 'ready', me: { uuid: s.uuid, name: s.name } });
      this.broadcastPresence(s.uuid);
      return;
    }
    const me = conn.uuid;
    if (!me) throw new ApiError(401, 'AUTH_EXPIRED');
    switch (msg.type) {
      case 'ping':
        this.send(conn.ws, { type: 'pong', at: Date.now() });
        return;
      case 'send': {
        const clientId = typeof msg.clientId === 'string' ? msg.clientId.slice(0, 64) : undefined;
        const m = this.social.send(me, msg.to, msg.body);
        const payload = { ...m };
        for (const c of this.byUser.get(me) ?? []) this.send(c.ws, { type: 'ack', clientId: c === conn ? clientId : undefined, message: payload });
        this.toUser(m.to, { type: 'message', message: payload });
        return;
      }
      case 'delivered': {
        const d = this.social.markDelivered(me, msg.id);
        if (d) this.toUser(d.from, { type: 'delivered', id: d.id, peer: me, at: d.at });
        return;
      }
      case 'typing': {
        if (typeof msg.to !== 'string' || !this.typingLimiter.hit(me)) return;
        if (this.social.areFriends(me, msg.to) && !this.social.isBlockedEitherWay(me, msg.to)) this.toUser(msg.to, { type: 'typing', from: me });
        return;
      }
      case 'presence': {
        if (msg.status !== 'online' && msg.status !== 'away') throw new ApiError(400, 'VALIDATION');
        conn.status = msg.status;
        this.broadcastPresence(me);
        return;
      }
      default:
        throw new ApiError(400, 'VALIDATION', 'tipo desconocido');
    }
  }
}
