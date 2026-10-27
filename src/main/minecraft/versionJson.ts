import path from 'node:path';

/**
 * Formato de los JSON de versión de Minecraft (piston-meta) y de los perfiles de loaders
 * (Fabric/Forge/NeoForge), que heredan con `inheritsFrom`.
 */
export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

export type ArgValue = string | { rules?: Rule[]; value: string | string[] };

export interface Artifact {
  path?: string;
  sha1?: string;
  size?: number;
  url?: string;
}

export interface Library {
  name: string;
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> };
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
  rules?: Rule[];
  /** Formato Fabric / Forge antiguo: repositorio maven base. */
  url?: string;
  sha1?: string;
  size?: number;
}

export interface VersionJson {
  id: string;
  inheritsFrom?: string;
  type?: string;
  mainClass: string;
  minecraftArguments?: string;
  arguments?: { game?: ArgValue[]; jvm?: ArgValue[] };
  assetIndex?: { id: string; sha1: string; size: number; totalSize?: number; url: string };
  assets?: string;
  downloads?: { client?: Artifact & { url: string; sha1: string }; client_mappings?: Artifact };
  javaVersion?: { component?: string; majorVersion: number };
  libraries: Library[];
  logging?: { client?: { argument: string; file: { id: string; sha1: string; size: number; url: string }; type: string } };
  jar?: string;
}

export type OsName = 'windows' | 'osx' | 'linux';

export interface Platform {
  os: OsName;
  arch: string; // 'x64' | 'arm64' | 'x86'
  osVersion?: string;
}

export function currentPlatform(): Platform {
  const os: OsName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
  return { os, arch: process.arch };
}

export function rulesAllow(rules: Rule[] | undefined, p: Platform, features: Record<string, boolean> = {}): boolean {
  if (!rules?.length) return true;
  let allowed = false;
  for (const r of rules) {
    let match = true;
    if (r.os) {
      if (r.os.name && r.os.name !== p.os) match = false;
      if (r.os.arch) {
        const arch = p.arch === 'x64' ? 'x86_64' : p.arch === 'ia32' ? 'x86' : p.arch;
        if (r.os.arch !== arch && !(r.os.arch === 'x86' && p.arch === 'ia32')) match = false;
      }
      if (r.os.version && p.osVersion) {
        try {
          if (!new RegExp(r.os.version).test(p.osVersion)) match = false;
        } catch {
          match = false;
        }
      }
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false;
    }
    if (match) allowed = r.action === 'allow';
  }
  return allowed;
}

/** "group:artifact:version[:classifier][@ext]" → ruta maven relativa. */
export function mavenPath(name: string): string {
  let ext = 'jar';
  let coords = name;
  const at = name.indexOf('@');
  if (at >= 0) {
    ext = name.slice(at + 1);
    coords = name.slice(0, at);
  }
  const parts = coords.split(':');
  if (parts.length < 3) throw new Error(`Coordenada maven inválida: ${name}`);
  const [group, artifact, version, classifier] = parts as [string, string, string, string | undefined];
  if ([group, artifact, version, classifier ?? '', ext].some((s) => s.includes('..') || /[\\/:]/.test(s))) {
    throw new Error(`Coordenada maven insegura: ${name}`);
  }
  const file = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

/** Combina un perfil hijo (loader) con su padre (vanilla) según las reglas del launcher oficial. */
export function mergeVersions(child: VersionJson, parent: VersionJson): VersionJson {
  const libs = new Map<string, Library>();
  const keyOf = (l: Library) => {
    const p = l.name.split(':');
    // grupo:artefacto[:clasificador] — la versión del hijo sustituye a la del padre.
    return `${p[0]}:${p[1]}${p[3] ? `:${p[3]}` : ''}`;
  };
  for (const l of parent.libraries ?? []) libs.set(keyOf(l), l);
  for (const l of child.libraries ?? []) libs.set(keyOf(l), l);
  // El hijo va primero en el classpath (como en el launcher oficial).
  const childKeys = new Set((child.libraries ?? []).map(keyOf));
  const ordered = [...(child.libraries ?? []), ...[...libs.entries()].filter(([k]) => !childKeys.has(k)).map(([, l]) => l)];
  return {
    ...parent,
    ...child,
    id: child.id,
    inheritsFrom: undefined,
    mainClass: child.mainClass ?? parent.mainClass,
    libraries: ordered,
    arguments:
      child.arguments || parent.arguments
        ? {
            game: [...(parent.arguments?.game ?? []), ...(child.arguments?.game ?? [])],
            jvm: [...(parent.arguments?.jvm ?? []), ...(child.arguments?.jvm ?? [])],
          }
        : undefined,
    minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
    assetIndex: child.assetIndex ?? parent.assetIndex,
    assets: child.assets ?? parent.assets,
    downloads: child.downloads ?? parent.downloads,
    javaVersion: child.javaVersion ?? parent.javaVersion,
    logging: child.logging ?? parent.logging,
    jar: child.jar ?? parent.jar ?? parent.id,
  };
}

export interface ResolvedLibrary {
  name: string;
  path: string; // relativa a libraries/
  url?: string;
  sha1?: string;
  size?: number;
  /** Va en el classpath. */
  classpath: boolean;
  /** Nativa legada (classifier) que hay que extraer al directorio de nativas. */
  extract: boolean;
  extractExclude?: string[];
}

/** Lista de librerías aplicables a la plataforma, incluidas las nativas legadas (classifiers). */
export function resolveLibraries(v: VersionJson, p: Platform): ResolvedLibrary[] {
  const out: ResolvedLibrary[] = [];
  for (const lib of v.libraries) {
    if (!rulesAllow(lib.rules, p)) continue;
    const art = lib.downloads?.artifact;
    if (art || !lib.natives) {
      const rel = art?.path ?? mavenPath(lib.name);
      let url = art?.url;
      if (!art && lib.url) url = lib.url.replace(/\/?$/, '/') + mavenPath(lib.name);
      if (!art && !lib.url && !lib.downloads) url = 'https://libraries.minecraft.net/' + mavenPath(lib.name);
      out.push({
        name: lib.name,
        path: rel,
        url: url || undefined,
        sha1: art?.sha1 ?? lib.sha1,
        size: art?.size ?? lib.size,
        classpath: true,
        extract: false,
      });
    }
    if (lib.natives) {
      const archBits = p.arch === 'x64' || p.arch === 'arm64' ? '64' : '32';
      const classifierKey = lib.natives[p.os]?.replace('${arch}', archBits);
      if (!classifierKey) continue;
      const c = lib.downloads?.classifiers?.[classifierKey];
      const parts = lib.name.split(':');
      const nativeName = `${parts[0]}:${parts[1]}:${parts[2]}:${classifierKey}`;
      out.push({
        name: nativeName,
        path: c?.path ?? mavenPath(nativeName),
        url: c?.url ?? (lib.url ? lib.url.replace(/\/?$/, '/') + mavenPath(nativeName) : undefined),
        sha1: c?.sha1,
        size: c?.size,
        classpath: false,
        extract: true,
        extractExclude: lib.extract?.exclude ?? ['META-INF/'],
      });
    }
  }
  return out;
}

export function classpath(libs: ResolvedLibrary[], librariesDir: string, clientJar: string): string[] {
  const seen = new Set<string>();
  const cp: string[] = [];
  for (const l of libs) {
    if (!l.classpath) continue; // nativas legadas: se extraen, no van al classpath
    const abs = path.join(librariesDir, l.path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    cp.push(abs);
  }
  cp.push(clientJar);
  return cp;
}
