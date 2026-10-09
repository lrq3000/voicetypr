#!/usr/bin/env node
'use strict';

// Recover development outputs without cleaning, changing source/Git state, or
// copying credentials/models. --plan is also usable off Windows and never runs
// commands or writes files. See docs/REBUILD-WINDOWS-DEBUG.md.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');

class WindowsDebugRebuilder {
  constructor() {
    this.options = parseArgs({ options: {
      help: { type: 'boolean', short: 'h' },
      plan: { type: 'boolean' },
      'app-only': { type: 'boolean' },
      'run-tests': { type: 'boolean' },
      'rebuild-sidecars': { type: 'boolean' },
      repo: { type: 'string' },
      'target-dir': { type: 'string' },
      'native-cache': { type: 'string' },
      'vulkan-sdk': { type: 'string' },
    } }).values;
    this.root = path.resolve(this.options.repo || path.join(__dirname, '..'));
    this.tauri = path.join(this.root, 'src-tauri');
    this.explicitTarget = this.options['target-dir'] || process.env.CARGO_TARGET_DIR;
    this.target = path.resolve(this.explicitTarget || path.join(this.tauri, 'target'));
    this.nativeCache = path.resolve(this.options['native-cache'] ||
      process.env.VOICETYPR_CRISPASR_CACHE || path.join(this.root, '.tmp', 'crispasr'));
    this.crispasrBuilder = path.join(this.root, 'scripts/build-crispasr-sidecar.mjs');
    this.hasCrispasr = fs.existsSync(this.crispasrBuilder);
    this.hasShippedBindings = fs.existsSync(path.join(this.tauri,
      'vendor/whisper-rs-sys/bindings/x86_64-pc-windows-msvc.rs'));
    this.env = { ...process.env,
      CARGO_TARGET_DIR: this.target,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '4',
      CARGO_TERM_COLOR: 'never',
    };
    delete this.env.DOCS_RS;
    delete this.env.TAURI_CONFIG;
    // Older checkouts have Linux-only pre-generated bindings. Their normal
    // bindgen path needs libclang; enabling the newer switch there breaks ABI.
    if (this.hasShippedBindings) {
      this.env.WHISPER_DONT_GENERATE_BINDINGS = '1';
      this.env.LIBCLANG_PATH = path.join(this.root, '.tmp', 'no-libclang');
    } else {
      delete this.env.WHISPER_DONT_GENERATE_BINDINGS;
    }
  }

  help() {
    console.log(`Rebuild a Windows x64 development application and test executables.

Usage: node scripts/rebuild-windows-debug.cjs [options]

Default: restore prerequisites as needed, build/manifest Rust test executables,
         build the embedded-frontend app, and write Start Voicetypr.bat.

  --plan                 Print decisions/commands without running or writing
  --app-only             Omit Rust test executables (quicker app-only rebuild)
  --run-tests            Also run generated tests with four threads
  --rebuild-sidecars     Incrementally rebuild CrispASR if that checkout has it
  --repo PATH            Checkout to rebuild (default: the script's repository)
  --target-dir PATH      Explicit Cargo output, created if needed; respects
                         CARGO_TARGET_DIR, otherwise uses src-tauri/target
  --native-cache PATH    CrispASR source/build cache; alternatively set
                         VOICETYPR_CRISPASR_CACHE (default: .tmp/crispasr)
  --vulkan-sdk PATH      SDK root when native GPU recompilation is necessary

Preserve existing target junctions. For a fresh checkout, choose --target-dir
explicitly before creating a large build. Close the target/debug app first.
The baseline checkout builds CPU Whisper; CrispASR is included when implemented
in the selected checkout. The separate Whisper Vulkan executable is not built.
`);
  }

  check() {
    if (!this.options.plan && (process.platform !== 'win32' || process.arch !== 'x64')) {
      throw new Error('Actual builds require Windows x64. Use --plan to inspect elsewhere.');
    }
    if (this.options['app-only'] && this.options['run-tests']) {
      throw new Error('--app-only and --run-tests cannot be combined.');
    }
    for (const relative of ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.dev.conf.json',
      'src-tauri/test-manifest.xml']) {
      if (!fs.existsSync(path.join(this.root, relative))) throw new Error(`Missing project file: ${relative}`);
    }
    if (!fs.existsSync(this.target)) {
      if (fs.lstatSync(this.target, { throwIfNoEntry: false })?.isSymbolicLink()) {
        throw new Error('The target junction is unavailable. Reconnect its drive before rebuilding.');
      }
      if (!this.explicitTarget && !this.options.plan) {
        throw new Error('No existing src-tauri/target. Choose --target-dir explicitly to control build storage.');
      }
    } else if (!fs.statSync(this.target).isDirectory()) {
      throw new Error('Cargo target path is not a directory.');
    }
    this.version = JSON.parse(fs.readFileSync(path.join(this.root, 'package.json'), 'utf8')).version;
    this.needsSidecars = this.hasCrispasr && (this.options['rebuild-sidecars'] || [
      'crispasr-sidecar-cpu-x86_64-pc-windows-msvc.exe',
      'crispasr-sidecar-gpu-x86_64-pc-windows-msvc.exe', 'CrispASR-LICENSE', 'ggml-LICENSE',
    ].some(name => !fs.existsSync(path.join(this.root, 'sidecar/crispasr/dist', name))));
    if (this.needsSidecars) this.configureVulkan();
    if (!this.options['app-only'] && !this.options.plan) this.mt = this.findManifestTool();
    if (!this.options.plan) {
      const executable = path.join(this.target, 'debug', 'voicetypr.exe');
      if (fs.existsSync(executable)) {
        try { const handle = fs.openSync(executable, 'r+'); fs.closeSync(handle); }
        catch { throw new Error('Cannot replace target/debug/voicetypr.exe. Exit that instance and check file permissions.'); }
      }
      fs.mkdirSync(this.target, { recursive: true });
    }
    const output = fs.existsSync(this.target) ? fs.realpathSync(this.target) : `${this.target} (not created)`;
    console.log(`Repository: ${this.root}\nBuild output: ${output}\nCargo jobs: ${this.env.CARGO_BUILD_JOBS}`);
    console.log(this.hasShippedBindings ? 'Whisper: target-correct shipped Windows bindings.' :
      'Whisper: normal bindgen; a working libclang installation is required (LIBCLANG_PATH is preserved).');
  }

  configureVulkan() {
    const candidates = this.options['vulkan-sdk'] ? [this.options['vulkan-sdk']] :
      [path.join(this.nativeCache, 'vulkan-sdk'), process.env.VULKAN_SDK].filter(Boolean);
    const sdk = candidates.find(folder => fs.existsSync(path.join(folder, 'Bin', 'glslc.exe')));
    if (!sdk) {
      if (this.options.plan) {
        console.log('GPU rebuild prerequisite: set VULKAN_SDK or --vulkan-sdk (1.4.363.0 was verified).');
        return;
      }
      throw new Error('Native runtimes need rebuilding. Set VULKAN_SDK or --vulkan-sdk to the Vulkan SDK root.');
    }
    this.env.VULKAN_SDK = path.resolve(sdk);
    const pathKeys = Object.keys(this.env).filter(key => key.toUpperCase() === 'PATH');
    const searchPath = this.env[pathKeys[0]] || '';
    for (const key of pathKeys) delete this.env[key];
    this.env.PATH = path.join(this.env.VULKAN_SDK, 'Bin') + path.delimiter + searchPath;
  }

  findManifestTool() {
    const base = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
    if (fs.existsSync(base)) {
      const versions = fs.readdirSync(base).filter(name => /^\d+\.\d+\.\d+\.\d+$/.test(name))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        const tool = path.join(base, version, 'x64', 'mt.exe');
        if (fs.existsSync(tool)) return tool;
      }
    }
    throw new Error('Windows SDK mt.exe is required for test executables. Install the SDK/C++ Build Tools, or use --app-only.');
  }

  run(label, executable, args, { cwd = this.root, env = this.env, capture = false } = {}) {
    console.log(`\n[${label}]\n${[executable, ...args].map(value => JSON.stringify(value)).join(' ')}`);
    if (this.options.plan) return '';
    const result = spawnSync(executable, args, {
      cwd, env, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      maxBuffer: 128 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status}, signal ${result.signal || 'none'}). Resolve that failure before retrying.`);
    return result.stdout || '';
  }

  dependencies() {
    this.cli = path.join(this.root, 'node_modules/@tauri-apps/cli/tauri.js');
    if (!fs.existsSync(this.cli)) {
      // Only a fixed command goes through cmd.exe; build paths and JSON below
      // are passed as argv, avoiding pnpm's handling of the -- separator.
      this.run('Restore JavaScript dependencies', process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'corepack pnpm install --frozen-lockfile']);
    } else {
      console.log('Reusing node_modules. Run corepack pnpm install --frozen-lockfile if dependencies change.');
    }
    if (!this.hasCrispasr) {
      console.log('This checkout has no CrispASR integration; preparing the CPU-Whisper preview.');
      return;
    }
    if (!this.needsSidecars) {
      console.log('Reusing sidecar/crispasr/dist runtimes and notices.');
      return;
    }
    for (const variant of ['cpu', 'gpu']) {
      this.run(`Build CrispASR ${variant}`, process.execPath, [
        this.crispasrBuilder, '--variant', variant,
        '--source', path.join(this.nativeCache, 'crispasr-source'),
        '--build-dir', path.join(this.nativeCache, `crispasr-native-${variant}`),
        '--target', 'x86_64-pc-windows-msvc',
      ]);
    }
  }

  tests() {
    if (this.options['app-only']) return;
    if (!fs.existsSync(path.join(this.root, 'dist', 'index.html'))) {
      this.run('Prepare frontend assets for Tauri tests', process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', 'pnpm build']);
    }
    // Follow run-tests.ps1's build -> manifest -> direct execution contract, but
    // discover only current executables from Cargo instead of guessing hashes.
    const env = { ...this.env, TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [], resources: [] } }) };
    const output = this.run('Build Rust test executables', 'cargo', [
      'test', '--no-run', '--message-format=json-render-diagnostics',
      '--config', 'profile.test.package.voicetypr.debug=0',
      '--config', 'profile.test.package.voicetypr.opt-level=0',
    ], { cwd: this.tauri, env, capture: true });
    if (this.options.plan) {
      console.log('Then embed src-tauri/test-manifest.xml with mt.exe into each test executable reported by Cargo.');
      if (this.options['run-tests']) console.log('Then execute those test binaries directly with --quiet --test-threads=4.');
      return;
    }
    const executables = new Set();
    for (const line of output.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      if (item.reason === 'compiler-artifact' && item.profile?.test && item.executable) executables.add(item.executable);
    }
    if (!executables.size) throw new Error('Cargo reported no test executables; test restoration is unverified.');
    for (const executable of executables) {
      this.run('Embed Windows test manifest', this.mt, ['-nologo', '-manifest',
        path.join(this.tauri, 'test-manifest.xml'), `-outputresource:${executable};1`]);
      if (this.options['run-tests']) this.run('Run Rust tests', executable,
        ['--quiet', '--test-threads=4'], { cwd: this.tauri, env });
    }
  }

  application() {
    // An unbundled dev preview needs neither installer resources nor the separate
    // Whisper Vulkan executable. CrispASR assets are included only if supported.
    const bundle = this.hasCrispasr ? {
      externalBin: ['../sidecar/crispasr/dist/crispasr-sidecar-cpu', '../sidecar/crispasr/dist/crispasr-sidecar-gpu'],
      resources: ['../sidecar/crispasr/dist/CrispASR-LICENSE', '../sidecar/crispasr/dist/ggml-LICENSE'],
    } : { externalBin: [], resources: [] };
    this.run('Build Windows preview', process.execPath, [this.cli,
      'build', '--debug', '--no-bundle', '--config', 'src-tauri/tauri.dev.conf.json',
      '--config', JSON.stringify({ version: this.version, bundle }), '--',
      '--config', 'profile.dev.package.voicetypr.debug=0',
      '--config', 'profile.dev.package.voicetypr.opt-level=0', '--message-format=short',
    ]);
    const launcher = path.join(this.target, 'debug', 'Start Voicetypr.bat');
    if (this.options.plan) {
      console.log(`Then write the per-launch API-URL batch file: ${launcher}`);
      return;
    }
    fs.writeFileSync(launcher, [
      '@echo off', 'setlocal', 'set "VOICETYPR_API_URL=https://api.voicetypr.com/api/v1"',
      'pushd "%~dp0"', '"%~dp0voicetypr.exe" %*', 'set "VOICETYPR_EXIT_CODE=%errorlevel%"',
      'popd', 'exit /b %VOICETYPR_EXIT_CODE%', '',
    ].join('\r\n'), 'ascii');
    this.run('Verify executable startup', path.join(this.target, 'debug', 'voicetypr.exe'), ['--version']);
    console.log(`\nReady: ${launcher}`);
  }

  execute() {
    if (this.options.help) return this.help();
    this.check();
    this.dependencies();
    // Integration tests can build a normal CLI binary too. Build the preview
    // last so its embedded UI and dev configuration own the final executable.
    this.tests();
    this.application();
    console.log(this.options.plan ? '\nPlan only: no commands were executed and no files were written.' : '\nRequested rebuild steps completed.');
  }
}

try { new WindowsDebugRebuilder().execute(); }
catch (error) { console.error(`[rebuild] ${error.message}`); process.exitCode = 1; }
