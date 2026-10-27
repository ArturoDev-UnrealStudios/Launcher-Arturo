import { useEffect, useState } from 'react';
import { LuFolderOpen, LuRefreshCw, LuTrash2 } from 'react-icons/lu';
import type { CleanupPlan, DiskSummary, LargeFile } from '../../shared/types';
import { useAction } from '../components/common';
import { Button, Confirm } from '../components/ui';
import { api, call } from '../lib/api';
import { ago, bytes } from '../lib/format';
import { t } from '../lib/i18n';
import { useApp } from '../lib/store';

const COLORS = {
  instances: 'var(--accent)',
  shared: 'color-mix(in oklab, var(--accent) 55%, var(--accent-2))',
  runtimes: 'var(--accent-2)',
  cache: 'var(--warn)',
  temp: 'color-mix(in oklab, var(--warn) 50%, var(--danger))',
  logs: 'var(--muted)',
  skins: 'var(--ok)',
};

export default function Storage() {
  const { settings } = useApp();
  const [s, setS] = useState<DiskSummary>();
  const [big, setBig] = useState<LargeFile[]>();
  const [plan, setPlan] = useState<CleanupPlan>();
  const [freed, setFreed] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const run = useAction();

  const refresh = async (force = true) => {
    setLoading(true);
    const r = await run(() => call(api.storage.summary(force)));
    if (r) setS(r);
    setLoading(false);
  };
  useEffect(() => {
    void refresh(false);
  }, []);

  const pct = s ? Math.round((s.drive.used / Math.max(1, s.drive.total)) * 100) : 0;
  const L = s?.launcher;
  const parts: Array<[keyof typeof COLORS, string, number]> = L
    ? [
        ['instances', t('Instancias'), L.instances],
        ['shared', t('Archivos compartidos'), L.shared],
        ['runtimes', t('Runtimes de Java'), L.runtimes],
        ['cache', t('Caché'), L.cache],
        ['temp', t('Temporales'), L.temp],
        ['logs', t('Registros'), L.logs],
        ['skins', t('Skins'), L.skins],
      ]
    : [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Almacenamiento')}</h1>
          {s && <p>{t('Medido {when}', { when: ago(s.measuredAt).toLowerCase() })}</p>}
        </div>
        <div className="page-actions">
          <Button icon={<LuRefreshCw />} busy={loading} onClick={() => void refresh(true)}>
            {t('Actualizar')}
          </Button>
          <Button
            icon={<LuTrash2 />}
            onClick={async () => {
              setFreed(undefined);
              const p = await run(() => call(api.storage.planCleanup()));
              if (p) setPlan(p);
            }}
          >
            {t('Revisar limpieza')}
          </Button>
        </div>
      </div>
      {freed != null && (
        <div className="callout" role="status" style={{ marginBottom: 16 }}>
          {t('Liberados {size} (confirmado)', { size: bytes(freed) })}
        </div>
      )}
      <div className="grid grid-3">
        <section className="panel">
          <div className="muted small">{t('Capacidad total')}</div>
          <div className="stat-big" style={{ marginTop: 6 }}>{s ? bytes(s.drive.total) : '—'}</div>
        </section>
        <section className="panel">
          <div className="muted small">{t('Usado')}</div>
          <div className="stat-big" style={{ marginTop: 6 }}>
            {s ? `${bytes(s.drive.used)}` : '—'} <span className="muted small num">{s ? `${pct}%` : ''}</span>
          </div>
        </section>
        <section className="panel">
          <div className="muted small">{t('Libre')}</div>
          <div className="stat-big" style={{ marginTop: 6 }}>{s ? bytes(s.drive.free) : '—'}</div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 16 }}>
        <div className="panel-title">
          <span>{t('Ocupado por el launcher')}</span>
          <span className="hint num">{L ? bytes(L.total) : ''}</span>
        </div>
        <div className="meter" role="img" aria-label={parts.map(([, l, v]) => `${l} ${bytes(v)}`).join(', ')}>
          {parts.map(([k, , v]) => (
            <i key={k} style={{ width: `${L && L.total ? (v / L.total) * 100 : 0}%`, background: COLORS[k] }} />
          ))}
        </div>
        <div className="legend">
          {parts.map(([k, l, v]) => (
            <span key={k}>
              <i style={{ background: COLORS[k] }} />
              {l} <span className="muted num">{bytes(v)}</span>
            </span>
          ))}
        </div>
        <div className="divider" />
        <div className="row wrap">
          <span className="small muted" style={{ flex: 1, minWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {t('Directorio de instancias')}: {settings?.minecraft.instancesDir ?? s?.drive.path}
          </span>
          <Button size="sm" onClick={() => setMoving(true)}>
            {t('Cambiar ubicación de instancias')}
          </Button>
        </div>
      </section>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <section className="panel">
          <div className="panel-title">{t('Por instancia')}</div>
          {s?.instances.length ? (
            <table className="table">
              <thead>
                <tr>
                  <th>{t('Nombre')}</th>
                  <th>{t('Mods')}</th>
                  <th>{t('Mundos')}</th>
                  <th>{t('Paquetes de recursos')}</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {s.instances.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td className="num">{bytes(i.mods)}</td>
                    <td className="num">{bytes(i.saves)}</td>
                    <td className="num">{bytes(i.resourcepacks)}</td>
                    <td className="num" style={{ textAlign: 'right' }}>
                      {bytes(i.total)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Button size="sm" variant="ghost" iconOnly icon={<LuFolderOpen />} onClick={() => run(() => call(api.instances.openFolder(i.id, 'root')))}>
                        {t('Abrir carpeta')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted small">{t('Aún no tienes instancias')}</p>
          )}
        </section>
        <section className="panel">
          <div className="panel-title">
            <span>{t('Archivos más grandes')}</span>
            {!big && (
              <Button size="sm" onClick={async () => setBig(await run(() => call(api.storage.largest(15))))}>
                {t('Calcular')}
              </Button>
            )}
          </div>
          {big && (
            <table className="table">
              <tbody>
                {big.map((f) => (
                  <tr key={f.path}>
                    <td className="path" title={f.path}>
                      {f.path}
                    </td>
                    <td className="num" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {bytes(f.size)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {plan && (
        <Confirm
          title={t('Limpiar')}
          body={plan.items.length ? t('Se eliminarán {n} archivos regenerables (caché, temporales y registros antiguos). Estimado: {size}. Nunca se tocan mundos, mods ni configuraciones.', { n: plan.items.length, size: bytes(plan.estimatedBytes) }) : t('No hay nada que limpiar.')}
          confirmLabel={t('Limpiar')}
          onCancel={() => setPlan(undefined)}
          onConfirm={async () => {
            if (!plan.items.length) return setPlan(undefined);
            const r = await run(() => call(api.storage.executeCleanup(plan.planId)));
            setPlan(undefined);
            if (r) {
              setFreed(r.freedBytes);
              void refresh(true);
            }
          }}
        />
      )}
      {moving && (
        <Confirm
          title={t('Cambiar ubicación de instancias')}
          body={t('Las instancias se copiarán, se verificará la copia y el launcher se reiniciará.')}
          confirmLabel={t('Cambiar ubicación de instancias')}
          onCancel={() => setMoving(false)}
          onConfirm={async () => {
            await run(() => call(api.storage.moveInstances()));
            setMoving(false);
          }}
        />
      )}
    </div>
  );
}
