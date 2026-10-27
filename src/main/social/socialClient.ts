import crypto from 'node:crypto';
import { AppError, isAppError } from '../../shared/errors';
import type { ChatMessage, Friend, FriendRequest, SocialEvent, SocialState, SocialUser } from '../../shared/types';
import type { AccountManager } from '../auth/accountManager';
import type { AuthorityClient } from '../authority/authorityClient';
import type { Logger } from '../core/logger';

interface Outgoing {
  clientId: string;
  to: string;
  body: string;
  attempts: number;
  queuedAt: number;
}

type WsLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: string, cb: (ev: { data?: unknown; code?: number }) => void): void;
};

export type WsFactory = (url: string) => WsLike;

/**
 * Cliente social del proceso principal. Solo funciona con cuentas premium verificadas: la
 * comprobación real la hace la autoridad (hasJoined), no una variable local.
 */
export class SocialClient {
  private ws?: WsLike;
  private accountId?: string;
  private state: SocialState = { connection: 'disabled', friends: [], requests: [], blocked: [] };
  private readonly outbox = new Map<string, Outgoing>();
  private reconnectTimer?: NodeJS.Timeout;
  private backoff = 1000;
  private stopped = true;
  private pingTimer?: NodeJS.Timeout;
  private presence: 'online' | 'away' = 'online';

  constructor(
    private readonly authority: AuthorityClient,
    private readonly accounts: AccountManager,
    private readonly emit: (e: SocialEvent) => void,
    private readonly log: Logger,
    private readonly wsFactory: WsFactory = (url) => new WebSocket(url) as unknown as WsLike,
  ) {}

  getState(): SocialState {
    return this.state;
  }

  private setState(patch: Partial<SocialState>): void {
    this.state = { ...this.state, ...patch };
    this.emit({ type: 'state', state: this.state });
  }

  /** (Re)conecta para la cuenta activa; se desactiva para cuentas offline o sin autoridad. */
  async start(accountId: string | undefined): Promise<void> {
    this.stop();
    const acc = accountId ? this.accounts.get(accountId) : undefined;
    if (!this.authority.configured || !acc || acc.kind !== 'microsoft' || !acc.premium) {
      this.setState({ connection: 'disabled', friends: [], requests: [], blocked: [], me: undefined });
      return;
    }
    this.accountId = accountId;
    this.stopped = false;
    this.setState({ connection: 'connecting', me: { uuid: acc.uuid, name: acc.username } });
    await this.refreshOverview().catch(() => undefined);
    this.open();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    try {
      this.ws?.close(1000);
    } catch {
      /* ignorar */
    }
    this.ws = undefined;
  }

  private wsUrl(): string {
    return this.authority.baseUrl.replace(/^http/, 'ws') + '/v1/ws';
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = Math.min(this.backoff, 30_000) * (0.75 + Math.random() * 0.5);
    this.backoff = Math.min(this.backoff * 2, 30_000);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private async open(forceSession = false): Promise<void> {
    if (this.stopped || !this.accountId) return;
    let token: string;
    try {
      token = (await this.authority.session(this.accountId, forceSession)).token;
    } catch (e) {
      if (isAppError(e) && (e.code === 'AUTH_EXPIRED' || e.code === 'PREMIUM_REQUIRED' || e.code === 'AUTH_NO_LICENSE')) {
        this.setState({ connection: 'unauthorized' });
        return;
      }
      this.setState({ connection: 'offline' });
      this.scheduleReconnect();
      return;
    }
    const ws = this.wsFactory(this.wsUrl());
    this.ws = ws;
    let authed = false;
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.addEventListener('message', (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        authed = true;
        this.backoff = 1000;
        this.setState({ connection: 'online' });
        if (this.presence === 'away') this.sendRaw({ type: 'presence', status: 'away' });
        this.flushOutbox();
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.sendRaw({ type: 'ping' }), 25_000);
        return;
      }
      this.onServerEvent(msg);
    });
    ws.addEventListener('close', (ev) => {
      clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (this.stopped) return;
      if (ev.code === 4401 && !authed && !forceSession) {
        void this.open(true);
        return;
      }
      if (ev.code === 4401) {
        this.setState({ connection: 'unauthorized' });
        return;
      }
      this.setState({ connection: 'offline' });
      this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      /* el evento close gestiona la reconexión */
    });
  }

  private sendRaw(o: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== 1) return false;
    this.ws.send(JSON.stringify(o));
    return true;
  }

  private onServerEvent(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'ack': {
        const m = toChat(msg.message, 'sent');
        if (!m) return;
        const clientId = typeof msg.clientId === 'string' ? msg.clientId : undefined;
        if (clientId) this.outbox.delete(clientId);
        this.emit({ type: 'ack', clientId: clientId ?? '', message: { ...m, clientId } });
        return;
      }
      case 'message': {
        const m = toChat(msg.message, 'delivered');
        if (!m) return;
        this.sendRaw({ type: 'delivered', id: m.id });
        this.state.friends = this.state.friends.map((f) => (f.uuid === m.from ? { ...f, unread: f.unread + 1 } : f));
        this.emit({ type: 'message', message: m });
        this.emit({ type: 'state', state: this.state });
        return;
      }
      case 'delivered':
        if (typeof msg.id === 'string' && typeof msg.peer === 'string') this.emit({ type: 'delivered', id: msg.id, peer: msg.peer, at: Number(msg.at) || Date.now() });
        return;
      case 'typing':
        if (typeof msg.from === 'string') this.emit({ type: 'typing', from: msg.from });
        return;
      case 'presence': {
        const uuid = msg.uuid;
        const presence = msg.presence;
        if (typeof uuid !== 'string' || (presence !== 'online' && presence !== 'away' && presence !== 'offline')) return;
        this.setState({ friends: this.state.friends.map((f) => (f.uuid === uuid ? { ...f, presence, lastSeenAt: presence === 'offline' ? Date.now() : f.lastSeenAt } : f)) });
        return;
      }
      case 'friends-changed':
        void this.refreshOverview().catch(() => undefined);
        return;
      case 'error': {
        const clientId = typeof msg.clientId === 'string' ? msg.clientId : undefined;
        const code = typeof msg.code === 'string' ? msg.code : 'UNKNOWN';
        if (clientId) {
          this.outbox.delete(clientId);
          this.emit({ type: 'send-failed', clientId, code });
        } else if (code === 'RATE_LIMITED') {
          // Sin clientId: se notifica el fallo del último mensaje pendiente.
          const last = [...this.outbox.values()].pop();
          if (last) {
            this.outbox.delete(last.clientId);
            this.emit({ type: 'send-failed', clientId: last.clientId, code });
          }
        }
        return;
      }
    }
  }

  private flushOutbox(): void {
    for (const o of this.outbox.values()) {
      if (o.attempts >= 3 || Date.now() - o.queuedAt > 5 * 60_000) {
        this.outbox.delete(o.clientId);
        this.emit({ type: 'send-failed', clientId: o.clientId, code: 'SOCIAL_DISCONNECTED' });
        continue;
      }
      o.attempts++;
      this.sendRaw({ type: 'send', to: o.to, body: o.body, clientId: o.clientId });
    }
  }

  private requireAccount(): string {
    if (!this.accountId || this.state.connection === 'disabled') throw new AppError('PREMIUM_REQUIRED');
    return this.accountId;
  }

  async refreshOverview(): Promise<SocialState> {
    const id = this.requireAccount();
    const r = await this.authority.call<{ friends: Friend[]; requests: FriendRequest[]; blocked: SocialUser[] }>(id, 'GET', '/v1/social');
    this.setState({ friends: r.friends, requests: r.requests, blocked: r.blocked });
    return this.state;
  }

  async search(q: string): Promise<SocialUser[]> {
    const term = q.trim();
    if (!/^[A-Za-z0-9_]{3,16}$/.test(term)) return [];
    return (await this.authority.call<{ users: SocialUser[] }>(this.requireAccount(), 'GET', `/v1/users/search?q=${encodeURIComponent(term)}`)).users;
  }

  async sendRequest(uuid: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'POST', '/v1/friends/requests', { to: uuid });
    await this.refreshOverview();
  }
  async respond(requestId: string, accept: boolean): Promise<void> {
    await this.authority.call(this.requireAccount(), 'POST', `/v1/friends/requests/${encodeURIComponent(requestId)}/${accept ? 'accept' : 'decline'}`);
    await this.refreshOverview();
  }
  async cancelRequest(requestId: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'DELETE', `/v1/friends/requests/${encodeURIComponent(requestId)}`);
    await this.refreshOverview();
  }
  async removeFriend(uuid: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'DELETE', `/v1/friends/${encodeURIComponent(uuid)}`);
    await this.refreshOverview();
  }
  async block(uuid: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'POST', '/v1/blocks', { uuid });
    await this.refreshOverview();
  }
  async unblock(uuid: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'DELETE', `/v1/blocks/${encodeURIComponent(uuid)}`);
    await this.refreshOverview();
  }
  async report(uuid: string, reason: string, messageId?: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'POST', '/v1/reports', { uuid, reason: reason.slice(0, 500), messageId });
  }
  async updatePrivacy(presence: 'friends' | 'nobody', allowRequests: boolean): Promise<void> {
    if (!this.accountId || this.state.connection === 'disabled') return;
    await this.authority.call(this.accountId, 'PUT', '/v1/settings/social', { presence, allowRequests });
  }

  async history(peer: string, before?: number): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
    const q = new URLSearchParams({ limit: '40' });
    if (before) q.set('before', String(before));
    const r = await this.authority.call<{ messages: unknown[]; hasMore: boolean }>(this.requireAccount(), 'GET', `/v1/messages/${encodeURIComponent(peer)}?${q}`);
    return { messages: r.messages.map((m) => toChat(m, 'sent')).filter((m): m is ChatMessage => !!m), hasMore: r.hasMore };
  }

  async markRead(peer: string): Promise<void> {
    await this.authority.call(this.requireAccount(), 'POST', `/v1/messages/${encodeURIComponent(peer)}/read`);
    this.setState({ friends: this.state.friends.map((f) => (f.uuid === peer ? { ...f, unread: 0 } : f)) });
  }

  send(peer: string, body: string, clientId: string): void {
    this.requireAccount();
    const text = body.trim();
    if (!text || [...text].length > 2000) throw new AppError('VALIDATION', 'mensaje');
    if (!/^[\w-]{1,64}$/.test(clientId)) throw new AppError('VALIDATION', 'clientId');
    const o: Outgoing = { clientId, to: peer, body: text, attempts: 1, queuedAt: Date.now() };
    this.outbox.set(clientId, o);
    // Si no hay conexión, queda en cola y se reintenta al reconectar (máx. 3 intentos / 5 min).
    this.sendRaw({ type: 'send', to: peer, body: text, clientId });
  }

  typing(peer: string): void {
    this.sendRaw({ type: 'typing', to: peer });
  }

  setPresence(p: 'online' | 'away'): void {
    if (this.presence === p) return;
    this.presence = p;
    this.sendRaw({ type: 'presence', status: p });
  }
}

function toChat(raw: unknown, state: ChatMessage['state']): ChatMessage | null {
  const m = raw as { id?: string; from?: string; to?: string; body?: string; sentAt?: number; deliveredAt?: number };
  if (!m?.id || !m.from || !m.to || typeof m.body !== 'string' || !m.sentAt) return null;
  return { id: m.id, from: m.from, to: m.to, body: m.body, sentAt: m.sentAt, deliveredAt: m.deliveredAt, state: m.deliveredAt ? 'delivered' : state };
}

export function newClientId(): string {
  return crypto.randomBytes(9).toString('base64url');
}
