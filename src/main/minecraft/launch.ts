import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../shared/errors';
import { extractZip } from '../core/archive';
import { safeJoin, type AppPaths } from '../core/paths';
import { classpath, resolveLibraries, rulesAllow, type ArgValue, type Platform, type VersionJson } from './versionJson';

export interface LaunchParams {
  version: VersionJson;
  versionId: string;
  paths: AppPaths;
  gameDir: string;
  nativesDir: string;
  identity: { username: string; uuid: string; accessToken: string; userType: 'msa' | 'legacy'; xuid?: string };
  memory: { minMb: number; maxMb: number };
  jvmArgs: string[];
  game: { width: number; height: number; fullscreen: boolean };
  launcherName: string;
  launcherVersion: string;
  platform: Platform;
}

export interface LaunchCommand {
  args: string[];
  mainClass: string;
}

function flattenArgs(list: ArgValue[] | undefined, p: Platform, features: Record<string, boolean>): string[] {
  const out: string[] = [];
  for (const a of list ?? []) {
    if (typeof a === 'string') out.push(a);
    else if (rulesAllow(a.rules, p, features)) out.push(...(Array.isArray(a.value) ? a.value : [a.value]));
  }
  return out;
}

/**
 * Construye la línea de comandos de Java exactamente como el launcher oficial:
 * formato moderno (`arguments`) y legado (`minecraftArguments`).
 */
export function buildLaunchCommand(lp: LaunchParams): LaunchCommand {
  const v = lp.version;
  const sep = lp.platform.os === 'windows' ? ';' : ':';
  const jarId = v.jar ?? lp.versionId;
  const clientJar = path.join(lp.paths.versions, jarId, `${jarId}.jar`);
  const cp = classpath(resolveLibraries(v, lp.platform), lp.paths.libraries, clientJar).join(sep);
  const assetsIndex = v.assetIndex?.id ?? v.assets ?? 'legacy';
  const legacyAssets = assetsIndex === 'legacy' || assetsIndex === 'pre-1.6';
  const vars: Record<string, string> = {
    auth_player_name: lp.identity.username,
    version_name: lp.versionId,
    game_directory: lp.gameDir,
    assets_root: lp.paths.assets,
    game_assets: legacyAssets ? path.join(lp.paths.assets, 'virtual', assetsIndex) : lp.paths.assets,
    assets_index_name: assetsIndex,
    auth_uuid: lp.identity.uuid.replace(/-/g, ''),
    auth_access_token: lp.identity.accessToken,
    auth_session: `token:${lp.identity.accessToken}:${lp.identity.uuid.replace(/-/g, '')}`,
    auth_xuid: lp.identity.xuid ?? '0',
    clientid: '0',
    user_type: lp.identity.userType,
    user_properties: '{}',
    version_type: v.type ?? 'release',
    natives_directory: lp.nativesDir,
    launcher_name: lp.launcherName,
    launcher_version: lp.launcherVersion,
    classpath: cp,
    classpath_separator: sep,
    library_directory: lp.paths.libraries,
    resolution_width: String(lp.game.width),
    resolution_height: String(lp.game.height),
  };
  const subst = (s: string) => s.replace(/\$\{([a-zA-Z_]+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const features = { has_custom_resolution: !lp.game.fullscreen, is_demo_user: false };

  const jvm: string[] = [`-Xms${lp.memory.minMb}M`, `-Xmx${lp.memory.maxMb}M`];
  if (v.arguments?.jvm?.length) {
    jvm.push(...flattenArgs(v.arguments.jvm, lp.platform, features).map(subst));
  } else {
    if (lp.platform.os === 'osx') jvm.push('-XstartOnFirstThread');
    if (lp.platform.os === 'windows') jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump');
    jvm.push(`-Djava.library.path=${lp.nativesDir}`, '-cp', cp);
  }
  if (v.logging?.client?.argument && v.logging.client.file) {
    jvm.push(v.logging.client.argument.replace('${path}', path.join(lp.paths.assets, 'log_configs', v.logging.client.file.id)));
  }
  // Argumentos del usuario (validados en SettingsService.validateJvmArgs) antes de la clase principal.
  jvm.push(...lp.jvmArgs.filter((a) => a.trim()));

  let game: string[];
  if (v.arguments?.game?.length) game = flattenArgs(v.arguments.game, lp.platform, features).map(subst);
  else game = (v.minecraftArguments ?? '').split(/\s+/).filter(Boolean).map(subst);
  if (lp.game.fullscreen) game.push('--fullscreen');
  else if (!v.arguments?.game?.length) game.push('--width', String(lp.game.width), '--height', String(lp.game.height));

  if (!v.mainClass) throw new AppError('LAUNCH_FAILED', 'mainClass ausente');
  return { args: [...jvm, v.mainClass, ...game], mainClass: v.mainClass };
}

/** Extrae las nativas legadas a un directorio limpio de la instancia. */
export async function prepareNatives(v: VersionJson, paths: AppPaths, nativesDir: string, platform: Platform): Promise<void> {
  await fsp.rm(nativesDir, { recursive: true, force: true });
  await fsp.mkdir(nativesDir, { recursive: true });
  for (const l of resolveLibraries(v, platform)) {
    if (!l.extract) continue;
    const jar = safeJoin(paths.libraries, l.path);
    await extractZip(jar, nativesDir, { exclude: l.extractExclude ?? ['META-INF/'], maxBytes: 512 * 1024 * 1024 });
  }
}

/** Redacta el token en una línea de comandos (para logs). */
export function redactCommand(args: string[], token: string): string[] {
  return args.map((a) => (token && token !== '0' && a.includes(token) ? a.split(token).join('[REDACTED]') : a));
}
