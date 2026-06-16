# GitHub CLI Real Remote Proof Execution - 2026-06-16

## Decision

The local repository confirmed `origin/main` points at commit `d6471a2e530ecef9bb673a78c26887ac7a501be9`.

The current machine still does not have `gh` on PATH, so real Actions verification cannot complete locally yet. Missing CLI/auth failures now include safe `operatorRecovery` command hints while remaining documentation-only and read-only.

## Safety Contract

- Do not install GitHub CLI automatically.
- Do not run `gh auth login` automatically.
- Do not request or persist tokens.
- Do not download raw GitHub logs or artifacts.
- Do not mutate branch protection, secrets, environments or repository settings.

## Operator Commands

- `npm run github:setup`
- `brew install gh`
- `gh --version`
- `gh auth login`
- `gh auth status`
- `npm run github:doctor`
- `npm run remote:ci`
- `npm run remote:ci:proof`

## Validation Target

Once `gh` is installed and authenticated, `remote:ci` and `remote:ci:proof` must verify the exact current commit SHA before passing.
