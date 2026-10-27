import os from 'node:os';
import { AppError } from '../../shared/errors';
import { applySettingsPatch, defaultSettings, SettingsSchema, type Settings, type SettingsPatch } from '../../shared/settings';
import { Mutex, readJson, writeJson } from '../core/jsonStore';
import type { Logger } from '../core/logger';

/**
 * Argumentos JVM que pueden comprometer el sistema o el aislamiento: cargar agentes nativos,
 * ejecutar comandos ante errores, reemplazar el classpath o depurar remotamente.
 */
const FORBIDDEN_JVM = [
  /^-javaagent:/i,
  /^-agentlib:/i,
  /^-agentpath:/i,
  /^-Xbootclasspath/i,
  /^-XX:OnError=/i,
  /^-XX:OnOutOfMemoryError=/i,
  /^-Xrun/i,
  /^-Xdebug$/i,
  /^-(cp|classpath|jar)$/i,
  /^--class-path/i,
  /^-Djava\.library\.path=/i,
  /^-Djava\.security\.manager/i,
  /^--add-opens=java\.base\/java\.lang=ALL-UNNAMED$/i, // permitido por loaders vía su perfil, no por el usuario
  /^-Xmx/i, // la memoria se gestiona con sus propios controles validados
  /^-Xms/i,
  /^@/, // archivos de argumentos arbitrarios
];

export function validateJvmArgs(args: string[]): { ok: true } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  for (const a of args) {
    if (!a.trim()) continue;
    if (/[\r\n\0]/.test(a) || !a.startsWith('-') || FORBIDDEN_JVM.some((re) => re.test(a))) invalid.push(a);
  }
  return invalid.length ? { ok: false, invalid } : { ok: true };
}

/** Parte una cadena de argumentos respetando comillas simples y dobles. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

export function totalMemoryMb(): number {
  return Math.floor(os.totalmem() / 1024 / 1024);
}

/** Máximo razonable para Minecraft: deja al menos 2 GB (o 25 %) al sistema. */
export function maxAllowedMemoryMb(totalMb = totalMemoryMb()): number {
  const reserve = Math.max(2048, Math.floor(totalMb * 0.25));
  return Math.max(1024, Math.floor((totalMb - reserve) / 256) * 256);
}

export function validateMemory(minMb: number, maxMb: number, totalMb = totalMemoryMb()): void {
  if (!Number.isInteger(minMb) || !Number.isInteger(maxMb) || minMb < 256 || maxMb < 512) {
    throw new AppError('VALIDATION', 'memory.range', { field: 'memory' });
  }
  if (minMb > maxMb) throw new AppError('VALIDATION', 'memory.minGreaterThanMax', { field: 'memory' });
  const limit = maxAllowedMemoryMb(totalMb);
  if (maxMb > limit) throw new AppError('VALIDATION', 'memory.exceedsSystem', { field: 'memory', limit, totalMb });
}

export class SettingsService {
  private value: Settings = defaultSettings();
  private readonly mutex = new Mutex();
  private readonly listeners = new Set<(s: Settings, prev: Settings) => void>();

  constructor(private readonly file: string, private readonly log: Logger, private readonly totalMb = totalMemoryMb()) {}

  async load(): Promise<Settings> {
    const { value, recovered } = await readJson(this.file, SettingsSchema, defaultSettings);
    this.value = value;
    if (recovered) this.log.warn('Configuración recuperada desde copia de seguridad o valores por defecto');
    return value;
  }

  get(): Settings {
    return this.value;
  }

  onChange(cb: (s: Settings, prev: Settings) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  update(patch: SettingsPatch): Promise<Settings> {
    return this.mutex.run(async () => {
      let next: Settings;
      try {
        next = applySettingsPatch(this.value, patch);
      } catch (e) {
        throw new AppError('VALIDATION', 'settings.invalid', { issues: String((e as Error).message).slice(0, 500) });
      }
      if (patch.minecraft && ('defaultMemoryMaxMb' in patch.minecraft || 'defaultMemoryMinMb' in patch.minecraft)) {
        validateMemory(next.minecraft.defaultMemoryMinMb, next.minecraft.defaultMemoryMaxMb, this.totalMb);
      }
      if (patch.minecraft?.defaultJvmArgs) {
        const v = validateJvmArgs(next.minecraft.defaultJvmArgs);
        if (!v.ok) throw new AppError('VALIDATION', 'jvmArgs.forbidden', { invalid: v.invalid });
      }
      const prev = this.value;
      await writeJson(this.file, next);
      this.value = next;
      for (const l of this.listeners) {
        try {
          l(next, prev);
        } catch (e) {
          this.log.error('listener de ajustes falló', e);
        }
      }
      return next;
    });
  }

  reset(): Promise<Settings> {
    return this.mutex.run(async () => {
      const prev = this.value;
      // Se conservan la cuenta activa y la ubicación de instancias: restablecer preferencias no debe "perder" datos.
      const next = SettingsSchema.parse({
        ui: prev.ui,
        minecraft: { instancesDir: prev.minecraft.instancesDir },
      });
      await writeJson(this.file, next);
      this.value = next;
      for (const l of this.listeners) l(next, prev);
      return next;
    });
  }
}
