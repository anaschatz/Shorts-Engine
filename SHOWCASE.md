# ShortsEngine Real Generated Outputs

This showcase connects specific outputs to the evidence that is actually
available. A public page proves availability and public metadata; it does not by
itself prove the internal pipeline. Repository-backed claims require matching job,
render, provenance and quality artifacts.

Verification date: **2026-07-23**.

| Output | Workflow | Public link | Automation | Human edits | Quality proof | Engine version |
| --- | --- | --- | --- | --- | --- | --- |
| Why Cynicism Never Helps You \| Andrew Huberman #Shorts | Motivational | [Verified public Short](https://www.youtube.com/shorts/3sQmO4611mo) | Not recorded in inspected provenance | Not recorded | Public page and metadata only; no matching QA bundle recorded | Not recorded |
| Football example | Football | [Supplied URL — unavailable at verification](https://www.youtube.com/shorts/1yubCngacLk) | Not recorded | Not recorded | YouTube returned “Video unavailable”; no output metadata or QA bundle verified | Not recorded |
| The GPS clocks that looked haunted | Narrated animation | Verified local output — public upload pending | Script-to-render stages recorded; approval and narration were operator inputs | Content approval, self-recorded narration, guarded-release approval; no public upload | Animation QA passed; 50/50 blocking technical gates passed; provenance and rights packages complete | Renderer 2.0.0; Hyperframes 0.7.55; animation style 3.1.0; producing Git SHA not recorded |

The [Budget Friendly channel](https://www.youtube.com/@BudgetFriendlyShorts) was
verified as a public channel named **Budget Friendly**. Only the individually
documented 2026 examples are attributed to ShortsEngine workflows; this showcase
does not attribute every channel video to ShortsEngine.

## Motivational short

Manifest ID: `motivational-cynicism-2026`

YouTube currently exposes this as a public Short titled **Why Cynicism Never
Helps You | Andrew Huberman #Shorts**. Its page metadata reports a 19-second
duration and 405×720 dimensions.

The repository's motivational workflow is designed around editorial moment
selection, sentence-boundary protection, kinetic captions, pacing, rendering and
quality evaluation. Those are workflow capabilities, not verified
output-specific facts for this URL: the inspected evidence did not contain a
matching job record, render manifest, quality report, render duration, engine
version or manual-edit log. Workflow attribution for this example is therefore
operator supplied, and source/rights disclosure remains pending.

## Football short

Manifest ID: `football-supplied-short-2026`

The supplied URL displayed YouTube's **Video unavailable** state during live
verification. It is consequently not labeled as a currently public Short, and its
title, duration, dimensions and codecs remain `unknown`.

ShortsEngine's football workflow can perform evidence-backed candidate
selection, score/event validation when supported, action-aware vertical framing,
captions, rendering and final-output verification. No matching job or provenance
bundle was found for the supplied URL, so this showcase does not claim that those
stages ran for this specific output. Goal validation, framing mode, caption
behavior, human edits and final-QA status are all `not_recorded`.

## Animated mystery

Manifest ID: `narrated-gps-clocks-2026`

**The GPS clocks that looked haunted** is a verified local technical final with
no public URL yet. Public documentation intentionally omits its local filesystem
location, and the MP4 is not part of Git.

The revision-1 content bundle was operator approved and binds a brief, three
factual claims, script and five-beat storyboard. The rights package records
institutional factual sources from CISA and GPS.gov, original engine-generated
SVG visuals, and self-recorded narration with commercial-use permission.

The narration was uploaded by the operator and then aligned to 93 script words.
That timing drives semantic scene planning and a frame-addressable AnimationIR:
1080×1920, 30 fps, 1,233 frames and five primary story beats. Hyperframes local
runtime 0.7.55 with animation style 3.1.0 produced the continuous vector visual
master; the narrated compositor added aligned audio and burned captions.

Animation QA passed browser state-isolation, repeated-frame determinism, network
isolation, semantic geometry, label coverage, motion and caption-safe-zone
checks. There is no gate literally named “comprehension”; the recorded
comprehension evidence is complete semantic-label observation with no legibility
or primary-region violations. Repeated frame 0 and frame 594 hashes matched
across non-linear seeks, which is the recorded seek-determinism proof.

FFprobe independently confirmed an ISO Base Media MP4 with H.264 High video,
YUV420P pixels, 1080×1920 dimensions, 30 fps, 41.1 seconds, and mono AAC-LC
audio at 48 kHz. The technical QA report passed all 50 blocking gates with no
warnings, and the output hash matches the render manifest, export metadata,
provenance report and pilot report.

This is a technical final, not a public publication. Artifact metadata records
`publishable: false`, `technicalFinal: true`, and `publishApprovalRequired: true`.
The exact producing Git SHA was not written into the evidence package; component
versions are recorded, so no producing commit is inferred from later repository
history.

## Automation and intervention vocabulary

- **Automatic** means the repository evidence names a pipeline stage and binds its
  output into the final artifact package.
- **Operator-approved** means a person supplied or approved a required input, such
  as the content bundle, narration or guarded release.
- **Manual edits** means direct timeline, caption, scene or media modification.
  None are claimed absent an edit log; for the public examples they are
  `not_recorded`.

The animated mystery is the only example here demonstrating repository-proven
AnimationIR, semantic vector rendering, narration alignment, seek determinism,
rights packaging and 50-gate technical QA. The public examples demonstrate live
hosting status only until their matching job bundles are recorded.

## Measurement guidance

Use [showcase/metrics-template.csv](showcase/metrics-template.csv) for future
published outputs. The strongest product metric is the percentage of outputs
published without manual editing:

`published_without_manual_edit outputs / all published outputs`

Report the median across multiple consecutive outputs. Do not select only the
best-performing video, and do not fill unavailable YouTube Studio fields with
estimates.

## Animated mystery upload plan

1. Re-run the showcase validator and confirm the verified output SHA-256 remains
   `08142ce5471488400fe8b2e394aba4e94da1b32ea5cee2a13d6fa9fd6fedde8a`.
2. Review the rights manifest, factual source disclosures, title, description,
   thumbnail, audience setting and any synthetic-content disclosure requirement.
3. Obtain explicit operator approval naming this exact output hash and intended
   YouTube channel.
4. Use the existing publishing tool to create a dry-run upload plan. Do not use
   the upload action yet.
5. Upload privately only after approval, verify YouTube's processed duration,
   dimensions, audio, restrictions and description, then obtain a second
   operator decision before changing visibility.
6. Record the final public URL, publish date and immutable producing commit in
   `showcase/examples.json`, then re-run tests and report-safety checks.

Prepared metadata is in
[showcase/youtube-descriptions.md](showcase/youtube-descriptions.md).
