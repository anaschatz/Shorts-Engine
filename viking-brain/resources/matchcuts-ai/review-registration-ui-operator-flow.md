# Review Registration UI Operator Flow

## Purpose

ShortsEngine exposes generated-output review registration directly in the local operator UI after a successful render/export. This lets a tester register the rendered short into the local review loop without copying ids into the CLI.

## Backend Contract

Route:

```text
POST /api/review/register
```

Required payload:

- `projectId`
- `jobId`
- `rightsConfirmed: true`

Optional payload:

- `exportId`
- `reference`
- `reviewerNotes`
- `title`

The route delegates to `registerReviewDraft` and returns only a safe public summary:

- registration status.
- workspace-relative draft refs.
- compare command.
- overall score and bounded review metrics.
- failed criteria/cases with safe text only.
- next action.

## UI Contract

- The review panel is visible in the render controls area.
- The Register button is disabled until a render has completed, an export exists, and rights are confirmed for the active source.
- After successful registration, the button becomes `Registered` and remains disabled until a new render resets the review state.
- The summary shows overall score, no-false-goal, caption/action, framing, aspect ratio, animation cue and reviewer-readiness metrics.
- Failures show safe user-facing criteria only, never raw paths, storage keys, logs or provider output.

## Safety

- No review draft is created for failed, processing or missing-export jobs.
- No review registration happens without explicit rights confirmation.
- Missing local render artifacts fail closed with `ARTIFACT_NOT_FOUND`.
- API responses/loggable output must not include absolute local paths, storage keys, raw stdout/stderr, raw provider errors, tokens or secrets.
- The route is rate-limited and accepts bounded JSON only.

## Validation

- Backend route tests cover success, missing rights, non-completed jobs, missing artifacts, unsafe references and leak guards.
- Browser contract tests cover the disabled initial UI state and review panel selectors.
- Demo smoke registers review after export and includes a safe `reviewRegistration` summary.
