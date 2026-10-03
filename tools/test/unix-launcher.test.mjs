import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createLauncher, parseOptions, processStamp, resolveJavaHome, usage } from '../lib/unix-launcher.mjs';

const noEnv = { env: {}, home: '/users/tester' };

test('Unix options preserve defaults and support cli-proxy, repeatable repos and Foreman arguments', () => {
  const defaults = parseOptions(['launch'], noEnv);
  assert.equal(defaults.backend, 'claude');
  assert.equal(defaults.profile, 'claude');
  assert.equal(defaults.home, '/users/tester/.agentcraft');
  assert.equal(defaults.port, 7878);
  const args = ['launch', '--backend', 'cli-proxy', '--repo', '.', '--repo', '..', '--foreman-arg', '--workers', '--foreman-arg', 'kit,wren', '--no-game'];
  const options = parseOptions(args, noEnv);
  assert.equal(args[0], 'launch', 'does not consume caller arguments');
  assert.equal(options.profile, 'cli-proxy');
  assert.deepEqual(options.repo, [path.resolve('.'), path.resolve('..')]);
  assert.deepEqual(options.foremanArgs, ['--workers', 'kit,wren']);
  assert.equal(options['no-game'], true);
  assert.equal(parseOptions(['stop'], { env: { AGENTCRAFT_BACKEND: 'cli-proxy', AGENTCRAFT_PORT: '40001' } }).profile, 'cli-proxy');
  assert.equal(parseOptions(['launch', '--showcase', 'late'], noEnv).profile, 'showcase-late');
  assert.match(usage('linux'), /tools\/linux.mjs/);
  assert.match(usage('darwin'), /tools\/mac.mjs/);
});

test('Unix options reject invalid backends, profiles, missing values and ports', () => {
  for (const args of [
    ['launch', '--backend', 'bogus'], ['launch', '--profile', '../other'],
    ['launch', '--repo'], ['launch', '--port', '--no-game'],
    ['launch', '--port', '0'], ['launch', '--port', '65536'], ['launch', '--port', '1.5'],
    ['launch', '--port', '7879'], ['launch', '--showcase', 'missing'],
    ['launch', '--unknown'], ['other'],
  ]) assert.throws(() => parseOptions(args, noEnv), Error, args.join(' '));
});

function javaFixture({ jdks = {}, symlinks = {}, directories = {}, detectedMacJdk } = {}) {
  const calls = [];
  const io = {
    existsSync(file) {
      if (file === '/usr/libexec/java_home') return !!detectedMacJdk;
      const home = path.dirname(path.dirname(file));
      return !!jdks[home] && (path.basename(file) !== 'javac' || !jdks[home].jre);
    },
    realpathSync(file) { if (symlinks[file]) return symlinks[file]; throw new Error('not found'); },
    readdirSync(dir) { if (directories[dir]) return directories[dir]; throw new Error('not found'); },
  };
  const run = (command) => {
    calls.push(command);
    if (command === '/usr/libexec/java_home') return { status: 0, stdout: detectedMacJdk };
    const jdk = jdks[path.dirname(path.dirname(command))];
    return { status: jdk.status ?? 0, stderr: `openjdk version "${jdk.version}" 2026-01-01`, stdout: '' };
  };
  return { io, run, calls };
}

test('Linux Java uses JAVA_HOME first, resolving PATH alternatives when the selected Java is older', () => {
  const fixture = javaFixture({
    jdks: { '/jdk/custom': { version: '25.0.1' }, '/jdk/path': { version: '25' } },
    symlinks: { '/usr/bin/java': '/jdk/path/bin/java' },
  });
  assert.equal(resolveJavaHome({ platform: 'linux', env: { JAVA_HOME: '/jdk/custom', PATH: '/usr/bin' }, ...fixture }), '/jdk/custom');
  assert.deepEqual(fixture.calls, ['/jdk/custom/bin/java']);
  const old = javaFixture({
    jdks: { '/jdk/old': { version: '21.0.7' }, '/jdk/path': { version: '25' } },
    symlinks: { '/usr/bin/java': '/jdk/path/bin/java' },
  });
  assert.equal(resolveJavaHome({ platform: 'linux', env: { JAVA_HOME: '/jdk/old', PATH: '/usr/bin' }, ...old }), '/jdk/path');
});

test('Linux Java searches common JDK directories and SDKMAN without accepting a JRE', () => {
  const fixture = javaFixture({
    jdks: { '/usr/lib/jvm/java-25-jre': { version: '25', jre: true }, '/home/me/.sdkman/candidates/java/25-tem': { version: '25.0.2' } },
    directories: { '/usr/lib/jvm': ['java-25-jre'], '/home/me/.sdkman/candidates/java': ['25-tem'] },
  });
  assert.equal(resolveJavaHome({ platform: 'linux', env: {}, home: '/home/me', ...fixture }), '/home/me/.sdkman/candidates/java/25-tem');
  assert.deepEqual(fixture.calls, ['/home/me/.sdkman/candidates/java/25-tem/bin/java']);
});

test('macOS Java preserves Homebrew discovery and supports system Java home', () => {
  const homebrew = '/opt/homebrew/opt/openjdk@25/libexec/openjdk.jdk/Contents/Home';
  assert.equal(resolveJavaHome({ platform: 'darwin', env: {}, ...javaFixture({ jdks: { [homebrew]: { version: '25' } } }) }), homebrew);
  const system = '/Library/Java/JavaVirtualMachines/jdk-25.jdk/Contents/Home';
  assert.equal(resolveJavaHome({ platform: 'darwin', env: {}, ...javaFixture({ jdks: { [system]: { version: '25' } }, detectedMacJdk: system }) }), system);
});

test('Java errors explain Linux headless mode and reject failed or wrong-version binaries', () => {
  const fixture = javaFixture({ jdks: { '/bad': { version: '25', status: 1 }, '/wrong': { version: '250' } }, symlinks: { '/bin/java': '/wrong/bin/java' } });
  assert.throws(() => resolveJavaHome({ platform: 'linux', env: { JAVA_HOME: '/bad', PATH: '/bin' }, ...fixture }), /Java 25 JDK.*--no-game/);
});

test('Linux process identity parses command parentheses, boot ID and start ticks; excludes zombies', () => {
  const fields = Array(20).fill('0');
  fields[0] = 'S';
  fields[19] = '1234567';
  const io = { readFileSync: (file) => file.endsWith('boot_id') ? 'test-boot\n' : `34 (worker ) name) ${fields.join(' ')}\n` };
  assert.equal(processStamp(34, 'linux', { io }), 'test-boot:1234567');
  fields[0] = 'Z';
  assert.equal(processStamp(34, 'linux', { io }), null);
  assert.equal(processStamp(-1, 'linux', { io }), null);
  assert.equal(processStamp(34, 'linux', { io: { readFileSync() { throw new Error('gone'); } } }), null);
  assert.equal(processStamp(34, 'darwin', { run: () => ({ status: 0, stdout: ' Sat Oct 3 10:00:00 2026 \n' }) }), 'Sat Oct 3 10:00:00 2026');
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function write(root, file, text) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

// No real dependencies, API calls, Gradle or desktop game are run. This local TCP
// fixture exercises actual detached-process startup, reuse and signal ownership.
test('headless Linux launch passes cli-proxy arguments, reuses the process and stops only an owned PID', { skip: process.platform !== 'linux', timeout: 15000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcraft-launcher-'));
  const recordFile = path.join(root, 'artifacts/run/linux-foreman-cli-proxy.json');
  let info;
  t.after(() => {
    if (info && processStamp(info.pid) === info.stamp) {
      try { process.kill(-info.pid, 'SIGKILL'); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  write(root, 'foreman/package.json', '{"type":"module"}');
  write(root, 'foreman/package-lock.json', '{}');
  write(root, 'foreman/node_modules/.package-lock.json', '{}');
  write(root, 'foreman/node_modules/tsx/package.json', '{"type":"module","exports":"./index.mjs"}');
  write(root, 'foreman/node_modules/tsx/index.mjs', `import { register } from 'node:module'; register('./loader.mjs', import.meta.url);`);
  write(root, 'foreman/node_modules/tsx/loader.mjs', `import fs from 'node:fs/promises'; export async function load(url, context, nextLoad) { if (url.endsWith('.ts')) return { format: 'module', source: await fs.readFile(new URL(url), 'utf8'), shortCircuit: true }; return nextLoad(url, context); }`);
  write(root, 'foreman/src/main.ts', `
    import fs from 'node:fs'; import net from 'node:net';
    const argv = process.argv.slice(2);
    fs.writeFileSync('received.json', JSON.stringify(argv));
    const server = net.createServer((socket) => socket.end());
    server.listen(Number(argv[argv.indexOf('--port') + 1]), '127.0.0.1');
    process.on('SIGTERM', () => server.close(() => process.exit(0)));
  `);
  const launcher = createLauncher({ root, platform: 'linux' });
  const port = await freePort();
  const devPort = port === 7879 ? 7880 : 7879;
  const options = parseOptions(['launch', '--no-game', '--backend', 'cli-proxy', '--dev', '--port', String(port), '--dev-port', String(devPort), '--home', path.join(root, 'state'), '--foreman-arg', '--model', '--foreman-arg', 'local-model']);
  const summary = { foreman: { started: false }, game: { started: false } };
  await launcher.launch(options, summary);
  info = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
  assert.equal(summary.foreman.started, true);
  assert.equal(summary.foreman.pid, info.pid);
  assert.equal(summary.game.started, false);
  assert.equal(fs.existsSync(path.join(root, 'tools')), false, 'headless mode does not install game/tool dependencies');
  assert.equal(fs.existsSync(path.join(root, 'mod')), false, 'headless mode does not run Gradle');
  const received = JSON.parse(fs.readFileSync(path.join(root, 'foreman/received.json'), 'utf8'));
  assert.equal(received[received.indexOf('--backend') + 1], 'cli-proxy');
  assert.ok(received.includes('--no-notify'));
  assert.deepEqual(received.slice(-2), ['--model', 'local-model']);

  const reuse = { foreman: { started: false }, game: { started: false } };
  await launcher.launch(options, reuse);
  assert.equal(reuse.foreman.started, false);
  assert.equal(reuse.foreman.pid, info.pid);

  fs.writeFileSync(recordFile, JSON.stringify({ ...info, stamp: 'not-this-process' }));
  await launcher.stop({ ...options, foreman: true });
  assert.equal(processStamp(info.pid), info.stamp, 'stale PID identity must never be signalled');
  fs.writeFileSync(recordFile, JSON.stringify(info));
  await launcher.stop({ ...options, foreman: true });
  assert.equal(processStamp(info.pid), null);
  assert.equal(fs.existsSync(recordFile), false);
});
