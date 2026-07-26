# Budget Friendly production runbook

Status: implemented and locally verified on 2026-07-17. No YouTube upload was performed.

This is the operator path for one reviewed Budget Friendly Short. It freezes the new format, binds every artifact by hash, uploads privately only after all gates pass, and records equal-age analytics. Public release is not automatic.

## Frozen production contract

| Component | Version / constraint |
| --- | --- |
| Combined format | `bf_viral_micro_v1` |
| Content profile | `motivational_podcast` |
| Selection policy | `motivational_tension_micro_v1` |
| Render profile | `bf_editorial_inset_v1` |
| Output | 1080×1920, 30 fps, H.264/AAC |
| Layout | `editorial_inset_v1`: black canvas, centered rounded 16:9 inset |
| Grade | `high_contrast_grayscale_v1` |
| Typography | `kinetic_editorial_v1`, 1–4 words, hero ≥1.8× |
| Cuts | ≤2 genuine source cuts; 0 undeclared/artificial cuts |
| Brand tail | Original `BF.` mark, 0.2–0.4s on YouTube |
| Renderer | Local only; remote/API rendering fails closed |

`budget_friendly_v2` remains the unchanged legacy control. Do not mix its components into `bf_viral_micro_v1`.

## 0. Operator setup

Run from the media-worker directory:

```bash
cd "/Users/anastaseschatzedakes/Desktop/short form /AI-Youtube-Shorts-Generator"
source .venv/bin/activate
command -v python ffmpeg ffprobe jq
python -m unittest discover -s tests -v
```

Create one immutable working directory and set real operator values. Do not put secrets in the repository or in command history.

```bash
export RUN="$PWD/output/production/bf-2026-07-17-001"
export OPERATOR="<REAL_REVIEWER_ID>"
export DECIDED_AT="<UTC_ISO_TIMESTAMP>"
export EXPERIMENT_ID="bf-content-001"
export DECLARED_AT="<UTC_ISO_TIMESTAMP>"
export DECISION_DUE_AT="<UTC_ISO_TIMESTAMP>"
mkdir -p "$RUN/discovery" "$RUN/render"
```

Before rendering, configure only fonts and music with documented commercial-use rights. The bundled music evidence is in `assets/music/README.md`; the operator must still verify that the applicable license covers the intended publication. Never use the Leysath assets, source clips, logo, fonts, or extracted audio.

## 1. Candidate discovery, without upload

If a current `ranking.json`, exact source file, and word-timestamp transcript already exist, use them and skip this discovery command. Otherwise:

```bash
export SOURCE_INPUT="<YOUTUBE_URL_OR_LOCAL_SOURCE_PATH>"
export LOCAL_OUTPUT_DIR="$RUN/discovery"

python main.py "$SOURCE_INPUT" \
  --mode local \
  --select-only \
  --format 1080 \
  --language en \
  --aspect-ratio 9:16 \
  --format-profile bf_viral_micro_v1 \
  --num-clips 6 \
  --output-json "$RUN/discovery-result.json"

export RANKING="$RUN/discovery/ranking.json"
export SOURCE="$(jq -r '.source.local_path' "$RANKING")"
jq '.transcript' "$RUN/discovery-result.json" > "$RUN/transcript.json"
export TRANSCRIPT="$RUN/transcript.json"
```

Do not add `--upload-youtube`. The direct uploader is disabled for `bf_editorial_inset_v1`; production publishing must use the reviewed publisher below.
`--select-only` performs download/transcription/visual analysis/ranking and writes the sealed
`RankingManifest`, but deliberately skips all candidate renders. Only the one candidate sealed by
the human approval step is rendered later.

An all-rejected discovery run is a valid fail-closed result: it persists a sealed manifest with
zero `selected_outputs` and exits without rendering. In that case, stop before step 2 and choose a
new source. See the
[2026-07-17 pilot readiness report](BUDGET_FRIENDLY_PILOT_READINESS_2026-07-17.md)
for a verified example and the next-source acceptance brief.

Confirm the frozen profiles and review each eligible source moment, transcript arc, and ranking
record. Phone-size composition is reviewed only after the exact approved render in step 4:

```bash
jq '.profiles' "$RANKING"
jq '[.candidates[] | {
  rank:(.selection_rank // .output_rank),
  title,
  start_time,
  end_time,
  final_score,
  rejected,
  rejection_reasons,
  hook_sentence,
  final_takeaway_sentence,
  source_cut_count
}]' "$RANKING"
```

Reject any candidate that lacks a first-frame tension hook, standalone meaning, complete payoff, genuine source context, or publishable source rights.

## 2. Human candidate approval

Approval seals the exact candidate and source hash. Any later candidate or source mutation invalidates production rendering.

```bash
export APPROVED_RANK="<REVIEWED_RANK>"

python budget_friendly_ops.py approve-candidate \
  --candidate-json "$RANKING" \
  --rank "$APPROVED_RANK" \
  --source "$SOURCE" \
  --reviewer "$OPERATOR" \
  --decided-at "$DECIDED_AT" \
  --notes "Reviewed hook, semantic closure, reaction integrity, source cuts and phone-size composition." \
  --output "$RUN/candidate-decision.json"

jq -e '.artifactType == "CandidateDecision" and .decision == "approved"' \
  "$RUN/candidate-decision.json"
```

This step is a real human approval, not an automatic promotion of rank 1.

## 3. Predeclare the experiment

Choose exactly one content cohort: `contradiction`, `concrete_rule`, `identity_stakes`, or `legacy_control`. Keep production variables fixed.

```bash
export COHORT="<contradiction|concrete_rule|identity_stakes|legacy_control>"
export TREATMENT="<TREATMENT_ID>"
export PILLAR="<CONTENT_PILLAR>"

python budget_friendly_ops.py declare-experiment \
  --candidate-decision "$RUN/candidate-decision.json" \
  --experiment-id "$EXPERIMENT_ID" \
  --cohort "$COHORT" \
  --treatment "$TREATMENT" \
  --hypothesis "<ONE_PREDECLARED_HYPOTHESIS>" \
  --primary-variable hook_family \
  --pillar "$PILLAR" \
  --declared-at "$DECLARED_AT" \
  --decision-due-at "$DECISION_DUE_AT" \
  --speaker-id "<SPEAKER_ID>" \
  --source-popularity-bucket "<SOURCE_POPULARITY_BUCKET>" \
  --output "$RUN/experiment.json"

jq '{experimentId,cohortId,treatmentId,formatProfile,selectionProfile,renderProfile,fixedVariables}' \
  "$RUN/experiment.json"
```

The experiment must exist before the production render.

## 4. Render the exact approved candidate

```bash
python budget_friendly_ops.py render-approved \
  --source "$SOURCE" \
  --transcript "$TRANSCRIPT" \
  --candidate-decision "$RUN/candidate-decision.json" \
  --experiment "$RUN/experiment.json" \
  --output-dir "$RUN/render" \
  --output "$RUN/production-bundle.json"

jq '.renderManifest' "$RUN/production-bundle.json" > "$RUN/render-manifest.json"
jq '.creativeQaReport' "$RUN/production-bundle.json" > "$RUN/creative-qa.json"
jq '.audioQaReport' "$RUN/production-bundle.json" > "$RUN/audio-qa.json"

jq -e '
  .creativeQaReport.passed == true and
  .audioQaReport.passed == true and
  .renderManifest.renderProfile == "bf_editorial_inset_v1" and
  .renderManifest.cuts.artificialCutCount == 0 and
  .renderManifest.timeline.firstVisibleTextSeconds <= 0.25 and
  .renderManifest.typography.maxHeroScale >= 1.8 and
  (.renderManifest.brandTail.durationSeconds >= 0.2 and
   .renderManifest.brandTail.durationSeconds <= 0.4)
' "$RUN/production-bundle.json"
```

Open the rendered MP4 from `.renderManifest.outputPath` and perform a human phone-size review. Automated QA does not approve source meaning, speaker representation, attribution, or rights.

## 5. Originality gate

Maintain a complete recent-publication ledger, including unpublished scheduled videos. Its shape is:

```json
{
  "publications": [
    {
      "videoId": "...",
      "sourceHash": "...",
      "startTime": 0.0,
      "endTime": 10.0,
      "hook": "...",
      "candidateText": "..."
    }
  ]
}
```

An empty ledger is valid only when there truly are no recent publications.

```bash
python budget_friendly_ops.py originality \
  --candidate-decision "$RUN/candidate-decision.json" \
  --recent-publications "$RUN/recent-publications.json" \
  --output "$RUN/originality-report.json"

jq -e '.passed == true' "$RUN/originality-report.json"
```

## 6. Human rights attestation

Stop here unless there is real evidence for the exact source, YouTube transformations, music, and every rendered font. A downloaded public podcast is not automatically licensed for republication.

```bash
export RIGHTS_STATUS="<owned|licensed|permission_granted>"
export RIGHTS_OWNER="<LEGAL_OWNER>"
export SOURCE_RIGHTS_EVIDENCE="<VERIFIABLE_DOCUMENT_OR_RECORD>"
export MUSIC_LICENSE_EVIDENCE="<VERIFIED_LICENSE_REFERENCE>"
export FONT_LICENSE_EVIDENCE="<VERIFIED_FONT_LICENSE_REFERENCE>"
export SOURCE_ATTRIBUTION="<EXACT_SOURCE_AND_SPEAKER_ATTRIBUTION_FOR_DESCRIPTION>"

python budget_friendly_ops.py rights \
  --candidate-decision "$RUN/candidate-decision.json" \
  --status "$RIGHTS_STATUS" \
  --owner "$RIGHTS_OWNER" \
  --evidence-reference "$SOURCE_RIGHTS_EVIDENCE" \
  --platform youtube \
  --music-license "$MUSIC_LICENSE_EVIDENCE" \
  --font-license "$FONT_LICENSE_EVIDENCE" \
  --attribution-text "$SOURCE_ATTRIBUTION" \
  --output "$RUN/rights-manifest.json"

jq -e '
  .artifactType == "SourceRightsManifest" and
  (.allowedPlatforms | index("youtube")) != null
' "$RUN/rights-manifest.json"
```

Use repeated `--font-license` arguments when more than one family is rendered. Never use placeholder evidence to pass this gate.

## 7. Build a private publish plan

The human-reviewed `$RUN/youtube-metadata.json` must contain, at minimum:

```json
{
  "title": "A concise reviewed title",
  "description": "<EXACT_SOURCE_ATTRIBUTION_FROM_RIGHTS_MANIFEST>\n\nThe Budget Friendly channel promise.",
  "tags": ["shorts", "self improvement"],
  "categoryId": "22",
  "containsSyntheticMedia": false
}
```

Provide either an eligible related video or an explicit reviewed waiver:

```bash
python budget_friendly_ops.py publish-plan \
  --production-bundle "$RUN/production-bundle.json" \
  --rights "$RUN/rights-manifest.json" \
  --originality "$RUN/originality-report.json" \
  --metadata "$RUN/youtube-metadata.json" \
  --privacy private \
  --related-video-waiver "<REVIEWED_REASON_NO_RELATED_VIDEO_IS_AVAILABLE>" \
  --output "$RUN/private-publish-manifest.json"

jq -e '
  .artifactType == "PublishManifest" and
  .privacyStatus == "private"
' "$RUN/private-publish-manifest.json"
```

If a related video exists, replace the waiver with `--related-video-id "$RELATED_VIDEO_ID"`.
The ID is preserved in the publish receipt as a required post-upload action. YouTube currently
documents adding the related video in Studio after upload; the selected video must be public or
unlisted. Complete that Studio action before public release:
https://support.google.com/youtube/answer/14075157?hl=en

## 8. Private YouTube upload — explicit external side effect

This is the only command in the runbook that uploads anything. Do not run it until the operator explicitly authorizes the private upload and has verified the OAuth channel ID.

```bash
export EXPECTED_CHANNEL_ID="<BUDGET_FRIENDLY_CHANNEL_ID>"
export YOUTUBE_CLIENT_SECRETS="<ABSOLUTE_PATH_TO_CLIENT_SECRETS_JSON>"
export YOUTUBE_TOKEN_FILE="<ABSOLUTE_PATH_TO_BUDGET_FRIENDLY_TOKEN_JSON>"

python budget_friendly_ops.py publish \
  --publish-manifest "$RUN/private-publish-manifest.json" \
  --render-manifest "$RUN/render-manifest.json" \
  --receipt-store "$RUN/publish-receipts.json" \
  --expected-channel-id "$EXPECTED_CHANNEL_ID" \
  --client-secrets "$YOUTUBE_CLIENT_SECRETS" \
  --token-file "$YOUTUBE_TOKEN_FILE"

jq '.receipts' "$RUN/publish-receipts.json"
```

When the receipt reports `relatedVideoState: "studio_action_required"`, open the private Short in
YouTube Studio, set the declared related video, save, and record the completed human review. The
Data API uploader does not pretend that this Studio-only action has already happened.

The manifest is private and the command intentionally omits `--confirm-public`. Before calling
YouTube, the publisher durably records a sealed pending receipt and a unique marker tag. Replaying
the command returns the completed receipt, or reconciles that exact marker after a crash. If the
remote state cannot be reconciled, it fails closed instead of risking a duplicate upload.

After the private review, rights confirmation, metadata review, and any required related-video
Studio action are complete, release the *same* stored YouTube video. This command calls
`videos.update`; it never inserts or re-uploads a video:

```bash
export VIDEO_ID="<YOUTUBE_VIDEO_ID_FROM_THE_PRIVATE_RECEIPT>"

python budget_friendly_ops.py release \
  --youtube-video-id "$VIDEO_ID" \
  --receipt-store "$RUN/publish-receipts.json" \
  --expected-channel-id "$EXPECTED_CHANNEL_ID" \
  --client-secrets "$YOUTUBE_CLIENT_SECRETS" \
  --token-file "$YOUTUBE_TOKEN_FILE" \
  --confirm-public
```

The release intent is also stored before the external update. A retry first inspects the exact
video: if it is already public, the local release receipt is reconciled without another update; if
it is still private, the same-video transition may resume. Do not create a second public
`publish-plan`, and do not bypass this boundary with `main.py --upload-youtube`.

## 9. Equal-age analytics snapshots

Distribution analytics begin only after an approved public release. Do not treat private-preview activity as experiment performance.

Collect snapshots near 1h, 6h, 24h, 72h, 168h, and 672h. A metrics JSON must use these fields:

```json
{
  "views": 0,
  "engagedViews": 0,
  "stayedToWatchPercent": 0,
  "averageViewDurationSeconds": 0,
  "averagePercentageViewed": 0,
  "likes": 0,
  "shares": 0,
  "comments": 0,
  "subscribersGained": 0
}
```

For a Studio CSV export:

```bash
export VIDEO_ID="<YOUTUBE_VIDEO_ID>"

python budget_friendly_ops.py import-studio-csv \
  --csv "$RUN/youtube-studio-export.csv" \
  --output "$RUN/studio-normalized.json"

jq --arg VIDEO_ID "$VIDEO_ID" \
  '.rows[] | select(.videoId == $VIDEO_ID) | .metrics' \
  "$RUN/studio-normalized.json" > "$RUN/metrics-168h.json"
```

Write one sealed snapshot at the matching age gate:

```bash
export PUBLIC_PUBLISHED_AT="<UTC_ISO_PUBLICATION_TIMESTAMP>"
export OBSERVED_AT="<UTC_ISO_TIMESTAMP_NEAR_THE_GATE>"
export GATE="168"
export ANALYTICS_STORE="$PWD/output/production/bf-analytics-snapshots.json"
export DURATION_SECONDS="$(jq -r '.renderManifest.durationSeconds' "$RUN/production-bundle.json")"

python budget_friendly_ops.py snapshot \
  --video-id "$VIDEO_ID" \
  --published-at "$PUBLIC_PUBLISHED_AT" \
  --observed-at "$OBSERVED_AT" \
  --metrics "$RUN/metrics-${GATE}h.json" \
  --source studio_csv \
  --experiment "$RUN/experiment.json" \
  --duration-seconds "$DURATION_SECONDS" \
  --store "$ANALYTICS_STORE"
```

Repeat with gate-matched observations and metrics at 1, 6, 24, 72, 168, and 672 hours. Never compare videos at different age gates.

## 10. Cohort evaluation

Evaluate only cohorts with at least three complete, equal-age observations each:

```bash
python budget_friendly_ops.py evaluate \
  --store "$ANALYTICS_STORE" \
  --gate-hours 168 \
  --minimum-per-cohort 3 \
  --output "$RUN/cohort-evaluation-168h.json"

jq '{snapshotGateHours,eligibleSnapshotCount,decision,winnerCohortId,humanApprovalRequired,cohorts}' \
  "$RUN/cohort-evaluation-168h.json"
```

Repeat at 24, 72, 168, and 672 hours as samples mature. `humanApprovalRequired` remains true even when the report says `human_review_winner`; the evaluator never changes production or publishing automatically.

## Existing private proof artifacts

The implemented renderer has a three-clip local proof set:

- `output/bf-editorial-proof-2026-07-16/proof-report.json`
- `output/bf-editorial-proof-2026-07-16/short_01.mp4` — concrete rule, ~10s
- `output/bf-editorial-proof-2026-07-16/short_02.mp4` — contradiction/reaction, ~16s
- `output/bf-editorial-proof-2026-07-16/short_03.mp4` — identity stakes, ~19s
- `short_01-contact.jpg` through `short_03-contact.jpg`
- `short_01-tail.jpg` through `short_03-tail.jpg`

The report is sealed, has `privateReviewOnly: true`, and currently records `passed: true` for all three clips, including editorial QA, audio QA, and zero artificial cuts. Re-run QA without rendering:

```bash
python tools/render_bf_editorial_proofs.py \
  --output-dir output/bf-editorial-proof-2026-07-16 \
  --qa-only

jq '{privateReviewOnly,passed,proofs:[.proofs[]|{
  proof_id,
  proof_passed,
  first_visible_text_seconds,
  max_hero_scale,
  brand_tail_seconds,
  artificial_cut_count
}]}' output/bf-editorial-proof-2026-07-16/proof-report.json
```

These are local visual/technical proofs, not publication approvals. They do not establish source rights, and none was uploaded to YouTube during implementation.
