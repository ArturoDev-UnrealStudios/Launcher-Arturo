import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../shared/errors';
import type { LoaderKind, LoaderVersionInfo, McVersionInfo } from '../../shared/types';
import type { Http } from '../core/http';
import { writeFileAtomic } from '../core/jsonStore';
import type { Logger } from '../core/logger';
import { sha1Hex } from '../security/crypto';
import type { VersionJson } from './versionJson';

/** Fuentes oficiales y documentadas. Configurables para pruebas. */
export interface MetaEndpoints {
  versionManifest: string;
  fabricMeta: string;
  forgeMaven: string;
  forgePromotions: string;
  neoforgeMaven: string;
  resources: string;
}

export const META_ENDPOINTS: MetaEndpoints = {
  versionManifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  fabricMeta: 'https://meta.fabricmc.net/v2',
  forgeMaven: 'https://maven.minecraftforge.net',
  forgePromotions: 'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json',
  neoforgeMaven: 'https://maven.neoforged.net/releases',
  resources: 'https://resources.download.minecraft.net',
};

export interface ManifestEntry extends McVersionInfo {
  url: string;
  sha1: string;
}

interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: ManifestEntry[];
}

/**
 * Metadatos con caché en disco: si no hay red, se usa la última copia válida, lo que permite
 * reinstalar o lanzar versiones ya descargadas sin conexión.
 */
export class MetadataService {
  private manifest?: { at: number; data: VersionManifest };

  constructor(
    private readonly http: Http,
    private readonly cacheDir: string,
    private readonly versionsDir: string,
    private readonly log: Logger,
    readonly ep: MetaEndpoints = META_ENDPOINTS,
  ) {}

  private async cachedJson<T>(name: string, url: string, ttlMs: number, validate: (v: unknown) => v is T): Promise<T> {
    const file = path.join(this.cacheDir, name);
    try {
      const st = await fsp.stat(file);
      if (Date.now() - st.mtimeMs < ttlMs) {
        const v = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (validate(v)) return v;
      }
    } catch {
      /* sin caché */
    }
    try {
      const v = await this.http.json<unknown>(url, {}, { timeoutMs: 15_000 });
      if (!validate(v)) throw new AppError('HTTP', `${name}: formato inesperado`);
      await writeFileAtomic(file, JSON.stringify(v));
      return v;
    } catch (e) {
      try {
        const v = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (validate(v)) {
          this.log.warn('Usando metadatos en caché (sin red)', { name });
          return v;
        }
      } catch {
        /* nada en caché */
      }
      throw e;
    }
  }

  async versionManifest(): Promise<VersionManifest> {
    if (this.manifest && Date.now() - this.manifest.at < 10 * 60_000) return this.manifest.data;
    const data = await this.cachedJson<VersionManifest>('version_manifest_v2.json', this.ep.versionManifest, 10 * 60_000, (v): v is VersionManifest =>
      Array.isArray((v as VersionManifest)?.versions),
    );
    this.manifest = { at: Date.now(), data };
    return data;
  }

  async mcVersions(includeSnapshots: boolean): Promise<McVersionInfo[]> {
    const m = await this.versionManifest();
    return m.versions
      .filter((v) => includeSnapshots || v.type === 'release')
      .map(({ id, type, releaseTime }) => ({ id, type, releaseTime }));
  }

  /** JSON de versión vanilla verificado con el SHA-1 del manifiesto. */
  async vanillaVersion(id: string): Promise<VersionJson> {
    const file = path.join(this.versionsDir, id, `${id}.json`);
    let entry: ManifestEntry | undefined;
    try {
      entry = (await this.versionManifest()).versions.find((v) => v.id === id);
    } catch (e) {
      // Sin red: se acepta la copia local que ya fue verificada al descargarla.
      try {
        return JSON.parse(await fsp.readFile(file, 'utf8')) as VersionJson;
      } catch {
        throw e;
      }
    }
    if (!entry) throw new AppError('NOT_FOUND', `versión ${id}`);
    try {
      const raw = await fsp.readFile(file);
      if (sha1Hex(raw) === entry.sha1) return JSON.parse(raw.toString('utf8')) as VersionJson;
    } catch {
      /* descargar */
    }
    const raw = Buffer.from(await this.http.text(entry.url));
    if (sha1Hex(raw) !== entry.sha1) throw new AppError('HASH_MISMATCH', `${id}.json`);
    await writeFileAtomic(file, raw, 0o644);
    return JSON.parse(raw.toString('utf8')) as VersionJson;
  }

  async saveLoaderVersion(v: VersionJson): Promise<void> {
    if (!/^[\w.+-]{1,120}$/.test(v.id)) throw new AppError('VALIDATION', 'id de versión inválido');
    await writeFileAtomic(path.join(this.versionsDir, v.id, `${v.id}.json`), JSON.stringify(v, null, 2), 0o644);
  }

  async readLocalVersion(id: string): Promise<VersionJson | null> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.versionsDir, id, `${id}.json`), 'utf8')) as VersionJson;
    } catch {
      return null;
    }
  }

  // ------------------------------- Loaders -------------------------------

  async loaderVersions(kind: LoaderKind, mc: string): Promise<LoaderVersionInfo[]> {
    if (!/^[\w.+-]{1,40}$/.test(mc)) throw new AppError('VALIDATION', 'versión de Minecraft inválida');
    switch (kind) {
      case 'vanilla':
        return [];
      case 'fabric': {
        const list = await this.cachedJson<Array<{ loader: { version: string; stable: boolean } }>>(
          `fabric-${mc}.json`,
          `${this.ep.fabricMeta}/versions/loader/${encodeURIComponent(mc)}`,
          30 * 60_000,
          (v): v is Array<{ loader: { version: string; stable: boolean } }> => Array.isArray(v),
        );
        return list.map((x) => ({ version: x.loader.version, stable: !!x.loader.stable }));
      }
      case 'forge': {
        const xml = await this.http.text(`${this.ep.forgeMaven}/net/minecraftforge/forge/maven-metadata.xml`);
        let promos: Record<string, string> = {};
        try {
          promos = (await this.http.json<{ promos: Record<string, string> }>(this.ep.forgePromotions)).promos ?? {};
        } catch {
          /* opcional */
        }
        const rec = promos[`${mc}-recommended`];
        return parseMavenVersions(xml)
          .filter((v) => v.startsWith(`${mc}-`))
          .map((v) => v.slice(mc.length + 1))
          .reverse()
          .map((v) => ({ version: v, stable: v === rec }));
      }
      case 'neoforge': {
        const xml = await this.http.text(`${this.ep.neoforgeMaven}/net/neoforged/neoforge/maven-metadata.xml`);
        const prefix = neoforgePrefix(mc);
        if (!prefix) return [];
        return parseMavenVersions(xml)
          .filter((v) => v.startsWith(prefix))
          .reverse()
          .map((v) => ({ version: v, stable: !/beta|alpha/i.test(v) }));
      }
    }
  }

  async fabricProfile(mc: string, loader: string): Promise<VersionJson> {
    if (!/^[\w.+-]{1,40}$/.test(loader)) throw new AppError('VALIDATION', 'versión de loader inválida');
    const v = await this.http.json<VersionJson>(
      `${this.ep.fabricMeta}/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`,
    );
    if (!v?.id || !Array.isArray(v.libraries) || v.inheritsFrom !== mc) throw new AppError('HTTP', 'perfil Fabric inesperado');
    return v;
  }

  /** URL del instalador oficial + URL del checksum publicado en el mismo maven. */
  installerArtifact(kind: 'forge' | 'neoforge', mc: string, loader: string): { url: string; checksumUrls: string[]; fileName: string } {
    if (!/^[\w.+-]{1,60}$/.test(loader)) throw new AppError('VALIDATION', 'versión de loader inválida');
    if (kind === 'forge') {
      const full = `${mc}-${loader}`;
      const base = `${this.ep.forgeMaven}/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
      return { url: base, checksumUrls: [`${base}.sha256`, `${base}.sha1`], fileName: `forge-${full}-installer.jar` };
    }
    const base = `${this.ep.neoforgeMaven}/net/neoforged/neoforge/${loader}/neoforge-${loader}-installer.jar`;
    return { url: base, checksumUrls: [`${base}.sha256`, `${base}.sha1`], fileName: `neoforge-${loader}-installer.jar` };
  }
}

export function parseMavenVersions(xml: string): string[] {
  const out: string[] = [];
  const re = /<version>([^<]{1,80})<\/version>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1]!.trim());
  return out;
}

/** NeoForge numera como <menor MC>.<parche MC>.<build>: 1.21.1 → "21.1.", 1.20.4 → "20.4.", 1.21 → "21.0.". */
export function neoforgePrefix(mc: string): string | null {
  // Versiones de Minecraft con numeración anual (26.1, 26.1.2…): NeoForge las antepone tal cual.
  if (/^\d{2}\.\d+(?:\.\d+)?$/.test(mc)) return `${mc}.`;
  const m = /^1\.(\d+)(?:\.(\d+))?$/.exec(mc);
  if (!m) return null;
  const minor = Number(m[1]);
  if (minor < 20 || (minor === 20 && Number(m[2] ?? 0) < 2)) return null; // NeoForge independiente desde 1.20.2
  return `${m[1]}.${m[2] ?? 0}.`;
}
