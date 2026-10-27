import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors';
import type { SkinEntry, SkinVariant } from '../../shared/types';
import type { AccountManager } from '../auth/accountManager';
import type { MinecraftServices } from '../auth/minecraftServices';
import type { Http } from '../core/http';
import { Mutex, readJson, writeFileAtomic, writeJson } from '../core/jsonStore';
import type { Logger } from '../core/logger';

const MAX_PNG = 256 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Valida que el archivo sea un PNG real de 64×64 (o 64×32 clásico). */
export function validateSkinPng(buf: Buffer): { width: number; height: number } {
  if (buf.length < 33 || buf.length > MAX_PNG) throw new AppError('SKIN_INVALID', 'tamaño de archivo', { reason: 'size' });
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new AppError('SKIN_INVALID', 'no es PNG', { reason: 'format' });
  if (buf.readUInt32BE(8) !== 13 || buf.toString('ascii', 12, 16) !== 'IHDR') throw new AppError('SKIN_INVALID', 'IHDR', { reason: 'format' });
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== 64 || (height !== 64 && height !== 32)) throw new AppError('SKIN_INVALID', `${width}x${height}`, { reason: 'dimensions', width, height });
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (bitDepth !== 8 || ![2, 3, 6].includes(colorType!)) throw new AppError('SKIN_INVALID', 'formato de color', { reason: 'color' });
  return { width, height };
}

export function pngFromDataUrl(dataUrl: string): Buffer {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m || m[1]!.length > MAX_PNG * 1.4) throw new AppError('SKIN_INVALID', 'data URL', { reason: 'format' });
  return Buffer.from(m[1]!, 'base64');
}

const EntrySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string().min(1).max(40),
  variant: z.enum(['classic', 'slim']),
  favorite: z.boolean(),
  addedAt: z.number(),
  lastAppliedAt: z.number().optional(),
});
const IndexSchema = z.object({ skins: z.array(EntrySchema).default([]) });
type Entry = z.infer<typeof EntrySchema>;

export class SkinService {
  private entries: Entry[] = [];
  private readonly mutex = new Mutex();

  constructor(
    private readonly dir: string,
    private readonly indexFile: string,
    private readonly accounts: AccountManager,
    private readonly mc: MinecraftServices,
    private readonly http: Http,
    private readonly log: Logger,
  ) {}

  async load(): Promise<void> {
    this.entries = (await readJson(this.indexFile, IndexSchema, () => ({ skins: [] }))).value.skins;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.png`);
  }

  async library(): Promise<SkinEntry[]> {
    const out: SkinEntry[] = [];
    for (const e of this.entries) {
      try {
        const buf = await fsp.readFile(this.file(e.id));
        out.push({ ...e, dataUrl: `data:image/png;base64,${buf.toString('base64')}` });
      } catch {
        /* archivo perdido: se omite */
      }
    }
    return out.sort((a, b) => Number(b.favorite) - Number(a.favorite) || (b.lastAppliedAt ?? b.addedAt) - (a.lastAppliedAt ?? a.addedAt));
  }

  async add(name: string, png: Buffer, variant: SkinVariant): Promise<SkinEntry> {
    validateSkinPng(png);
    const cleanName = name.replace(/\.png$/i, '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Skin';
    const id = crypto.createHash('sha256').update(png).digest('hex').slice(0, 16);
    return this.mutex.run(async () => {
      await writeFileAtomic(this.file(id), png, 0o644);
      let e = this.entries.find((x) => x.id === id);
      if (!e) {
        e = { id, name: cleanName, variant, favorite: false, addedAt: Date.now() };
        this.entries.push(e);
        // Recientes: se conservan como máximo 60 (las favoritas nunca se purgan).
        const purge = this.entries.filter((x) => !x.favorite).sort((a, b) => a.addedAt - b.addedAt);
        while (this.entries.length > 60 && purge.length) {
          const old = purge.shift()!;
          this.entries = this.entries.filter((x) => x.id !== old.id);
          await fsp.rm(this.file(old.id), { force: true });
        }
      }
      await writeJson(this.indexFile, { skins: this.entries });
      return { ...e, dataUrl: `data:image/png;base64,${png.toString('base64')}` };
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutex.run(async () => {
      this.entries = this.entries.filter((e) => e.id !== id);
      await fsp.rm(this.file(id), { force: true });
      await writeJson(this.indexFile, { skins: this.entries });
    });
  }

  async patch(id: string, p: Partial<Pick<Entry, 'favorite' | 'variant'>>): Promise<void> {
    await this.mutex.run(async () => {
      const e = this.entries.find((x) => x.id === id);
      if (!e) throw new AppError('NOT_FOUND');
      Object.assign(e, p);
      await writeJson(this.indexFile, { skins: this.entries });
    });
  }

  /**
   * Publica la skin en el perfil oficial. Requiere una cuenta premium con token válido
   * (comprobado aquí, no en la interfaz). Solo se informa de éxito si Minecraft Services
   * devuelve el perfil con la nueva skin activa.
   */
  async apply(id: string, accountId: string | undefined): Promise<{ appliedAt: number }> {
    if (!accountId) throw new AppError('PREMIUM_REQUIRED');
    const acc = this.accounts.get(accountId);
    if (!acc || acc.kind !== 'microsoft') throw new AppError('PREMIUM_REQUIRED');
    const e = this.entries.find((x) => x.id === id);
    if (!e) throw new AppError('NOT_FOUND');
    const png = await fsp.readFile(this.file(id));
    validateSkinPng(png);
    const { token } = await this.accounts.premiumToken(accountId);
    const profile = await this.mc.uploadSkin(token, png, e.variant);
    await this.accounts.updateSkinCache(accountId, profile.skin);
    const appliedAt = Date.now();
    await this.mutex.run(async () => {
      e.lastAppliedAt = appliedAt;
      await writeJson(this.indexFile, { skins: this.entries });
    });
    this.log.info('Skin publicada', { variant: e.variant });
    return { appliedAt };
  }

  /** Skin actual de la cuenta: se descarga solo de textures.minecraft.net (HTTPS). */
  async current(accountId: string | undefined): Promise<{ dataUrl?: string; variant: SkinVariant; url?: string } | null> {
    const acc = accountId ? this.accounts.get(accountId) : undefined;
    if (!acc?.skin) return null;
    const u = new URL(acc.skin.url.replace(/^http:/, 'https:'));
    if (u.host !== 'textures.minecraft.net') return { variant: acc.skin.variant, url: undefined };
    try {
      const res = await this.http.request(u.toString(), {}, { timeoutMs: 10_000 });
      if (!res.ok) return { variant: acc.skin.variant };
      const buf = Buffer.from(await res.arrayBuffer());
      validateSkinPng(buf);
      return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, variant: acc.skin.variant, url: u.toString() };
    } catch {
      return { variant: acc.skin.variant };
    }
  }
}
