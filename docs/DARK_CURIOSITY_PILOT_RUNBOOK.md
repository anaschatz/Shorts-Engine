# Dark Curiosity Pilot Runbook

This runbook executes one operator-controlled Dark Curiosity fixture through the existing narrated pipeline. It does not publish media and cannot mark an output publishable.

## 1. Readiness-only proof

Run this first. It validates the allowlisted fixture, FFmpeg/FFprobe, the narrated renderer, managed storage, the local Faster-Whisper model, narration availability, and rights confirmation without creating a project or render:

```bash
npm run dark-curiosity:pilot -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --report-only
```

The safe report is written atomically under `demo/dark-curiosity-pilot-results/`. A timestamped record and `latest.json` are produced. Reports contain artifact IDs and hashes only; they never contain input/output paths, storage keys, raw transcripts, provider output, commands, or secrets.

## 2. Diagnose and bootstrap the local aligner

Run the bounded doctor first:

```bash
npm run dark-curiosity:aligner:doctor
```

The supported CPU profile is Python 3.9–3.12, `faster-whisper==1.2.0`, `ctranslate2==4.6.0`, model `base`, device `cpu`, compute type `int8`. Package versions are locked in `requirements-dark-curiosity-aligner.txt`; model identity is configured separately.

The bootstrap command is a no-mutation dry run by default:

```bash
npm run dark-curiosity:aligner:bootstrap -- --dry-run
```

Package installation and model acquisition are separate network-capable operations. Each requires its explicit flag and `--yes`; neither is run by the normal pilot. They use `.venv-dark-curiosity`, never `sudo` or a global Python install. Only allowlisted `tiny`, `base`, and `small` models are accepted. Example operator-authorized commands are:

```bash
npm run dark-curiosity:aligner:bootstrap -- --install-package --yes
npm run dark-curiosity:aligner:bootstrap -- --download-model --model base --device cpu --compute-type int8 --yes
```

Do not run these commands when network or sandbox policy does not authorize them. Fix the external environment and rerun doctor instead.

## 3. Prepare authorized narration

Generate the exact operator-only recording package:

```bash
npm run dark-curiosity:narration:prepare -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json
```

The generated package is explicitly non-publishable. It contains only the approved spoken script, ordered beats, technical WAV constraints, and rights/consent checklist—not article bodies or source excerpts.

Record the exact `spokenText` sequence of the approved fixture script. Do not paraphrase, omit, reorder, or add words. Supply one local WAV with:

- RIFF/WAVE container;
- one PCM audio stream;
- 48 kHz sample rate;
- mono or stereo channels;
- duration greater than one second and no more than 120 seconds;
- maximum size 32 MiB;
- commercial-use rights controlled by the operator.

The engine supports either an authorized human recording or provenance-bound AI narration. The operator must explicitly confirm rights in both paths. The `mock` TTS provider is test-only and is permanently blocked from release.

### 3A. Generate free local AI narration with Kokoro

Kokoro is the default production TTS path. It requires no API key, account, billing, or runtime network access. The pinned `kokoro-onnx==0.5.0` wrapper is MIT-licensed and the Kokoro-82M v1.0 model is Apache-2.0. Runtime, model, and voice files are isolated under `.venv-kokoro` and managed ignored storage.

Bootstrap is explicit and separated into package and model operations:

```bash
npm run dark-curiosity:kokoro:bootstrap -- --dry-run
npm run dark-curiosity:kokoro:bootstrap -- --install-package --yes
npm run dark-curiosity:kokoro:bootstrap -- --download-model --yes
npm run dark-curiosity:kokoro:doctor
```

The doctor must report package, helper, model, and voices `ready`. Downloads are checked against pinned byte sizes and SHA-256 hashes before becoming active.

Generate the approved narration locally:

```bash
npm run dark-curiosity:tts:synthesize -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --project demo/dark-curiosity-ai-narration \
  --provider kokoro_local \
  --model kokoro-v1.0-onnx-f32 \
  --voice af_heart \
  --commercial-use-attested \
  --attested-by local_operator \
  --json
```

`kokoro_local`, `kokoro-v1.0-onnx-f32`, and `af_heart` are the CLI/environment defaults, so provider/model/voice flags may be omitted. Explicit commercial-use attestation remains required even though the managed license reference is recorded automatically. No cloned or user-supplied voice is accepted.

### 3B. Optional paid OpenAI narration

First inspect the exact approved script without making a provider call:

```bash
npm run dark-curiosity:tts:synthesize -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --project demo/dark-curiosity-ai-narration \
  --provider openai \
  --model gpt-4o-mini-tts \
  --voice coral \
  --dry-run \
  --json
```

For a real synthesis, put `OPENAI_API_KEY` in the process environment or a secret manager. Never commit it. Before adding `--commercial-use-attested`, the operator must verify the current provider terms, account plan, selected built-in voice, YouTube use, and applicable law. The code does not make that legal determination. Custom/cloned voices and impersonation are rejected.

```bash
export OPENAI_API_KEY='<secret-from-secret-manager>'

npm run dark-curiosity:tts:synthesize -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --project demo/dark-curiosity-ai-narration \
  --provider openai \
  --model gpt-4o-mini-tts \
  --voice coral \
  --commercial-use-attested \
  --terms-reference 'operator-reviewed-provider-terms-YYYY-MM-DD' \
  --attested-by local_operator \
  --json
```

The provider response is normalized through FFmpeg and verified as mono 48 kHz `pcm_s16le` WAV. The directory receives `narration.wav` and `narration.provenance.json`. The manifest binds the approved script hash, provider/model/voice, operator attestation, audio metadata, and final WAV hash. Repeating the exact command reuses a verified matching artifact. Changing configuration or replacing an existing artifact requires `--regenerate`.

Verify before alignment or pilot mutation:

```bash
npm run dark-curiosity:tts:verify -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --project demo/dark-curiosity-ai-narration
```

Local non-publishable integration testing uses:

```bash
npm run dark-curiosity:tts:synthesize -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --project /tmp/dark-curiosity-tts-mock \
  --provider mock \
  --voice fixture \
  --commercial-use-attested \
  --attested-by local_test_operator
```

This creates a deterministic tone WAV, not spoken narration. It exercises normalization, hashing, upload, and guard logic, but its provenance contains `TTS_MOCK_NON_PUBLISHABLE`. It cannot pass the publish guard.

Before any pilot mutation, validate the authorized file and then rehearse exact alignment:

```bash
npm run dark-curiosity:narration:check -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --audio /absolute/path/to/authorized-narration.wav \
  --rights-confirmed

npm run dark-curiosity:narration:rehearse -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --audio /absolute/path/to/authorized-narration.wav
```

For AI narration, use the generated absolute audio path and keep `narration.provenance.json` beside the WAV. Preflight verifies the sidecar automatically, and upload embeds its verified provenance in the narration manifest:

```bash
npm run dark-curiosity:narration:check -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --audio /absolute/path/to/project/narration.wav \
  --rights-confirmed
```

Troubleshooting:

- Kokoro doctor `python_missing` or `package_missing`: run the explicitly authorized package bootstrap.
- Kokoro doctor `model_missing` or `voices_missing`: run the model bootstrap; corrupted downloads never become active.
- `TTS_PROVIDER_UNAVAILABLE` with Kokoro: rerun doctor. Normal synthesis never downloads packages or models automatically.
- `TTS_CREDENTIALS_MISSING`: configure `OPENAI_API_KEY`; no mock fallback occurs.
- `TTS_PROVIDER_TIMEOUT` or `TTS_PROVIDER_FAILED`: retry after checking provider availability and `SHORTSENGINE_TTS_TIMEOUT_MS`. Partial files are removed.
- `TTS_AUDIO_INVALID`: confirm FFmpeg/FFprobe availability and regenerate; invalid output is not retained.
- `TTS_AUDIO_TAMPERED`, `TTS_SCRIPT_TAMPERED`, or `TTS_PROVENANCE_MISMATCH`: do not edit the WAV, approved fixture, or manifest independently. Regenerate from the current approved script.
- `TTS_OVERWRITE_BLOCKED`: verify the existing output or use `--regenerate` only after intentionally approving replacement.
- `TTS_COMMERCIAL_ATTESTATION_REQUIRED`: inspect is allowed, but release remains blocked until the operator provides an explicit attestation.

Kokoro has zero per-request provider cost after the one-time local setup. OpenAI billing and rate limits can change; check them before an optional paid call. No real provider calls occur in automated tests.

Both commands are read-only. They do not create projects, approvals, artifacts, renders, or exports, and their public output contains no input path or transcript dump.

## 4. Execute the pilot

```bash
npm run dark-curiosity:pilot -- \
  --fixture eval/narrated/dark-curiosity/fixtures/001_wow_signal_mystery.json \
  --audio /absolute/path/to/authorized-narration.wav \
  --rights-confirmed \
  --operator-id local_operator \
  --render-profile final
```

The runner repeats doctor, preflight, and exact rehearsal before it constructs the mutation-capable runtime. Any failed gate produces a bounded report after `fixture_validated` with no project, approval, artifact, or export mutation.

To prove the existing manual release boundary after a successful real pilot, add `--publish-approve`. This keeps the raw release token in memory, verifies it, and requests a guarded final-download descriptor without exposing or persisting the token. Add `--download-proof` only to verify the local final bytes against the approved output hash.

The runner uses the existing repositories and pipeline services for draft creation, exact approval, managed WAV ingestion, local alignment, review preview, final render, technical QA, contact sheet, rights/provenance/export metadata, evidence validation, and final commit. It does not invoke a second compositor, QA implementation, or evidence pipeline.

The ordered state machine is:

1. `fixture_validated`
2. `project_created`
3. `draft_ready`
4. `content_approved`
5. `narration_uploaded`
6. `narration_aligned`
7. `preview_ready`
8. `technical_final_staged`
9. `technical_qa_passed`
10. `evidence_packaged`
11. `technical_final_committed`
12. `pilot_complete`

Any failure stops later stages. QA or evidence failure removes the uncommitted final candidate and creates no final export. Existing immutable diagnostic artifacts may remain historical.

## 5. Interpreting the result

A successful report must state:

- `status: "complete"`;
- `technicalFinal: true`;
- `qaPassed: true`;
- `publishable: false`;
- `publishApprovalRequired: true`;
- all 12 ordered stages;
- exact current-revision draft, narration, alignment, QA, evidence, and final-output references.

The stable run identity includes the normalized fixture hash, audio hash, operator/configuration, render profile, and pilot profile version. A verified completed run is replayed without duplicating approval, audio, or export. A failed or corrupted same-run checkpoint fails closed and must be inspected before retrying.

## 6. Current local proof

The 2026-07-12 Slice 11 authorized provisioning used the already installed Python 3.10.20 to create `.venv-dark-curiosity`, install and verify `faster-whisper==1.2.0`, `ctranslate2==4.6.0`, and `requests==2.32.5`, and acquire the allowlisted `base` CPU/int8 model into the managed engine cache. The helper, doctor, rehearsal, and transcription paths now use that managed cache exclusively; an external Hugging Face cache cannot create a false `ready` result.

Run operator commands with the project-local interpreter selected:

```bash
export SHORTSENGINE_LOCAL_WHISPER_PYTHON_BIN=.venv-dark-curiosity/bin/python
```

The resulting doctor and report-only run validated the real `001_wow_signal_mystery.json` fixture and confirmed that Python, packages, model, FFmpeg, FFprobe, the narrated renderer, and managed storage are ready. The preparation package was regenerated for the exact 81-word script. Full execution remains correctly blocked because:

- no authorized narration WAV was supplied;
- commercial-use rights were not confirmed for an operator recording.

No narration preflight or rehearsal could run, no preview or final MP4 was created, no publish approval or release token was created, and no fallback provider was used. The persisted `dark_curiosity_operator_proof_v1` report records environment `ready` and the remaining narration blockers without paths or secrets.

The Slice 12 readiness rerun found no attached or explicitly scoped authorized WAV, so it correctly stopped after preparation and `fixture_validated`. During that proof, two bounded-readiness regressions were fixed: model availability now verifies the required files in the managed snapshot without loading the full CTranslate2 model, and the report-only CLI lazy-loads the mutation runtime only after full-pilot gates pass. Report-only now completes quickly without constructing project/runtime state; actual model loading remains mandatory in exact rehearsal and transcription.

## 7. Manual release approval

A completed real pilot remains a non-publishable technical final until an operator approves the exact current evidence graph:

```text
POST /api/narrated-projects/:id/publish-approve
```

The request must name the current revision, final output hash, QA report artifact/hash, export metadata artifact/hash, an `approve` decision, allowlisted warning acknowledgements, and an idempotency key. The PublishGuard independently reloads the current content approval, aligned narration, final render manifest, output checksum, passing QA report, rights manifest, contact sheet, provenance report, and export metadata before issuing eligibility.

Successful creation returns one opaque 256-bit release token. Only its SHA-256 hash is persisted. The default token lifetime is 15 minutes, bounded between 5 and 30 minutes. Exact replay within the lifetime does not reveal the token again. Expired, revoked, superseded, output-mismatched, or previous-revision tokens fail closed.

Read-only verification uses:

```text
POST /api/narrated-projects/:id/release-verify
```

A guarded final download descriptor uses:

```text
POST /api/narrated-projects/:id/final-download-url
```

Both require the raw release token plus exact output hash. The download descriptor expires no later than the release token. Generic export download endpoints reject Dark Curiosity technical finals; previews and legacy clip exports retain their existing review boundaries.

This release boundary does not upload anything, call YouTube, generate metadata, or make the underlying technical artifact generally publishable. A new content or style revision revokes prior release eligibility while retaining historical immutable approval artifacts.
