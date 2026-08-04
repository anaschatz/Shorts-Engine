# Lossless-cut configuration maintainability slice

Date: 2026-08-04

## Identity and scope

- Repository: `anaschatz/Shorts-Engine`
- Base commit: `e0513092bc1ccd4ab40c821af84146084c6f5c6f`
- Branch: `codex/maintainability-lossless-cut-config`
- Final commit: recorded in the pull request after commit creation. A commit cannot
  contain its own final SHA without changing that SHA.
- Scope: import-time parsing for the local lossless-cut cache only.
- Runtime: Node.js 24.16.0, npm 11.13.0, Python 3.13.0.

No caption, highlight, FFmpeg, cache identity, cache execution, provider, API,
migration, infrastructure, or video-output behavior was changed.

## Boundary audit

Before this slice, `clipper.py` read and parsed three environment variables at
module import. The resulting globals were consumed by the existing cache path,
pruning, and get-or-create functions. Tests patched the globals directly in
`clipper.py`.

The preserved facade globals are:

- `LOSSLESS_CUT_CACHE_ENABLED` (`bool`)
- `LOSSLESS_CUT_CACHE_DIR` (`Path`)
- `LOSSLESS_CUT_CACHE_MAX_BYTES` (`int`)

The preserved environment contract is:

| Variable | Default | Exact characterized behavior |
| --- | --- | --- |
| `LOCAL_LOSSLESS_CUT_CACHE` | `true` | Strip and lowercase; only `1`, `true`, `yes`, and `on` enable the cache. Every other value, including empty, disables it. |
| `LOCAL_LOSSLESS_CUT_CACHE_DIR` | `<LOCAL_CACHE_DIR>/lossless-cuts-v1` | Construct a `Path` and expand `~`; relative paths remain relative, an empty value becomes `.`, and spaces/Unicode are preserved. |
| `LOCAL_LOSSLESS_CUT_CACHE_MAX_GB` | `20` | Parse with `float`, multiply by `1024**3`, convert with `int`, then apply a 2 GiB floor. There is no upper bound. Existing `ValueError`/`OverflowError` behavior is preserved. |

Values remain an import-time snapshot. Mutating the three environment variables
after importing `clipper.py` has no effect until `clipper.py` is reloaded. No
configured cache directory is created merely by importing the module.

Direct patch targets in `clipper.py` remain unchanged. No caller imports the new
configuration module.

## Dependency change

Before:

```text
process environment
        |
        v
clipper.py parsing + facade globals + cache execution
```

After:

```text
process environment mapping + LOCAL_CACHE_DIR
        |
        v
lossless_cut_config.py (pure parser, standard library only)
        |
        v
clipper.py facade globals + unchanged cache execution
```

Import direction is one way: `clipper.py` imports the pure leaf. The leaf does
not import `clipper.py`, read `os.environ` at import, access the filesystem,
create directories, log, or execute subprocesses. No cycle or new runtime
dependency was introduced.

## Size

| Measure | Before | After | Delta |
| --- | ---: | ---: | ---: |
| `clipper.py` | 7,599 | 7,590 | -9 |
| New configuration module | 0 | 53 | +53 |
| `shorts_generator` Python LOC | 30,054 | 30,098 | +44 net |

Production diff: 58 insertions, 14 deletions across one new and one existing
production module. The characterization test module contains 271 lines.

## Characterization evidence

Eleven configuration tests freeze:

- defaults and exact exported types;
- boolean allowlist, case, whitespace, empty, and unknown values;
- relative, absolute, empty, spaced, Unicode, and home-expanded paths;
- binary-GiB conversion, fractional/scientific values, 2 GiB floor, and no cap;
- exact malformed numeric exception types and messages;
- import-time snapshot/reload behavior;
- direct `clipper.py` monkeypatch targets;
- absence of import-time cache-directory creation;
- supplied-mapping parsing and the standard-library-only leaf boundary.

All ten behavioral tests passed against the pre-extraction implementation.
The leaf-boundary and supplied-mapping assertions were added with the extraction.

Focused post-extraction results:

- Configuration plus lossless planning: 22/22 passed.
- BF editorial integration and cache patch points: 48/48 passed.
- Python compilation, import direction, and `git diff --check`: passed.

## Full regression evidence

| Gate | Baseline | Final |
| --- | --- | --- |
| `npm run lint` | pass | pass |
| `npm run build` | pass | pass |
| `npm test` | 1,683 pass, 7 skip, 0 fail | 1,683 pass, 7 skip, 0 fail |
| Python discovery | 513/513 | 524/524 |
| Python isolated runner | 52/52 modules | 53/53 modules |
| HookGate quality | 96.2981, hard guards pass | 96.2981, hard guards pass |
| Fixture fingerprint | `37ef626b9901ad2eeb1056d47954d88cdf2ede6430cc80e449bd5f9c7a91f9c9` | unchanged |
| Metric fingerprint | `d62ce934e038d9026263ce2be7efa5f0c6e3ffac8a583d7b23b609540a5f4fe9` | unchanged |

## Warnings and limitations

- `npm audit` reports five pre-existing moderate vulnerabilities: affected
  transitive Hono adapter/Hono packages and PostCSS. No high or critical issue
  was reported, and dependency remediation is outside this slice.
- The first locked npm install found an incomplete developer Puppeteer cache;
  the authoritative install used an isolated temporary cache and passed.
- The first sandboxed Node run could not launch/kill headless Chrome (`EPERM`);
  the authoritative unsandboxed baseline and final runs both passed.
- The local executable is `python3`; no `python` alias is installed.
- No fresh video fixture was rendered for this configuration-only refactor, so
  this report does not claim a new byte-identical or pixel-identical render.
  It claims exact configuration contracts plus the complete regression evidence
  above.

## Next safe slice

Do not combine further work with this pull request. The next independent,
characterization-first slice should isolate caption command/render planning while
keeping caption I/O, subprocess execution, logs, and facade patch points unchanged.
