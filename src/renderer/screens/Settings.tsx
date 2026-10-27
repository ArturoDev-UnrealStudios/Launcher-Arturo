import { useEffect, useState, type ReactNode } from 'react';
import { LuDownload, LuExternalLink, LuFileText, LuFolderOpen, LuRefreshCw, LuRotateCcw } from 'react-icons/lu';
import type { SettingsPatch } from '../../shared/settings';
import type { JavaInstallation, ReleaseNote } from '../../shared/types';
import { useAction } from '../components/common';
import { Button, Callout, Confirm, Modal, Segmented, Switch } from '../components/ui';
import { api, call, errOf } from '../lib/api';
import { bytes, date } from '../lib/format';
import { describeError, t, useLang } from '../lib/i18n';
import { useApp } from '../lib/store';
import { brand } from '../../shared/brand';

type Section = 'general' | 'minecraft' | 'downloads' | 'account' | 'social' | 'advanced';

function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div className="text">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="control">{children}</div>
    </div>
  );
}

const ACCENTS = [brand.colors.accent, '#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

export default function Settings() {
  const { settings: s, updateSettings, setSettings, routeParam, info, update, active, go } = useApp();
  const lang = useLang();
  const [section, setSection] = useState<Section>((routeParam as Section) || 'general');
  const [javas, setJavas] = useState<JavaInstallation[]>();
  const [notes, setNotes] = useState<ReleaseNote[]>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [jvmText, setJvmText] = useState(s?.minecraft.defaultJvmArgs.join(' ') ?? '');
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const run = useAction();

  useEffect(() => setJvmText(s?.minecraft.defaultJvmArgs.join(' ') ?? ''), [s?.minecraft.defaultJvmArgs]);
  if (!s) return null;

  const patch = async (p: SettingsPatch, field?: string) => {
    try {
      await updateSettings(p);
      if (field) setFieldErr((e) => ({ ...e, [field]: '' }));
    } catch (e) {
      const msg = describeError(errOf(e));
      if (field) setFieldErr((x) => ({ ...x, [field]: msg }));
      else run(async () => Promise.reject(e));
    }
  };

  const sections: Array<[Section, string]> = [
    ['general', t('General')],
    ['minecraft', 'Minecraft'],
    ['downloads', t('Descargas')],
    ['account', t('Cuenta')],
    ['social', t('Social')],
    ['advanced', t('Avanzado')],
  ];

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Configuración')}</h1>
      </div>
      <div className="settings-layout">
        <nav className="settings-nav" aria-label={t('Configuración')}>
          {sections.map(([k, l]) => (
            <button key={k} className="nav-item" aria-current={section === k ? 'page' : undefined} onClick={() => setSection(k)}>
              <span>{l}</span>
            </button>
          ))}
        </nav>
        <section className="panel settings-section" aria-label={sections.find((x) => x[0] === section)?.[1]}>
          {section === 'general' && (
            <>
              <Row label={t('Idioma')}>
                <Segmented value={s.general.language} label={t('Idioma')} onChange={(v) => void patch({ general: { language: v } })} options={[{ value: 'es', label: 'Español' }, { value: 'en', label: 'English' }]} />
              </Row>
              <Row label={t('Tema')}>
                <Segmented
                  value={s.general.theme}
                  label={t('Tema')}
                  onChange={(v) => void patch({ general: { theme: v } })}
                  options={[
                    { value: 'dark', label: t('Oscuro') },
                    { value: 'light', label: t('Claro') },
                    { value: 'system', label: t('Según el sistema') },
                  ]}
                />
              </Row>
              <Row label={t('Color de acento')}>
                <div className="swatches" role="group" aria-label={t('Color de acento')}>
                  {ACCENTS.map((c) => (
                    <button key={c} style={{ background: c }} aria-label={c} aria-pressed={(s.general.accent ?? brand.colors.accent).toLowerCase() === c.toLowerCase()} onClick={() => void patch({ general: { accent: c } })} />
                  ))}
                </div>
              </Row>
              <Row label={t('Animaciones')}>
                <Segmented
                  value={s.general.animations}
                  label={t('Animaciones')}
                  onChange={(v) => void patch({ general: { animations: v } })}
                  options={[
                    { value: 'system', label: t('Según el sistema') },
                    { value: 'full', label: t('Completas') },
                    { value: 'reduced', label: t('Reducidas') },
                  ]}
                />
              </Row>
              <Switch label={t('Iniciar con el sistema')} checked={s.general.launchOnStartup} onChange={(v) => void patch({ general: { launchOnStartup: v } })} disabled={info?.platform === 'linux'} />
              <Switch label={t('Minimizar a la bandeja al cerrar')} checked={s.general.minimizeToTrayOnClose} onChange={(v) => void patch({ general: { minimizeToTrayOnClose: v } })} />
              <Switch label={t('Minimizar al iniciar el juego')} checked={s.general.hideLauncherOnGameStart} onChange={(v) => void patch({ general: { hideLauncherOnGameStart: v } })} />
              <Switch label={t('Notificaciones')} checked={s.general.notifications} onChange={(v) => void patch({ general: { notifications: v } })} />
              <Switch label={t('Recordar cuentas')} hint={t('Sin telemetría: el launcher no envía datos de uso.')} checked={s.privacy.rememberAccounts} onChange={(v) => void patch({ privacy: { rememberAccounts: v } })} />
            </>
          )}
          {section === 'minecraft' && (
            <>
              <Row label={t('Memoria máxima')} hint={fieldErr.mem || `${t('Memoria mínima')}: ${s.minecraft.defaultMemoryMinMb} MB`}>
                <div className="row">
                  <input
                    className="range"
                    type="range"
                    min={1024}
                    max={info?.maxMemMb ?? 8192}
                    step={256}
                    value={Math.min(s.minecraft.defaultMemoryMaxMb, info?.maxMemMb ?? 8192)}
                    onChange={(e) => setSettings({ ...s, minecraft: { ...s.minecraft, defaultMemoryMaxMb: Number(e.target.value) } })}
                    onMouseUp={(e) => void patch({ minecraft: { defaultMemoryMaxMb: Number((e.target as HTMLInputElement).value), defaultMemoryMinMb: Math.min(s.minecraft.defaultMemoryMinMb, Number((e.target as HTMLInputElement).value)) } }, 'mem')}
                    onKeyUp={(e) => void patch({ minecraft: { defaultMemoryMaxMb: Number((e.target as HTMLInputElement).value), defaultMemoryMinMb: Math.min(s.minecraft.defaultMemoryMinMb, Number((e.target as HTMLInputElement).value)) } }, 'mem')}
                    aria-label={t('Memoria máxima')}
                    style={{ width: 200 }}
                  />
                  <span className="num" style={{ minWidth: 64 }}>
                    {(s.minecraft.defaultMemoryMaxMb / 1024).toFixed(1)} GB
                  </span>
                </div>
              </Row>
              <Row label={t('Argumentos JVM')} hint={fieldErr.jvm || '-XX:+UseG1GC'}>
                <input
                  className="input"
                  style={{ width: 320 }}
                  value={jvmText}
                  aria-invalid={!!fieldErr.jvm}
                  onChange={(e) => setJvmText(e.target.value)}
                  onBlur={() => void patch({ minecraft: { defaultJvmArgs: jvmText.split(/\s+/).filter(Boolean) } }, 'jvm')}
                  spellCheck={false}
                />
              </Row>
              <Switch label={t('Java automático')} hint={t('Descarga Eclipse Temurin cuando ninguna instalación es compatible.')} checked={s.minecraft.autoJava} onChange={(v) => void patch({ minecraft: { autoJava: v } })} />
              <Row label={t('Ejecutable Java global')} hint={s.minecraft.javaPath || t('Automático')}>
                <div className="row">
                  {s.minecraft.javaPath && (
                    <Button size="sm" variant="ghost" onClick={() => void patch({ minecraft: { javaPath: undefined } })}>
                      {t('Automático')}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={async () => {
                      const j = await run(() => call(api.settings.chooseJava()));
                      if (j) await patch({ minecraft: { javaPath: j.path } });
                    }}
                  >
                    {t('Elegir ejecutable')}
                  </Button>
                </div>
              </Row>
              <Row label={t('Instalaciones detectadas')}>
                <Button size="sm" icon={<LuRefreshCw />} onClick={async () => setJavas(await run(() => call(api.instances.detectJava())))}>
                  {t('Detectar Java')}
                </Button>
              </Row>
              {javas && (
                <table className="table" style={{ marginBottom: 8 }}>
                  <tbody>
                    {javas.map((j) => (
                      <tr key={j.path}>
                        <td>Java {j.major}</td>
                        <td className="muted">{j.vendor ?? ''}</td>
                        <td className="path" title={j.path}>
                          {j.path}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Row label={t('Resolución')}>
                <div className="row">
                  <input className="input num" style={{ width: 90 }} type="number" min={320} max={7680} value={s.minecraft.width} onChange={(e) => void patch({ minecraft: { width: Number(e.target.value) || 1280 } })} aria-label="ancho" />
                  <span className="muted">×</span>
                  <input className="input num" style={{ width: 90 }} type="number" min={240} max={4320} value={s.minecraft.height} onChange={(e) => void patch({ minecraft: { height: Number(e.target.value) || 720 } })} aria-label="alto" />
                </div>
              </Row>
              <Switch label={t('Pantalla completa')} checked={s.minecraft.fullscreen} onChange={(v) => void patch({ minecraft: { fullscreen: v } })} />
              <Row label={t('Directorio de instancias')} hint={s.minecraft.instancesDir ?? `${info?.dataDir ?? ''}/data/instances`}>
                <Button size="sm" onClick={() => go('storage')}>
                  {t('Cambiar ubicación de instancias')}
                </Button>
              </Row>
            </>
          )}
          {section === 'downloads' && (
            <>
              <Row label={t('Límite de ancho de banda')} hint={s.downloads.bandwidthLimitKiB ? `${bytes(s.downloads.bandwidthLimitKiB * 1024)}/s` : t('Sin límite')}>
                <select className="select" style={{ width: 160 }} value={s.downloads.bandwidthLimitKiB} onChange={(e) => void patch({ downloads: { bandwidthLimitKiB: Number(e.target.value) } })}>
                  {[0, 512, 1024, 2048, 5120, 10240, 25600].map((v) => (
                    <option key={v} value={v}>
                      {v ? `${bytes(v * 1024)}/s` : t('Sin límite')}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label={t('Descargas simultáneas')}>
                <select className="select" style={{ width: 100 }} value={s.downloads.concurrency} onChange={(e) => void patch({ downloads: { concurrency: Number(e.target.value) } })}>
                  {[1, 2, 4, 6, 8, 12, 16].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Row>
              <Switch label={t('Reanudar descargas')} checked={s.downloads.resume} onChange={(v) => void patch({ downloads: { resume: v } })} />
              <Row label={t('Directorio temporal')} hint={s.downloads.tempDir ?? `${info?.dataDir ?? ''}/data/tmp`}>
                <Button size="sm" icon={<LuFolderOpen />} onClick={() => run(() => call(api.settings.chooseDirectory('temp'))).then(async () => setSettings(await call(api.settings.get())))}>
                  {t('Abrir')}
                </Button>
              </Row>
              <Row label={t('Verificación de integridad')} hint={t('Siempre activa (SHA-1 / SHA-256 / SHA-512).')}>
                <span className="badge ok">SHA</span>
              </Row>
            </>
          )}
          {section === 'account' && (
            <>
              <Row label={t('Cuenta activa')} hint={active ? (active.premium ? t('Licencia verificada') : t('Identidad no verificada')) : undefined}>
                <Button size="sm" onClick={() => go('profile')}>
                  {active?.username ?? t('Añadir cuenta')}
                </Button>
              </Row>
              {info?.secureStorage === 'unavailable' && <Callout tone="warn">{t('El almacenamiento seguro del sistema no está disponible: las sesiones no se recordarán al reiniciar.')}</Callout>}
              <Row label={t('Revisar permisos de la app en Microsoft')}>
                <Button size="sm" variant="ghost" icon={<LuExternalLink />} onClick={() => run(() => call(api.app.openExternal('https://account.live.com/consent/Manage')))}>
                  account.live.com
                </Button>
              </Row>
            </>
          )}
          {section === 'social' && (
            <>
              <Switch label={t('Notificaciones de mensajes')} checked={s.social.messageNotifications} onChange={(v) => void patch({ social: { messageNotifications: v } })} />
              <Row label={t('Quién ve mi presencia')}>
                <Segmented value={s.social.presence} label={t('Quién ve mi presencia')} onChange={(v) => void patch({ social: { presence: v } })} options={[{ value: 'friends', label: t('Mis amigos') }, { value: 'nobody', label: t('Nadie') }]} />
              </Row>
              <Row label={t('Quién puede enviarme solicitudes')}>
                <Segmented value={s.social.friendRequests} label={t('Quién puede enviarme solicitudes')} onChange={(v) => void patch({ social: { friendRequests: v } })} options={[{ value: 'everyone', label: t('Todos') }, { value: 'nobody', label: t('Nadie') }]} />
              </Row>
              <Switch label={t('Indicador de escritura')} checked={s.social.typingIndicator} onChange={(v) => void patch({ social: { typingIndicator: v } })} />
              <Switch label={t('Enviar con Intro')} checked={s.social.enterToSend} onChange={(v) => void patch({ social: { enterToSend: v } })} />
            </>
          )}
          {section === 'advanced' && (
            <>
              <Row label={t('Canal de actualizaciones')} hint={t('Versión del launcher {v}', { v: info?.version ?? '' })}>
                <Segmented value={s.advanced.updateChannel} label={t('Canal de actualizaciones')} onChange={(v) => void patch({ advanced: { updateChannel: v } })} options={[{ value: 'stable', label: t('Estable') }, { value: 'beta', label: t('Beta') }]} />
              </Row>
              <Switch label={t('Buscar automáticamente')} checked={s.advanced.autoCheckUpdates} onChange={(v) => void patch({ advanced: { autoCheckUpdates: v } })} />
              <Switch label={t('Descargar automáticamente')} checked={s.advanced.autoDownloadUpdates} onChange={(v) => void patch({ advanced: { autoDownloadUpdates: v } })} />
              <div className="setting-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                {update?.state === 'disabled' ? (
                  <span className="muted small">{t('Las actualizaciones no están configuradas en esta compilación.')}</span>
                ) : (
                  <div className="stack" style={{ gap: 10 }}>
                    <div className="row wrap">
                      <span style={{ flex: 1 }}>
                        {update?.latest ? t('Hay una versión nueva: {v}', { v: update.latest.version }) : update?.state === 'error' ? describeError(update.error) : t('Estás al día')}
                      </span>
                      <Button size="sm" icon={<LuRefreshCw />} busy={update?.state === 'checking'} onClick={() => run(() => call(api.updates.check()))}>
                        {t('Buscar actualizaciones')}
                      </Button>
                      {update?.state === 'available' && (
                        <Button size="sm" variant="primary" icon={<LuDownload />} onClick={() => run(() => call(api.updates.download()))}>
                          {t('Descargar actualización')}
                        </Button>
                      )}
                      {update?.state === 'ready' && (
                        <Button size="sm" variant="primary" icon={<LuRotateCcw />} onClick={() => run(() => call(api.updates.install()))}>
                          {t('Instalar y reiniciar')}
                        </Button>
                      )}
                    </div>
                    {update?.state === 'downloading' && update.progress && (
                      <div className="progress" role="progressbar" aria-valuenow={Math.round((update.progress.bytesDone / Math.max(1, update.progress.bytesTotal)) * 100)}>
                        <i style={{ width: `${(update.progress.bytesDone / Math.max(1, update.progress.bytesTotal)) * 100}%` }} />
                      </div>
                    )}
                    <div>
                      <Button size="sm" variant="ghost" icon={<LuFileText />} onClick={async () => setNotes(await run(() => call(api.updates.history())))}>
                        {t('Historial de cambios')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <Row label={t('Nivel de registro')}>
                <select className="select" style={{ width: 140 }} value={s.advanced.logLevel} onChange={(e) => void patch({ advanced: { logLevel: e.target.value as 'info' } })}>
                  {['error', 'warn', 'info', 'debug'].map((l) => (
                    <option key={l}>{l}</option>
                  ))}
                </select>
              </Row>
              <Row label={t('Registros')} hint={t('Los registros exportados no contienen tokens ni claves.')}>
                <div className="row">
                  <Button size="sm" onClick={() => run(() => call(api.app.openLogs()))}>
                    {t('Abrir registros')}
                  </Button>
                  <Button size="sm" onClick={() => run(() => call(api.app.exportLogs()))}>
                    {t('Exportar registros')}
                  </Button>
                </div>
              </Row>
              <Row label={t('Reparar')} hint={t('Verificar integridad')}>
                <Button size="sm" onClick={() => go('instances')}>
                  {t('Instancias')}
                </Button>
              </Row>
              <Row label={t('Restablecer preferencias')}>
                <Button size="sm" variant="danger" onClick={() => setConfirmReset(true)}>
                  {t('Restablecer')}
                </Button>
              </Row>
            </>
          )}
        </section>
      </div>
      {confirmReset && (
        <Confirm
          danger
          title={t('¿Restablecer todas las preferencias?')}
          body={t('Se restaurarán los valores por defecto. Tus cuentas, instancias y archivos no se modifican.')}
          confirmLabel={t('Restablecer')}
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            const r = await run(() => call(api.settings.reset()), t('Ajustes guardados'));
            if (r) setSettings(r);
            setConfirmReset(false);
          }}
        />
      )}
      {notes && (
        <Modal title={t('Historial de cambios')} onClose={() => setNotes(undefined)} wide>
          <div className="stack" style={{ gap: 18 }}>
            {notes.length === 0 && <p className="muted">{describeError({ code: 'UPDATE_NO_RELEASE' })}</p>}
            {notes.map((n) => (
              <article key={n.version}>
                <div className="row">
                  <h3>{n.name}</h3>
                  {n.prerelease && <span className="badge">{t('Beta')}</span>}
                  <span className="spacer" />
                  <span className="muted small">{date(n.publishedAt, lang)}</span>
                </div>
                <p className="small" style={{ whiteSpace: 'pre-wrap', marginTop: 6, color: 'var(--text-2)', userSelect: 'text' }}>
                  {n.body}
                </p>
              </article>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}
