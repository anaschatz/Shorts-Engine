# Review Drafts

This directory is for local generated-output review drafts created by:

```bash
npm run review:register -- --project=<project-id> --job=<job-id> --rights-confirmed=1
```

Generated JSON drafts are ignored by git by default because they point to local media artifacts and operator-owned review decisions.

Drafts must contain only safe workspace-relative media references. They are intended to be consumed by:

```bash
npm run review:compare -- --input=eval/review-drafts/review-draft-latest.json
```
