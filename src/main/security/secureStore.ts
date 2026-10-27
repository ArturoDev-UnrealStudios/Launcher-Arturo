import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../core/jsonStore';
import type { Logger } from '../core/logger';

/**
 * Almacén de secretos. Las credenciales (refresh tokens de Microsoft, sesiones con la autoridad,
 * clave de dispositivo) se cifran con el almacén del sistema operativo:
 *   Windows → DPAPI, macOS → Keychain, Linux → libsecret/kwallet (vía Electron safeStorage).
 * Si el sistema no ofrece un backend seguro, NO se persiste nada en texto plano: los secretos
 * quedan solo en memoria durante la sesión y la interfaz lo advierte.
 */
export interface SecretStore {
  readonly persistent: boolean;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface OsCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
  getSelectedStorageBackend?: () => string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

function checkName(name: string): void {
  if (!NAME_RE.test(name)) throw new Error('Nombre de secreto inválido');
}

export class OsSecretStore implements SecretStore {
  private readonly memory = new Map<string, string>();
  readonly persistent: boolean;

  constructor(private readonly dir: string, private readonly cipher: OsCipher, private readonly log: Logger) {
    let ok = false;
    try {
      ok = cipher.isEncryptionAvailable();
      // En Linux sin llavero, Electron cae a "basic_text" (clave fija conocida): no es seguro.
      const backend = cipher.getSelectedStorageBackend?.();
      if (backend === 'basic_text' || backend === 'unknown') ok = false;
    } catch {
      ok = false;
    }
    this.persistent = ok;
    if (!ok) log.warn('Almacenamiento seguro del sistema no disponible: los secretos no se guardarán en disco');
  }

  private file(name: string): string {
    return path.join(this.dir, `${name}.bin`);
  }

  async get(name: string): Promise<string | undefined> {
    checkName(name);
    if (this.memory.has(name)) return this.memory.get(name);
    if (!this.persistent) return undefined;
    try {
      const buf = await fs.readFile(this.file(name));
      const value = this.cipher.decryptString(buf);
      this.memory.set(name, value);
      return value;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.warn('No se pudo descifrar un secreto; se descarta', { name, err: (e as Error).message });
        await fs.rm(this.file(name), { force: true });
      }
      return undefined;
    }
  }

  async set(name: string, value: string): Promise<void> {
    checkName(name);
    this.memory.set(name, value);
    if (!this.persistent) return;
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.file(name), this.cipher.encryptString(value), 0o600);
  }

  async delete(name: string): Promise<void> {
    checkName(name);
    this.memory.delete(name);
    await fs.rm(this.file(name), { force: true });
  }
}

/** Implementación en memoria (pruebas y modo sin llavero). */
export class MemorySecretStore implements SecretStore {
  readonly persistent = false;
  private readonly m = new Map<string, string>();
  async get(name: string) {
    checkName(name);
    return this.m.get(name);
  }
  async set(name: string, value: string) {
    checkName(name);
    this.m.set(name, value);
  }
  async delete(name: string) {
    this.m.delete(name);
  }
  keys(): string[] {
    return [...this.m.keys()];
  }
}
