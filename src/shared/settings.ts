import { z } from 'zod';

/**
 * Esquema único de configuración. Se valida al leer de disco, al recibir cambios por IPC
 * y antes de aplicar cualquier ajuste. Los valores por defecto viven aquí.
 */
export const SettingsSchema = z
  .object({
    version: z.literal(1).default(1),
    general: z
      .object({
        language: z.enum(['es', 'en']).default('es'),
        theme: z.enum(['dark', 'light', 'system']).default('dark'),
        accent: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        launchOnStartup: z.boolean().default(false),
        minimizeToTrayOnClose: z.boolean().default(false),
        notifications: z.boolean().default(true),
        animations: z.enum(['system', 'full', 'reduced']).default('system'),
        hideLauncherOnGameStart: z.boolean().default(false),
      })
      .default({}),
    privacy: z
      .object({
        /** Enviar diagnósticos a terceros: no existe telemetría; se mantiene explícito en false. */
        telemetry: z.literal(false).default(false),
        rememberAccounts: z.boolean().default(true),
      })
      .default({}),
    minecraft: z
      .object({
        defaultMemoryMinMb: z.number().int().min(256).max(65536).default(1024),
        defaultMemoryMaxMb: z.number().int().min(512).max(131072).default(4096),
        javaPath: z.string().max(1024).optional(),
        autoJava: z.boolean().default(true),
        defaultJvmArgs: z.array(z.string().max(512)).max(64).default([]),
        width: z.number().int().min(320).max(7680).default(1280),
        height: z.number().int().min(240).max(4320).default(720),
        fullscreen: z.boolean().default(false),
        instancesDir: z.string().max(1024).optional(),
        closeLauncherOnExit: z.boolean().default(false),
      })
      .default({}),
    downloads: z
      .object({
        /** KiB/s; 0 = sin límite. */
        bandwidthLimitKiB: z.number().int().min(0).max(1_000_000).default(0),
        concurrency: z.number().int().min(1).max(16).default(6),
        resume: z.boolean().default(true),
        tempDir: z.string().max(1024).optional(),
        verifyIntegrity: z.literal(true).default(true),
      })
      .default({}),
    social: z
      .object({
        messageNotifications: z.boolean().default(true),
        presence: z.enum(['friends', 'nobody']).default('friends'),
        friendRequests: z.enum(['everyone', 'nobody']).default('everyone'),
        typingIndicator: z.boolean().default(true),
        enterToSend: z.boolean().default(true),
      })
      .default({}),
    advanced: z
      .object({
        logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
        updateChannel: z.enum(['stable', 'beta']).default('stable'),
        autoCheckUpdates: z.boolean().default(true),
        autoDownloadUpdates: z.boolean().default(false),
      })
      .default({}),
    ui: z
      .object({
        selectedInstanceId: z.string().max(64).optional(),
        activeAccountId: z.string().max(128).optional(),
      })
      .default({}),
  })
  .superRefine((s, ctx) => {
    if (s.minecraft.defaultMemoryMinMb > s.minecraft.defaultMemoryMaxMb) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minecraft', 'defaultMemoryMinMb'], message: 'min>max' });
    }
  });

export type Settings = z.infer<typeof SettingsSchema>;

export function defaultSettings(): Settings {
  return SettingsSchema.parse({});
}

/** Parche profundo de un nivel por categoría (lo que envía la interfaz). */
export type SettingsPatch = {
  [K in keyof Settings]?: Partial<Settings[K]>;
};

export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      next[k] = { ...(current as unknown as Record<string, Record<string, unknown>>)[k], ...v };
    }
  }
  return SettingsSchema.parse(next);
}
