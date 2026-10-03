# CrispASR and Auto language Implementation Plan

> **For agentic workers:** Use `executing-plans` inline, as approved by the founder.
> Implement each task with focused red/green checks and a conventional commit.

**Goal:** Ship the three approved quantized local models, background recognition,
and an end-to-end Auto spoken-language choice.

**Architecture:** A persistent C++ CrispASR sidecar owns native inference. Rust
owns model management, process lifecycle and generation-keyed stream results;
React and native menus reuse the existing model and language surfaces.

**Tech Stack:** Tauri 2, Rust 1.91.1, React 19/TypeScript, C++17/CMake,
CrispASR v0.8.41 at `340d7085eaa53c40a46dcb73a6d3d0448a480006`.

---

## Task 1 — Auto language as a spoken-language capability

Files: `src-tauri/src/whisper/languages.rs`,
`src-tauri/src/commands/settings.rs`, `src-tauri/src/menu/languages.rs`,
`src-tauri/src/whisper/transcriber.rs`,
`sidecar/whisper-vulkan/src/main.rs`, `src-tauri/src/transcription.rs`,
`src-tauri/src/writing/pipeline.rs`, `src/components/LanguageSelection.tsx`,
and colocated tests. Keep translation-target language lists separate.

- [ ] Add tests for Auto selection, supported-language filtering, English-only
  models and explicit-language-only Cohere. In native tests assert:
  ```rust
  assert_eq!(normalize_speech_language_for_model("whisper", "base", "auto"), "auto");
  assert_eq!(normalize_speech_language_for_model("whisper", "base.en", "auto"), "en");
  assert_eq!(TranscriptionTask::Transcribe.fallback_transcript_language(Some("auto")), None);
  ```
- [ ] Run focused tests and confirm the absent Auto behavior is the failure.
- [ ] Preserve `auto` in spoken settings, normalize it to an unconstrained
  engine request, and pass `Some("")` to Whisper's `FullParams::set_language`.
  Use `WhisperState::full_lang_id_from_state()` (verify the pinned binding's
  spelling before use) for detected-language metadata, without another model
  pass. Missing settings keep the existing English default.
- [ ] Add Auto to the selector and native menu capability paths; never add it
  to the shared list used for explicit output-language selection. Keep unknown
  transcript output language as `same_as_transcript` in the writing pipeline.
- [ ] Run `pnpm exec vitest run src/components/LanguageSelection.test.tsx`,
  `pnpm typecheck`, and focused Windows language tests with `run-tests.ps1`.
- [ ] Commit `feat(language): support automatic spoken-language detection`.

## Task 2 — Reproducible native sidecar and protocol

Create `sidecar/crispasr/CMakeLists.txt`, `sidecar/crispasr/src/main.cpp`,
`sidecar/crispasr/src/session.{h,cpp}`, `sidecar/crispasr/tests/`,
`scripts/build-crispasr-sidecar.mjs`, and `sidecar/crispasr/README.md`.

- [ ] Add a protocol harness that sends `status`, an invalid model load, a
  stale stream command, and `shutdown`; assert typed responses and clean exit.
  The harness must reject missing executable/invalid JSON as a failed check,
  not as a skipped success.
- [ ] Build from the pinned upstream source and its pinned ggml dependency.
  Keep only the required adapters in the executable where upstream's link
  structure permits. Build CPU first; add Metal/Vulkan configurations.
- [ ] Implement an owning session class around `CrispasrBackend`:
  ```cpp
  std::unique_ptr<CrispasrBackend> backend;
  std::unique_ptr<CrispasrRealtimeSession> stream;
  ```
  Serialize backend access, reuse matching loaded models, explicitly warm,
  and destroy stream state before unloading the backend.
- [ ] Implement versioned JSON commands and structured errors. Require request
  and session identities; validate PCM size/rate and model paths. Keep stdout
  protocol-only and suppress native payload-bearing diagnostics.
- [ ] Run CTest and the protocol harness against the built CPU executable.
- [ ] Commit `feat(crispasr): add persistent native inference sidecar`.

## Task 3 — Catalog, downloads and Rust process client

Create `src-tauri/src/crispasr/{mod,models,messages,manager,sidecar}.rs`.
Modify `src-tauri/src/lib.rs`, `src-tauri/src/commands/model.rs`,
`src-tauri/src/commands/settings.rs`, `src/types.ts`, and model lifecycle tests.

- [ ] Test the three catalog identities, distinct sizes/checksums, language
  sets, and downloaded-state handling for missing/partial files.
- [ ] Pin the HF model revisions and SHA-256s recorded by the upstream tree
  APIs. Use a streaming download and digest, with rename only after validation.
- [ ] Test protocol IDs, cancellation, timeout and process death using a
  committed deterministic fixture process. Implement the client with
  `tokio::process`, bounded requests, `kill_on_drop` and lazy restart.
- [ ] Register `CrispasrManager` as managed app state, route local lifecycle
  commands to it, and reuse existing progress/error events and UI model rows.
- [ ] Route preload on selection through the manager and unload on shutdown
  without disturbing the existing Whisper/remote/media/analytics teardown order.
- [ ] Run focused native lifecycle tests, model-management Vitest and typecheck.
- [ ] Commit `feat(models): add Ultra Q8 and quantized R2T2 catalog`.

## Task 4 — Shared batch execution and capability integration

Modify `src-tauri/src/provider_capabilities.rs`,
`src-tauri/src/transcription/{engines,executor,stream}.rs`,
`src-tauri/src/commands/audio.rs`, `src-tauri/src/cli.rs`,
`src-tauri/src/menu/`, `src-tauri/src/pill/`, and readiness/model consumers.

- [ ] Add dispatch and capability truth-table cases for `crispasr`.
- [ ] Reject unsupported translate tasks and retain model-specific language
  sets. Convert native segments/timestamps to `TranscriptionResult` and leave
  missing language/timestamps unknown rather than fabricating values.
- [ ] Route desktop, uploads and CLI through the same manager. Prepare mono
  16 kHz input without copying Whisper-only gain/trim/decode parameters.
- [ ] Test model selection, command routing, unknown model and missing runtime
  errors, and native menu/readiness behavior.
- [ ] Run focused executor/model tests and frontend model/readiness tests.
- [ ] Commit `feat(transcription): route CrispASR local recognition`.

## Task 5 — Background streams and final authority

Create `src-tauri/src/crispasr/{stream,final_result}.rs`; extend native session
tests and sidecar handling. Keep wiring in `commands/audio.rs` small by
placing the new sink/factory and result lifecycle in the engine module.

- [ ] Test final-result admission by generation, model, language, complete
  sample coverage and no dropped frames; test cancellation and stale results.
- [ ] Feed the existing stream tap through the streaming resampler, including
  `finish()` at stop. Bound ingress to 5 s and retained stream audio to 120 s.
- [ ] Implement Parakeet context-preserving preview scheduling with one active
  decode, conservative stable prefixes and a replaceable tail. Finalize once
  over complete audio and deliver that result through the handoff.
- [ ] Use upstream `create_realtime_session` / `append(..., flush, callback)`
  for R2T2. Keep upstream prefix rollback and language semantics. A valid final
  bypasses batch; invalid/incomplete sessions use complete-file fallback.
- [ ] Wire background processing independently of preview visibility. Keep
  final inference outside recorder join deadlines and cancel stale work.
- [ ] Run ordered-audio, overflow, cancellation, final-authority and boundary
  tests, followed by a real-speech sidecar stream smoke.
- [ ] Commit `perf(crispasr): decode during capture and reuse complete stream finals`.

## Task 6 — Packaging and final evidence

Files: `src-tauri/tauri.{macos,windows}.conf.json`, relevant build/CI workflow
steps, `docs/ARCHITECTURE.md`, `plans/SMOKE.md`, the real-speech harness under
`scripts/`, and this plan's completion notes.

- [ ] Stage target-qualified sidecars and required runtime libraries through
  the Node build helper; verify CPU fallback does not require a Vulkan driver.
- [ ] Run `pnpm typecheck`, `pnpm lint`, focused/full relevant Vitest, Windows
  backend tests, `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --check`, and native CTest without forced clean rebuilds.
- [ ] Run the committed harness on redistributable real speech for every model
  available locally. Record load, first partial, stop-to-final, WER/text and
  stream-vs-batch differences. Record unavailable hardware as `NEEDS-SMOKE`.
- [ ] Inspect final diff, privacy of diagnostics, source pins, and build
  outputs; commit the packaging and verification evidence.

## Execution notes

- 2026-10-04: 43 baseline frontend tests pass across model preview controls,
  island quick settings and settings persistence. Existing Vite config warning
  and the expected rejected-settings test diagnostic are present at baseline.
- Windows environment has Node 24.12.0, pnpm 11.8.0, Rust 1.91.1, CMake 4.4.3
  and Visual Studio 18 Build Tools. Native tools still need environment setup.
