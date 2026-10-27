// Empaqueta una versión portable SIN electron-builder (útil sin acceso a npm):
// toma el zip oficial de Electron (verificado por SHA-256 con SHASUMS256.txt) y añade la app.
//   node scripts/package-portable.mjs --electron-zip electron-v44.9.3-win32-x64.zip --shasums SHASUMS256.txt --out release/UnrealLauncher-win-x64-portable
// La app queda en resources/app (sin asar) y el ejecutable se renombra a "Unreal Launcher.exe".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const zip = arg('electron-zip');
const sums = arg('shasums');
const out = path.resolve(arg('out') ?? path.join(root, 'release', 'portable'));
if (!zip || !sums) throw new Error('--electron-zip y --shasums son obligatorios');

const expected = fs
  .readFileSync(sums, 'utf8')
  .split('\n')
  .find((l) => l.trim().endsWith(path.basename(zip)))
  ?.split(/\s+/)[0];
const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (!expected || expected !== actual) throw new Error(`SHA-256 de Electron no coincide (${actual} ≠ ${expected})`);

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
execFileSync('unzip', ['-q', zip, '-d', out]);
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
const app = path.join(out, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main }, null, 2));
const exe = path.join(out, 'electron.exe');
if (fs.existsSync(exe)) fs.renameSync(exe, path.join(out, `${pkg.productName}.exe`));
const bin = path.join(out, 'electron');
if (fs.existsSync(bin)) fs.renameSync(bin, path.join(out, pkg.name));
fs.writeFileSync(path.join(out, 'LEEME.txt'), `${pkg.productName} ${pkg.version} (portable)\r\nEjecuta "${pkg.productName}.exe". Tus datos se guardan en %APPDATA%\\${pkg.productName}.\r\n`);
console.log(`Portable listo en ${out}`);
