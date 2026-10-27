import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Settings, SettingsPatch } from '../../shared/settings';
import type { AccountSummary, AppInfo, InstanceView, NotificationItem, SocialState, TaskProgress, UpdateInfo } from '../../shared/types';
import { api, call } from './api';
import { setLang } from './i18n';
import { brand } from '../../shared/brand';

export type Route = 'home' | 'instances' | 'keys' | 'skins' | 'social' | 'storage' | 'settings' | 'profile';

interface AppState {
  ready: boolean;
  info?: AppInfo;
  settings?: Settings;
  accounts: AccountSummary[];
  active?: AccountSummary;
  instances: InstanceView[];
  progress: Record<string, TaskProgress>;
  update?: UpdateInfo;
  notifications: NotificationItem[];
  social?: SocialState;
  route: Route;
  routeParam?: string;
  go(route: Route, param?: string): void;
  refreshAccounts(): Promise<void>;
  refreshInstances(): Promise<void>;
  updateSettings(p: SettingsPatch): Promise<Settings>;
  setSettings(s: Settings): void;
  selectInstance(id: string): void;
  selected?: InstanceView;
  dismissNotification(id: string): void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp fuera de AppProvider');
  return c;
}

function applyAppearance(s: Settings) {
  const root = document.documentElement;
  const theme = s.general.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.general.theme;
  root.dataset.theme = theme;
  root.dataset.motion = s.general.animations === 'system' ? '' : s.general.animations;
  root.style.setProperty('--accent', s.general.accent ?? brand.colors.accent);
  setLang(s.general.language);
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [info, setInfo] = useState<AppInfo>();
  const [settings, setSettingsState] = useState<Settings>();
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [instances, setInstances] = useState<InstanceView[]>([]);
  const [progress, setProgress] = useState<Record<string, TaskProgress>>({});
  const [update, setUpdate] = useState<UpdateInfo>();
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [social, setSocial] = useState<SocialState>();
  const [route, setRoute] = useState<Route>('home');
  const [routeParam, setRouteParam] = useState<string>();

  const setSettings = useCallback((s: Settings) => {
    setSettingsState(s);
    applyAppearance(s);
  }, []);

  const refreshAccounts = useCallback(async () => {
    const r = await call(api.accounts.list());
    setAccounts(r.accounts);
    setActiveId(r.activeId);
  }, []);
  const refreshInstances = useCallback(async () => setInstances(await call(api.instances.list())), []);

  useEffect(() => {
    (async () => {
      const [i, s] = await Promise.all([call(api.app.info()), call(api.settings.get())]);
      setInfo(i);
      setSettings(s);
      await Promise.all([
        refreshAccounts(),
        refreshInstances(),
        call(api.updates.status()).then(setUpdate),
        call(api.app.notifications()).then(setNotifications),
        call(api.social.state()).then(setSocial),
      ]).catch(() => undefined);
      setReady(true);
    })();
    const offs = [
      api.on.instances((list) => setInstances(list)),
      api.on.accounts(() => void refreshAccounts()),
      api.on.update((u) => setUpdate(u)),
      api.on.notification((n) => setNotifications((l) => [n, ...l.filter((x) => x.id !== n.id)])),
      api.on.social((e) => {
        if (e.type === 'state') setSocial(e.state);
      }),
      api.on.progress((p) => {
        if (!p.instanceId) return;
        setProgress((m) => {
          const next = { ...m };
          if (p.state === 'running') next[p.instanceId!] = p;
          else delete next[p.instanceId!];
          return next;
        });
      }),
    ];
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = () => setSettingsState((s) => (s && applyAppearance(s), s));
    mq.addEventListener('change', onScheme);
    return () => {
      offs.forEach((o) => o());
      mq.removeEventListener('change', onScheme);
    };
  }, [refreshAccounts, refreshInstances, setSettings]);

  const updateSettings = useCallback(
    async (p: SettingsPatch) => {
      const s = await call(api.settings.update(p));
      setSettings(s);
      if (p.ui && 'activeAccountId' in p.ui) await refreshAccounts();
      return s;
    },
    [refreshAccounts, setSettings],
  );

  const selectedId = settings?.ui.selectedInstanceId;
  const selected = useMemo(() => {
    const byId = instances.find((i) => i.id === selectedId);
    if (byId) return byId;
    return [...instances].sort((a, b) => (b.lastPlayedAt ?? b.createdAt) - (a.lastPlayedAt ?? a.createdAt))[0];
  }, [instances, selectedId]);

  const value: AppState = {
    ready,
    info,
    settings,
    accounts,
    active: accounts.find((a) => a.id === activeId),
    instances,
    progress,
    update,
    notifications,
    social,
    route,
    routeParam,
    go: (r, param) => {
      setRoute(r);
      setRouteParam(param);
      document.getElementById('content')?.scrollTo({ top: 0 });
    },
    refreshAccounts,
    refreshInstances,
    updateSettings,
    setSettings,
    selectInstance: (id) => void updateSettings({ ui: { selectedInstanceId: id } }),
    selected,
    dismissNotification: (id) => {
      setNotifications((l) => l.filter((x) => x.id !== id));
      void api.app.dismissNotification(id);
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
