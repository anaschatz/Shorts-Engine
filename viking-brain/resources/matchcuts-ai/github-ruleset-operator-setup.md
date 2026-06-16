# GitHub Ruleset Operator Setup

## Context

Remote CI proof is green for exact pushed commits, but branch policy proof can still
be `incomplete` when `main` has no matching active GitHub ruleset. ShortsEngine should
guide an operator through setup without mutating GitHub settings itself.

## Decision

- Add `npm run branch:setup` as a documentation-only, no-network setup guide.
- Keep ruleset creation/editing manual in GitHub UI.
- Add a `uiSetupReference` to `branch:proof` reports so every incomplete proof points
  to the operator setup path.
- Keep `branch:doctor` and `branch:proof` read-only and leak-guarded.

## Required UI Steps

- Repository -> Settings -> Rules -> Rulesets.
- Create a new branch ruleset targeting `main`.
- Set enforcement to Active.
- Require pull request before merging.
- Require status checks to pass with `Release gate`.
- Require branches to be up to date before merging.
- Block force pushes and deletions.
- Require conversation resolution before merge.
- Review bypass actors and direct-push exceptions.
- Save the ruleset.

## Proof Commands

After manual setup, run:

- `npm run branch:doctor`
- `npm run branch:proof`
- `npm run remote:ci`
- `npm run remote:ci:proof`
