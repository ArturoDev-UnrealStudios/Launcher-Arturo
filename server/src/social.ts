import { convId, pair, tx, type DB } from './db';
import { ApiError, newId, RateLimiter, sanitizeMessage, UUID_RE } from './util';

export type Presence = 'online' | 'away' | 'offline';

export interface MessageRow {
  id: string;
  from: string;
  to: string;
  body: string;
  sentAt: number;
  deliveredAt?: number;
}

/** Notificador de tiempo real (lo implementa el hub WebSocket). */
export interface Notifier {
  toUser(uuid: string, event: Record<string, unknown>): boolean;
  presenceOf(uuid: string): Presence;
}

/**
 * Lógica social. TODAS las comprobaciones de permisos se hacen aquí, en el servidor,
 * en cada operación; la interfaz del launcher nunca decide quién puede leer o escribir.
 */
export class SocialService {
  private readonly requestLimiter = new RateLimiter(20, 3600_000);
  private readonly msgBurst = new RateLimiter(8, 5_000);
  private readonly msgMinute = new RateLimiter(60, 60_000);
  private readonly searchLimiter = new RateLimiter(30, 60_000);
  private readonly reportLimiter = new RateLimiter(10, 3600_000);
  notifier: Notifier = { toUser: () => false, presenceOf: () => 'offline' };

  constructor(private readonly db: DB) {}

  private user(uuid: string): { uuid: string; name: string; presence_visibility: string; allow_requests: number; last_seen_at: number | null } | undefined {
    return this.db.prepare('SELECT uuid, name, presence_visibility, allow_requests, last_seen_at FROM users WHERE uuid = ?').get(uuid) as never;
  }

  private checkUuid(u: unknown): string {
    if (typeof u !== 'string' || !UUID_RE.test(u)) throw new ApiError(400, 'VALIDATION', 'uuid');
    return u;
  }

  areFriends(a: string, b: string): boolean {
    const [x, y] = pair(a, b);
    return !!this.db.prepare('SELECT 1 FROM friendships WHERE a = ? AND b = ?').get(x, y);
  }

  isBlockedEitherWay(a: string, b: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM blocks WHERE (blocker = ? AND blocked = ?) OR (blocker = ? AND blocked = ?)').get(a, b, b, a);
  }

  search(me: string, q: unknown): Array<{ uuid: string; name: string }> {
    if (!this.searchLimiter.hit(me)) throw new ApiError(429, 'RATE_LIMITED');
    if (typeof q !== 'string') throw new ApiError(400, 'VALIDATION');
    const term = q.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,16}$/.test(term)) return [];
    const rows = this.db
      .prepare(
        `SELECT uuid, name FROM users WHERE name_lower LIKE ? ESCAPE '\\' AND uuid != ?
         AND uuid NOT IN (SELECT blocked FROM blocks WHERE blocker = ?) AND uuid NOT IN (SELECT blocker FROM blocks WHERE blocked = ?)
         ORDER BY (name_lower = ?) DESC, name_lower LIMIT 10`,
      )
      .all(`${term.replace(/_/g, '\\_')}%`, me, me, me, term) as Array<{ uuid: string; name: string }>;
    return rows.map((r) => ({ uuid: r.uuid, name: r.name }));
  }

  sendRequest(me: string, to: unknown): { status: 'sent' | 'accepted' } {
    const target = this.checkUuid(to);
    if (target === me) throw new ApiError(400, 'VALIDATION', 'self');
    if (!this.requestLimiter.hit(me)) throw new ApiError(429, 'RATE_LIMITED');
    const t = this.user(target);
    if (!t) throw new ApiError(404, 'NOT_FOUND');
    // Mismo error para "bloqueado" y "no acepta solicitudes": no se revela el motivo.
    if (this.isBlockedEitherWay(me, target) || !t.allow_requests) throw new ApiError(403, 'FORBIDDEN');
    if (this.areFriends(me, target)) throw new ApiError(409, 'CONFLICT', 'ya sois amigos');
    const result = tx(this.db, () => {
      const reverse = this.db.prepare('SELECT id FROM friend_requests WHERE from_uuid = ? AND to_uuid = ?').get(target, me) as { id: string } | undefined;
      if (reverse) {
        this.db.prepare('DELETE FROM friend_requests WHERE id = ?').run(reverse.id);
        const [a, b] = pair(me, target);
        this.db.prepare('INSERT OR IGNORE INTO friendships (a, b, created_at) VALUES (?, ?, ?)').run(a, b, Date.now());
        return 'accepted' as const;
      }
      const pending = this.db.prepare('SELECT COUNT(*) AS n FROM friend_requests WHERE from_uuid = ?').get(me) as { n: number };
      if (pending.n >= 50) throw new ApiError(429, 'RATE_LIMITED', 'demasiadas solicitudes pendientes');
      this.db.prepare('INSERT OR IGNORE INTO friend_requests (id, from_uuid, to_uuid, created_at) VALUES (?, ?, ?, ?)').run(newId(), me, target, Date.now());
      return 'sent' as const;
    });
    this.notifier.toUser(target, { type: 'friends-changed' });
    if (result === 'accepted') this.notifier.toUser(me, { type: 'friends-changed' });
    return { status: result };
  }

  respond(me: string, requestId: unknown, accept: boolean): void {
    if (typeof requestId !== 'string' || requestId.length > 64) throw new ApiError(400, 'VALIDATION');
    const req = this.db.prepare('SELECT id, from_uuid, to_uuid FROM friend_requests WHERE id = ?').get(requestId) as { id: string; from_uuid: string; to_uuid: string } | undefined;
    // Solo el destinatario puede responder; a cualquier otro se le responde como si no existiera.
    if (!req || req.to_uuid !== me) throw new ApiError(404, 'NOT_FOUND');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM friend_requests WHERE id = ?').run(req.id);
      if (accept && !this.isBlockedEitherWay(req.from_uuid, me)) {
        const [a, b] = pair(req.from_uuid, me);
        this.db.prepare('INSERT OR IGNORE INTO friendships (a, b, created_at) VALUES (?, ?, ?)').run(a, b, Date.now());
      }
    });
    this.notifier.toUser(req.from_uuid, { type: 'friends-changed' });
    this.notifier.toUser(me, { type: 'friends-changed' });
  }

  cancelRequest(me: string, requestId: unknown): void {
    if (typeof requestId !== 'string' || requestId.length > 64) throw new ApiError(400, 'VALIDATION');
    const req = this.db.prepare('SELECT id, from_uuid, to_uuid FROM friend_requests WHERE id = ?').get(requestId) as { id: string; from_uuid: string; to_uuid: string } | undefined;
    if (!req || req.from_uuid !== me) throw new ApiError(404, 'NOT_FOUND');
    this.db.prepare('DELETE FROM friend_requests WHERE id = ?').run(req.id);
    this.notifier.toUser(req.to_uuid, { type: 'friends-changed' });
  }

  removeFriend(me: string, other: unknown): void {
    const o = this.checkUuid(other);
    const [a, b] = pair(me, o);
    this.db.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').run(a, b);
    this.notifier.toUser(o, { type: 'friends-changed' });
  }

  block(me: string, other: unknown): void {
    const o = this.checkUuid(other);
    if (o === me) throw new ApiError(400, 'VALIDATION');
    tx(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO blocks (blocker, blocked, created_at) VALUES (?, ?, ?)').run(me, o, Date.now());
      const [a, b] = pair(me, o);
      this.db.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').run(a, b);
      this.db.prepare('DELETE FROM friend_requests WHERE (from_uuid = ? AND to_uuid = ?) OR (from_uuid = ? AND to_uuid = ?)').run(me, o, o, me);
    });
    this.notifier.toUser(o, { type: 'friends-changed' });
  }

  unblock(me: string, other: unknown): void {
    const o = this.checkUuid(other);
    this.db.prepare('DELETE FROM blocks WHERE blocker = ? AND blocked = ?').run(me, o);
  }

  report(me: string, target: unknown, reason: unknown, messageId: unknown): void {
    const t = this.checkUuid(target);
    if (!this.reportLimiter.hit(me)) throw new ApiError(429, 'RATE_LIMITED');
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) throw new ApiError(400, 'VALIDATION', 'reason');
    let mid: string | null = null;
    if (typeof messageId === 'string' && messageId) {
      // Solo se puede denunciar un mensaje de una conversación propia.
      const m = this.db.prepare('SELECT id FROM messages WHERE id = ? AND sender = ? AND recipient = ?').get(messageId, t, me);
      if (!m) throw new ApiError(404, 'NOT_FOUND');
      mid = messageId;
    }
    this.db.prepare('INSERT INTO reports (id, reporter, target, reason, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId(), me, t, reason.trim(), mid, Date.now());
  }

  private visiblePresence(viewer: string, u: { uuid: string; presence_visibility: string; last_seen_at: number | null }): { presence: Presence; lastSeenAt?: number } {
    if (u.presence_visibility === 'nobody' || !this.areFriends(viewer, u.uuid)) return { presence: 'offline' };
    return { presence: this.notifier.presenceOf(u.uuid), lastSeenAt: u.last_seen_at ?? undefined };
  }

  overview(me: string) {
    const friendRows = this.db
      .prepare(
        `SELECT u.uuid, u.name, u.presence_visibility, u.last_seen_at FROM friendships f
         JOIN users u ON u.uuid = CASE WHEN f.a = ? THEN f.b ELSE f.a END
         WHERE f.a = ? OR f.b = ? ORDER BY u.name_lower`,
      )
      .all(me, me, me) as Array<{ uuid: string; name: string; presence_visibility: string; last_seen_at: number | null }>;
    const unread = new Map(
      (this.db.prepare('SELECT sender, COUNT(*) AS n FROM messages WHERE recipient = ? AND read_at IS NULL GROUP BY sender').all(me) as Array<{ sender: string; n: number }>).map((r) => [r.sender, r.n]),
    );
    const friends = friendRows.map((u) => ({ uuid: u.uuid, name: u.name, ...this.visiblePresence(me, u), unread: unread.get(u.uuid) ?? 0 }));
    const requests = (
      this.db
        .prepare(
          `SELECT r.id, r.from_uuid, r.to_uuid, r.created_at, uf.name AS from_name, ut.name AS to_name FROM friend_requests r
           JOIN users uf ON uf.uuid = r.from_uuid JOIN users ut ON ut.uuid = r.to_uuid WHERE r.from_uuid = ? OR r.to_uuid = ? ORDER BY r.created_at DESC`,
        )
        .all(me, me) as Array<{ id: string; from_uuid: string; to_uuid: string; created_at: number; from_name: string; to_name: string }>
    ).map((r) =>
      r.to_uuid === me
        ? { id: r.id, uuid: r.from_uuid, name: r.from_name, direction: 'incoming' as const, createdAt: r.created_at }
        : { id: r.id, uuid: r.to_uuid, name: r.to_name, direction: 'outgoing' as const, createdAt: r.created_at },
    );
    const blocked = this.db
      .prepare('SELECT b.blocked AS uuid, COALESCE(u.name, b.blocked) AS name FROM blocks b LEFT JOIN users u ON u.uuid = b.blocked WHERE b.blocker = ?')
      .all(me) as Array<{ uuid: string; name: string }>;
    return { friends, requests, blocked: blocked.map((b) => ({ uuid: b.uuid, name: b.name })) };
  }

  /** Envía un mensaje. Comprueba amistad, bloqueos, tamaño y frecuencia en cada envío. */
  send(me: string, to: unknown, body: unknown): MessageRow {
    const target = this.checkUuid(to);
    if (!this.msgBurst.hit(me) || !this.msgMinute.hit(me)) throw new ApiError(429, 'RATE_LIMITED');
    const clean = sanitizeMessage(body);
    if (!clean) throw new ApiError(400, 'VALIDATION', 'mensaje vacío o demasiado largo');
    if (this.isBlockedEitherWay(me, target)) throw new ApiError(403, 'SOCIAL_BLOCKED');
    if (!this.areFriends(me, target)) throw new ApiError(403, 'SOCIAL_NOT_FRIENDS');
    const msg: MessageRow = { id: newId(), from: me, to: target, body: clean, sentAt: Date.now() };
    this.db.prepare('INSERT INTO messages (id, conv, sender, recipient, body, sent_at) VALUES (?, ?, ?, ?, ?, ?)').run(msg.id, convId(me, target), me, target, clean, msg.sentAt);
    return msg;
  }

  markDelivered(me: string, messageId: unknown): { id: string; from: string; at: number } | null {
    if (typeof messageId !== 'string' || messageId.length > 64) return null;
    const at = Date.now();
    const r = this.db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ? AND recipient = ? AND delivered_at IS NULL').run(at, messageId, me);
    if (Number(r.changes) !== 1) return null;
    const m = this.db.prepare('SELECT sender FROM messages WHERE id = ?').get(messageId) as { sender: string };
    return { id: messageId, from: m.sender, at };
  }

  markRead(me: string, peer: unknown): void {
    const p = this.checkUuid(peer);
    const now = Date.now();
    this.db.prepare('UPDATE messages SET read_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE recipient = ? AND sender = ? AND read_at IS NULL').run(now, now, me, p);
  }

  history(me: string, peer: unknown, before: unknown, limit: unknown): { messages: MessageRow[]; hasMore: boolean } {
    const p = this.checkUuid(peer);
    // Solo participantes de la conversación y mientras sean amigos.
    if (!this.areFriends(me, p)) throw new ApiError(403, 'SOCIAL_NOT_FRIENDS');
    const lim = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const b = Number(before) > 0 ? Number(before) : Number.MAX_SAFE_INTEGER;
    const rows = this.db
      .prepare('SELECT id, sender, recipient, body, sent_at, delivered_at FROM messages WHERE conv = ? AND sent_at < ? ORDER BY sent_at DESC LIMIT ?')
      .all(convId(me, p), b, lim + 1) as Array<{ id: string; sender: string; recipient: string; body: string; sent_at: number; delivered_at: number | null }>;
    const hasMore = rows.length > lim;
    const messages = rows
      .slice(0, lim)
      .reverse()
      .map((r) => ({ id: r.id, from: r.sender, to: r.recipient, body: r.body, sentAt: r.sent_at, deliveredAt: r.delivered_at ?? undefined }));
    return { messages, hasMore };
  }

  updatePrivacy(me: string, body: { presence?: unknown; allowRequests?: unknown }): void {
    if (body.presence !== undefined) {
      if (body.presence !== 'friends' && body.presence !== 'nobody') throw new ApiError(400, 'VALIDATION');
      this.db.prepare('UPDATE users SET presence_visibility = ? WHERE uuid = ?').run(body.presence, me);
    }
    if (body.allowRequests !== undefined) {
      if (typeof body.allowRequests !== 'boolean') throw new ApiError(400, 'VALIDATION');
      this.db.prepare('UPDATE users SET allow_requests = ? WHERE uuid = ?').run(body.allowRequests ? 1 : 0, me);
    }
  }

  touch(me: string): void {
    this.db.prepare('UPDATE users SET last_seen_at = ? WHERE uuid = ?').run(Date.now(), me);
  }

  friendsOf(me: string): string[] {
    return (this.db.prepare('SELECT CASE WHEN a = ? THEN b ELSE a END AS u FROM friendships WHERE a = ? OR b = ?').all(me, me, me) as Array<{ u: string }>).map((r) => r.u);
  }

  presenceVisibility(me: string): string {
    return this.user(me)?.presence_visibility ?? 'friends';
  }
}
