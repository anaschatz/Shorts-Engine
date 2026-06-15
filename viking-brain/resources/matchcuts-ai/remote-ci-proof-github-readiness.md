# Remote CI Proof + GitHub Release Readiness

ShortsEngine adds a safe GitHub release readiness layer around the existing remote CI verifier.

## Commands

- `npm run github:doctor`
- `npm run github:setup`
- `npm run remote:ci`
- `npm run remote:ci:proof`

## GitHub Setup

`github:setup` is a documentation-only helper for local machines that do not yet have `gh` installed or authenticated.

It prints safe JSON with install options, manual auth guidance, `gh auth status`, post-push verification commands and branch-protection `unknown` guidance. It does not install tools, start auth, request tokens, call GitHub APIs, mutate repository settings or download logs/artifacts.

## GitHub Doctor

`github:doctor` is read-only and checks:

- GitHub CLI availability.
- `gh auth status` readiness.
- local `origin` presence.
- repository metadata readability through `gh repo view`.
- GitHub Actions metadata readability through `gh run list`.
- branch protection readiness through `gh api` when permissions allow it.

Branch protection can return `unknown` when GitHub permissions or repository rulesets hide settings. That is not treated as remote mutation; the next action is to confirm the branch-protection checklist in the GitHub UI.

## Remote CI Proof

`remote:ci:proof` writes:

- `release/results/remote-ci-latest.json`
- timestamped `release/results/remote-ci-proof-*.json`

The proof includes repo owner/name, branch, commit SHA, workflow run id, safe run URL, release-job status, failed job names only, bounded polling settings, and fix-forward guidance.

Before persistence, the proof writer validates the summary shape. Missing release-job metadata, malformed branch/SHA/run fields, unsafe URLs, local paths and secret-shaped values fail closed and do not write proof files.

## Safety

- Uses `execFile`, never shell command strings.
- No hardcoded GitHub tokens.
- No raw logs or artifact downloads by default.
- No GitHub repository mutation.
- No branch-protection mutation.
- Output is bounded and scanned through the shared report-safety leak guard.
- Remote CI proof reports validate summary schema before writing release evidence.

## Fix-Forward

When remote CI fails, use the safe failed-job names and run URL only. Make a new local fix-forward commit after rerunning local validation. Do not force-push, rewrite release evidence, or paste raw logs/tokens/artifacts into reports.
