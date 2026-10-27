import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Escritura atómica: archivo temporal en el mismo directorio + fsync + rename.
 * Si el proceso muere a mitad, el archivo original queda intacto.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`;
  const fh = await fs.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    // En Windows rename puede fallar si un antivirus mantiene el archivo abierto: reintento breve.
    await new Promise((r) => setTimeout(r, 50));
    try {
      await fs.rename(tmp, file);
    } catch {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }
}

export async function readJson<T>(file: string, schema: ZodType<T, ZodTypeDef, unknown>, fallback: () => T): Promise<{ value: T; recovered: boolean }> {
  for (const candidate of [file, `${file}.bak`]) {
    try {
      const raw = await fs.readFile(candidate, 'utf8');
      const parsed = schema.safeParse(JSON.parse(raw));
      if (parsed.success) return { value: parsed.data, recovered: candidate !== file };
    } catch {
      /* siguiente candidato */
    }
  }
  return { value: fallback(), recovered: fsSync.existsSync(file) };
}

/** Guarda JSON conservando una copia .bak de la versión válida anterior. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  if (fsSync.existsSync(file)) {
    try {
      await fs.copyFile(file, `${file}.bak`);
    } catch {
      /* best-effort */
    }
  }
  await writeFileAtomic(file, JSON.stringify(value, null, 2));
}

/** Serializa escrituras concurrentes sobre el mismo recurso. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}
