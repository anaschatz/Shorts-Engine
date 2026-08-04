# Maintainability slice — lossless-cut planning

This slice isolates only the pure lossless-cut planning boundary. It does not
claim that `clipper.py` is maintainable overall and does not change video output.

## Repository and scope

- Base: `92988d82ae93845be42cc98cf0f0fd3600ef65a6` (`main` after the production-beta merge).
- Branch: `codex/maintainability-lossless-cut-planning-v2`.
- Final PR head: recorded in the pull request and task report after commit; a
  commit cannot embed its own SHA without changing that SHA.
- Baseline runtime: Node `24.16.0`, npm `11.13.0`, CPython `3.13.0` in an isolated venv.
- Initial working tree: clean; no open pull requests.
- Non-goals: captions, highlights, Node modules, migrations, routes,
  infrastructure, providers, product defaults and video-quality changes.

## Boundary audit

`crop_clip_local` and `_prewarm_bf_editorial_realesrgan_cache` call
`_get_or_create_lossless_cut`. Tests and callers import or patch the existing
`clipper.py` facade names `_cut_subclip_command`, `_cut_subclip`,
`_lossless_cut_cache_key`, `_lossless_cut_cache_path`,
`_prune_lossless_cut_cache` and `_get_or_create_lossless_cut`.

The facade still owns source `stat`/resolution, environment-derived cache
configuration, cache lookup/touch/pruning, directories, temporary names,
atomic replacement, partial cleanup, logging and `subprocess.run`. It preserves:

- exact `ffmpeg -ss/-i/-t/-vf fps` ordering and three-decimal timestamp formatting;
- FFV1 level 3 video, PCM S16LE audio and Matroska output;
- BLAKE2b-24 key schema, six-decimal key inputs and source path/size/mtime identity;
- two-character cache sharding and `.mkv` extension;
- cache-hit log text, return tuple and existing exception propagation;
- cache-disabled fallback, single execution attempt and bounded-cache pruning.

Cancellation is not part of this existing synchronous boundary, so this slice
does not invent a cancellation contract.

## Extraction and dependency direction

Before:

```text
callers -> clipper.py
             |- command/key/path planning
             |- filesystem/cache orchestration
             `- subprocess execution
```

After:

```text
callers -> clipper.py compatibility facade -> lossless_cut_planning.py
             |                              (hashlib/json/pathlib/typing only)
             |- filesystem/cache orchestration
             `- subprocess execution
```

The 57-line `lossless_cut_planning.py` leaf accepts explicit inputs and performs
no environment reads, logging, file access, subprocess work, OpenCV import or
provider access. It never imports `clipper.py`. No caller migration was required.

## Measured change

The measured production boundary is `server/` plus `shorts_generator/` source
files with `.py`, `.js`, `.cjs` or `.mjs` extensions.

| Measure | Baseline | Final | Delta |
| --- | ---: | ---: | ---: |
| Production LOC | 130,371 | 130,418 | +47 |
| `clipper.py` LOC | 7,609 | 7,599 | -10 |
| `lossless_cut_planning.py` LOC | 0 | 57 | +57 |

Production diff is 70 additions and 23 removals, net +47 lines (about 0.036% of
the measured boundary). The small positive delta is compatibility-facade and
module-interface overhead; the extracted implementation itself is not duplicated.
Only two production modules changed and no runtime dependency was added.

## Characterization and regression evidence

Twelve new characterization tests freeze:

- exact argv, paths with spaces, timestamp/fps rounding, codecs and audio mapping;
- stable known cache key and variation across source identity, interval, fps and schema;
- exact sharded cache path and extension;
- hit/touch/log behavior, miss, disabled cache and zero-byte cache recovery;
- one execution attempt, exact return values and facade patch points;
- subprocess failure, missing successful output and partial-output cleanup;
- the pure leaf's standard-library-only dependency boundary.

| Gate | Baseline | Final |
| --- | --- | --- |
| `npm run lint` | pass | pass |
| `npm run build` | pass | pass |
| `npm test` | 1,683 pass, 7 skip, 0 fail | 1,683 pass, 7 skip, 0 fail |
| Python discovery | 501/501 | 513/513 |
| Python isolated runner | 51/51 modules | 52/52 modules |
| HookGate quality | 96.2981, hard guards pass | 96.2981, hard guards pass |
| Fixture fingerprint | `37ef626b9901ad2eeb1056d47954d88cdf2ede6430cc80e449bd5f9c7a91f9c9` | unchanged |
| Metric fingerprint | `d62ce934e038d9026263ce2be7efa5f0c6e3ffac8a583d7b23b609540a5f4fe9` | unchanged |

The exact FFmpeg argv and cache identity contracts are equal before and after.
No deterministic local video fixture was rendered for a byte or pixel comparison,
so this report does not claim byte-identical or pixel-identical output. It claims
only unchanged planning contracts plus the full regression evidence above.

## Next safe slice

Do not combine the next work with this PR. The safest follow-up is a separate
characterization-first slice for import-time cache/environment configuration.
Caption command/render planning is the next candidate after that; Real-ESRGAN
process planning and `highlights.py` candidate discovery should remain later,
independent slices.
