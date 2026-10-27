import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { ZipWriter } from '../../src/main/core/archive';
import { nullLogger } from '../../src/main/core/logger';
import { MemorySecretStore } from '../../src/main/security/secureStore';
import { createServices, type Services } from '../../src/main/services';
import type { BrandConfig } from '../../src/shared/brand';

export const sha1 = (b: Buffer | string) => crypto.createHash('sha1').update(b).digest('hex');
export const sha256 = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
export const sha512 = (b: Buffer | string) => crypto.createHash('sha512').update(b).digest('hex');

export function tmpDir(prefix = 'unreal-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

type RouteFn = (req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) => void | Promise<void>;

/** Servidor HTTP de pruebas que reproduce las APIs oficiales usadas por el launcher. */
export class MockServer {
  readonly server: http.Server;
  base = '';
  private readonly routes = new Map<string, RouteFn>();
  readonly hits: string[] = [];
  /** Corta la conexión tras N bytes la primera vez que se pide una ruta (prueba de reanudación). */
  readonly cutOnce = new Map<string, number>();

  constructor() {
    this.server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const url = new URL(req.url ?? '/', 'http://x');
      this.hits.push(`${req.method} ${url.pathname}`);
      const fn = this.routes.get(`${req.method} ${url.pathname}`) ?? this.routes.get(`* ${url.pathname}`);
      if (!fn) {
        res.writeHead(404).end();
        return;
      }
      try {
        await fn(req, res, Buffer.concat(chunks));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  close(): Promise<void> {
    this.server.closeAllConnections?.();
    return new Promise((r) => this.server.close(() => r()));
  }

  on(method: string, p: string, fn: RouteFn): this {
    this.routes.set(`${method} ${p}`, fn);
    return this;
  }

  json(method: string, p: string, value: unknown | (() => unknown), status = 200): this {
    return this.on(method, p, (_req, res) => {
      const v = typeof value === 'function' ? (value as () => unknown)() : value;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    });
  }

  /** Archivo binario con soporte de Range (descargas reanudables). */
  file(p: string, data: Buffer): this {
    return this.on('GET', p, (req, res) => {
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const cut = this.cutOnce.get(p);
      if (cut != null) {
        this.cutOnce.delete(p);
        res.writeHead(200, { 'content-length': data.length });
        res.write(data.subarray(0, cut));
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      if (start > 0) {
        res.writeHead(206, { 'content-length': data.length - start, 'content-range': `bytes ${start}-${data.length - 1}/${data.length}` });
        res.end(data.subarray(start));
      } else {
        res.writeHead(200, { 'content-length': data.length });
        res.end(data);
      }
    });
  }
}

export async function makeJar(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const f = path.join(tmpDir('jar-'), 'x.jar');
  const z = new ZipWriter(f);
  for (const [k, v] of Object.entries(entries)) await z.addBuffer(k, Buffer.isBuffer(v) ? v : Buffer.from(v));
  await z.close();
  return fs.readFileSync(f);
}

/** "java" falso para Linux: responde a -XshowSettings y registra los argumentos de lanzamiento. */
export function fakeJava(dir: string, major = 21, opts: { exitCode?: number; logFile?: string } = {}): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const java = path.join(bin, 'java');
  const log = opts.logFile ?? path.join(dir, 'args.log');
  fs.writeFileSync(
    java,
    `#!/bin/sh
if [ "$1" = "-XshowSettings:properties" ]; then
  echo "Property settings:" >&2
  echo "    java.version = ${major}.0.4" >&2
  echo "    java.vendor = Mock" >&2
  echo "    os.arch = amd64" >&2
  echo 'openjdk version "${major}.0.4"' >&2
  exit 0
fi
printf '%s\\n' "$@" > "${log}"
echo "[main] Setting user: Steve"
echo "token leak test: $(grep -A1 -- '--accessToken' "${log}" | tail -n1)"
exit ${opts.exitCode ?? 0}
`,
    { mode: 0o755 },
  );
  return java;
}

export const TEST_UUID = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

export interface FakeWorld {
  mock: MockServer;
  versionId: string;
  files: { lib: Buffer; client: Buffer; assetObj: Buffer[]; nativeJar: Buffer };
  adoptiumTar: Buffer;
  ms: { refreshCount: number; xstsErr?: number; entitled: boolean; profile: boolean; tokenError?: string };
  skinsUploaded: Array<{ variant: string; size: number }>;
}

/** Monta un "mundo" completo: Microsoft, Xbox, Minecraft Services, piston-meta, recursos, Fabric y Adoptium. */
export async function fakeWorld(): Promise<FakeWorld> {
  const mock = await new MockServer().start();
  const B = mock.base;
  const versionId = '1.21.1';
  const lib = Buffer.from('fake-library-' + 'x'.repeat(5000));
  const client = Buffer.from('fake-client-jar-' + 'y'.repeat(20000));
  const nativeJar = await makeJar({ 'liblwjgl.so': 'ELF', 'META-INF/MANIFEST.MF': 'x' });
  const assetObj = [Buffer.from('sound-a'), Buffer.from('texture-b'), Buffer.from('lang-c')];
  const objects: Record<string, { hash: string; size: number }> = {};
  assetObj.forEach((b, i) => (objects[`minecraft/file${i}.bin`] = { hash: sha1(b), size: b.length }));
  const assetIndex = Buffer.from(JSON.stringify({ objects }));
  const logCfg = Buffer.from('<Configuration/>');

  for (const b of assetObj) mock.file(`/resources/${sha1(b).slice(0, 2)}/${sha1(b)}`, b);
  mock.file('/libs/com/example/lib/1.0/lib-1.0.jar', lib);
  mock.file('/libs/org/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar', nativeJar);
  mock.file('/client.jar', client);
  mock.file('/assets/index.json', assetIndex);
  mock.file('/log4j.xml', logCfg);

  const versionJson = {
    id: versionId,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '17', sha1: sha1(assetIndex), size: assetIndex.length, url: `${B}/assets/index.json` },
    assets: '17',
    downloads: { client: { url: `${B}/client.jar`, sha1: sha1(client), size: client.length } },
    javaVersion: { component: 'java-runtime-delta', majorVersion: 21 },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client-1.21.xml', sha1: sha1(logCfg), size: logCfg.length, url: `${B}/log4j.xml` }, type: 'log4j2-xml' } },
    arguments: {
      game: ['--username', '${auth_player_name}', '--version', '${version_name}', '--gameDir', '${game_directory}', '--assetsDir', '${assets_root}', '--assetIndex', '${assets_index_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--userType', '${user_type}', { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}', '--height', '${resolution_height}'] }, { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' }],
      jvm: [{ rules: [{ action: 'allow', os: { name: 'osx' } }], value: ['-XstartOnFirstThread'] }, '-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
    libraries: [
      { name: 'com.example:lib:1.0', downloads: { artifact: { path: 'com/example/lib/1.0/lib-1.0.jar', sha1: sha1(lib), size: lib.length, url: `${B}/libs/com/example/lib/1.0/lib-1.0.jar` } } },
      { name: 'com.example:windows-only:1.0', rules: [{ action: 'allow', os: { name: 'windows' } }], downloads: { artifact: { path: 'w.jar', sha1: 'a'.repeat(40), size: 1, url: `${B}/nope` } } },
      {
        name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4',
        natives: { linux: 'natives-linux', windows: 'natives-windows', osx: 'natives-osx' },
        extract: { exclude: ['META-INF/'] },
        downloads: { classifiers: { 'natives-linux': { path: 'org/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar', sha1: sha1(nativeJar), size: nativeJar.length, url: `${B}/libs/org/lwjgl/lwjgl-platform/2.9.4/lwjgl-platform-2.9.4-natives-linux.jar` } } },
      },
    ],
  };
  const vjBuf = Buffer.from(JSON.stringify(versionJson));
  mock.file(`/v1/packages/${versionId}.json`, vjBuf);
  mock.json('GET', '/mc/game/version_manifest_v2.json', {
    latest: { release: versionId, snapshot: versionId },
    versions: [
      { id: versionId, type: 'release', url: `${B}/v1/packages/${versionId}.json`, time: '2024-08-08T00:00:00Z', releaseTime: '2024-08-08T00:00:00Z', sha1: sha1(vjBuf) },
      { id: '24w01a', type: 'snapshot', url: `${B}/none`, time: '', releaseTime: '', sha1: '0'.repeat(40) },
    ],
  });

  // Fabric
  const fabricLib = Buffer.from('fabric-loader-jar');
  mock.file('/maven/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar', fabricLib);
  mock.on('GET', '/maven/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar.sha1', (_q, r) => void r.end(sha1(fabricLib)));
  mock.json('GET', `/fabric/v2/versions/loader/${versionId}`, [{ loader: { version: '0.16.9', stable: true } }, { loader: { version: '0.17.0-beta', stable: false } }]);
  mock.json('GET', `/fabric/v2/versions/loader/${versionId}/0.16.9/profile/json`, {
    id: `fabric-loader-0.16.9-${versionId}`,
    inheritsFrom: versionId,
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    arguments: { game: [], jvm: ['-DFabricMcEmu= net.minecraft.client.main.Main '] },
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.16.9', url: `${B}/maven/` }],
  });

  // Adoptium (JRE falso en tar.gz)
  const jreDir = tmpDir('jre-');
  fakeJava(path.join(jreDir, 'jdk-21.0.4+7-jre'), 21);
  const tarFile = path.join(tmpDir('tar-'), 'jre.tar.gz');
  execFileSync('tar', ['-czf', tarFile, '-C', jreDir, 'jdk-21.0.4+7-jre']);
  const adoptiumTar = fs.readFileSync(tarFile);
  mock.file('/adoptium/jre21.tar.gz', adoptiumTar);
  mock.json('GET', '/adoptium/v3/assets/latest/21/hotspot', [
    { binary: { package: { link: `${B}/adoptium/jre21.tar.gz`, checksum: sha256(adoptiumTar), size: adoptiumTar.length, name: 'OpenJDK21U-jre_x64_linux.tar.gz' } }, release_name: 'jdk-21.0.4+7' },
  ]);

  // Microsoft / Xbox / Minecraft Services
  const ms = { refreshCount: 0, xstsErr: undefined as number | undefined, entitled: true, profile: true, tokenError: undefined as string | undefined };
  const skinsUploaded: FakeWorld['skinsUploaded'] = [];
  mock.on('GET', '/ms/authorize', (req, res) => {
    const u = new URL(req.url!, 'http://x');
    const redirect = new URL(u.searchParams.get('redirect_uri')!);
    if (u.searchParams.get('code_challenge_method') !== 'S256' || !u.searchParams.get('code_challenge')) {
      res.writeHead(400).end();
      return;
    }
    redirect.searchParams.set('code', 'AUTH_CODE_123');
    redirect.searchParams.set('state', u.searchParams.get('state')!);
    res.writeHead(302, { location: redirect.toString() }).end();
  });
  mock.on('POST', '/ms/token', (_req, res, body) => {
    const p = new URLSearchParams(body.toString());
    if (ms.tokenError) return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: ms.tokenError }));
    if (p.get('grant_type') === 'refresh_token') ms.refreshCount++;
    if (p.get('grant_type') === 'authorization_code' && (!p.get('code_verifier') || p.get('code') !== 'AUTH_CODE_123')) {
      return void res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_grant' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'MS_ACCESS', refresh_token: `MS_REFRESH_${ms.refreshCount}`, expires_in: 3600, token_type: 'Bearer' }));
  });
  mock.json('POST', '/xbl', { Token: 'XBL_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS1' }] } });
  mock.on('POST', '/xsts', (_q, res) => {
    if (ms.xstsErr) return void res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ XErr: ms.xstsErr }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ Token: 'XSTS_TOKEN', DisplayClaims: { xui: [{ uhs: 'UHS1' }] } }));
  });
  mock.on('POST', '/mc/login', (_q, res, body) => {
    const j = JSON.parse(body.toString());
    if (j.identityToken !== 'XBL3.0 x=UHS1;XSTS_TOKEN') return void res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'MC_ACCESS_TOKEN_SECRET', expires_in: 86400 }));
  });
  mock.on('GET', '/mc/entitlements', (_q, res) =>
    void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ items: ms.entitled ? [{ name: 'product_minecraft' }, { name: 'game_minecraft' }] : [] })),
  );
  mock.on('GET', '/mc/profile', (req, res) => {
    if (req.headers.authorization !== 'Bearer MC_ACCESS_TOKEN_SECRET') return void res.writeHead(401).end();
    if (!ms.profile) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: TEST_UUID.replace(/-/g, ''), name: 'Notch', skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/abc', variant: 'CLASSIC' }] }));
  });
  mock.on('POST', '/mc/skins', (req, res, body) => {
    if (req.headers.authorization !== 'Bearer MC_ACCESS_TOKEN_SECRET') return void res.writeHead(401).end();
    const variant = /name="variant"\r\n\r\n(\w+)/.exec(body.toString('latin1'))?.[1] ?? '?';
    skinsUploaded.push({ variant, size: body.length });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: TEST_UUID.replace(/-/g, ''), name: 'Notch', skins: [{ state: 'ACTIVE', url: 'http://textures.minecraft.net/texture/new', variant: variant.toUpperCase() }] }));
  });

  return { mock, versionId, files: { lib, client, assetObj, nativeJar }, adoptiumTar, ms, skinsUploaded };
}

export interface ServicesEnv {
  services: Services;
  world: FakeWorld;
  userData: string;
  secrets: MemorySecretStore;
  close(): Promise<void>;
}

export function testBrand(overrides: Partial<BrandConfig> = {}): BrandConfig {
  return {
    productName: 'Unreal Launcher',
    shortName: 'UNREAL',
    appId: 'test',
    tagline: '',
    colors: { accent: '#8B5CF6', accentAlt: '#22D3EE' },
    logo: '',
    github: { owner: 'owner', repo: 'repo', updateManifestAsset: 'update-manifest.json', updateSignatureAsset: 'update-manifest.json.sig' },
    updatePublicKeys: [],
    authority: { url: '', publicKeys: [] },
    microsoft: { clientId: '00000000-0000-4000-8000-000000000000', redirectPath: '/auth/callback' },
    support: { website: '', issues: '' },
    ...overrides,
  };
}

export async function servicesEnv(opts: { brand?: Partial<BrandConfig>; world?: FakeWorld; userData?: string; secrets?: MemorySecretStore } = {}): Promise<ServicesEnv> {
  const world = opts.world ?? (await fakeWorld());
  const B = world.mock.base;
  const userData = opts.userData ?? tmpDir('userdata-');
  const secrets = opts.secrets ?? new MemorySecretStore();
  const services = await createServices({
    userData,
    appVersion: '1.0.0',
    brand: testBrand(opts.brand),
    secrets,
    fetch: globalThis.fetch.bind(globalThis),
    log: nullLogger,
    allowInsecureLocalhost: true,
    platformKey: 'linux-x64',
    endpoints: {
      ms: { authorize: `${B}/ms/authorize`, token: `${B}/ms/token` },
      mc: { xbl: `${B}/xbl`, xsts: `${B}/xsts`, mcLogin: `${B}/mc/login`, entitlements: `${B}/mc/entitlements`, profile: `${B}/mc/profile`, skins: `${B}/mc/skins` },
      meta: {
        versionManifest: `${B}/mc/game/version_manifest_v2.json`,
        fabricMeta: `${B}/fabric/v2`,
        forgeMaven: `${B}/forge`,
        forgePromotions: `${B}/forge/promotions.json`,
        neoforgeMaven: `${B}/neoforge`,
        resources: `${B}/resources`,
      },
      adoptium: `${B}/adoptium/v3`,
      github: `${B}/gh`,
      join: `${B}/session/minecraft/join`,
    },
  });
  return {
    services,
    world,
    userData,
    secrets,
    close: async () => {
      services.social.stop();
      services.updater.schedule(false);
      await world.mock.close();
    },
  };
}

/** Navegador simulado: sigue la redirección de autorización hasta el servidor loopback. */
export async function fakeBrowser(url: string): Promise<void> {
  const r1 = await fetch(url, { redirect: 'manual' });
  const loc = r1.headers.get('location');
  if (!loc) throw new Error('sin redirección');
  await fetch(loc);
}
