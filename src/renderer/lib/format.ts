import { t } from './i18n';

export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function speed(n: number): string {
  return `${bytes(n)}/s`;
}

export function ago(ts?: number): string {
  if (!ts) return t('Nunca');
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return t('Ahora');
  if (s < 3600) return t('hace {n} min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('hace {n} h', { n: Math.floor(s / 3600) });
  return t('hace {n} d', { n: Math.floor(s / 86400) });
}

export function date(ts: number | string, lang: string): string {
  return new Date(ts).toLocaleDateString(lang === 'en' ? 'en-US' : 'es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function time(ts: number, lang: string): string {
  return new Date(ts).toLocaleTimeString(lang === 'en' ? 'en-US' : 'es-ES', { hour: '2-digit', minute: '2-digit' });
}

export const LOADER_LABEL: Record<string, string> = { vanilla: 'Vanilla', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' };

export function stageLabel(stage: string): string {
  return (
    {
      metadata: t('Preparando metadatos'),
      loader: t('Instalando loader'),
      java: t('Preparando Java'),
      libraries: t('Descargando librerías'),
      assets: t('Descargando recursos'),
      private: t('Descargando archivos privados'),
      finalize: t('Finalizando'),
      verify: t('Verificando archivos'),
    }[stage] ?? stage
  );
}
