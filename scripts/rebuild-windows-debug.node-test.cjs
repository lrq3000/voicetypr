'use strict';
// Contract tests use disposable checkouts and an empty PATH. A plan that tries
// to install/build anything fails instead of accidentally invoking a toolchain.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'rebuild-windows-debug.cjs');

class CheckoutFixture {
  constructor(t, crispasr = false) {
    this.parent = fs.mkdtempSync(path.join(os.tmpdir(), 'voicetypr-rebuild-'));
    this.root = path.join(this.parent, 'checkout with spaces');
    t.after(() => fs.rmSync(this.parent, { recursive: true, force: true }));
    for (const [name, text] of [
      ['package.json', '{"version":"2.0.7"}'],
      ['src-tauri/Cargo.toml', '[package]\nname = "voicetypr"'],
      ['src-tauri/tauri.dev.conf.json', '{}'],
      ['src-tauri/test-manifest.xml', '<assembly/>'],
    ]) this.write(name, text);
    if (crispasr) {
      this.write('scripts/build-crispasr-sidecar.mjs', '// fixture; never executed');
      this.write('src-tauri/vendor/whisper-rs-sys/bindings/x86_64-pc-windows-msvc.rs', '// fixture');
    }
  }
  write(name, text) {
    const file = path.join(this.root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  files() {
    return fs.readdirSync(this.root, { recursive: true }).sort();
  }
  run(...args) {
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.toUpperCase() === 'PATH' || ['CARGO_TARGET_DIR', 'VOICETYPR_CRISPASR_CACHE', 'VULKAN_SDK'].includes(key)) delete env[key];
    }
    env.PATH = '';
    return spawnSync(process.execPath, [script, '--repo', this.root, ...args], {
      cwd: this.parent, env, encoding: 'utf8', timeout: 10_000,
    });
  }
}

test('baseline plan works without native tools, a target folder or CrispASR', t => {
  const fixture = new CheckoutFixture(t);
  const before = fixture.files();
  const result = fixture.run('--plan');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /normal bindgen/);
  assert.doesNotMatch(result.stdout, /\[Build CrispASR/);
  assert.ok(result.stdout.includes(JSON.stringify(JSON.stringify({ version: '2.0.7', bundle: { externalBin: [], resources: [] } }))));
  assert.ok(result.stdout.indexOf('[Build Rust test executables]') < result.stdout.indexOf('[Build Windows preview]'));
  assert.match(result.stdout, /embed src-tauri\/test-manifest.xml/);
  assert.deepEqual(fixture.files(), before);
});

test('CrispASR plan selects shipped bindings and plans both variants without requiring an SDK', t => {
  const fixture = new CheckoutFixture(t, true);
  const before = fixture.files();
  const target = path.join(fixture.parent, 'chosen output');
  const result = fixture.run('--plan', '--run-tests', '--target-dir', target);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /target-correct shipped Windows bindings/);
  assert.match(result.stdout, /\[Build CrispASR cpu\]/);
  assert.match(result.stdout, /\[Build CrispASR gpu\]/);
  assert.match(result.stdout, /--test-threads=4/);
  assert.ok(result.stdout.includes(target));
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fixture.files(), before);
});

test('app-only plan reuses native assets and omits test linking; explicit rebuild restores native steps', t => {
  const fixture = new CheckoutFixture(t, true);
  for (const name of ['crispasr-sidecar-cpu-x86_64-pc-windows-msvc.exe',
    'crispasr-sidecar-gpu-x86_64-pc-windows-msvc.exe', 'CrispASR-LICENSE', 'ggml-LICENSE']) {
    fixture.write(`sidecar/crispasr/dist/${name}`, 'fixture');
  }
  const result = fixture.run('--plan', '--app-only');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\[Build CrispASR|\[Build Rust test executables/);
  assert.match(result.stdout, /Start Voicetypr\.bat/);
  const rebuild = fixture.run('--plan', '--app-only', '--rebuild-sidecars');
  assert.equal(rebuild.status, 0, rebuild.stderr);
  assert.match(rebuild.stdout, /\[Build CrispASR gpu\]/);
});

test('conflicting options fail before making changes', t => {
  const fixture = new CheckoutFixture(t);
  const before = fixture.files();
  const result = fixture.run('--plan', '--app-only', '--run-tests');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/);
  assert.deepEqual(fixture.files(), before);
});
