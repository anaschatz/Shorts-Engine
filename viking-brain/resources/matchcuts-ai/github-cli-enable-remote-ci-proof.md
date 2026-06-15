# GitHub CLI Enablement + Remote CI Proof Activation

ShortsEngine uses GitHub CLI only for explicit, local post-push release proof.

## Commands

- `npm run github:setup`
- `npm run github:doctor`
- `npm run remote:ci`
- `npm run remote:ci:proof`

## Setup Helper Contract

`github:setup` prints a safe JSON guide for preparing `gh`.

It is documentation-only:

- No network calls.
- No auth starts.
- No token prompts.
- No repository mutation.
- No logs or artifact downloads.

The guide includes macOS, Linux and Windows install options, manual `gh auth login` guidance, `gh auth status`, read-only access expectations, branch-protection `unknown` guidance and post-push verification commands.

## Failure Guidance

Missing `gh` should point to `npm run github:setup`.

Missing auth should point to manual `gh auth login`, then `gh auth status`.

Remote CI run missing should point to waiting for Actions or confirming branch/SHA.

Timeout should point to waiting for remote CI.

Branch protection `unknown` should point to GitHub UI confirmation, not mutation.

## Safety

- Keep GitHub auth outside project code and reports.
- Do not hardcode GitHub tokens.
- Do not download raw Actions logs/artifacts into release evidence.
- Keep remote proof read-only and post-push only.
- Default tests must mock GitHub CLI output.
- Reports must avoid secrets, local paths, storage keys and provider identifiers.

## Release Flow

1. Run the full local release chain.
2. Commit and push.
3. Run `npm run github:doctor`.
4. Run `npm run remote:ci`.
5. Run `npm run remote:ci:proof`.
6. If remote CI fails, make a fix-forward commit after local validation.
