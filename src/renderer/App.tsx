import { lazy, Suspense } from 'react';
import { LuBoxes, LuDownload, LuHardDrive, LuHouse, LuKeyRound, LuMaximize2, LuMinus, LuSettings, LuShirt, LuUsers, LuX } from 'react-icons/lu';
import { brand } from '../shared/brand';
import { Avatar, useProgressFor } from './components/common';
import { stageLabel } from './lib/format';
import { t, useLang } from './lib/i18n';
import { useApp, type Route } from './lib/store';
import { api } from './lib/api';
import Home from './screens/Home';

const Instances = lazy(() => import('./screens/Instances'));
const Keys = lazy(() => import('./screens/Keys'));
const Skins = lazy(() => import('./screens/Skins'));
const Social = lazy(() => import('./screens/Social'));
const Storage = lazy(() => import('./screens/Storage'));
const SettingsScreen = lazy(() => import('./screens/Settings'));
const Profile = lazy(() => import('./screens/Profile'));

export function Logo() {
  return (
    <svg className="brand-mark" viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="1" stopColor="color-mix(in oklab, var(--accent) 55%, #0b0b10)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#lg)" />
      <path d="M9 8h5v11a2 2 0 0 0 4 0V8h5v11a7 7 0 0 1-14 0z" fill="#fff" />
      <rect x="9" y="8" width="5" height="3" fill="rgba(0,0,0,.18)" />
      <rect x="18" y="8" width="5" height="3" fill="rgba(0,0,0,.18)" />
    </svg>
  );
}

const NAV: Array<{ id: Route; label: string; Icon: typeof LuHouse }> = [
  { id: 'home', label: 'Inicio', Icon: LuHouse },
  { id: 'instances', label: 'Instancias', Icon: LuBoxes },
  { id: 'keys', label: 'Agregar clave', Icon: LuKeyRound },
  { id: 'skins', label: 'Skins', Icon: LuShirt },
  { id: 'social', label: 'Social', Icon: LuUsers },
  { id: 'storage', label: 'Almacenamiento', Icon: LuHardDrive },
];

function Sidebar() {
  const { route, go, active, social, progress, instances, update } = useApp();
  useLang();
  const unread = social?.friends.reduce((s, f) => s + f.unread, 0) ?? 0;
  const incoming = social?.requests.filter((r) => r.direction === 'incoming').length ?? 0;
  const task = Object.values(progress)[0];
  const taskInst = instances.find((i) => i.id === task?.instanceId);
  const taskP = useProgressFor(task?.instanceId);
  const pct = taskP && taskP.bytesTotal ? Math.round((taskP.bytesDone / taskP.bytesTotal) * 100) : undefined;
  const item = (id: Route, label: string, Icon: typeof LuHouse, count?: number) => (
    <button key={id} className="nav-item" aria-current={route === id ? 'page' : undefined} onClick={() => go(id)} title={t(label)}>
      <Icon aria-hidden />
      <span className="label">{t(label)}</span>
      {count ? <span className="count" aria-label={`${count}`}>{count > 99 ? '99+' : count}</span> : null}
    </button>
  );
  return (
    <aside className="sidebar">
      <div className="brand">
        <Logo />
        <span className="brand-name">{brand.productName}</span>
      </div>
      <nav className="nav" aria-label="Principal">
        {NAV.map((n) => item(n.id, n.label, n.Icon, n.id === 'social' ? unread + incoming : undefined))}
        <div className="nav-sep" />
        {item('settings', 'Configuración', LuSettings)}
      </nav>
      <div className="side-foot">
        {update && ['available', 'downloading', 'ready'].includes(update.state) && (
          <button className="side-task update-chip" onClick={() => go('settings', 'advanced')} title={t('Hay una versión nueva: {v}', { v: update.latest?.version ?? '' })}>
            <LuDownload aria-hidden style={{ width: 16, height: 16, color: 'var(--accent)', flex: 'none' }} />
            <span className="label">
              <strong style={{ display: 'block', fontSize: 12 }}>{update.state === 'ready' ? t('Instalar y reiniciar') : t('Descargar actualización')}</strong>
              {t('Versión {v}', { v: update.latest?.version ?? '' })}
              {update.state === 'downloading' && update.progress ? ` ${Math.round((update.progress.bytesDone / Math.max(1, update.progress.bytesTotal)) * 100)}%` : ''}
            </span>
          </button>
        )}
        {task && taskInst && (
          <button className="side-task" onClick={() => go('instances', taskInst.id)} style={{ cursor: 'pointer', textAlign: 'left' }}>
            <span className="label">
              <strong style={{ display: 'block', fontSize: 12 }}>{taskInst.name}</strong>
              {stageLabel(task.stage)}
              {pct != null ? ` ${pct}%` : ''}
            </span>
            <div className="progress" style={{ marginTop: 6 }}>
              <i style={{ width: `${pct ?? 30}%` }} />
            </div>
          </button>
        )}
        <button className="account-chip" aria-current={route === 'profile' ? 'page' : undefined} onClick={() => go('profile')} title={t('Perfil y cuenta')}>
          <Avatar account={active} size="sm" />
          <span className="who">
            <strong>{active?.username ?? t('Perfil y cuenta')}</strong>
            <span>{active ? (active.premium ? t('Premium') : active.kind === 'offline' ? t('Offline') : t('Volver a iniciar sesión')) : t('Iniciar sesión con Microsoft')}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}

function Titlebar() {
  const custom = window.platform?.os === 'linux';
  return (
    <div className={`titlebar${custom ? ' custom' : ''}`}>
      {custom && (
        <div className="win-controls">
          <button onClick={() => void api.app.windowControl('minimize')} aria-label={t('Minimizar')}>
            <LuMinus />
          </button>
          <button onClick={() => void api.app.windowControl('maximize')} aria-label={t('Maximizar')}>
            <LuMaximize2 size={14} />
          </button>
          <button className="close" onClick={() => void api.app.windowControl('close')} aria-label={t('Cerrar')}>
            <LuX />
          </button>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const { ready, route } = useApp();
  useLang();
  if (!ready) return <div className="shell" aria-busy="true" />;
  const Screen = { home: Home, instances: Instances, keys: Keys, skins: Skins, social: Social, storage: Storage, settings: SettingsScreen, profile: Profile }[route];
  return (
    <div className="shell">
      <a href="#content" className="skip-link">
        {t('Saltar al contenido')}
      </a>
      <Sidebar />
      <div className="main">
        <Titlebar />
        <main className="content" id="content" tabIndex={-1}>
          <Suspense fallback={<div className="page" aria-busy="true" />}>
            <Screen key={route} />
          </Suspense>
        </main>
      </div>
    </div>
  );
}

