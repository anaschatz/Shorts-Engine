# GitHub CLI Setup + Remote CI Confirmation - 2026-06-16

## Decisions

- Keep GitHub CLI setup documentation-only with expected repo/workflow/job metadata.
- Add GitHub doctor phases/status booleans and classify network failures separately from auth failures.
- Keep remote CI proof exact-commit, read-only and no-log/no-artifact by default.

## Limitations

- Real remote confirmation still requires `gh` to be installed and authenticated on the operator machine.
- `gh auth login` remains a manual user action.
