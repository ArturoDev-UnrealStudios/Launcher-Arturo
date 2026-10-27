import { useEffect, useMemo, useRef, useState } from 'react';
import { LuBan, LuEllipsis, LuFlag, LuMessageCircle, LuSearch, LuSend, LuUserMinus, LuUserPlus, LuWifiOff } from 'react-icons/lu';
import type { ChatMessage, Friend, SocialUser } from '../../shared/types';
import { useAction } from '../components/common';
import { Button, Callout, Empty, Field, Modal, useMenu } from '../components/ui';
import { api, call } from '../lib/api';
import { ago, time } from '../lib/format';
import { t, useLang } from '../lib/i18n';
import { useApp } from '../lib/store';

function presenceLabel(f: Friend): string {
  if (f.presence === 'online') return t('En línea');
  if (f.presence === 'away') return t('Ausente');
  return f.lastSeenAt ? t('Última vez {when}', { when: ago(f.lastSeenAt) }) : t('Desconectado');
}

function newClientId(): string {
  const a = new Uint8Array(9);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function Chat({ friend, me }: { friend: Friend; me: string }) {
  const { settings } = useApp();
  const lang = useLang();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [reporting, setReporting] = useState<ChatMessage | null | undefined>(undefined);
  const logRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);
  const typingTimer = useRef<number | undefined>(undefined);
  const run = useAction();
  const menu = useMenu();

  useEffect(() => {
    setMessages([]);
    call(api.social.history(friend.uuid))
      .then((r) => {
        setMessages(r.messages);
        setHasMore(r.hasMore);
        requestAnimationFrame(() => logRef.current?.scrollTo({ top: 1e9 }));
      })
      .catch(() => undefined);
    void api.social.markRead(friend.uuid);
    return api.on.social((e) => {
      if (e.type === 'message' && e.message.from === friend.uuid) {
        setMessages((m) => [...m, e.message]);
        setTyping(false);
        void api.social.markRead(friend.uuid);
      } else if (e.type === 'ack' && e.message.to === friend.uuid) {
        setMessages((m) => {
          const i = m.findIndex((x) => x.clientId && x.clientId === e.clientId);
          if (i >= 0) return m.map((x, j) => (j === i ? { ...e.message, state: 'sent' } : x));
          return m.some((x) => x.id === e.message.id) ? m : [...m, { ...e.message, state: 'sent' }];
        });
      } else if (e.type === 'delivered' && e.peer === friend.uuid) {
        setMessages((m) => m.map((x) => (x.id === e.id ? { ...x, state: 'delivered', deliveredAt: e.at } : x)));
      } else if (e.type === 'send-failed') {
        setMessages((m) => m.map((x) => (x.clientId === e.clientId ? { ...x, state: 'failed' } : x)));
      } else if (e.type === 'typing' && e.from === friend.uuid) {
        setTyping(true);
        window.clearTimeout(typingTimer.current);
        typingTimer.current = window.setTimeout(() => setTyping(false), 4000);
      }
    });
  }, [friend.uuid]);

  useEffect(() => {
    const el = logRef.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTo({ top: el.scrollHeight });
  }, [messages.length]);

  const send = () => {
    const body = text.trim();
    if (!body || [...body].length > 2000) return;
    const clientId = newClientId();
    setMessages((m) => [...m, { id: clientId, clientId, from: me, to: friend.uuid, body, sentAt: Date.now(), state: 'sending' }]);
    setText('');
    void call(api.social.send(friend.uuid, body, clientId)).catch(() => setMessages((m) => m.map((x) => (x.clientId === clientId ? { ...x, state: 'failed' } : x))));
  };

  const loadOlder = async () => {
    const r = await run(() => call(api.social.history(friend.uuid, messages[0]?.sentAt)));
    if (r) {
      setMessages((m) => [...r.messages, ...m]);
      setHasMore(r.hasMore);
    }
  };

  const stateText = (m: ChatMessage) => (m.state === 'sending' ? t('Enviando') : m.state === 'delivered' ? t('Entregado') : m.state === 'failed' ? t('No enviado') : t('Enviado'));

  return (
    <section className="panel chat" aria-label={friend.name}>
      <div className="chat-head">
        <span className={`dot ${friend.presence}`} aria-hidden />
        <div className="stack" style={{ gap: 0, flex: 1 }}>
          <strong>{friend.name}</strong>
          <span className="muted xs">{presenceLabel(friend)}</span>
        </div>
        <div ref={menu.ref} style={{ position: 'relative' }}>
          <Button variant="ghost" iconOnly icon={<LuEllipsis />} aria-haspopup="menu" aria-expanded={menu.open} onClick={() => menu.setOpen(!menu.open)}>
            {t('Detalles')}
          </Button>
          {menu.open && (
            <div className="menu" role="menu" style={{ right: 0, top: 40 }}>
              <button role="menuitem" onClick={() => (menu.setOpen(false), setReporting(null))}>
                <LuFlag /> {t('Denunciar')}
              </button>
              <button role="menuitem" onClick={() => (menu.setOpen(false), void run(() => call(api.social.removeFriend(friend.uuid))))}>
                <LuUserMinus /> {t('Eliminar amigo')}
              </button>
              <hr />
              <button role="menuitem" className="danger" onClick={() => (menu.setOpen(false), void run(() => call(api.social.block(friend.uuid))))}>
                <LuBan /> {t('Bloquear')}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="chat-log" ref={logRef} role="log" aria-live="polite">
        {hasMore && (
          <Button size="sm" variant="ghost" onClick={() => void loadOlder()} style={{ alignSelf: 'center' }}>
            {t('Cargar anteriores')}
          </Button>
        )}
        {messages.map((m) => {
          const mine = m.from === me;
          return (
            <div key={m.id} className={`bubble${mine ? ' mine' : ''}${m.state === 'failed' ? ' failed' : ''}`} onContextMenu={(e) => !mine && (e.preventDefault(), setReporting(m))}>
              {m.body}
              <span className="stamp">
                {time(m.sentAt, lang)}
                {mine ? ` — ${stateText(m)}` : ''}
              </span>
            </div>
          );
        })}
      </div>
      <div className="typing" aria-live="polite">
        {typing ? `${friend.name} ${t('escribiendo…')}` : ''}
      </div>
      <form
        className="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          className="textarea"
          value={text}
          placeholder={t('Escribe un mensaje')}
          aria-label={t('Escribe un mensaje')}
          maxLength={2000}
          onChange={(e) => {
            setText(e.target.value);
            if (Date.now() - lastTyping.current > 3000) {
              lastTyping.current = Date.now();
              void api.social.typing(friend.uuid);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && settings?.social.enterToSend !== false) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button type="submit" variant="primary" iconOnly icon={<LuSend />} disabled={!text.trim()}>
          {t('Enviar')}
        </Button>
      </form>
      {reporting !== undefined && <ReportModal user={friend} message={reporting} onClose={() => setReporting(undefined)} />}
    </section>
  );
}

function ReportModal({ user, message, onClose }: { user: SocialUser; message: ChatMessage | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const run = useAction();
  return (
    <Modal
      title={`${t('Denunciar')} ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('Cancelar')}</Button>
          <Button
            variant="danger"
            busy={busy}
            disabled={!reason.trim()}
            onClick={async () => {
              setBusy(true);
              const ok = await run(() => call(api.social.report(user.uuid, reason.trim(), message?.id)), t('Denuncia enviada'));
              setBusy(false);
              if (ok !== undefined) onClose();
            }}
          >
            {t('Denunciar')}
          </Button>
        </>
      }
    >
      {message && <p className="muted small" style={{ marginBottom: 12 }}>“{message.body.slice(0, 200)}”</p>}
      <Field label={t('Motivo de la denuncia')} htmlFor="rep">
        <textarea id="rep" className="textarea" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus />
      </Field>
    </Modal>
  );
}

function FindPlayers() {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SocialUser[]>();
  const [busy, setBusy] = useState(false);
  const run = useAction();
  return (
    <div className="stack" style={{ padding: 12, gap: 10 }}>
      <form
        className="input-group"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setRes(await run(() => call(api.social.search(q))));
          setBusy(false);
        }}
      >
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Nombre de Minecraft')} aria-label={t('Buscar jugadores')} maxLength={16} />
        <Button type="submit" variant="ghost" iconOnly icon={<LuSearch />} busy={busy} disabled={q.trim().length < 3}>
          {t('Buscar')}
        </Button>
      </form>
      {res && !res.length && <span className="muted small">{t('Sin resultados')}</span>}
      {res?.map((u) => (
        <div key={u.uuid} className="row">
          <strong style={{ flex: 1 }}>{u.name}</strong>
          <Button size="sm" icon={<LuUserPlus />} onClick={() => run(() => call(api.social.sendRequest(u.uuid)), t('Solicitud enviada'))}>
            {t('Enviar solicitud')}
          </Button>
        </div>
      ))}
    </div>
  );
}

export default function Social() {
  const { social, active, info, go } = useApp();
  const [tab, setTab] = useState<'friends' | 'requests' | 'blocked' | 'find'>('friends');
  const [peer, setPeer] = useState<string>();
  const run = useAction();
  const friends = social?.friends ?? [];
  const requests = social?.requests ?? [];
  const friend = useMemo(() => friends.find((f) => f.uuid === peer), [friends, peer]);

  if (!active?.premium) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>{t('Social')}</h1>
        </div>
        <Callout action={<Button size="sm" variant="primary" onClick={() => go('profile')}>{t('Iniciar sesión con Microsoft')}</Button>}>
          {t('Amigos y chat requieren una cuenta Microsoft con Minecraft Java Edition.')}
        </Callout>
      </div>
    );
  }
  if (!info?.authorityConfigured || social?.connection === 'disabled') {
    return (
      <div className="page">
        <div className="page-head">
          <h1>{t('Social')}</h1>
        </div>
        <Callout tone="warn">{t('El servicio social no está configurado en esta versión del launcher.')}</Callout>
      </div>
    );
  }

  const incoming = requests.filter((r) => r.direction === 'incoming');
  const outgoing = requests.filter((r) => r.direction === 'outgoing');

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Social')}</h1>
        {social?.connection === 'offline' && (
          <span className="badge warn">
            <LuWifiOff /> {t('Sin conexión con el servicio social. Reintentando…')}
          </span>
        )}
        {social?.connection === 'connecting' && <span className="badge">{t('Conectando…')}</span>}
        {social?.connection === 'unauthorized' && (
          <div className="row">
            <span className="badge danger">{t('Tu sesión social caducó.')}</span>
            <Button size="sm" onClick={() => run(() => call(api.social.connect()))}>
              {t('Reconectar')}
            </Button>
          </div>
        )}
      </div>
      <div className="social-layout">
        <section className="panel social-side" aria-label={t('Amigos')}>
          <div className="tabs" role="tablist">
            {(
              [
                ['friends', t('Amigos')],
                ['requests', `${t('Solicitudes')}${incoming.length ? ` (${incoming.length})` : ''}`],
                ['find', t('Buscar')],
                ['blocked', t('Bloqueados')],
              ] as const
            ).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="friend-list">
            {tab === 'friends' &&
              (friends.length ? (
                friends.map((f) => (
                  <button key={f.uuid} className="friend" aria-selected={f.uuid === peer} onClick={() => setPeer(f.uuid)}>
                    <span className={`dot ${f.presence}`} aria-hidden />
                    <span className="who">
                      <strong>{f.name}</strong>
                      <span>{presenceLabel(f)}</span>
                    </span>
                    {f.unread > 0 && <span className="badge accent">{f.unread}</span>}
                  </button>
                ))
              ) : (
                <p className="muted small" style={{ padding: 8 }}>
                  {t('Aún no tienes amigos. Busca a alguien por su nombre de Minecraft.')}
                </p>
              ))}
            {tab === 'requests' && (
              <div className="stack" style={{ padding: 8 }}>
                <span className="muted xs">{t('Entrantes')}</span>
                {incoming.map((r) => (
                  <div key={r.id} className="row">
                    <strong style={{ flex: 1 }}>{r.name}</strong>
                    <Button size="sm" variant="primary" onClick={() => run(() => call(api.social.respond(r.id, true)))}>
                      {t('Aceptar')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => run(() => call(api.social.respond(r.id, false)))}>
                      {t('Rechazar')}
                    </Button>
                  </div>
                ))}
                <span className="muted xs" style={{ marginTop: 8 }}>
                  {t('Enviadas')}
                </span>
                {outgoing.map((r) => (
                  <div key={r.id} className="row">
                    <strong style={{ flex: 1 }}>{r.name}</strong>
                    <Button size="sm" variant="ghost" onClick={() => run(() => call(api.social.cancelRequest(r.id)))}>
                      {t('Cancelar solicitud')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {tab === 'find' && <FindPlayers />}
            {tab === 'blocked' && (
              <div className="stack" style={{ padding: 8 }}>
                {(social?.blocked ?? []).map((b) => (
                  <div key={b.uuid} className="row">
                    <strong style={{ flex: 1 }}>{b.name}</strong>
                    <Button size="sm" onClick={() => run(() => call(api.social.unblock(b.uuid)))}>
                      {t('Desbloquear')}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
        {friend && social?.me ? (
          <Chat friend={friend} me={social.me.uuid} />
        ) : (
          <section className="panel" style={{ display: 'grid', placeItems: 'center' }}>
            <Empty icon={<LuMessageCircle className="ill" aria-hidden />} title={t('Social')}>
              {friends.length ? t('Elige un amigo para empezar a chatear.') : t('Aún no tienes amigos. Busca a alguien por su nombre de Minecraft.')}
            </Empty>
          </section>
        )}
      </div>
    </div>
  );
}

