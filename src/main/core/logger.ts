import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const LEVELS: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/**
 * Política de redacción: cualquier cosa con forma de token, clave de acceso o código OAuth
 * se sustituye antes de escribir. Se aplica a mensajes y a metadatos estructurados.
 */
const SENSITIVE_KEY = /(token|secret|password|passwd|authorization|cookie|code_verifier|verifier|refresh|access|signature|private|^code$|^key$|apikey|session)/i;

const PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[JWT]'],
  [/\b(Bearer|XBL3\.0)\s+[^\s"',]+/gi, '$1 [REDACTED]'],
  [/([?&](?:code|access_token|refresh_token|id_token|token|state|code_verifier)=)[^&\s"]+/gi, '$1[REDACTED]'],
  [/("?(?:accessToken|access_token|refresh_token|refreshToken|identityToken|xstsToken|Token|token|sessionToken|clientToken)"?\s*[:=]\s*")[^"]+/g, '$1[REDACTED]'],
  [/(--accessToken\s+)\S+/g, '$1[REDACTED]'],
  // Claves de canje (formato UNRL-XXXXX-...) → solo se conserva el prefijo.
  [/\b([A-Z]{4})-([A-Z0-9]{5})(?:-[A-Z0-9]{5}){2,}\b/g, '$1-$2-…'],
  [/\bM\.C\d{3}_[A-Za-z0-9!*$._-]{20,}/g, '[MS_TOKEN]'],
];

export function redactString(input: string): string {
  let out = input;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message), code: (value as { code?: unknown }).code };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) && v != null && v !== '' ? '[REDACTED]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export interface Logger {
  error(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  debug(msg: string, meta?: unknown): void;
  child(scope: string): Logger;
  setLevel(level: LogLevel): void;
}

interface Sink {
  write(line: string): void;
}

class FileSink implements Sink {
  private stream?: fs.WriteStream;
  private day = '';
  constructor(private readonly dir: string, private readonly keepDays = 10) {}
  write(line: string): void {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== this.day || !this.stream) {
      this.stream?.end();
      fs.mkdirSync(this.dir, { recursive: true });
      this.day = day;
      this.stream = fs.createWriteStream(path.join(this.dir, `launcher-${day}.log`), { flags: 'a', mode: 0o600 });
      this.rotate();
    }
    this.stream.write(line + '\n');
  }
  private rotate(): void {
    try {
      const files = fs.readdirSync(this.dir).filter((f) => /^launcher-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
      for (const f of files.slice(0, Math.max(0, files.length - this.keepDays))) fs.rmSync(path.join(this.dir, f), { force: true });
    } catch {
      /* rotación best-effort */
    }
  }
}

class RootLogger implements Logger {
  constructor(private readonly sinks: Sink[], private readonly state: { level: LogLevel }, private readonly scope = 'app') {}
  setLevel(level: LogLevel): void {
    this.state.level = level;
  }
  child(scope: string): Logger {
    return new RootLogger(this.sinks, this.state, `${this.scope}:${scope}`);
  }
  private log(level: LogLevel, msg: string, meta?: unknown): void {
    if (LEVELS[level] > LEVELS[this.state.level]) return;
    const rec = {
      t: new Date().toISOString(),
      l: level,
      s: this.scope,
      m: redactString(msg),
      ...(meta === undefined ? {} : { d: redact(meta) }),
    };
    const line = JSON.stringify(rec);
    for (const s of this.sinks) {
      try {
        s.write(line);
      } catch {
        /* nunca romper por logging */
      }
    }
  }
  error(m: string, d?: unknown) { this.log('error', m, d); }
  warn(m: string, d?: unknown) { this.log('warn', m, d); }
  info(m: string, d?: unknown) { this.log('info', m, d); }
  debug(m: string, d?: unknown) { this.log('debug', m, d); }
}

export function createLogger(opts: { dir?: string; level?: LogLevel; console?: boolean }): Logger {
  const sinks: Sink[] = [];
  if (opts.dir) sinks.push(new FileSink(opts.dir));
  if (opts.console) sinks.push({ write: (l) => process.stdout.write(l + '\n') });
  return new RootLogger(sinks, { level: opts.level ?? 'info' });
}

export const nullLogger: Logger = {
  error() {}, warn() {}, info() {}, debug() {},
  child() { return nullLogger; },
  setLevel() {},
};
