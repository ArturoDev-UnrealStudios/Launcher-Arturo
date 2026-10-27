import { useCallback, useEffect, useState } from 'react';
import { LuDownload, LuLock, LuLoader, LuPlay, LuRotateCcw, LuSquare, LuWrench } from 'react-icons/lu';
import type { AccountSummary, InstanceView, TaskProgress } from '../../shared/types';
import { api, call, errOf } from '../lib/api';
import { bytes, speed, stageLabel } from '../lib/format';
import { describeError, t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { faceDataUrl, placeholderSkin } from '../skin3d/skin';
import { Confirm, Progress, useToast } from './ui';

/** Ejecuta una acción asíncrona mostrando el error comprensible si falla. */
export function useAction() {
  const toast = useToast();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      try {
        const r = await fn();
        if (success) toast({ tone: 'success', title: success });
        return r;
      } catch (e) {
        const err = errOf(e);
        if (err.code !== 'CANCELLED' && err.code !== 'AUTH_CANCELLED') toast({ tone: 'error', title: describeError(err) });
        return undefined;
      }
    },
    [toast],
  );
}

const faceCache = new Map<string, string>();

export function Avatar({ account, size = 'md' }: { account?: AccountSummary; size?: 'sm' | 'md' | 'lg' }) {
  const { settings } = useApp();
  const [src, setSrc] = useState<string>();
  const accent = settings?.general.accent ?? getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  useEffect(() => {
    let alive = true;
    const key = `${account?.id ?? 'none'}|${account?.skin?.url ?? ''}|${accent}`;
    if (faceCache.has(key)) {
      setSrc(faceCache.get(key));
      return;
    }
    (async () => {
      let skin: string | undefined;
      if (account?.kind === 'microsoft' && account.skin) {
        const cur = await call(api.skins.current()).catch(() => null);
        skin = cur?.dataUrl;
      }
      const face = await faceDataUrl(skin ?? placeholderSkin(accent || '#8b5cf6'), 64);
      faceCache.set(key, face);
      if (alive) setSrc(face);
    })().catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [account?.id, account?.kind, account?.skin, accent]);
  return <img className={`avatar ${size === 'md' ? '' : size}`} src={src} alt="" />;
}

export function TaskLine({ p, light }: { p: TaskProgress; light?: boolean }) {
  const hasBytes = p.bytesTotal > 0;
  const hasFiles = p.filesTotal > 0;
  return (
    <div className={light ? 'hero-progress' : 'stack'} style={light ? undefined : { gap: 6 }}>
      <div className="row small" style={{ justifyContent: 'space-between' }}>
        <span>{stageLabel(p.stage)}</span>
        <span className="num muted">
          {hasBytes ? `${bytes(p.bytesDone)} / ${bytes(p.bytesTotal)}` : hasFiles ? t('{done} de {total} archivos', { done: p.filesDone, total: p.filesTotal }) : ''}
          {p.speed > 0 ? ` · ${speed(p.speed)}` : ''}
        </span>
      </div>
      <Progress
        label={stageLabel(p.stage)}
        indeterminate={!hasBytes && !hasFiles}
        value={hasBytes ? p.bytesDone : p.filesDone}
        total={hasBytes ? p.bytesTotal : p.filesTotal}
      />
    </div>
  );
}

/** Botón principal con estado real: Jugar, Instalar, Reanudar, Reparar, En juego, Bloqueada. */
export function PlayButton({ inst, compact }: { inst?: InstanceView; compact?: boolean }) {
  const { active, go } = useApp();
  const run = useAction();
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!inst) return null;

  const needsConsent = (inst.loader.kind === 'forge' || inst.loader.kind === 'neoforge') && !inst.loader.installerTrusted;
  const install = async () => {
    if (needsConsent) return setConsent(true);
    await run(() => call(api.instances.install(inst.id)));
  };

  let label = t('Jugar');
  let Icon = LuPlay;
  let cls = '';
  let onClick: () => unknown = async () => {
    setBusy(true);
    await run(() => call(api.instances.launch(inst.id)));
    setBusy(false);
  };
  switch (inst.primaryAction) {
    case 'install':
      label = t('Instalar');
      Icon = LuDownload;
      onClick = install;
      break;
    case 'resume':
      label = t('Reanudar');
      Icon = LuRotateCcw;
      onClick = install;
      break;
    case 'repair':
      label = t('Reparar');
      Icon = LuWrench;
      cls = 'state-repair';
      onClick = () => run(() => call(api.instances.repair(inst.id)), t('Reparación completada'));
      break;
    case 'running':
      label = t('En juego');
      Icon = LuSquare;
      cls = 'state-running';
      onClick = () => run(() => call(api.instances.stop(inst.id)));
      break;
    case 'busy':
      label = t('Cancelar tarea');
      Icon = LuLoader;
      onClick = () => run(() => call(api.instances.cancelTask(inst.id)));
      break;
    case 'locked':
      label = t('Bloqueada');
      Icon = LuLock;
      cls = 'state-locked';
      onClick = () => go('keys');
      break;
  }
  if (!active && (inst.primaryAction === 'play' || inst.primaryAction === 'running')) {
    label = t('Inicia sesión para jugar');
    onClick = () => go('profile');
  }
  const title = inst.primaryAction === 'running' ? t('Detener') : undefined;
  return (
    <>
      <button className={`play ${cls}`} onClick={() => void onClick()} disabled={busy} title={title} style={compact ? { height: 44, minWidth: 150, fontSize: 16 } : undefined}>
        {busy ? <span className="spinner" /> : <Icon aria-hidden />}
        {label}
      </button>
      {consent && (
        <Confirm
          title={inst.loader.kind === 'forge' ? 'Forge' : 'NeoForge'}
          body={t('Forge y NeoForge se instalan ejecutando su instalador oficial, descargado de su repositorio y verificado por checksum. ¿Confías en él?')}
          confirmLabel={t('Confío en el instalador oficial')}
          onCancel={() => setConsent(false)}
          onConfirm={async () => {
            setConsent(false);
            await run(async () => {
              await call(api.instances.trustInstaller(inst.id));
              await call(api.instances.install(inst.id));
            });
          }}
        />
      )}
    </>
  );
}

export function useProgressFor(id?: string): TaskProgress | undefined {
  const { progress } = useApp();
  return id ? progress[id] : undefined;
}

export function stateLabel(inst: InstanceView): string {
  if (inst.access.kind === 'private' && inst.access.status !== 'granted') return t('Bloqueada');
  if (inst.running) return t('En juego');
  if (inst.installState === 'installed') return t('Instalada');
  if (inst.installState === 'needs-repair') return t('Necesita reparación');
  if (inst.installInterrupted) return t('Instalación interrumpida');
  return t('No instalada');
}

export { describeError };
