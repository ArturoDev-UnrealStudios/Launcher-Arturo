import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildLaunchCommand } from '../../src/main/minecraft/launch';
import { mavenPath, mergeVersions, resolveLibraries, rulesAllow, type VersionJson } from '../../src/main/minecraft/versionJson';
import { neoforgePrefix, parseMavenVersions } from '../../src/main/minecraft/metadata';
import { javaSatisfies, parseJavaProperties } from '../../src/main/minecraft/java';
import { buildPaths } from '../../src/main/core/paths';
import { exportInstance, planImport } from '../../src/main/instances/exportImport';
import { fakeBrowser, fakeJava, makeJar, servicesEnv, tmpDir } from '../helpers/mock';
import { ZipWriter } from '../../src/main/core/archive';

const linux = { os: 'linux' as const, arch: 'x64' };
const win = { os: 'windows' as const, arch: 'x64' };

test('reglas de versión, coordenadas maven y herencia de loaders', () => {
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'osx' } }], linux), false);
  assert.equal(rulesAllow([{ action: 'allow' }, { action: 'disallow', os: { name: 'osx' } }], linux), true);
  assert.equal(rulesAllow([{ action: 'allow', features: { has_custom_resolution: true } }], linux, { has_custom_resolution: true }), true);
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], win), false);
  assert.equal(mavenPath('net.fabricmc:fabric-loader:0.16.9'), 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar');
  assert.equal(mavenPath('org.lwjgl:lwjgl:3.3.3:natives-windows'), 'org/lwjgl/lwjgl/3.3.3/lwjgl-3.3.3-natives-windows.jar');
  assert.equal(mavenPath('de.oceanlabs.mcp:mcp_config:1.20.1@zip'), 'de/oceanlabs/mcp/mcp_config/1.20.1/mcp_config-1.20.1.zip');
  assert.throws(() => mavenPath('a:../../evil:1'));
  const parent = { id: '1.20.1', mainClass: 'Main', libraries: [{ name: 'org.ow2.asm:asm:9.3' }, { name: 'x:y:1' }], arguments: { game: ['--a'], jvm: ['-Dp'] } } as VersionJson;
  const child = { id: 'fabric', inheritsFrom: '1.20.1', mainClass: 'Knot', libraries: [{ name: 'org.ow2.asm:asm:9.6' }], arguments: { game: [], jvm: ['-Dc'] } } as VersionJson;
  const m = mergeVersions(child, parent);
  assert.equal(m.mainClass, 'Knot');
  assert.deepEqual(m.libraries.map((l) => l.name), ['org.ow2.asm:asm:9.6', 'x:y:1']);
  assert.deepEqual(m.arguments?.jvm, ['-Dp', '-Dc']);
  assert.equal(m.jar, '1.20.1');
  assert.deepEqual(parseMavenVersions('<versions><version>1.20.1-47.2.0</version><version>1.20.1-47.3.0</version></versions>'), ['1.20.1-47.2.0', '1.20.1-47.3.0']);
  assert.equal(neoforgePrefix('1.21.1'), '21.1.');
  assert.equal(neoforgePrefix('1.21'), '21.0.');
  assert.equal(neoforgePrefix('1.20.1'), null);
  assert.equal(parseJavaProperties('    java.version = 1.8.0_402\n    java.vendor = Temurin')!.major, 8);
  assert.equal(parseJavaProperties('openjdk version "21.0.4" 2024-07-16')!.major, 21);
  assert.equal(javaSatisfies(17, 16), true);
  assert.equal(javaSatisfies(17, 8), false);
  assert.equal(javaSatisfies(21, 17), false);
});

test('línea de comandos: formatos moderno y legado, Windows con espacios', () => {
  const paths = buildPaths('C:\\Users\\Jose Luis\\AppData\\Roaming\\Unreal Launcher');
  const modern = {
    id: '1.21.1',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: { id: '17', sha1: '', size: 0, url: '' },
    arguments: {
      game: ['--username', '${auth_player_name}', '--accessToken', '${auth_access_token}', { rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] }],
      jvm: ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}'],
    },
    libraries: [{ name: 'a:b:1', downloads: { artifact: { path: 'a/b/1/b-1.jar', url: 'https://x', sha1: '', size: 1 } } }],
  } as VersionJson;
  const base = {
    version: modern,
    versionId: '1.21.1',
    paths,
    gameDir: 'C:\\Users\\Jose Luis\\inst\\minecraft',
    nativesDir: 'C:\\n',
    identity: { username: 'Steve', uuid: 'b50ad385-829d-3141-a216-7e7d7539ba7f', accessToken: 'TOKEN', userType: 'msa' as const },
    memory: { minMb: 1024, maxMb: 4096 },
    jvmArgs: ['-XX:+UseG1GC'],
    game: { width: 1280, height: 720, fullscreen: false },
    launcherName: 'UNREAL',
    launcherVersion: '1.0.0',
    platform: win,
  };
  const cmd = buildLaunchCommand(base);
  const args = cmd.args;
  assert.equal(args[0], '-Xms1024M');
  assert.equal(args[1], '-Xmx4096M');
  const cp = args[args.indexOf('-cp') + 1]!;
  assert.ok(cp.includes(';'), 'separador de classpath de Windows');
  assert.ok(cp.includes('Jose Luis'), 'las rutas con espacios se pasan como un solo argumento');
  assert.ok(args.indexOf('-XX:+UseG1GC') < args.indexOf('net.minecraft.client.main.Main'));
  assert.equal(args[args.indexOf('--accessToken') + 1], 'TOKEN');
  assert.ok(args.includes('--width'));
  const fs1 = buildLaunchCommand({ ...base, game: { ...base.game, fullscreen: true } });
  assert.ok(!fs1.args.includes('--width') && fs1.args.includes('--fullscreen'));

  const legacy = { id: '1.8.9', mainClass: 'net.minecraft.client.main.Main', assets: '1.8', minecraftArguments: '--username ${auth_player_name} --session ${auth_session} --uuid ${auth_uuid}', libraries: [] } as unknown as VersionJson;
  const l = buildLaunchCommand({ ...base, version: legacy, versionId: '1.8.9', platform: linux });
  assert.ok(l.args.includes('-Djava.library.path=C:\\n'));
  assert.equal(l.args[l.args.indexOf('--session') + 1], 'token:TOKEN:b50ad385829d3141a2167e7d7539ba7f');
  assert.ok(l.args.includes('--width'));
});

test('nativas legadas: solo la plataforma actual, extraídas y fuera del classpath', () => {
  const v = {
    id: 'x',
    mainClass: 'M',
    libraries: [
      { name: 'org.lwjgl.lwjgl:lwjgl-platform:2.9.4', natives: { linux: 'natives-linux', windows: 'natives-windows-${arch}' }, downloads: { classifiers: { 'natives-windows-64': { path: 'w64.jar', url: 'https://x/w64.jar', sha1: 'a', size: 1 } } } },
    ],
  } as unknown as VersionJson;
  const r = resolveLibraries(v, win);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.path, 'w64.jar');
  assert.equal(r[0]!.extract, true);
  assert.equal(r[0]!.classpath, false);
});

test('instancias: instalación real (vanilla), aislamiento, verificación, reparación y lanzamiento', async () => {
  const env = await servicesEnv();
  try {
    const { instances, accounts, paths } = env.services;
    const a = await instances.create({ name: 'Supervivencia', mcVersion: env.world.versionId, loader: { kind: 'vanilla' } });
    const b = await instances.create({ name: 'Creativo', mcVersion: env.world.versionId, loader: { kind: 'vanilla' } });
    assert.equal(a.primaryAction, 'install');
    const java = fakeJava(tmpDir('java-'), 21);
    await instances.update(a.id, { java: { path: java } });
    await instances.update(b.id, { java: { path: java } });

    const stages = new Set<string>();
    const off = env.services.bus.on('progress', (p) => stages.add(p.stage));
    await instances.install(a.id);
    off();
    assert.ok(stages.has('libraries') && stages.has('assets'));
    assert.equal(instances.get(a.id).installState, 'installed');
    assert.equal(instances.view(instances.get(a.id)).primaryAction, 'play');
    const clientJar = path.join(paths.versions, env.world.versionId, `${env.world.versionId}.jar`);
    assert.ok(fs.readFileSync(clientJar).equals(env.world.files.client));
    assert.equal(fs.existsSync(path.join(paths.libraries, 'w.jar')), false, 'librería de otra plataforma no descargada');

    // Verificación detecta corrupción y reparación la corrige
    fs.writeFileSync(clientJar, 'dañado');
    const v = await instances.verify(a.id);
    assert.equal(v.ok, false);
    assert.equal(instances.get(a.id).installState, 'needs-repair');
    assert.equal(instances.view(instances.get(a.id)).primaryAction, 'repair');
    const rep = await instances.repair(a.id);
    assert.ok(rep.repaired >= 1);
    assert.ok(fs.readFileSync(clientJar).equals(env.world.files.client));
    assert.equal(instances.get(a.id).installState, 'installed');

    // Lanzamiento real del proceso Java (falso) con argumentos correctos
    await assert.rejects(() => instances.launch(a.id, undefined), (e: any) => e.code === 'AUTH_EXPIRED');
    const acc = await accounts.loginMicrosoft(fakeBrowser);
    const lines: string[] = [];
    env.services.bus.on('gameLog', (e) => lines.push(...e.lines));
    await instances.launch(a.id, acc.id);
    await new Promise<void>((r) => {
      const t = setInterval(() => {
        if (!instances.isRunning(a.id)) {
          clearInterval(t);
          r();
        }
      }, 50);
    });
    const argsFile = path.join(path.dirname(path.dirname(java)), 'args.log');
    const args = fs.readFileSync(argsFile, 'utf8').split('\n');
    assert.ok(args.includes('net.minecraft.client.main.Main'));
    assert.ok(args.includes('Notch'));
    assert.equal(args[args.indexOf('--gameDir') + 1], instances.gameDir(a.id));
    assert.ok(fs.existsSync(path.join(paths.instancesDir, a.id, 'natives', 'liblwjgl.so')), 'nativas extraídas');
    assert.ok(!fs.existsSync(path.join(paths.instancesDir, a.id, 'natives', 'META-INF')), 'exclusiones respetadas');
    assert.ok(lines.some((l) => l.includes('[REDACTED]')) && !lines.join('\n').includes('MC_ACCESS_TOKEN_SECRET'), 'el token no aparece en el log del juego');
    assert.ok(instances.get(a.id).lastPlayedAt);

    // Eliminar A no afecta a B ni a los archivos compartidos
    await instances.install(b.id);
    fs.writeFileSync(path.join(instances.gameDir(b.id), 'options.txt'), 'fov:90');
    await instances.remove(a.id);
    assert.equal(fs.existsSync(path.join(paths.instancesDir, a.id)), false);
    assert.equal(fs.readFileSync(path.join(instances.gameDir(b.id), 'options.txt'), 'utf8'), 'fov:90');
    assert.ok(fs.existsSync(clientJar));
    assert.equal((await instances.verify(b.id)).ok, true);
  } finally {
    await env.close();
  }
});

test('instancias: cancelación → reanudar, Java incompatible, Java automático (Adoptium) y Fabric', async () => {
  const env = await servicesEnv();
  try {
    const { instances, settings } = env.services;
    await settings.update({ downloads: { bandwidthLimitKiB: 4 } });
    const i = await instances.create({ name: 'Lenta', mcVersion: env.world.versionId, loader: { kind: 'vanilla' } });
    const p = instances.install(i.id);
    setTimeout(() => instances.cancelTask(i.id), 300);
    await assert.rejects(() => p, (e: any) => e.code === 'CANCELLED');
    const v = instances.view(instances.get(i.id));
    assert.equal(v.primaryAction, 'resume');
    assert.equal(v.pendingResume, true);
    await settings.update({ downloads: { bandwidthLimitKiB: 0 } });

    // Java incompatible forzado
    await instances.update(i.id, { java: { path: fakeJava(tmpDir('j8-'), 8) } });
    await assert.rejects(() => instances.install(i.id), (e: any) => e.code === 'JAVA_INCOMPATIBLE');

    // Sin Java forzado: se usa uno compatible del sistema o se descarga de Adoptium (verificado por SHA-256)
    await instances.update(i.id, { java: { path: '' } });
    (env.services.java as any).candidateDirs = () => [];
    await instances.install(i.id);
    assert.equal(instances.get(i.id).installState, 'installed');
    assert.ok(env.world.mock.hits.includes('GET /adoptium/jre21.tar.gz'), 'JRE descargado de Adoptium');
    const runtimes = fs.readdirSync(env.services.paths.runtimes);
    assert.ok(runtimes.includes('java-21'));

    // Fabric: perfil oficial + librería maven verificada con su .sha1
    const f = await instances.create({ name: 'Fabric', mcVersion: env.world.versionId, loader: { kind: 'fabric' } });
    await instances.install(f.id);
    const fi = instances.get(f.id);
    assert.equal(fi.resolvedVersionId, `fabric-loader-0.16.9-${env.world.versionId}`);
    assert.ok(fs.existsSync(path.join(env.services.paths.libraries, 'net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar')));

    // Forge sin consentimiento explícito → rechazado
    await assert.rejects(() => instances.create({ name: 'Forge', mcVersion: '1.20.1', loader: { kind: 'forge' } }), (e: any) => e.code === 'VALIDATION');
  } finally {
    await env.close();
  }
});

test('exportar / importar (.unrealpack) y .mrpack con hosts no permitidos', async () => {
  const env = await servicesEnv();
  try {
    const { instances, downloader } = env.services;
    const i = await instances.create({ name: 'Mi pack', mcVersion: env.world.versionId, loader: { kind: 'fabric', version: '0.16.9' } });
    fs.mkdirSync(path.join(instances.gameDir(i.id), 'mods'), { recursive: true });
    fs.writeFileSync(path.join(instances.gameDir(i.id), 'mods', 'a.jar'), 'mod');
    fs.mkdirSync(path.join(instances.gameDir(i.id), 'logs'), { recursive: true });
    fs.writeFileSync(path.join(instances.gameDir(i.id), 'logs', 'latest.log'), 'no exportar');
    const out = path.join(tmpDir(), 'p.unrealpack');
    const r = await exportInstance(instances.get(i.id), instances.gameDir(i.id), out);
    assert.equal(r.files, 1);
    const plan = await planImport(out, downloader);
    const imported = await instances.importPack(plan);
    assert.notEqual(imported.id, i.id);
    assert.equal(imported.loader.kind, 'fabric');
    assert.equal(fs.readFileSync(path.join(instances.gameDir(imported.id), 'mods', 'a.jar'), 'utf8'), 'mod');

    // mrpack con descarga desde un host no permitido por la especificación
    const mr = path.join(tmpDir(), 'x.mrpack');
    const z = new ZipWriter(mr);
    await z.addBuffer('modrinth.index.json', Buffer.from(JSON.stringify({
      formatVersion: 1, game: 'minecraft', name: 'Pack', versionId: '1',
      dependencies: { minecraft: env.world.versionId, 'fabric-loader': '0.16.9' },
      files: [{ path: 'mods/x.jar', hashes: { sha1: 'a'.repeat(40), sha512: 'b'.repeat(128) }, downloads: ['https://evil.example.com/x.jar'], fileSize: 3 }],
    })));
    await z.addBuffer('overrides/config/a.txt', Buffer.from('cfg'));
    await z.close();
    const mrPlan = await planImport(mr, downloader);
    assert.equal(mrPlan.kind, 'mrpack');
    assert.equal(mrPlan.input.loader.kind, 'fabric');
    await assert.rejects(() => instances.importPack(mrPlan), (e: any) => e.code === 'UNTRUSTED_SOURCE');
    assert.equal(instances.all().filter((x) => x.name === 'Pack').length, 0, 'importación fallida no deja instancias a medias');
    void makeJar;
  } finally {
    await env.close();
  }
});
