import { useEffect, useState } from 'react';
import { LuEye, LuEyeOff, LuKeyRound, LuRefreshCw, LuShieldCheck } from 'react-icons/lu';
import type { KeyRedemption } from '../../shared/types';
import { Cover } from '../components/Cover';
import { useAction } from '../components/common';
import { Button, Callout, Field } from '../components/ui';
import { api, call, errOf } from '../lib/api';
import { date, LOADER_LABEL } from '../lib/format';
import { describeError, t, useLang } from '../lib/i18n';
import { useApp } from '../lib/store';

const KEY_RE = /^UNRL(-[A-Z2-7]{5}){5}$/;

/** Da formato mientras se escribe: UNRL-XXXXX-XXXXX-… */
function formatKey(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const body = clean.startsWith('UNRL') ? clean.slice(4) : clean;
  const groups = body.slice(0, 25).match(/.{1,5}/g) ?? [];
  return ['UNRL', ...groups].join('-').replace(/^UNRL$/, clean ? 'UNRL' : '');
}

export default function Keys() {
  const { info, active, go, selectInstance } = useApp();
  const lang = useLang();
  const [key, setKey] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<KeyRedemption>();
  const [history, setHistory] = useState<KeyRedemption[]>([]);
  const run = useAction();

  useEffect(() => {
    call(api.keys.history()).then(setHistory).catch(() => undefined);
  }, [result]);

  const valid = KEY_RE.test(key);
  const submit = async () => {
    setBusy(true);
    setError(null);
    setResult(undefined);
    try {
      const r = await call(api.keys.redeem(key));
      setResult(r);
      setKey('');
    } catch (e) {
      setError(describeError(errOf(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Agregar clave')}</h1>
          <p>{t('Las claves desbloquean instancias privadas. Se validan con la autoridad del launcher; nunca se guardan completas en tu equipo.')}</p>
        </div>
      </div>
      {!info?.authorityConfigured && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warn">{t('El servicio de claves no está configurado en esta versión del launcher.')}</Callout>
        </div>
      )}
      <div className="key-stage">
        <section className="panel stack" style={{ gap: 16 }}>
          <form
            className="stack"
            style={{ gap: 16 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (valid && !busy) void submit();
            }}
          >
            <Field label={t('Clave de acceso')} htmlFor="key" error={error} hint={t('El formato es UNRL- seguido de 5 grupos de 5 caracteres.')}>
              <div className="input-group">
                <input
                  id="key"
                  className="input key-input"
                  type={show ? 'text' : 'password'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="UNRL-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX"
                  value={key}
                  aria-invalid={!!error}
                  onChange={(e) => {
                    setKey(formatKey(e.target.value));
                    setError(null);
                  }}
                  style={{ height: 56, paddingRight: 52 }}
                  data-autofocus
                />
                <Button variant="ghost" iconOnly icon={show ? <LuEyeOff /> : <LuEye />} onClick={() => setShow(!show)} style={{ top: 11 }}>
                  {show ? t('Ocultar clave') : t('Mostrar clave')}
                </Button>
              </div>
            </Field>
            <div className="row">
              <Button type="submit" variant="primary" size="lg" icon={<LuKeyRound />} busy={busy} disabled={!valid || !active || !info?.authorityConfigured}>
                {busy ? t('Comprobando clave') : t('Canjear clave')}
              </Button>
              {!active && (
                <Button variant="ghost" onClick={() => go('profile')}>
                  {t('Inicia sesión para jugar')}
                </Button>
              )}
            </div>
          </form>
          {result && (
            <div className="key-result" role="status">
              <span className="cover-thumb" style={{ width: 72, height: 72 }}>
                <Cover cover="end" seed={result.instanceId} width={36} height={36} />
              </span>
              <div className="stack" style={{ gap: 6, flex: 1 }}>
                <span className="badge ok" style={{ alignSelf: 'flex-start' }}>
                  <LuShieldCheck /> {t('Instancia desbloqueada')}
                </span>
                <h3>{result.instanceName}</h3>
                <span className="muted small">
                  Minecraft {result.mcVersion} {LOADER_LABEL[result.loader.kind]}
                  {result.expiresAt ? ` — ${t('Caduca {date}', { date: date(result.expiresAt, lang) })}` : ''}
                </span>
                <div className="row" style={{ marginTop: 6 }}>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      selectInstance(result.instanceId);
                      await run(() => call(api.instances.install(result.instanceId)));
                      go('instances', result.instanceId);
                    }}
                  >
                    {t('Instalar ahora')}
                  </Button>
                  <Button onClick={() => go('instances', result.instanceId)}>{t('Ir a la instancia')}</Button>
                </div>
              </div>
            </div>
          )}
        </section>
        <section className="panel">
          <div className="panel-title">
            <span>{t('Claves canjeadas')}</span>
            <Button size="sm" variant="ghost" iconOnly icon={<LuRefreshCw />} onClick={() => run(() => call(api.keys.refreshGrants()))}>
              {t('Actualizar')}
            </Button>
          </div>
          {history.length ? (
            history.map((h) => (
              <div className="history-row" key={`${h.instanceId}-${h.redeemedAt}`}>
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                  <strong>{h.instanceName}</strong>
                  <span className="muted xs">
                    {h.keyHint}… — {date(h.redeemedAt, lang)}
                  </span>
                </div>
                <Button size="sm" onClick={() => go('instances', h.instanceId)}>
                  {t('Abrir')}
                </Button>
              </div>
            ))
          ) : (
            <p className="muted small">{t('Todavía no has canjeado ninguna clave.')}</p>
          )}
        </section>
      </div>
    </div>
  );
}
