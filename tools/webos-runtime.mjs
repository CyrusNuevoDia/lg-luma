// SDL in the NDK is for linking, not TV display: its Wayland backend is disabled.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, '.build/sdl-webos');
// No SDL-webOS release has the SDL_WEBOS_WINDOW_TYPE hint yet (webosbrew/SDL-webOS#19, merged
// after release-2.30.12-webos.8), which the Live TV background needs for its overlay window.
// Releases are only built when published, so build that merge commit with the NDK instead.
const commit = '50a17c0539ff26ef571cc05d7c703af59ae68332';
const filename = `SDL-webOS-${commit}.tar.gz`;
const archiveHash = 'e23567121840937f589db56afb51a1a3b54dcdab20ba8e98bddb9be8ee0f94d8';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function verifyWebosSdl(bytes) {
  if (
    bytes.length < 52 ||
    bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
    bytes[4] !== 1 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 40 ||
    bytes.readUInt16LE(16) !== 3 ||
    (bytes.readUInt32LE(36) & 0x400) !== 0
  ) {
    throw new Error('SDL runtime must be an ARM soft-float shared library.');
  }
  // These are compiled backend strings, not merely exported SDL_webOS API stubs.
  if (
    !bytes.includes(Buffer.from('SDL Wayland video driver\0')) ||
    !bytes.includes(Buffer.from('APPID environment variable is not set\0'))
  ) {
    throw new Error('SDL has no webOS Wayland video backend. Do not package the SDK stub SDL.');
  }
}

function run(command, args, timeout) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`SDL-webOS: ${command} failed.`);
}

// The flags of SDL-webOS's own release build (.github/workflows/webos.yml), standard SDL ABI.
async function build(archive) {
  const ndk = process.env.WEBOS_NDK && path.resolve(process.env.WEBOS_NDK);
  const toolchain = ndk && path.join(ndk, 'share/buildroot/toolchainfile.cmake');
  try {
    await fs.access(toolchain);
  } catch {
    throw new Error('Building SDL-webOS needs WEBOS_NDK (run pnpm sdk) and cmake.');
  }
  const source = path.join(directory, 'source');
  await fs.rm(source, { recursive: true, force: true });
  await fs.mkdir(source);
  run('tar', ['-xzf', archive, '-C', source, '--strip-components=1'], 60000);
  const output = path.join(source, 'build');
  run(
    'cmake',
    [
      '-B',
      output,
      '-S',
      source,
      `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DWEBOS=ON',
      '-DSDL_OFFSCREEN=OFF',
      '-DSDL_DISKAUDIO=OFF',
      '-DSDL_DUMMYAUDIO=OFF',
      '-DSDL_DUMMYVIDEO=OFF',
      '-DSDL_KMSDRM=OFF',
      '-DSDL_VENDOR_INFO=webOS Backport',
      '-DSDL_WEBOS_BROKEN_ABI=OFF',
    ],
    300000,
  );
  run('cmake', ['--build', output, '--config', 'Release', '--parallel'], 1200000);
  run('cmake', ['--install', output, '--prefix', directory], 120000);
}

export async function prepareWebosRuntime() {
  await fs.mkdir(directory, { recursive: true });
  const archive = path.join(directory, filename);
  let bytes;
  try {
    bytes = await fs.readFile(archive);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    console.log(`Downloading SDL-webOS ${commit} (source).`);
    const url = `https://github.com/webosbrew/SDL-webOS/archive/${commit}.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`SDL-webOS download failed: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== archiveHash) throw new Error('SDL-webOS archive checksum mismatch.');
    await fs.writeFile(archive, bytes);
  }
  if (hash(bytes) !== archiveHash) throw new Error('SDL-webOS archive checksum mismatch.');

  // The build is not reproducible bit for bit, so a stamp records which commit is installed.
  const library = path.join(directory, 'lib/libSDL2-2.0.so.0');
  const stamp = path.join(directory, 'commit');
  const built = await fs.readFile(stamp, 'utf8').catch(() => '');
  if (built !== commit || !(await fs.stat(library).catch(() => null))) {
    await fs.rm(stamp, { force: true });
    await build(archive);
    await fs.writeFile(stamp, commit);
  }
  const current = await fs.readFile(library);
  verifyWebosSdl(current);
  if (!current.includes(Buffer.from('SDL_WEBOS_WINDOW_TYPE\0'))) {
    throw new Error('SDL-webOS lacks the SDL_WEBOS_WINDOW_TYPE hint. Remove .build/sdl-webos.');
  }

  // Upstream metadata embeds /usr/local and an rpath. Generate relocatable build-host
  // lookup metadata instead; the TV executable keeps only its $ORIGIN/lib rpath.
  const pkgconfig = path.join(directory, 'pkgconfig');
  await fs.mkdir(pkgconfig, { recursive: true });
  await fs.writeFile(
    path.join(pkgconfig, 'sdl2.pc'),
    `prefix=${directory}
libdir=\${prefix}/lib
includedir=\${prefix}/include/SDL2
Name: sdl2
Description: SDL-webOS with the Wayland/webOS backend and standard SDL ABI
Version: 2.30.12
Libs: -L\${libdir} -lSDL2
Cflags: -I\${includedir} -D_REENTRANT
`,
  );
  console.log(`Verified SDL-webOS ${commit}: ARM soft-float, Wayland/webOS backend.`);
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await prepareWebosRuntime();
}
