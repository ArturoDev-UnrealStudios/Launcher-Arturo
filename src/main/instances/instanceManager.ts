import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { AppError, isAppError, toSerializedError } from '../../shared/errors';
import type { InstanceConfig, InstanceView, NewInstanceInput, TaskProgress } from '../../shared/types';
import type { EventBus } from '../core/events';
import { Mutex, readJson, writeJson } from '../core/jsonStore';
import { redactString, type Logger } from '../core/logger';
import { isInside, safeJoin, type AppPaths } from '../core/paths';
import { validateJvmArgs, validateMemory } from '../config/settingsService';
import type { SettingsService } from '../config/settingsService';
import type { AccountManager } from '../auth/accountManager';
import { GameInstaller, instanceGameDir, type InstallReport, type PrivateManifest } from '../minecraft/installer';
import { buildLaunchCommand, prepareNatives, redactCommand } from '../minecraft/launch';
import { javawFor, requiredJavaMajor, type JavaManager } from '../minecraft/java';
import { currentPlatform } from '../minecraft/versionJson';

const LoaderSchema = z.object({
  kind: z.enum(['vanilla', 'fabric', 'forge', 'neoforge']),
  version: z.string().max(80).optional(),
  installerTrusted: z.boolean().optional(),
});

export const InstanceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
  name: z.string().min(1).max(48),
  cover: z.string().max(700_000),
  mcVersion: z.string().regex(/^[\w.+-]{1,40}$/),
  loader: LoaderSchema,
  java: z.object({ path: z.string().max(1024).optional(), major: z.number().int().optional() }),
  memory: z.object({ minMb: z.number().int(), maxMb: z.number().int() }),
  jvmArgs: z.array(z.string().max(512)).max(64),
  game: z.object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320), fullscreen: z.boolean() }),
  createdAt: z.number(),
  lastPlayedAt: z.number().optional(),
  installState: z.enum(['not-installed', 'installing', 'installed', 'needs-repair']),
  installInterrupted: z.boolean().optional(),
  access: z.union([
    z.object({ kind: z.literal('public') }),
    z.object({
      kind: z.literal('private'),
      grantId: z.string(),
      status: z.enum(['granted', 'expired', 'revoked', 'pending']),
      expiresAt: z.number().optional(),
    }),
  ]),
  privateManifest: z.object({ url: z.string().url(), sha256: z.string(), version: z.string() }).optional(),
  resolvedVersionId: z.string().optional(),
  lastError: z.object({ code: z.string(), at: z.number(), detail: z.string().optional() }).optional(),
});
const IndexSchema = z.object({ instances: z.array(InstanceSchema).default([]) });

const BUILTIN_COVERS = ['grass', 'nether', 'end', 'ocean', 'cherry', 'deepdark'] as const;

function isValidCover(c: string): boolean {
  return (BUILTIN_COVERS as readonly string[]).includes(c) || (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(c) && c.length < 700_000);
}

interface RunningGame {
  proc: ChildProcess;
  startedAt: number;
}

export interface PrivateManifestProvider {
  /** Devuelve el manifiesto privado verificado (firma + hash) si la concesión sigue vigente. */
  fetch(inst: InstanceConfig): Promise<PrivateManifest>;
}

export class InstanceManager {
  private instances: InstanceConfig[] = [];
  private readonly mutex = new Mutex();
  private readonly tasks = new Map<string, { abort: AbortController; progress: TaskProgress }>();
  private readonly running = new Map<string, RunningGame>();
  private readonly logs = new Map<string, string[]>();
  private privateProvider?: PrivateManifestProvider;

  constructor(
    private paths: AppPaths,
    private readonly installer: GameInstaller,
    private readonly java: JavaManager,
    private readonly settings: SettingsService,
    private readonly accounts: AccountManager,
    private readonly bus: EventBus,
    private readonly log: Logger,
    private readonly appVersion: string,
    private readonly launcherName = 'UnrealLauncher',
  ) {}

  setPrivateProvider(p: PrivateManifestProvider): void {
    this.privateProvider = p;
  }

  setPaths(paths: AppPaths): void {
    this.paths = paths;
  }

  async load(): Promise<void> {
    const { value } = await readJson(this.paths.instancesIndex, IndexSchema, () => ({ instances: [] }));
    // Una instalación que estaba en curso al cerrarse queda marcada como reanudable.
    this.instances = value.instances.map((i) =>
      i.installState === 'installing' ? { ...i, installState: 'not-installed', installInterrupted: true } : i,
    ) as InstanceConfig[];
  }

  private async persist(): Promise<void> {
    await writeJson(this.paths.instancesIndex, { instances: this.instances });
    this.emit();
  }

  private emit(): void {
    this.bus.emit('instances', this.list());
  }

  get(id: string): InstanceConfig {
    const i = this.instances.find((x) => x.id === id);
    if (!i) throw new AppError('NOT_FOUND', 'instancia');
    return i;
  }

  list(): InstanceView[] {
    return this.instances.map((i) => this.view(i));
  }

  view(i: InstanceConfig): InstanceView {
    const running = this.running.has(i.id);
    const busy = this.tasks.has(i.id);
    let primaryAction: InstanceView['primaryAction'];
    if (i.access.kind === 'private' && i.access.status !== 'granted') primaryAction = 'locked';
    else if (running) primaryAction = 'running';
    else if (busy) primaryAction = 'busy';
    else if (i.installState === 'needs-repair') primaryAction = 'repair';
    else if (i.installState !== 'installed') primaryAction = i.installInterrupted ? 'resume' : 'install';
    else primaryAction = 'play';
    return { ...i, running, busy, primaryAction, pendingResume: !!i.installInterrupted };
  }

  private async mutate(id: string, fn: (i: InstanceConfig) => void): Promise<InstanceConfig> {
    return this.mutex.run(async () => {
      const i = this.get(id);
      fn(i);
      await this.persist();
      return i;
    });
  }

  async create(input: NewInstanceInput, extra: Partial<InstanceConfig> = {}): Promise<InstanceView> {
    const name = input.name.trim();
    if (!name || name.length > 48) throw new AppError('VALIDATION', 'instance.name', { field: 'name' });
    if (!/^[\w.+-]{1,40}$/.test(input.mcVersion)) throw new AppError('VALIDATION', 'instance.version', { field: 'mcVersion' });
    if ((input.loader.kind === 'forge' || input.loader.kind === 'neoforge') && !input.loader.installerTrusted) {
      throw new AppError('VALIDATION', 'instance.installerConsent', { field: 'installerTrusted' });
    }
    const s = this.settings.get();
    const maxMb = input.memoryMaxMb ?? s.minecraft.defaultMemoryMaxMb;
    const minMb = Math.min(s.minecraft.defaultMemoryMinMb, maxMb);
    validateMemory(minMb, maxMb);
    const cover = input.cover && isValidCover(input.cover) ? input.cover : BUILTIN_COVERS[Math.floor(Math.random() * BUILTIN_COVERS.length)]!;
    const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'instancia';
    const id = `${slug}-${crypto.randomBytes(3).toString('hex')}`;
    const inst: InstanceConfig = {
      id,
      name,
      cover,
      mcVersion: input.mcVersion,
      loader: input.loader,
      java: {},
      memory: { minMb, maxMb },
      jvmArgs: [...s.minecraft.defaultJvmArgs],
      game: { width: s.minecraft.width, height: s.minecraft.height, fullscreen: s.minecraft.fullscreen },
      createdAt: Date.now(),
      installState: 'not-installed',
      access: { kind: 'public' },
      ...extra,
    };
    InstanceSchema.parse(inst);
    await this.mutex.run(async () => {
      this.instances.push(inst);
      await this.persist();
    });
    await fsp.mkdir(instanceGameDir(this.paths, id), { recursive: true });
    return this.view(inst);
  }

  async update(id: string, patch: Partial<Pick<InstanceConfig, 'name' | 'cover' | 'memory' | 'jvmArgs' | 'java' | 'game'>>): Promise<InstanceView> {
    if (patch.memory) validateMemory(patch.memory.minMb, patch.memory.maxMb);
    if (patch.jvmArgs) {
      const v = validateJvmArgs(patch.jvmArgs);
      if (!v.ok) throw new AppError('VALIDATION', 'jvmArgs.forbidden', { invalid: v.invalid, field: 'jvmArgs' });
    }
    if (patch.cover && !isValidCover(patch.cover)) throw new AppError('VALIDATION', 'instance.cover', { field: 'cover' });
    if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 48)) throw new AppError('VALIDATION', 'instance.name', { field: 'name' });
    const inst = await this.mutate(id, (i) => {
      if (patch.name !== undefined) i.name = patch.name.trim();
      if (patch.cover) i.cover = patch.cover;
      if (patch.memory) i.memory = patch.memory;
      if (patch.jvmArgs) i.jvmArgs = patch.jvmArgs.filter((a) => a.trim());
      if (patch.game) i.game = { ...i.game, ...patch.game };
      if (patch.java) i.java = { path: patch.java.path || undefined, major: patch.java.path ? patch.java.major : undefined };
      InstanceSchema.parse(i);
    });
    return this.view(inst);
  }

  /** Elimina SOLO la carpeta de esta instancia; los datos compartidos (hash) no se tocan. */
  async remove(id: string): Promise<void> {
    if (this.running.has(id)) throw new AppError('INSTANCE_RUNNING');
    if (this.tasks.has(id)) throw new AppError('INSTANCE_BUSY');
    const dir = safeJoin(this.paths.instancesDir, id);
    if (!isInside(this.paths.instancesDir, dir) || path.resolve(dir) === path.resolve(this.paths.instancesDir)) {
      throw new AppError('VALIDATION', 'ruta de instancia inválida');
    }
    await this.mutex.run(async () => {
      this.instances = this.instances.filter((i) => i.id !== id);
      await this.persist();
    });
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3 });
    this.logs.delete(id);
  }

  // ----------------------------- Tareas -----------------------------

  private startTask(id: string, kind: TaskProgress['kind']): { signal: AbortSignal; report: (r: InstallReport) => void; finish: (state: TaskProgress['state'], e?: unknown) => void } {
    if (this.tasks.has(id)) throw new AppError('INSTANCE_BUSY');
    const abort = new AbortController();
    const progress: TaskProgress = { taskId: crypto.randomUUID(), instanceId: id, kind, stage: 'metadata', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, speed: 0, state: 'running' };
    this.tasks.set(id, { abort, progress });
    this.bus.emit('progress', { ...progress });
    this.emit();
    return {
      signal: abort.signal,
      report: (r) => {
        progress.stage = r.stage;
        if (r.progress) Object.assign(progress, r.progress);
        else Object.assign(progress, { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, speed: 0 });
        this.bus.emit('progress', { ...progress });
      },
      finish: (state, e) => {
        progress.state = state;
        if (e) progress.error = toSerializedError(e);
        this.tasks.delete(id);
        this.bus.emit('progress', { ...progress });
        this.emit();
      },
    };
  }

  cancelTask(id: string): void {
    this.tasks.get(id)?.abort.abort();
  }

  private async privateManifestFor(inst: InstanceConfig): Promise<PrivateManifest | undefined> {
    if (inst.access.kind !== 'private') return undefined;
    if (inst.access.status !== 'granted') throw new AppError('INSTANCE_LOCKED');
    if (!this.privateProvider) throw new AppError('NOT_CONFIGURED', 'authority');
    return this.privateProvider.fetch(inst);
  }

  async install(id: string, kind: 'install' | 'repair' = 'install'): Promise<void> {
    const inst = this.get(id);
    if (this.running.has(id)) throw new AppError('INSTANCE_RUNNING');
    const t = this.startTask(id, kind);
    await this.mutate(id, (i) => {
      i.installState = 'installing';
      i.installInterrupted = false;
    });
    try {
      const s = this.settings.get();
      const privateManifest = await this.privateManifestFor(inst);
      let result;
      try {
        result = await this.installer.install(inst, t.signal, t.report, { javaAuto: s.minecraft.autoJava, javaPath: s.minecraft.javaPath, privateManifest });
      } catch (e) {
        // Un artefacto del loader falta o está dañado → se reinstala el loader una vez.
        if (isAppError(e) && e.data?.reinstallLoader && inst.resolvedVersionId) {
          await this.mutate(id, (i) => (i.resolvedVersionId = undefined));
          result = await this.installer.install(this.get(id), t.signal, t.report, { javaAuto: s.minecraft.autoJava, javaPath: s.minecraft.javaPath, privateManifest });
        } else throw e;
      }
      await this.mutate(id, (i) => {
        i.installState = 'installed';
        i.installInterrupted = false;
        i.resolvedVersionId = result.versionId;
        i.lastError = undefined;
        if (!i.java.path) i.java = { major: result.javaMajor };
      });
      t.finish('done');
    } catch (e) {
      const cancelled = isAppError(e) && e.code === 'CANCELLED';
      await this.mutate(id, (i) => {
        i.installState = kind === 'repair' ? 'needs-repair' : 'not-installed';
        i.installInterrupted = kind === 'install';
        i.lastError = cancelled ? undefined : { code: toSerializedError(e).code, at: Date.now(), detail: toSerializedError(e).detail };
      }).catch(() => undefined);
      t.finish(cancelled ? 'cancelled' : 'failed', cancelled ? undefined : e);
      if (!cancelled) this.log.error('Instalación fallida', { id, err: e });
      throw e;
    }
  }

  async repair(id: string): Promise<{ repaired: number; checked: number }> {
    const v = await this.verify(id);
    if (v.bad > 0 || this.get(id).installState !== 'installed') await this.install(id, 'repair');
    return { repaired: v.bad, checked: v.checked };
  }

  async verify(id: string): Promise<{ ok: boolean; bad: number; checked: number }> {
    const inst = this.get(id);
    const t = this.startTask(id, 'verify');
    try {
      const r = await this.installer.verify(inst, t.signal, t.report);
      if (r.bad > 0 && inst.installState === 'installed') await this.mutate(id, (i) => (i.installState = 'needs-repair'));
      t.finish('done');
      return { ok: r.bad === 0, ...r };
    } catch (e) {
      t.finish(isAppError(e) && e.code === 'CANCELLED' ? 'cancelled' : 'failed', e);
      throw e;
    }
  }

  // ----------------------------- Lanzamiento -----------------------------

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  anyRunning(): boolean {
    return this.running.size > 0;
  }

  async launch(id: string, accountId: string | undefined): Promise<void> {
    const inst = this.get(id);
    if (!accountId) throw new AppError('AUTH_EXPIRED', 'sin cuenta activa');
    if (inst.access.kind === 'private' && inst.access.status !== 'granted') throw new AppError('INSTANCE_LOCKED');
    if (this.running.has(id)) throw new AppError('INSTANCE_RUNNING');
    if (this.tasks.has(id)) throw new AppError('INSTANCE_BUSY');
    if (inst.installState !== 'installed') throw new AppError('INSTANCE_NOT_INSTALLED');

    const identity = await this.accounts.launchIdentity(accountId);
    const s = this.settings.get();
    const signal = new AbortController().signal;
    const { version, versionId } = await this.installer.resolveVersion(inst, signal, () => {}, false);
    const java = (
      await this.java.ensure(requiredJavaMajor(version.javaVersion?.majorVersion), {
        forcedPath: inst.java.path ?? s.minecraft.javaPath,
        auto: s.minecraft.autoJava,
      })
    ).path;
    const gameDir = instanceGameDir(this.paths, id);
    const nativesDir = safeJoin(this.paths.instancesDir, id, 'natives');
    await fsp.mkdir(gameDir, { recursive: true });
    await prepareNatives(version, this.paths, nativesDir, currentPlatform());
    const cmd = buildLaunchCommand({
      version,
      versionId,
      paths: this.paths,
      gameDir,
      nativesDir,
      identity,
      memory: inst.memory,
      jvmArgs: inst.jvmArgs,
      game: inst.game,
      launcherName: this.launcherName,
      launcherVersion: this.appVersion,
      platform: currentPlatform(),
    });
    this.log.info('Lanzando Minecraft', { id, versionId, java: java, args: redactCommand(cmd.args, identity.accessToken).join(' ').slice(0, 4000) });

    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.JAVA_TOOL_OPTIONS; // opciones globales de Java podrían inyectar agentes
    delete env._JAVA_OPTIONS;
    const proc = spawn(javawFor(java), cmd.args, { cwd: gameDir, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env });
    // Los manejadores se registran ANTES de cualquier await: un proceso que falla al instante
    // no debe perder su evento de salida.
    const run: RunningGame = { proc, startedAt: Date.now() };
    this.running.set(id, run);
    this.logs.set(id, []);
    let pending: string[] = [];
    let flushTimer: NodeJS.Timeout | undefined;
    const flush = () => {
      flushTimer = undefined;
      if (pending.length) this.bus.emit('gameLog', { instanceId: id, lines: pending });
      pending = [];
    };
    const token = identity.accessToken;
    const onData = (chunk: Buffer) => {
      let text = chunk.toString('utf8');
      if (token && token !== '0') text = text.split(token).join('[REDACTED]');
      const lines = redactString(text).split(/\r?\n/).filter(Boolean);
      const buf = this.logs.get(id) ?? [];
      buf.push(...lines);
      if (buf.length > 3000) buf.splice(0, buf.length - 3000);
      this.logs.set(id, buf);
      pending.push(...lines);
      flushTimer ??= setTimeout(flush, 200);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const exited = new Promise<void>((resolve) => {
      proc.on('close', (code, sig) => {
        clearTimeout(flushTimer);
        flush();
        if (this.running.get(id) === run) this.running.delete(id);
        this.emit();
        const crashed = code !== 0 && sig == null && code != null;
        this.log.info('Minecraft terminó', { id, code, sig, ranMs: Date.now() - run.startedAt });
        if (crashed) {
          this.bus.emit('notification', {
            id: crypto.randomUUID(),
            level: 'error',
            titleKey: 'notify.gameCrashed',
            params: { name: inst.name, code: code ?? -1 },
            at: Date.now(),
          });
          this.mutate(id, (i) => (i.lastError = { code: 'LAUNCH_FAILED', at: Date.now(), detail: `exit ${code}` })).catch(() => undefined);
        }
        resolve();
      });
    });
    const started = await new Promise<boolean>((resolve) => {
      proc.once('spawn', () => resolve(true));
      proc.once('error', (e) => {
        this.log.error('No se pudo iniciar Java', e);
        resolve(false);
      });
    });
    if (!started) {
      this.running.delete(id);
      this.emit();
      throw new AppError('LAUNCH_FAILED', 'java no se pudo ejecutar');
    }
    void exited;
    await this.mutate(id, (i) => (i.lastPlayedAt = Date.now()));
    this.emit();
  }

  stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    r.proc.kill();
    setTimeout(() => {
      if (this.running.get(id) === r) r.proc.kill('SIGKILL');
    }, 8000).unref();
  }

  stopAll(): void {
    for (const id of this.running.keys()) this.stop(id);
  }

  gameLog(id: string): string[] {
    return this.logs.get(id) ?? [];
  }

  gameDir(id: string, sub?: 'mods' | 'resourcepacks' | 'saves' | 'logs' | 'root'): string {
    this.get(id);
    const base = instanceGameDir(this.paths, id);
    return !sub || sub === 'root' ? base : safeJoin(base, sub);
  }

  /** Consentimiento explícito para ejecutar el instalador oficial de Forge/NeoForge. */
  async trustInstaller(id: string): Promise<InstanceView> {
    const inst = await this.mutate(id, (i) => {
      if (i.loader.kind === 'forge' || i.loader.kind === 'neoforge') i.loader.installerTrusted = true;
    });
    return this.view(inst);
  }

  /** Crea una instancia a partir de un paquete importado, con progreso real. */
  async importPack(plan: import('./exportImport').ImportPlan): Promise<InstanceView> {
    const view = await this.create(plan.input);
    if (plan.memory || plan.jvmArgs) {
      try {
        await this.update(view.id, { memory: plan.memory, jvmArgs: plan.jvmArgs });
      } catch {
        /* valores del paquete fuera de límites en este equipo: se mantienen los predeterminados */
      }
    }
    const t = this.startTask(view.id, 'import');
    try {
      await plan.apply(instanceGameDir(this.paths, view.id), t.signal, (p) => t.report({ stage: 'libraries', progress: p }));
      t.finish('done');
    } catch (e) {
      t.finish(isAppError(e) && e.code === 'CANCELLED' ? 'cancelled' : 'failed', e);
      await this.remove(view.id).catch(() => undefined);
      throw e;
    }
    return this.view(this.get(view.id));
  }

  /** Marca el estado de acceso (lo usa el módulo de claves al refrescar concesiones). */
  async setAccess(id: string, access: InstanceConfig['access']): Promise<void> {
    await this.mutate(id, (i) => (i.access = access));
  }

  findByGrant(grantId: string): InstanceConfig | undefined {
    return this.instances.find((i) => i.access.kind === 'private' && i.access.grantId === grantId);
  }

  all(): InstanceConfig[] {
    return [...this.instances];
  }

  dirSize(id: string): Promise<number> {
    return dirSize(safeJoin(this.paths.instancesDir, id));
  }
}

export async function dirSize(dir: string): Promise<number> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          /* desaparecido */
        }
      }
    }
  }
  return total;
}
