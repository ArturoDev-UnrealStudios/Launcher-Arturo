import { useState } from 'react';
import { LuLogOut, LuRefreshCw, LuShieldAlert, LuShieldCheck } from 'react-icons/lu';
import type { AccountSummary } from '../../shared/types';
import { Avatar, useAction } from '../components/common';
import { Button, Callout, Confirm, Field, Modal } from '../components/ui';
import { api, call, errOf } from '../lib/api';
import { ago } from '../lib/format';
import { describeError, t } from '../lib/i18n';
import { useApp } from '../lib/store';

function MicrosoftMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect width="7.5" height="7.5" fill="#f25022" />
      <rect x="8.5" width="7.5" height="7.5" fill="#7fba00" />
      <rect y="8.5" width="7.5" height="7.5" fill="#00a4ef" />
      <rect x="8.5" y="8.5" width="7.5" height="7.5" fill="#ffb900" />
    </svg>
  );
}

export default function Profile() {
  const { accounts, active, refreshAccounts, info } = useApp();
  const [waiting, setWaiting] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  const [offName, setOffName] = useState('');
  const [offErr, setOffErr] = useState<string | null>(null);
  const [offBusy, setOffBusy] = useState(false);
  const [logout, setLogout] = useState<AccountSummary>();
  const run = useAction();

  const login = async () => {
    setLoginErr(null);
    setWaiting(true);
    try {
      await call(api.accounts.loginMicrosoft());
      await refreshAccounts();
      run(async () => undefined, t('Licencia verificada'));
    } catch (e) {
      const err = errOf(e);
      if (err.code !== 'AUTH_CANCELLED') setLoginErr(describeError(err));
    } finally {
      setWaiting(false);
    }
  };

  const offValid = /^[A-Za-z0-9_]{3,16}$/.test(offName);
  const addOffline = async () => {
    setOffBusy(true);
    setOffErr(null);
    try {
      await call(api.accounts.addOffline(offName));
      setOffName('');
      await refreshAccounts();
    } catch (e) {
      setOffErr(describeError(errOf(e)));
    } finally {
      setOffBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Perfil y cuenta')}</h1>
          {!active && <p>{t('Usa tu cuenta Microsoft con Minecraft Java Edition o crea un perfil offline.')}</p>}
        </div>
      </div>

      {active && (
        <section className="panel row" style={{ gap: 20, marginBottom: 16, padding: 24 }}>
          <Avatar account={active} size="lg" />
          <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
            <h2>{active.username}</h2>
            <div className="row wrap">
              {active.premium ? (
                <span className="badge ok">
                  <LuShieldCheck /> {t('Licencia verificada')}
                </span>
              ) : active.kind === 'offline' ? (
                <span className="badge warn">
                  <LuShieldAlert /> {t('Identidad no verificada')}
                </span>
              ) : (
                <span className="badge danger">{t('Volver a iniciar sesión')}</span>
              )}
              <span className="badge">{active.kind === 'microsoft' ? 'Microsoft' : t('Offline')}</span>
              <span className="muted xs num" style={{ userSelect: 'text' }}>
                {active.uuid}
              </span>
            </div>
            {active.kind === 'microsoft' && active.lastValidatedAt && <span className="muted xs">{ago(active.lastValidatedAt)}</span>}
          </div>
          {active.kind === 'microsoft' && (
            <Button icon={<LuRefreshCw />} onClick={() => run(() => call(api.accounts.refresh(active.id)).then(refreshAccounts))}>
              {t('Actualizar')}
            </Button>
          )}
        </section>
      )}

      {info?.secureStorage === 'unavailable' && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="warn">{t('El almacenamiento seguro del sistema no está disponible: las sesiones no se recordarán al reiniciar.')}</Callout>
        </div>
      )}

      <div className="welcome">
        <section className="panel stack" style={{ gap: 14 }}>
          <h3>{t('Premium')}</h3>
          <p className="muted small">{t('Las skins personalizadas requieren una cuenta Microsoft con Minecraft Java Edition.')}</p>
          {!info?.microsoftConfigured && <Callout tone="warn">{t('Inicio de sesión con Microsoft no configurado en esta compilación.')}</Callout>}
          <div>
            <Button variant="primary" size="lg" icon={<MicrosoftMark />} disabled={!info?.microsoftConfigured} onClick={() => void login()}>
              {t('Iniciar sesión con Microsoft')}
            </Button>
          </div>
          {loginErr && <Callout tone="danger">{loginErr}</Callout>}
        </section>
        <section className="panel stack" style={{ gap: 14 }}>
          <h3>{t('Jugar sin conexión')}</h3>
          <p className="muted small">{t('La identidad offline no está verificada: no da acceso a servidores con autenticación oficial, skins ni social.')}</p>
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (offValid) void addOffline();
            }}
          >
            <Field label={t('Nombre de usuario offline')} htmlFor="off" error={offErr ?? (offName && !offValid ? t('Entre 3 y 16 caracteres: letras, números y _.') : null)} hint={t('Entre 3 y 16 caracteres: letras, números y _.')}>
              <input id="off" className="input" value={offName} maxLength={16} onChange={(e) => setOffName(e.target.value)} aria-invalid={!!offName && !offValid} autoComplete="off" spellCheck={false} />
            </Field>
            <div>
              <Button type="submit" busy={offBusy} disabled={!offValid}>
                {t('Crear perfil offline')}
              </Button>
            </div>
          </form>
        </section>
      </div>

      {accounts.length > 0 && (
        <section style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 12 }}>{t('Cuentas guardadas')}</h3>
          <div className="stack" style={{ gap: 8 }}>
            {accounts.map((a) => (
              <div key={a.id} className={`account-row${a.id === active?.id ? ' active' : ''}`}>
                <Avatar account={a} />
                <div className="stack" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                  <strong>{a.username}</strong>
                  <span className="muted xs">
                    {a.kind === 'microsoft' ? (a.status === 'ok' ? t('Licencia verificada') : t('Volver a iniciar sesión')) : t('Identidad no verificada')}
                  </span>
                </div>
                {a.id !== active?.id && (
                  <Button size="sm" onClick={() => run(() => call(api.accounts.setActive(a.id)).then(refreshAccounts))}>
                    {t('Usar esta cuenta')}
                  </Button>
                )}
                {a.kind === 'microsoft' && a.status !== 'ok' && (
                  <Button size="sm" variant="primary" onClick={() => void login()}>
                    {t('Volver a iniciar sesión')}
                  </Button>
                )}
                <Button size="sm" variant="ghost" icon={<LuLogOut />} onClick={() => setLogout(a)}>
                  {t('Cerrar sesión')}
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {waiting && (
        <Modal
          title={t('Esperando a Microsoft…')}
          description={t('Completa el inicio de sesión en tu navegador. Esta ventana se actualizará sola.')}
          onClose={() => void api.accounts.cancelLogin()}
          footer={<Button onClick={() => void api.accounts.cancelLogin()}>{t('Cancelar')}</Button>}
        >
          <div className="progress indeterminate">
            <i />
          </div>
        </Modal>
      )}
      {logout && (
        <Confirm
          title={t('¿Cerrar sesión de {name}?', { name: logout.username })}
          body={t('Se eliminarán las credenciales cifradas de este equipo.')}
          confirmLabel={t('Cerrar sesión')}
          danger
          onCancel={() => setLogout(undefined)}
          onConfirm={async () => {
            await run(() => call(api.accounts.logout(logout.id)));
            await refreshAccounts();
            setLogout(undefined);
          }}
        />
      )}
    </div>
  );
}
