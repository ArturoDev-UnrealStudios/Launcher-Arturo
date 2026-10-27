import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AppError } from '../../shared/errors';
import type { InstanceConfig, LoaderKind, NewInstanceInput } from '../../shared/types';
import { extractZip, listZip, readZipEntry, ZipWriter } from '../core/archive';
import { safeJoin } from '../core/paths';
import type { DownloadItem, DownloadProgress, Downloader } from '../download/downloader';

export const PACK_MANIFEST = 'unreal-instance.json';
const EXCLUDE_DIRS = new Set(['logs', 'crash-reports', 'natives', '.cache', '.fabric', '.mixin.out']);

const PackSchema = z.object({
  format: z.literal(1),
  name: z.string().min(1).max(48),
  mcVersion: z.string().regex(/^[\w.+-]{1,40}$/),
  loader: z.object({ kind: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']), version: z.string().max(80).optional() }),
  memory: z.object({ minMb: z.number().int(), maxMb: z.number().int() }).optional(),
  jvmArgs: z.array(z.string().max(512)).max(64).optional(),
  cover: z.string().max(700_000).optional(),
});

/** Exporta la instancia a un paquete .unrealpack (zip). Las instancias privadas no se exportan. */
export async function exportInstance(inst: InstanceConfig, gameDir: string, dest: string): Promise<{ files: number }> {
  if (inst.access.kind === 'private') throw new AppError('FORBIDDEN', 'las instancias privadas no se pueden exportar');
  const zip = new ZipWriter(dest);
  const manifest: z.infer<typeof PackSchema> = {
    format: 1,
    name: inst.name,
    mcVersion: inst.mcVersion,
    loader: { kind: inst.loader.kind, version: inst.loader.version },
    memory: inst.memory,
    jvmArgs: inst.jvmArgs,
    cover: inst.cover,
  };
  await zip.addBuffer(PACK_MANIFEST, Buffer.from(JSON.stringify(manifest, null, 2)));
  let files = 0;
  const walk = async (dir: string, rel: string) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!rel && EXCLUDE_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        await zip.addFile(`minecraft/${r}`, abs);
        files++;
      }
    }
  };
  try {
    await walk(gameDir, '');
    await zip.close();
  } catch (e) {
    await zip.close().catch(() => undefined);
    await fsp.rm(dest, { force: true });
    throw e;
  }
  return { files };
}

export interface ImportPlan {
  kind: 'unreal' | 'mrpack';
  input: NewInstanceInput;
  memory?: { minMb: number; maxMb: number };
  jvmArgs?: string[];
  apply: (gameDir: string, signal: AbortSignal, onProgress: (p: DownloadProgress) => void) => Promise<void>;
}

const MrIndexSchema = z.object({
  formatVersion: z.literal(1),
  game: z.literal('minecraft'),
  name: z.string().max(200),
  files: z.array(
    z.object({
      path: z.string().max(400),
      hashes: z.object({ sha1: z.string().optional(), sha512: z.string() }),
      env: z.object({ client: z.enum(['required', 'optional', 'unsupported']) }).partial().optional(),
      downloads: z.array(z.string().url()).min(1),
      fileSize: z.number().int().nonnegative(),
    }),
  ),
  dependencies: z.record(z.string()),
});

/** Hosts permitidos por la especificación .mrpack de Modrinth. */
const MRPACK_HOSTS = new Set(['cdn.modrinth.com', 'github.com', 'raw.githubusercontent.com', 'gitlab.com']);

export async function planImport(file: string, downloader: Downloader): Promise<ImportPlan> {
  const entries = await listZip(file);
  const names = new Set(entries.map((e) => e.name));
  if (names.has(PACK_MANIFEST)) {
    const raw = await readZipEntry(file, PACK_MANIFEST, 1024 * 1024);
    const m = PackSchema.parse(JSON.parse(raw!.toString('utf8')));
    return {
      kind: 'unreal',
      input: { name: m.name, mcVersion: m.mcVersion, loader: { ...m.loader, installerTrusted: false }, cover: m.cover },
      memory: m.memory,
      jvmArgs: m.jvmArgs,
      apply: async (gameDir) => {
        await extractZip(file, gameDir, {
          map: (n) => (n.startsWith('minecraft/') && n.length > 'minecraft/'.length ? n.slice('minecraft/'.length) : null),
          maxBytes: 16 * 1024 ** 3,
        });
      },
    };
  }
  if (names.has('modrinth.index.json')) {
    const raw = await readZipEntry(file, 'modrinth.index.json', 8 * 1024 * 1024);
    const idx = MrIndexSchema.parse(JSON.parse(raw!.toString('utf8')));
    const deps = idx.dependencies;
    const mc = deps.minecraft;
    if (!mc) throw new AppError('VALIDATION', 'mrpack sin versión de Minecraft');
    let loader: { kind: LoaderKind; version?: string } = { kind: 'vanilla' };
    if (deps['fabric-loader']) loader = { kind: 'fabric', version: deps['fabric-loader'] };
    else if (deps.neoforge) loader = { kind: 'neoforge', version: deps.neoforge };
    else if (deps.forge) loader = { kind: 'forge', version: deps.forge };
    else if (deps['quilt-loader']) throw new AppError('UNSUPPORTED_LOADER', 'Quilt no está soportado');
    return {
      kind: 'mrpack',
      input: { name: idx.name.slice(0, 48) || 'Modpack', mcVersion: mc, loader: { ...loader, installerTrusted: false } },
      apply: async (gameDir, signal, onProgress) => {
        const items: DownloadItem[] = [];
        for (const f of idx.files) {
          if (f.env?.client === 'unsupported') continue;
          const url = f.downloads.find((u) => {
            const h = new URL(u);
            return h.protocol === 'https:' && MRPACK_HOSTS.has(h.host);
          });
          if (!url) throw new AppError('UNTRUSTED_SOURCE', `descarga no permitida para ${f.path}`);
          if (!/^[0-9a-f]{128}$/i.test(f.hashes.sha512)) throw new AppError('VALIDATION', 'sha512 inválido');
          items.push({ url, dest: safeJoin(gameDir, f.path), size: f.fileSize, hash: { algo: 'sha512', value: f.hashes.sha512 } });
        }
        await downloader.downloadAll(items, onProgress, signal);
        for (const prefix of ['overrides/', 'client-overrides/']) {
          await extractZip(file, gameDir, {
            map: (n) => (n.startsWith(prefix) && n.length > prefix.length ? n.slice(prefix.length) : null),
            maxBytes: 16 * 1024 ** 3,
          });
        }
      },
    };
  }
  throw new AppError('VALIDATION', 'paquete no reconocido (.unrealpack o .mrpack)');
}
