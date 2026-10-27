import { useEffect, useRef, useState } from 'react';
import { LuShieldCheck, LuStar, LuTrash2, LuUpload } from 'react-icons/lu';
import type { SkinEntry, SkinVariant } from '../../shared/types';
import { useAction } from '../components/common';
import { Button, Callout, Empty, Segmented } from '../components/ui';
import { api, call } from '../lib/api';
import { describeError, t } from '../lib/i18n';
import { useApp } from '../lib/store';
import { drawFront, loadImage, placeholderSkin } from '../skin3d/skin';
import { SkinViewer } from '../skin3d/SkinViewer';

function Thumb({ entry }: { entry: SkinEntry }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void drawFront(ref.current, entry.dataUrl, entry.variant);
  }, [entry.dataUrl, entry.variant]);
  return <canvas ref={ref} aria-hidden />;
}

export default function Skins() {
  const { active, go, settings, refreshAccounts } = useApp();
  const premium = !!active?.premium;
  const [library, setLibrary] = useState<SkinEntry[]>([]);
  const [current, setCurrent] = useState<{ dataUrl?: string; variant: SkinVariant } | null>(null);
  const [sel, setSel] = useState<string>();
  const [over, setOver] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dropErr, setDropErr] = useState<string | null>(null);
  const run = useAction();
  const accent = settings?.general.accent ?? '#8b5cf6';

  const reload = () => call(api.skins.library()).then(setLibrary).catch(() => undefined);
  useEffect(() => {
    if (!premium) return;
    void reload();
    call(api.skins.current()).then(setCurrent).catch(() => undefined);
  }, [premium, active?.id]);

  const selected = library.find((s) => s.id === sel);
  const viewSkin = selected?.dataUrl ?? current?.dataUrl ?? placeholderSkin(accent);
  const viewVariant = selected?.variant ?? current?.variant ?? 'classic';

  const importFile = async (file: File) => {
    setDropErr(null);
    if (file.type !== 'image/png' || file.size > 256 * 1024) {
      setDropErr(describeError({ code: 'SKIN_INVALID' }));
      return;
    }
    const dataUrl = await new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result));
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const img = await loadImage(dataUrl).catch(() => null);
    if (!img || img.width !== 64 || (img.height !== 64 && img.height !== 32)) {
      setDropErr(describeError({ code: 'SKIN_INVALID' }));
      return;
    }
    const e = await run(() => call(api.skins.importData(file.name, dataUrl, 'classic')));
    if (e) {
      await reload();
      setSel(e.id);
    }
  };

  const favorites = library.filter((s) => s.favorite);
  const recents = library.filter((s) => !s.favorite);

  const tile = (s: SkinEntry) => (
    <div key={s.id} className="skin-tile" role="button" tabIndex={0} aria-pressed={s.id === sel} onClick={() => setSel(s.id)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(s.id))}>
      <Thumb entry={s} />
      <span className="name">{s.name}</span>
      <button
        className="btn ghost sm icon fav"
        aria-label={s.favorite ? t('Quitar de favoritas') : t('Añadir a favoritas')}
        onClick={(e) => {
          e.stopPropagation();
          void run(() => call(api.skins.setFavorite(s.id, !s.favorite))).then(reload);
        }}
      >
        <LuStar style={{ fill: s.favorite ? 'var(--warn)' : 'none', color: s.favorite ? 'var(--warn)' : undefined }} />
      </button>
    </div>
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Skins')}</h1>
          <p>{t('Esta vista previa no cambia tu skin hasta que pulses «Aplicar a mi cuenta».')}</p>
        </div>
        {premium && (
          <div className="page-actions">
            <Button icon={<LuUpload />} onClick={() => run(() => call(api.skins.importFile())).then((e) => e && (reload(), setSel(e.id)))}>
              {t('Subir PNG')}
            </Button>
          </div>
        )}
      </div>
      {!premium && (
        <div style={{ marginBottom: 16 }}>
          <Callout tone="info" action={<Button size="sm" variant="primary" onClick={() => go('profile')}>{t('Iniciar sesión con Microsoft')}</Button>}>
            {t('Las skins personalizadas requieren una cuenta Microsoft con Minecraft Java Edition.')}
          </Callout>
        </div>
      )}
      <div className="skins-layout">
        <div className="stack">
          <div className="viewer">
            <SkinViewer skin={viewSkin} variant={viewVariant} label={selected ? `${t('Vista previa local')}: ${selected.name}` : t('Skin actual')} />
            <span className="viewer-badge badge">{selected ? t('Vista previa local') : t('Skin actual')}</span>
            <span className="viewer-hint">{t('Arrastra para girar')}</span>
          </div>
          {selected && (
            <div className="panel stack" style={{ gap: 12 }}>
              <div className="row">
                <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{selected.name}</strong>
                <Segmented<SkinVariant>
                  label="Modelo"
                  value={selected.variant}
                  onChange={(v) => void run(() => call(api.skins.setVariant(selected.id, v))).then(reload)}
                  options={[
                    { value: 'classic', label: t('Clásico') },
                    { value: 'slim', label: t('Delgado') },
                  ]}
                />
              </div>
              <div className="row">
                <Button
                  variant="primary"
                  icon={<LuShieldCheck />}
                  busy={applying}
                  disabled={!premium}
                  onClick={async () => {
                    setApplying(true);
                    const r = await run(() => call(api.skins.apply(selected.id)), t('Skin aplicada en tu perfil de Minecraft'));
                    setApplying(false);
                    if (r) {
                      await refreshAccounts();
                      setCurrent(await call(api.skins.current()).catch(() => null));
                      await reload();
                    }
                  }}
                >
                  {t('Aplicar a mi cuenta')}
                </Button>
                <span className="spacer" />
                <Button
                  variant="ghost"
                  iconOnly
                  icon={<LuTrash2 />}
                  onClick={() =>
                    void run(() => call(api.skins.remove(selected.id))).then(() => {
                      setSel(undefined);
                      void reload();
                    })
                  }
                >
                  {t('Eliminar')}
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="stack" style={{ gap: 16 }}>
          {premium && (
            <div
              className={`dropzone${over ? ' over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                const f = e.dataTransfer.files[0];
                if (f) void importFile(f);
              }}
            >
              {t('Suelta aquí un PNG de 64×64')}
              {dropErr && (
                <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }} role="alert">
                  {dropErr}
                </div>
              )}
            </div>
          )}
          {premium && favorites.length > 0 && (
            <section>
              <h3 style={{ marginBottom: 10 }}>{t('Favoritas')}</h3>
              <div className="skin-grid">{favorites.map(tile)}</div>
            </section>
          )}
          {premium && (
            <section>
              <h3 style={{ marginBottom: 10 }}>{t('Biblioteca')}</h3>
              {recents.length ? <div className="skin-grid">{recents.map(tile)}</div> : favorites.length ? null : <Empty title={t('Biblioteca')}>{t('Tu biblioteca está vacía. Sube un PNG de 64×64 para previsualizarlo.')}</Empty>}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
