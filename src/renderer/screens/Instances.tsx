import { useEffect, useMemo, useRef, useState } from 'react';
import { LuBoxes, LuFolderInput, LuFolderOpen, LuFolderOutput, LuPlus, LuScanSearch, LuSearch, LuTrash2 } from 'react-icons/lu';
import type { InstanceView, LoaderKind, LoaderVersionInfo, McVersionInfo } from '../../shared/types';
import { Cover, COVER_KEYS } from '../components/Cover';
import { PlayButton, TaskLine, stateLabel, useAction, useProgressFor } from '../components/common';
import { Button, Callout, Confirm, Empty, Field, Modal, Segmented, Switch } from '../components/ui';
import { api, call, errOf } from '../lib/api';
import { ago, LOADER_LABEL } from '../lib/format';
import { describeError, t } from '../lib/i18n';
import { useApp } from '../lib/store';

function CoverPicker({ value, onChange, seed }: { value: string; onChange: (v: string) => void; seed: string }) {
  return (
    <div className="cover-picker" role="group" aria-label={t('Portada')}>
      {COVER_KEYS.map((k) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)} aria-label={k}>
          <Cover cover={k} seed={seed} width={32} height={32} />
        </button>
      ))}
    </div>
  );
}

function MemorySlider({ value, onChange, max }: { value: number; onChange: (v: number) => void; max: number }) {
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <input className="range" type="range" min={1024} max={Math.max(1024, max)} step={256} value={Math.min(value, max)} onChange={(e) => onChange(Number(e.target.value))} aria-label={t('Memoria máxima')} />
        <span className="num" style={{ minWidth: 72, textAlign: 'right' }}>
          {(value / 1024).toFixed(value % 1024 ? 2 : 0)} GB
        </span>
      </div>
    </div>
  );
}

export function NewInstanceModal({ onClose }: { onClose: () => void }) {
  const { info, settings, selectInstance, go } = useApp();
  const [name, setName] = useState('');
  const [snap, setSnap] = useState(false);
  const [versions, setVersions] = useState<McVersionInfo[]>();
  const [mc, setMc] = useState('');
  const [loader, setLoader] = useState<LoaderKind>('vanilla');
  const [lvList, setLvList] = useState<LoaderVersionInfo[]>();
  const [lv, setLv] = useState('');
  const [consent, setConsent] = useState(false);
  const [cover, setCover] = useState('grass');
  const [mem, setMem] = useState(settings?.minecraft.defaultMemoryMaxMb ?? 4096);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const seed = useRef(Math.random().toString(36)).current;

  useEffect(() => {
    setLoadErr(null);
    call(api.instances.mcVersions(snap))
      .then((v) => {
        setVersions(v);
        setMc((cur) => (cur && v.some((x) => x.id === cur) ? cur : v[0]?.id ?? ''));
      })
      .catch((e) => setLoadErr(describeError(errOf(e))));
  }, [snap]);

  useEffect(() => {
    setLvList(undefined);
    setLv('');
    if (loader === 'vanilla' || !mc) return;
    call(api.instances.loaderVersions(loader, mc))
      .then(setLvList)
      .catch((e) => {
        setLvList([]);
        setError(describeError(errOf(e)));
      });
  }, [loader, mc]);

  const needsConsent = loader === 'forge' || loader === 'neoforge';
  const valid = name.trim().length > 0 && name.trim().length <= 48 && !!mc && (!needsConsent || consent) && (loader === 'vanilla' || (lvList?.length ?? 0) > 0);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const inst = await call(
        api.instances.create({ name: name.trim(), mcVersion: mc, loader: { kind: loader, version: lv || undefined, installerTrusted: needsConsent ? consent : undefined }, cover, memoryMaxMb: mem }),
      );
      selectInstance(inst.id);
      await call(api.instances.install(inst.id));
      onClose();
      go('instances', inst.id);
    } catch (e) {
      setError(describeError(errOf(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t('Nueva instancia')}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>{t('Cancelar')}</Button>
          <Button variant="primary" busy={busy} disabled={!valid} onClick={() => void submit()}>
            {t('Crear instancia')}
          </Button>
        </>
      }
    >
      <form
        className="stack"
        style={{ gap: 18 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void submit();
        }}
      >
        <Field label={t('Nombre')} htmlFor="ni-name" error={name.length > 48 ? describeError({ code: 'VALIDATION', detail: 'instance.name' }) : null}>
          <input id="ni-name" className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} data-autofocus placeholder="Survival con amigos" />
        </Field>
        <div className="grid grid-2">
          <Field label={t('Versión de Minecraft')} htmlFor="ni-ver" error={loadErr}>
            <select id="ni-ver" className="select" value={mc} onChange={(e) => setMc(e.target.value)} disabled={!versions}>
              {!versions && <option>{t('Cargando')}…</option>}
              {versions?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.id}
                  {v.type !== 'release' ? ` (${v.type})` : ''}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span className="field-label">&nbsp;</span>
            <Switch checked={snap} onChange={setSnap} label={t('Mostrar snapshots')} />
          </div>
        </div>
        <div className="field">
          <span className="field-label">{t('Loader')}</span>
          <Segmented<LoaderKind>
            label={t('Loader')}
            value={loader}
            onChange={setLoader}
            options={(['vanilla', 'fabric', 'forge', 'neoforge'] as const).map((k) => ({ value: k, label: LOADER_LABEL[k] }))}
          />
        </div>
        {loader !== 'vanilla' && (
          <Field label={t('Versión del loader')} htmlFor="ni-lv" hint={lvList && !lvList.length ? describeError({ code: 'UNSUPPORTED_LOADER' }) : undefined}>
            <select id="ni-lv" className="select" value={lv} onChange={(e) => setLv(e.target.value)} disabled={!lvList?.length}>
              <option value="">{lvList ? t('Última estable') : `${t('Cargando')}…`}</option>
              {lvList?.slice(0, 60).map((v) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                  {v.stable ? '' : ' (beta)'}
                </option>
              ))}
            </select>
          </Field>
        )}
        {needsConsent && (
          <Callout tone="warn">
            <div className="stack" style={{ gap: 8 }}>
              <span>{t('Forge y NeoForge se instalan ejecutando su instalador oficial, descargado de su repositorio y verificado por checksum. ¿Confías en él?')}</span>
              <label className="row" style={{ cursor: 'pointer' }}>
                <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>{t('Confío en el instalador oficial')}</span>
              </label>
            </div>
          </Callout>
        )}
        <div className="grid grid-2">
          <div className="field">
            <span className="field-label">{t('Portada')}</span>
            <CoverPicker value={cover} onChange={setCover} seed={seed} />
          </div>
          <div className="field">
            <span className="field-label">{t('Memoria máxima')}</span>
            <MemorySlider value={mem} onChange={setMem} max={info?.maxMemMb ?? 8192} />
          </div>
        </div>
        {error && <Callout tone="danger">{error}</Callout>}
      </form>
    </Modal>
  );
}

function GameLog({ id }: { id: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    call(api.instances.gameLog(id)).then(setLines).catch(() => undefined);
    return api.on.gameLog((e) => {
      if (e.instanceId === id) setLines((l) => [...l, ...e.lines].slice(-1500));
    });
  }, [id]);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div ref={ref} className="log-view" role="log" aria-live="off" aria-label={t('Registro del juego')}>
      {lines.length ? lines.join('\n') : <span className="muted">{t('El registro aparecerá cuando inicies la instancia.')}</span>}
    </div>
  );
}

function Detail({ inst }: { inst: InstanceView }) {
  const { info, go } = useApp();
  const p = useProgressFor(inst.id);
  const run = useAction();
  const [tab, setTab] = useState<'general' | 'perf' | 'log' | 'adv'>('general');
  const [name, setName] = useState(inst.name);
  const [cover, setCover] = useState(inst.cover);
  const [mem, setMem] = useState(inst.memory.maxMb);
  const [minMem, setMinMem] = useState(inst.memory.minMb);
  const [jvm, setJvm] = useState(inst.jvmArgs.join(' '));
  const [game, setGame] = useState(inst.game);
  const [javaPath, setJavaPath] = useState(inst.java.path ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setName(inst.name);
    setCover(inst.cover);
    setMem(inst.memory.maxMb);
    setMinMem(inst.memory.minMb);
    setJvm(inst.jvmArgs.join(' '));
    setGame(inst.game);
    setJavaPath(inst.java.path ?? '');
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inst.id]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const args = jvm.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((a) => a.replace(/^"|"$/g, '')) ?? [];
      await call(api.instances.update(inst.id, { name, cover, memory: { minMb: Math.min(minMem, mem), maxMb: mem }, jvmArgs: args, game, java: { path: javaPath || undefined } }));
      run(async () => undefined, t('Cambios guardados'));
    } catch (e) {
      setErr(describeError(errOf(e)));
    } finally {
      setSaving(false);
    }
  };

  const locked = inst.access.kind === 'private' && inst.access.status !== 'granted';

  return (
    <div className="stack" style={{ gap: 0 }}>
      <section className="scene inst-detail-scene" aria-label={inst.name}>
        <Cover cover={inst.cover} seed={inst.id} width={200} height={60} />
        <div className="veil" />
        <div className="hero-inner">
          <h2 className="hero-title">{inst.name}</h2>
          <div className="hero-meta">
            <span className="badge">Minecraft {inst.mcVersion}</span>
            <span className="badge">
              {LOADER_LABEL[inst.loader.kind]} {inst.loader.version ?? ''}
            </span>
            <span className="badge">{stateLabel(inst)}</span>
            {inst.java.major && <span className="badge">Java {inst.java.major}</span>}
          </div>
          <div className="hero-actions">
            <PlayButton inst={inst} compact />
            {p && (
              <div style={{ flex: 1, minWidth: 220 }}>
                <TaskLine p={p} light />
              </div>
            )}
          </div>
        </div>
      </section>
      {locked && (
        <div style={{ marginTop: 12 }}>
          <Callout tone="warn" action={<Button size="sm" onClick={() => go('keys')}>{t('Agregar clave')}</Button>}>
            {describeError({ code: 'INSTANCE_LOCKED' })}
          </Callout>
        </div>
      )}
      {inst.lastError && !p && (
        <div style={{ marginTop: 12 }}>
          <Callout tone="danger" action={<Button size="sm" onClick={() => setTab('log')}>{t('Ver registro')}</Button>}>
            {describeError({ code: inst.lastError.code, detail: inst.lastError.detail })}
          </Callout>
        </div>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ['general', t('General')],
            ['perf', t('Rendimiento')],
            ['log', t('Registro del juego')],
            ['adv', t('Avanzado')],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'general' && (
        <div className="stack" style={{ gap: 16 }}>
          <Field label={t('Nombre')} htmlFor="d-name">
            <input id="d-name" className="input" value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
          </Field>
          <div className="field">
            <span className="field-label">{t('Portada')}</span>
            <CoverPicker value={cover} onChange={setCover} seed={inst.id} />
          </div>
          <div className="row small muted">
            {t('Última partida')}: {ago(inst.lastPlayedAt)}
          </div>
        </div>
      )}
      {tab === 'perf' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid grid-2">
            <div className="field">
              <span className="field-label">{t('Memoria máxima')}</span>
              <MemorySlider value={mem} onChange={setMem} max={info?.maxMemMb ?? 8192} />
            </div>
            <Field label={t('Memoria mínima')} htmlFor="d-min">
              <select id="d-min" className="select" value={minMem} onChange={(e) => setMinMem(Number(e.target.value))}>
                {[512, 1024, 2048, 3072, 4096].filter((v) => v <= mem).map((v) => (
                  <option key={v} value={v}>
                    {v} MB
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('Argumentos JVM')} htmlFor="d-jvm" hint="-XX:+UseG1GC -Dfile.encoding=UTF-8">
            <input id="d-jvm" className="input" value={jvm} onChange={(e) => setJvm(e.target.value)} spellCheck={false} />
          </Field>
          <Field label={t('Java de la instancia')} htmlFor="d-java" hint={t('Automático')}>
            <div className="row">
              <input id="d-java" className="input" value={javaPath} placeholder={t('Automático')} onChange={(e) => setJavaPath(e.target.value)} spellCheck={false} />
              <Button
                onClick={async () => {
                  const j = await run(() => call(api.settings.chooseJava()));
                  if (j) setJavaPath(j.path);
                }}
              >
                {t('Elegir ejecutable')}
              </Button>
            </div>
          </Field>
          <div className="grid grid-3">
            <Field label={`${t('Resolución')} (px)`} htmlFor="d-w">
              <input id="d-w" className="input num" type="number" min={320} max={7680} value={game.width} onChange={(e) => setGame({ ...game, width: Number(e.target.value) })} />
            </Field>
            <Field label="&nbsp;" htmlFor="d-h">
              <input id="d-h" className="input num" type="number" min={240} max={4320} value={game.height} onChange={(e) => setGame({ ...game, height: Number(e.target.value) })} aria-label="alto" />
            </Field>
            <div className="field">
              <span className="field-label">&nbsp;</span>
              <Switch checked={game.fullscreen} onChange={(v) => setGame({ ...game, fullscreen: v })} label={t('Pantalla completa')} />
            </div>
          </div>
        </div>
      )}
      {tab === 'log' && <GameLog id={inst.id} />}
      {tab === 'adv' && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="row wrap">
            <Button icon={<LuFolderOpen />} onClick={() => run(() => call(api.instances.openFolder(inst.id, 'root')))}>
              {t('Abrir carpeta')}
            </Button>
            <Button onClick={() => run(() => call(api.instances.openFolder(inst.id, 'mods')))}>{t('Mods')}</Button>
            <Button onClick={() => run(() => call(api.instances.openFolder(inst.id, 'saves')))}>{t('Mundos')}</Button>
            <Button onClick={() => run(() => call(api.instances.openFolder(inst.id, 'resourcepacks')))}>{t('Paquetes de recursos')}</Button>
          </div>
          <div className="row wrap">
            <Button
              icon={<LuScanSearch />}
              disabled={inst.busy || inst.installState === 'not-installed'}
              onClick={async () => {
                const r = await run(() => call(api.instances.verify(inst.id)));
                if (r) run(async () => undefined, r.ok ? t('Integridad correcta: {n} archivos verificados', { n: r.checked }) : t('{bad} archivos dañados de {n}', { bad: r.bad, n: r.checked }));
              }}
            >
              {t('Verificar integridad')}
            </Button>
            <Button
              icon={<LuFolderOutput />}
              disabled={inst.access.kind === 'private'}
              onClick={async () => {
                const r = await run(() => call(api.instances.exportInstance(inst.id)));
                if (r) run(async () => undefined, t('Instancia exportada'));
              }}
            >
              {t('Exportar')}
            </Button>
          </div>
          <div className="divider" />
          <div>
            <Button variant="danger" icon={<LuTrash2 />} disabled={inst.running || inst.busy} onClick={() => setConfirmDelete(true)}>
              {t('Eliminar instancia')}
            </Button>
          </div>
        </div>
      )}
      {(tab === 'general' || tab === 'perf') && (
        <div className="row" style={{ marginTop: 20 }}>
          {err && (
            <span className="small" style={{ color: 'var(--danger)' }} role="alert">
              {err}
            </span>
          )}
          <span className="spacer" />
          <Button variant="primary" busy={saving} onClick={() => void save()}>
            {t('Guardar cambios')}
          </Button>
        </div>
      )}
      {confirmDelete && (
        <Confirm
          danger
          title={t('¿Eliminar «{name}»?', { name: inst.name })}
          body={t('Se borrará su carpeta, incluidos mundos, mods y configuraciones. Las demás instancias no se verán afectadas. Esta acción no se puede deshacer.')}
          confirmLabel={t('Eliminar definitivamente')}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            await run(() => call(api.instances.remove(inst.id)));
            setConfirmDelete(false);
          }}
        />
      )}
    </div>
  );
}

export default function Instances() {
  const { instances, routeParam, selected, selectInstance } = useApp();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const run = useAction();
  const [current, setCurrent] = useState<string | undefined>(routeParam ?? selected?.id);
  const list = useMemo(() => instances.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()) || i.mcVersion.includes(q)), [instances, q]);
  const inst = instances.find((i) => i.id === current) ?? list[0];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{t('Instancias')}</h1>
        </div>
        <div className="page-actions">
          <Button
            icon={<LuFolderInput />}
            onClick={async () => {
              const r = await run(() => call(api.instances.importInstance()));
              if (r) {
                setCurrent(r.id);
                run(async () => undefined, t('Instancia importada'));
              }
            }}
          >
            {t('Importar')}
          </Button>
          <Button variant="primary" icon={<LuPlus />} onClick={() => setCreating(true)}>
            {t('Nueva instancia')}
          </Button>
        </div>
      </div>
      {instances.length === 0 ? (
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
      ) : (
        <div className="inst-layout">
          <div className="stack">
            <div className="input-group">
              <input className="input" placeholder={t('Buscar')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('Buscar')} />
              <span className="btn ghost icon" aria-hidden style={{ pointerEvents: 'none' }}>
                <LuSearch />
              </span>
            </div>
            <div className="inst-list" role="listbox" aria-label={t('Instancias')}>
              {list.length === 0 && <p className="muted small">{t('Ninguna instancia coincide')}</p>}
              {list.map((i) => (
                <button
                  key={i.id}
                  role="option"
                  className="inst-card"
                  aria-selected={i.id === inst?.id}
                  onClick={() => {
                    setCurrent(i.id);
                    selectInstance(i.id);
                  }}
                >
                  <span className="cover-thumb">
                    <Cover cover={i.cover} seed={i.id} width={28} height={28} />
                  </span>
                  <span className="meta">
                    <strong>{i.name}</strong>
                    <span className="sub">
                      {i.running ? <span className="dot online" /> : null}
                      {i.mcVersion} {LOADER_LABEL[i.loader.kind]}
                      {i.access.kind === 'private' ? ` — ${t('Privada')}` : ''}
                    </span>
                  </span>
                  <span className="badge">{i.busy ? t('Trabajando') : stateLabel(i)}</span>
                </button>
              ))}
            </div>
          </div>
          {inst && <Detail inst={inst} />}
        </div>
      )}
      {creating && <NewInstanceModal onClose={() => setCreating(false)} />}
    </div>
  );
}

