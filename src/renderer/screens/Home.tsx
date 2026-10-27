import { LuBell, LuBoxes, LuHardDrive, LuPlus, LuRefreshCw, LuSettings, LuX } from 'react-icons/lu';
import { useEffect, useState } from 'react';
import type { DiskSummary } from '../../shared/types';
import { Cover } from '../components/Cover';
import { PlayButton, TaskLine, stateLabel, useAction, useProgressFor } from '../components/common';
import { Button, Empty } from '../components/ui';
import { api, call } from '../lib/api';
import { ago, bytes, LOADER_LABEL } from '../lib/format';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { NewInstanceModal } from './Instances';

function notificationText(n: { titleKey: string; params?: Record<string, string | number> }): string {
  switch (n.titleKey) {
    case 'notify.gameCrashed':
      return t('Minecraft se cerró inesperadamente: {name} (código {code})', n.params);
    case 'notify.updated':
      return t('Actualizado a {version}', n.params);
    case 'notify.updateFailed':
      return t('La actualización a {version} no se completó. Sigues en la versión anterior.', n.params);
    default:
      return n.titleKey;
  }
}

export default function Home() {
  const { selected, instances, active, go, selectInstance, update, notifications, dismissNotification, info } = useApp();
  const p = useProgressFor(selected?.id);
  const [disk, setDisk] = useState<DiskSummary>();
  const [creating, setCreating] = useState(false);
  const run = useAction();

  useEffect(() => {
    call(api.storage.summary(false)).then(setDisk).catch(() => undefined);
  }, []);

  const recent = [...instances].sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt)).slice(0, 5);
  const name = active?.username;

  return (
    <div className="page">
      {selected ? (
        <section className="scene hero" aria-label={selected.name}>
          <Cover cover={selected.cover} seed={selected.id} width={240} height={110} />
          <div className="veil" />
          <div className="hero-inner">
            <span className="hero-greet">{name ? t('Hola, {name}', { name }) : t('Inicia sesión para jugar')}</span>
            <h1 className="hero-title">{selected.name}</h1>
            <div className="hero-meta">
              <span className="badge">Minecraft {selected.mcVersion}</span>
              <span className="badge">
                {LOADER_LABEL[selected.loader.kind]}
                {selected.loader.version ? ` ${selected.loader.version}` : ''}
              </span>
              <span className="badge">{stateLabel(selected)}</span>
              {selected.access.kind === 'private' && <span className="badge">{t('Privada')}</span>}
            </div>
            {p && <TaskLine p={p} light />}
            {!p && selected.lastError && (
              <span className="small" style={{ color: '#ffb4b4' }}>
                {selected.lastError.code === 'LAUNCH_FAILED' ? t('Minecraft se cerró inesperadamente: {name} (código {code})', { name: selected.name, code: selected.lastError.detail?.replace('exit ', '') ?? '?' }) : null}
              </span>
            )}
            <div className="hero-actions">
              <PlayButton inst={selected} />
              <Button icon={<LuBoxes />} onClick={() => go('instances', selected.id)}>
                {t('Detalles')}
              </Button>
            </div>
          </div>
        </section>
      ) : (
        <Empty
          icon={<LuBoxes className="ill" aria-hidden />}
          title={t('Aún no tienes instancias')}
          action={
            <Button variant="primary" icon={<LuPlus />} onClick={() => setCreating(true)}>
              {t('Crear instancia')}
            </Button>
          }
        >
          {t('Crea una instancia con la versión y el loader que quieras. Se instalará en su propia carpeta.')}
        </Empty>
      )}

      <div className="home-grid">
        <section className="panel" aria-labelledby="recent-h">
          <div className="panel-title">
            <span id="recent-h">{t('Recientes')}</span>
            <Button size="sm" variant="ghost" icon={<LuPlus />} onClick={() => setCreating(true)}>
              {t('Nueva instancia')}
            </Button>
          </div>
          {recent.length ? (
            <div className="recent-list">
              {recent.map((i) => (
                <button key={i.id} className="recent-item" aria-pressed={i.id === selected?.id} onClick={() => selectInstance(i.id)}>
                  <span className="cover-thumb">
                    <Cover cover={i.cover} seed={i.id} width={24} height={24} />
                  </span>
                  <span className="meta">
                    <strong>{i.name}</strong>
                    <span>
                      {i.mcVersion} {LOADER_LABEL[i.loader.kind]} — {t('Última partida')}: {ago(i.lastPlayedAt)}
                    </span>
                  </span>
                  <span className="badge">{stateLabel(i)}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted small">{t('Elige una instancia para empezar')}</p>
          )}
        </section>

        <div className="stack">
          <section className="panel" aria-labelledby="disk-h">
            <div className="panel-title">
              <span id="disk-h">{t('Espacio en disco')}</span>
              <Button size="sm" variant="ghost" iconOnly icon={<LuHardDrive />} onClick={() => go('storage')}>
                {t('Almacenamiento')}
              </Button>
            </div>
            {disk ? (
              <>
                <div className="stat-line">
                  <span className="stat-big">{bytes(disk.drive.free)}</span>
                  <span className="muted small">{t('libres de {total}', { total: bytes(disk.drive.total) })}</span>
                </div>
                <div className="meter" style={{ marginTop: 10 }} role="img" aria-label={`${Math.round((disk.drive.used / Math.max(disk.drive.total, 1)) * 100)}%`}>
                  <i style={{ width: `${(disk.launcher.total / Math.max(disk.drive.total, 1)) * 100}%`, background: 'var(--accent)' }} />
                  <i style={{ width: `${((disk.drive.used - disk.launcher.total) / Math.max(disk.drive.total, 1)) * 100}%`, background: 'var(--line-strong)' }} />
                </div>
                <p className="muted xs" style={{ marginTop: 8 }}>
                  {t('Ocupado por el launcher')}: {bytes(disk.launcher.total)}
                </p>
              </>
            ) : (
              <div className="progress indeterminate">
                <i />
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="upd-h">
            <div className="panel-title">
              <span id="upd-h">{t('Launcher')}</span>
              <span className="hint">{t('Versión {v}', { v: info?.version ?? '' })}</span>
            </div>
            {update?.state === 'disabled' ? (
              <p className="muted small">{t('Las actualizaciones no están configuradas en esta compilación.')}</p>
            ) : update?.state === 'available' || update?.state === 'ready' || update?.state === 'downloading' ? (
              <div className="row wrap">
                <span className="badge accent">{t('Hay una versión nueva: {v}', { v: update.latest?.version ?? '' })}</span>
                <Button size="sm" onClick={() => go('settings', 'advanced')}>
                  {t('Detalles')}
                </Button>
              </div>
            ) : (
              <div className="row">
                <span className="muted small">{update?.state === 'error' ? t('Sin conexión') : t('Estás al día')}</span>
                <span className="spacer" />
                <Button size="sm" variant="ghost" icon={<LuRefreshCw />} busy={update?.state === 'checking'} onClick={() => run(() => call(api.updates.check()))}>
                  {t('Buscar actualizaciones')}
                </Button>
              </div>
            )}
          </section>

          <section className="panel" aria-labelledby="ntf-h">
            <div className="panel-title">
              <span id="ntf-h">{t('Notificaciones')}</span>
              <Button size="sm" variant="ghost" iconOnly icon={<LuSettings />} onClick={() => go('settings')}>
                {t('Configuración')}
              </Button>
            </div>
            {notifications.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {notifications.slice(0, 4).map((n) => (
                  <div key={n.id} className="row small" style={{ alignItems: 'flex-start' }}>
                    <LuBell aria-hidden style={{ flex: 'none', marginTop: 3, color: n.level === 'error' ? 'var(--danger)' : 'var(--accent)' }} />
                    <span style={{ flex: 1 }}>{notificationText(n)}</span>
                    <Button size="sm" variant="ghost" iconOnly icon={<LuX />} onClick={() => dismissNotification(n.id)}>
                      {t('Descartar')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted small">{t('Sin notificaciones')}</p>
            )}
          </section>
        </div>
      </div>
      {creating && <NewInstanceModal onClose={() => setCreating(false)} />}
    </div>
  );
}
