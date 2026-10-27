import path from 'node:path';

/**
 * Distribución de directorios. `userData` lo decide Electron (%APPDATA%\Unreal Launcher en Windows).
 * Los datos compartidos (librerías, assets, versiones) son direccionados por hash y de solo lectura
 * para las instancias; cada instancia vive en su propia carpeta.
 */
export interface AppPaths {
  userData: string;
  logs: string;
  settingsFile: string;
  accountsFile: string;
  secretsDir: string;
  instancesIndex: string;
  instancesDir: string;
  shared: string;
  libraries: string;
  assets: string;
  versions: string;
  runtimes: string;
  cache: string;
  temp: string;
  skinsDir: string;
  skinsIndex: string;
  keysFile: string;
  updatesDir: string;
  notificationsFile: string;
}

export function buildPaths(userData: string, opts: { instancesDir?: string; tempDir?: string } = {}): AppPaths {
  const data = path.join(userData, 'data');
  const shared = path.join(data, 'shared');
  return {
    userData,
    logs: path.join(userData, 'logs'),
    settingsFile: path.join(userData, 'settings.json'),
    accountsFile: path.join(userData, 'accounts.json'),
    secretsDir: path.join(userData, 'secrets'),
    instancesIndex: path.join(userData, 'instances.json'),
    instancesDir: opts.instancesDir || path.join(data, 'instances'),
    shared,
    libraries: path.join(shared, 'libraries'),
    assets: path.join(shared, 'assets'),
    versions: path.join(shared, 'versions'),
    runtimes: path.join(data, 'runtimes'),
    cache: path.join(data, 'cache'),
    temp: opts.tempDir || path.join(data, 'tmp'),
    skinsDir: path.join(userData, 'skins'),
    skinsIndex: path.join(userData, 'skins', 'index.json'),
    keysFile: path.join(userData, 'grants.json'),
    updatesDir: path.join(data, 'updates'),
    notificationsFile: path.join(userData, 'notifications.json'),
  };
}

/** Garantiza que `child` queda dentro de `parent` (protección ante path traversal). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function safeJoin(parent: string, ...parts: string[]): string {
  const p = path.resolve(parent, ...parts);
  if (!isInside(parent, p)) throw new Error(`Ruta fuera del directorio permitido: ${parts.join('/')}`);
  return p;
}
