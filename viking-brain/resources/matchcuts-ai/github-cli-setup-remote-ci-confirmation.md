# GitHub CLI Setup + Remote CI Confirmation

## Purpose

Close the local `GITHUB_CLI_MISSING` limitation by making GitHub CLI setup and remote CI verification operator-ready without automating install, auth, tokens, raw logs or repository mutations.

## Commands

- `npm run github:setup`
- `gh auth login` manually
- `gh auth status`
- `npm run github:doctor`
- `npm run remote:ci`
- `npm run remote:ci:proof`

## Contracts

`github:setup` is documentation-only. It must include official install guidance, expected repository `anaschatz/Shorts-Engine`, expected workflow `ShortsEngine CI`, release job `Release gate`, manual auth commands and read-only access requirements.

`github:doctor` is read-only. It checks local git context, `gh --version`, `gh auth status`, repository metadata, Actions metadata and branch protection when allowed. Failures include safe `phase`, `status`, `passed`, `skipped` and `nextAction`.

`remote:ci` and `remote:ci:proof` verify the exact commit SHA. They do not download logs/artifacts and do not mutate GitHub settings.

## Safe Failure Codes

- `GITHUB_CLI_MISSING`
- `GITHUB_AUTH_MISSING`
- `GITHUB_NETWORK_UNAVAILABLE`
- `GITHUB_REPO_UNREADABLE`
- `GITHUB_ACTIONS_UNREADABLE`
- `GITHUB_BRANCH_PROTECTION_UNREADABLE`
- `REMOTE_CI_NETWORK_UNAVAILABLE`
- `REMOTE_CI_RUN_NOT_FOUND`
- `REMOTE_CI_TIMEOUT`
- `REMOTE_CI_SHA_MISMATCH`

Reports must not contain tokens, local paths, raw stderr/stdout, raw logs, downloaded artifacts or secrets.
