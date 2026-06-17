# Human Feedback Loop

This folder stores local, manually curated feedback for ShortsEngine caption and moment quality.

Feedback files are JSON objects or arrays of objects. They are read by:

```bash
npm run feedback:summary
```

The summary runner is local-only:
- no network calls
- no provider auth
- no automatic training data mutation
- no raw local paths, storage keys, tokens or logs in reports

Required fields:
- `fixtureId` or `projectId`
- `generatedShortRef`
- `selectedMomentCorrect`
- `captionAlignmentScore`
- `captionSpecificityScore`
- `falseClaimFlags`
- `notes`
- `preferredCaptionExamples`
- `reviewer`
- `createdAt`

Allowed `falseClaimFlags`:
- `goal_without_evidence`
- `wrong_action_claim`
- `caption_action_mismatch`
- `unsafe_path_or_secret`
- `generic_caption`
- `other`

