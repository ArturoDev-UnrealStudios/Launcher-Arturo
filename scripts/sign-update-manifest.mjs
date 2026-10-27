// Crea y firma update-manifest.json a partir de los instaladores de una carpeta.
//   UPDATE_SIGNING_KEY=<pkcs8 base64> node scripts/sign-update-manifest.mjs --dir release --version 1.2.0 [--channel beta] [--notes notas.md]
// Salida: <dir>/update-manifest.json y <dir>/update-manifest.json.sig (Ed25519, base64).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const dir = arg('dir', 'release');
const version = arg('version');
const channel = arg('channel', /-/.test(version ?? '') ? 'beta' : 'stable');
const notesFile = arg('notes');
const keyB64 = process.env.UPDATE_SIGNING_KEY;

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('--version semver obligatorio');
if (!keyB64) throw new Error('Falta UPDATE_SIGNING_KEY');
const key = crypto.createPrivateKey({ key: Buffer.from(keyB64, 'base64'), format: 'der', type: 'pkcs8' });
if (key.asymmetricKeyType !== 'ed25519') throw new Error('La clave debe ser Ed25519');

const rules = [
  { re: /win.*x64.*\.exe$/i, platform: 'win32-x64', kind: 'nsis' },
  { re: /linux.*(x86_64|x64).*\.AppImage$/i, platform: 'linux-x64', kind: 'appimage' },
  { re: /linux.*arm64.*\.AppImage$/i, platform: 'linux-arm64', kind: 'appimage' },
  { re: /mac.*arm64.*\.dmg$/i, platform: 'darwin-arm64', kind: 'dmg' },
  { re: /mac.*x64.*\.dmg$/i, platform: 'darwin-x64', kind: 'dmg' },
];

const files = {};
for (const name of fs.readdirSync(dir)) {
  const rule = rules.find((r) => r.re.test(name));
  if (!rule || !name.includes(version)) continue;
  const buf = fs.readFileSync(path.join(dir, name));
  files[rule.platform] = { name, sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length, kind: rule.kind };
}
if (!Object.keys(files).length) throw new Error(`No se encontraron instaladores ${version} en ${dir}`);

const manifest = {
  version,
  channel,
  releasedAt: new Date().toISOString(),
  notes: notesFile && fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').slice(0, 20000) : '',
  files,
};
const raw = JSON.stringify(manifest, null, 2);
const sig = crypto.sign(null, Buffer.from(raw, 'utf8'), key).toString('base64');
fs.writeFileSync(path.join(dir, 'update-manifest.json'), raw);
fs.writeFileSync(path.join(dir, 'update-manifest.json.sig'), sig);
console.log(`Manifiesto firmado para ${version} (${channel}): ${Object.keys(files).join(', ')}`);
