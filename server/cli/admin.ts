/**
 * Administración de la autoridad (sin endpoints HTTP de administración: se ejecuta en el servidor).
 *
 *   node dist/cli/admin.js gen-secrets
 *   node dist/cli/admin.js add-instance ./instancia.json
 *   node dist/cli/admin.js create-keys <instanceId> <cantidad> [--uses 1] [--expires-days 30] [--note "texto"]
 *   node dist/cli/admin.js revoke-key UNRL-XXXXX-...
 *   node dist/cli/admin.js revoke-grant <grantId>
 *   node dist/cli/admin.js events [--limit 50]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadConfig } from '../src/config';
import { openDb } from '../src/db';
import { KeyService } from '../src/keys';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

if (cmd === 'gen-secrets') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pk = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  console.log(`# Guarda estos valores como secretos del servidor (NUNCA en el repositorio)`);
  console.log(`KEY_PEPPER=${crypto.randomBytes(32).toString('base64')}`);
  console.log(`SIGNING_KEY=${pk}`);
  console.log(`# Clave PÚBLICA para el launcher (src/main/keys o variable AUTHORITY_PUBLIC_KEY):`);
  console.log(`AUTHORITY_PUBLIC_KEY=${pub}`);
  process.exit(0);
}

const cfg = loadConfig();
const db = openDb(cfg.dbPath);
const keys = new KeyService(db, cfg);

switch (cmd) {
  case 'add-instance': {
    const def = JSON.parse(fs.readFileSync(rest[0]!, 'utf8'));
    const r = keys.upsertInstance(def);
    console.log(`Instancia ${def.id} registrada. manifest sha256=${r.sha256}`);
    break;
  }
  case 'create-keys': {
    const [instanceId, count] = rest;
    const n = Math.min(Math.max(Number(count) || 1, 1), 10_000);
    const days = Number(flag('expires-days') ?? 0);
    const list = keys.createKeys(instanceId!, n, {
      maxUses: Number(flag('uses') ?? 1),
      expiresAt: days > 0 ? Date.now() + days * 86400_000 : undefined,
      note: flag('note'),
    });
    // Las claves solo se muestran UNA vez: el servidor no puede recuperarlas después.
    for (const k of list) console.log(k);
    break;
  }
  case 'revoke-key':
    console.log(keys.revokeKey(rest[0] ?? '') ? 'Clave revocada' : 'No encontrada o ya revocada');
    break;
  case 'revoke-grant':
    console.log(keys.revokeGrant(rest[0] ?? '') ? 'Concesión revocada' : 'No encontrada o ya revocada');
    break;
  case 'events': {
    const rows = db.prepare('SELECT at, type, principal, ip_hash, detail FROM security_events ORDER BY id DESC LIMIT ?').all(Number(flag('limit') ?? 50));
    for (const r of rows as Array<Record<string, unknown>>) console.log(new Date(Number(r.at)).toISOString(), r.type, r.principal ?? '-', r.ip_hash ?? '-', r.detail ?? '');
    break;
  }
  default:
    console.error('Comandos: gen-secrets | add-instance <json> | create-keys <id> <n> | revoke-key <clave> | revoke-grant <id> | events');
    process.exit(1);
}
db.close();
