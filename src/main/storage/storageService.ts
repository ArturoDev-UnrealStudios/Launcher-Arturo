import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError } from '../../shared/errors';
import type { CleanupPlan, CleanupResult, DiskSummary, LargeFile } from '../../shared/types';
import { isInside, type AppPaths } from '../core/paths';
import type { Logger } from '../core/logger';
import { dirSize, type InstanceManager } from '../instances/instanceManager';

async function driveStats(dir: string): Promise<{ total: number; free: number }> {
  let d = path.resolve(dir);
  for (;;) {
    try {
      const s = await fsp.statfs(d);
      return { total: Number(s.blocks) * Number(s.bsize), free: Number(s.bavail) * Number(s.bsize) };
    } catch {
      const p = path.dirname(d);
      if (p === d) return { total: 0, free: 0 };
      d = p;
    }
  }
}

/**
 * Panel de almacenamiento con datos reales del sistema de archivos. La limpieza solo puede
 * afectar a cachés regenerables, temporales y logs propios del launcher: nunca a mundos,
 * mods, configuraciones ni archivos del usuario.
 */
export class StorageService {
  private cache?: DiskSummary;
  private readonly plans = new Map<string, { plan: CleanupPlan; at: number }>();

  constructor(private paths: AppPaths, private readonly instances: InstanceManager, private readonly log: Logger, private readonly inflightParts: () => Set<string> = () => new Set()) {}

  invalidate(): void {
    this.cache = undefined;
  }

  setPaths(p: AppPaths): void {
    this.paths = p;
    this.cache = undefined;
  }

  async summary(force = false): Promise<DiskSummary> {
    if (!force && this.cache && Date.now() - this.cache.measuredAt < 60_000) return this.cache;
    const p = this.paths;
    await fsp.mkdir(p.instancesDir, { recursive: true });
    const drive = await driveStats(p.instancesDir);
    const [shared, runtimes, cache, temp, logs, skins] = await Promise.all([dirSize(p.shared), dirSize(p.runtimes), dirSize(p.cache), dirSize(p.temp), dirSize(p.logs), dirSize(p.skinsDir)]);
    const instances: DiskSummary['instances'] = [];
    for (const i of this.instances.all()) {
      const root = path.join(p.instancesDir, i.id);
      const game = path.join(root, 'minecraft');
      const [total, mods, resourcepacks, saves] = await Promise.all([
        dirSize(root),
        dirSize(path.join(game, 'mods')),
        dirSize(path.join(game, 'resourcepacks')),
        dirSize(path.join(game, 'saves')),
      ]);
      instances.push({ id: i.id, name: i.name, total, mods, resourcepacks, saves, other: Math.max(0, total - mods - resourcepacks - saves) });
    }
    const instTotal = instances.reduce((s, i) => s + i.total, 0);
    this.cache = {
      measuredAt: Date.now(),
      drive: { path: p.instancesDir, total: drive.total, free: drive.free, used: Math.max(0, drive.total - drive.free) },
      launcher: { total: instTotal + shared + runtimes + cache + temp + logs + skins, instances: instTotal, shared, runtimes, cache, temp, logs, skins },
      instances: instances.sort((a, b) => b.total - a.total),
    };
    return this.cache;
  }

  async largest(limit = 25): Promise<LargeFile[]> {
    const p = this.paths;
    const roots: Array<[string, LargeFile['category']]> = [
      [p.instancesDir, 'instance'],
      [p.shared, 'shared'],
      [p.runtimes, 'runtime'],
      [p.cache, 'cache'],
      [p.temp, 'temp'],
      [p.logs, 'log'],
    ];
    const top: LargeFile[] = [];
    const n = Math.min(Math.max(limit, 1), 200);
    for (const [root, category] of roots) {
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) stack.push(fp);
          else if (e.isFile()) {
            const size = (await fsp.stat(fp).catch(() => null))?.size ?? 0;
            if (top.length < n || size > top[top.length - 1]!.size) {
              top.push({ path: fp, size, category });
              top.sort((a, b) => b.size - a.size);
              if (top.length > n) top.pop();
            }
          }
        }
      }
    }
    return top;
  }

  /** Calcula qué se eliminaría. No borra nada. */
  async planCleanup(): Promise<CleanupPlan> {
    const p = this.paths;
    const items: CleanupPlan['items'] = [];
    const inflight = this.inflightParts();
    const walk = async (root: string, reason: CleanupPlan['items'][number]['reason'], filter: (f: string, st: fs.Stats) => boolean) => {
      const stack = [root];
      while (stack.length) {
        const d = stack.pop()!;
        let entries: fs.Dirent[];
        try {
          entries = await fsp.readdir(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          const fp = path.join(d, e.name);
          if (e.isDirectory()) stack.push(fp);
          else if (e.isFile()) {
            const st = await fsp.stat(fp).catch(() => null);
            if (st && filter(fp, st)) items.push({ path: fp, size: st.size, reason });
          }
        }
      }
    };
    const hourAgo = Date.now() - 3600_000;
    const weekAgo = Date.now() - 7 * 86400_000;
    await walk(p.cache, 'cache', () => true);
    await walk(p.temp, 'temp', (f, st) => !inflight.has(f) && st.mtimeMs < hourAgo);
    await walk(path.join(p.runtimes, '.download'), 'partial-download', (_f, st) => st.mtimeMs < hourAgo);
    await walk(p.logs, 'old-log', (f, st) => /launcher-\d{4}-\d{2}-\d{2}\.log$/.test(f) && st.mtimeMs < weekAgo);
    const plan: CleanupPlan = { planId: crypto.randomUUID(), items, estimatedBytes: items.reduce((s, i) => s + i.size, 0) };
    this.plans.set(plan.planId, { plan, at: Date.now() });
    return plan;
  }

  /** Ejecuta un plan previamente mostrado al usuario y devuelve el espacio liberado CONFIRMADO. */
  async executeCleanup(planId: string): Promise<CleanupResult> {
    const entry = this.plans.get(planId);
    this.plans.delete(planId);
    if (!entry || Date.now() - entry.at > 10 * 60_000) throw new AppError('NOT_FOUND', 'plan caducado');
    const p = this.paths;
    const allowed = [p.cache, p.temp, path.join(p.runtimes, '.download'), p.logs];
    const inflight = this.inflightParts();
    let freed = 0;
    let removed = 0;
    let failed = 0;
    for (const it of entry.plan.items) {
      if (!allowed.some((root) => isInside(root, it.path)) || inflight.has(it.path)) {
        failed++;
        continue;
      }
      try {
        const st = await fsp.lstat(it.path);
        if (!st.isFile()) {
          failed++;
          continue;
        }
        await fsp.rm(it.path);
        if (!fs.existsSync(it.path)) {
          freed += st.size;
          removed++;
        } else failed++;
      } catch {
        failed++;
      }
    }
    this.cache = undefined;
    this.log.info('Limpieza ejecutada', { freed, removed, failed });
    return { freedBytes: freed, removed, failed };
  }

  /** Mueve el directorio de instancias a una nueva ubicación (copia → verificación → borrado). */
  async moveInstances(target: string, onDone: (newDir: string) => Promise<void>): Promise<void> {
    const src = this.paths.instancesDir;
    const dest = path.resolve(target);
    if (isInside(src, dest) || isInside(dest, src)) throw new AppError('VALIDATION', 'storage.moveNested');
    if (this.instances.anyRunning()) throw new AppError('INSTANCE_RUNNING');
    if (fs.existsSync(dest) && (await fsp.readdir(dest)).length) throw new AppError('VALIDATION', 'storage.moveNotEmpty');
    await fsp.mkdir(dest, { recursive: true });
    const needed = await dirSize(src);
    const free = (await driveStats(dest)).free;
    if (free && free < needed + 256 * 1024 * 1024) throw new AppError('DISK_FULL', 'destino sin espacio', { needed, free });
    await fsp.cp(src, dest, { recursive: true, errorOnExist: false, force: true, preserveTimestamps: true });
    const copied = await dirSize(dest);
    if (copied < needed) throw new AppError('UNKNOWN', 'copia incompleta; se conserva el origen');
    await onDone(dest);
    await fsp.rm(src, { recursive: true, force: true, maxRetries: 3 });
    this.cache = undefined;
  }
}
