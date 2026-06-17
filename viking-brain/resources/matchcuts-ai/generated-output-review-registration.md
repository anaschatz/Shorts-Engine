# Generated Output Review Registration

## Purpose

ShortsEngine can now register a successful generated render/export as a local review draft. This closes the gap between the render pipeline and the real-video review loop: operators do not need to hand-write the review fixture after every successful short.

## Command

```bash
npm run review:register -- --project=<project-id> --job=<job-id> --rights-confirmed=1
```

Optional arguments:

- `--export=<export-id>`
- `--reference=<workspace-relative-reference-video>`
- `--output=eval/review-drafts`
- `--reviewer-notes="..."`

The generated draft can be scored with:

```bash
npm run review:compare -- --input=eval/review-drafts/review-draft-latest.json
```

## Contract

The registration layer reads persisted local project/render records and requires:

- a completed job.
- a matching export record.
- an existing generated video artifact.
- an existing source upload artifact.
- explicit rights confirmation.
- a valid selected moment and edit plan.

The draft includes:

- generated/source media refs as workspace-relative paths.
- project/job/export/upload ids.
- selected moment metadata.
- edit-plan summary, captions and animation cue types.
- style target and style preset.
- no-false-goal review expectations.
- reviewer notes placeholder.
- rights/consent metadata.

## Safety

- Draft JSON files are ignored under `eval/review-drafts/*.json`.
- Absolute local paths, storage keys, raw provider output, logs, tokens and artifacts are not included.
- Missing or unsafe artifact refs fail closed.
- Cloud/object-storage renders without a local generated media artifact are not registered by this local draft tool.
- The tool does not mutate training data, fixtures, providers or render behavior.

## OpenViking Cleanup Decision

Before adding this milestone, old dirty OpenViking test/timestamp truncation state was inspected and cleaned by restoring the affected files to the last committed version. The remaining untracked `manual-downloads/` directory is intentionally left untouched.
