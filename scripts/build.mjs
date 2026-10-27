// Compilación con esbuild: proceso principal, preload y renderer.
// Uso: node scripts/build.mjs [--dev]
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const out = path.join(root, 'dist');
fs.rmSync(out, { recursive: true, force: true });

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  logLevel: 'warning',
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'), __APP_VERSION__: JSON.stringify(pkg.version) },
};

await Promise.all([
  build({
    ...common,
    entryPoints: [path.join(root, 'src/main/main.ts')],
    outfile: path.join(out, 'main/main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [path.join(root, 'src/preload/preload.ts')],
    outfile: path.join(out, 'preload/preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: { main: path.join(root, 'src/renderer/main.tsx') },
    outdir: path.join(out, 'renderer'),
    platform: 'browser',
    format: 'esm',
    splitting: true,
    target: 'chrome130',
    jsx: 'automatic',
    loader: { '.ttf': 'file', '.png': 'file', '.svg': 'file' },
    assetNames: 'assets/[name]-[hash]',
    chunkNames: 'chunks/[name]-[hash]',
  }),
]);

fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'));
const assets = path.join(root, 'src/renderer/assets');
fs.mkdirSync(path.join(out, 'renderer/assets'), { recursive: true });
for (const f of ['icon.png', 'tray.png']) {
  if (fs.existsSync(path.join(assets, f))) fs.copyFileSync(path.join(assets, f), path.join(out, 'renderer/assets', f));
}
for (const f of fs.readdirSync(path.join(assets, 'fonts')).filter((x) => x.endsWith('.txt'))) {
  fs.copyFileSync(path.join(assets, 'fonts', f), path.join(out, 'renderer/assets', f));
}
console.log(`build ${dev ? 'dev' : 'prod'} → ${path.relative(root, out)}`);
