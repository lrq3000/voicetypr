# Recreate Windows debug build outputs

`scripts/rebuild-windows-debug.cjs` is the recovery recipe for deleting Cargo's
`target/debug` directory or preparing a Windows development preview. It lives in
Git outside the generated output, so deleting the cache does not delete the recipe.

Deleting `debug` removes compiled dependencies, intermediate artifacts, test
binaries, symbols and the application executable. Cargo regenerates the required
outputs; reinstalling your development tools is normally unnecessary. Historical
unused artifact hashes do not need to be reproduced.

## Quick start

From the repository/worktree root in PowerShell:

```powershell
# Inspect all planned commands without running them or writing any files.
node scripts/rebuild-windows-debug.cjs --plan

# Restore the app and Rust test executables, including Windows test manifests.
node scripts/rebuild-windows-debug.cjs
```

Wait until deletion has finished, and close any application running from the
target build directory. Keep existing target junctions and their drives available.

For a fresh checkout with no target directory, explicitly choose storage:

```powershell
node scripts/rebuild-windows-debug.cjs --target-dir "D:\voicetypr-build\my-worktree\app-target"
```

The target selection order is `--target-dir`, `CARGO_TARGET_DIR`, then
`src-tauri/target`. Existing directories/junctions are reused. A missing explicit
target is created when building; an unavailable junction is an error. Plan mode
can inspect a missing target without creating it. This avoids silently filling
the system disk when an intended build drive is disconnected.

## Options

| Option | Purpose |
|---|---|
| `--plan` | Print decisions and commands only; no builds, subprocesses or writes. Usable off Windows too. |
| `--app-only` | Skip Rust test executables; quickest route to the runnable app. |
| `--run-tests` | Also execute generated tests with four threads after embedding their manifests. |
| `--rebuild-sidecars` | Run normal incremental CrispASR native builds after changing C++ sources, if this checkout supports CrispASR. |
| `--repo PATH` | Rebuild another checkout; otherwise use the repository containing the script. |
| `--target-dir PATH` | Choose Cargo output explicitly. |
| `--native-cache PATH` | Reuse a CrispASR source/build cache; otherwise `VOICETYPR_CRISPASR_CACHE` or `.tmp/crispasr`. |
| `--vulkan-sdk PATH` | Vulkan SDK root for CrispASR GPU recompilation. |

`--app-only` and `--run-tests` are mutually exclusive. Actual builds require
Windows x64; plan mode has no native-tool requirement.

## Baseline versus CrispASR checkouts

The helper detects the selected checkout rather than assuming every branch has
the newer integration:

- **Baseline checkout:** builds the in-process CPU-Whisper application. Normal
  bindgen needs a working libclang installation. Set `LIBCLANG_PATH` to the folder
  containing `libclang.dll` if it cannot be located normally. The helper preserves
  that setting and removes the incompatible old no-generation switch from child
  environments.
- **Checkout with the Windows shipped-bindings patch:** sets
  `WHISPER_DONT_GENERATE_BINDINGS=1` and uses its target-correct Windows snapshots,
  avoiding libclang for Whisper. `DOCS_RS` is removed from build environments so
  native compilation is not accidentally skipped.
- **CrispASR checkout:** reuses surviving CPU/Vulkan executables and notices under
  `sidecar/crispasr/dist`. Missing files or `--rebuild-sidecars` invoke the existing
  pinned-source Node/CMake helper. GPU recompilation requires the Vulkan SDK;
  1.4.363.0 was used for the verified preview. Discovery uses `--vulkan-sdk`, then
  `<native-cache>/vulkan-sdk` and `VULKAN_SDK`.

The helper does not add models/backends to a baseline branch. It does not build
the separate Whisper Vulkan executable, release installers or macOS artifacts.

### Reuse the original CrispASR worktree/cache

These are examples for the original local setup, not hardcoded requirements:

```powershell
node scripts/rebuild-windows-debug.cjs `
  --repo "C:\git\voicetypr\.worktrees\crispasr-auto" `
  --native-cache "D:\voicetypr-build\crispasr-auto" `
  --app-only
```

That worktree's `src-tauri/target` junction points to
`D:\voicetypr-build\crispasr-auto\app-target`; the extracted SDK is at
`D:\voicetypr-build\crispasr-auto\vulkan-sdk`. Keep the junction when deleting
only its `debug` contents. To inspect a native rebuild first, add
`--rebuild-sidecars --plan`.

## Build sequence and implementation

1. Reuse `node_modules`, or run `corepack pnpm install --frozen-lockfile` if the
   Tauri CLI is missing. After intentionally changing JavaScript dependencies,
   run that install command yourself before rebuilding.
2. Restore CrispASR runtimes when that checkout needs them. Native builds are
   sequential so the shared pinned source checkout is not configured concurrently.
3. Unless `--app-only` was passed, compile Rust tests with `cargo test --no-run`.
   If frontend assets are missing, prepare them first. Parse Cargo's machine-
   readable artifact output to find the current test executables, then use Windows
   SDK `mt.exe` and `src-tauri/test-manifest.xml` to embed Common-Controls support.
   `--run-tests` executes those binaries directly, following `run-tests.ps1`'s
   manifest contract without rerunning Cargo and potentially losing the manifest.
4. Run the Tauri debug/no-bundle build through its Node CLI entry point so JSON
   configuration and Cargo arguments survive Windows quoting. Tauri runs the
   frontend build and embeds the UI. Use the existing `.dev` identity and only
   the runtime assets needed by this preview. Build the application last because
   integration-test compilation can also generate a CLI executable.
5. Write `debug/Start Voicetypr.bat` and check the executable with `--version`.

The app/test-only profile overrides are `debug=0` and `opt-level=0`, as used for
the original preview; dependencies retain the project's optimization settings.
Cargo defaults to four build jobs unless `CARGO_BUILD_JOBS` is already set. This
is a development build, not a release-performance benchmark. Failed commands
stop the recipe. No clean/forced-rebuild flag is used.

## Launcher, credentials and retained files

Launch the rebuilt application through `Start Voicetypr.bat`. It sets
`VOICETYPR_API_URL=https://api.voicetypr.com/api/v1` for that process because debug
builds otherwise default to the local licensing development server. The URL is
public, and `setlocal` keeps the change scoped to the launcher. No personal API
or activation key is embedded, copied or removed; licensing behavior is unchanged.

Node, Rust/rustup (the project toolchain pin), Visual Studio C++ Build Tools,
Windows SDK and CMake remain installed when `debug` is deleted. Source code,
Cargo's downloaded source cache, `node_modules`, downloaded models, credentials
and any separately prepared redistributable ZIP are outside this rebuild target.
Recompiling dependencies takes longer than an incremental build, especially on
a USB-backed build drive. An updated ZIP is a separate packaging step after code
changes; do not distribute the entire compiler output directory.

## Validation

```powershell
node --check scripts/rebuild-windows-debug.cjs
node --test scripts/rebuild-windows-debug.node-test.cjs
node scripts/rebuild-windows-debug.cjs --plan
```

The focused tests check baseline/CrispASR planning, argument handling, test/app
ordering and absence of dry-run writes/subprocesses using disposable fixtures.
They do not perform a cold Rust/C++ build or prove microphone/GPU behavior. The
commands and manifest procedure derive from the existing Windows preview and
test workflow; hardware-dependent results require an actual build/smoke run.
