# Leysath-Style Editorial Short — Production Specification

**User-designated reference:** [Instagram Reel `DYkFjyFty5s`](https://www.instagram.com/leysathlab/reel/DYkFjyFty5s/)

**Target render profile:** `bf_editorial_inset_v1`

**Target selection policy:** `motivational_tension_micro_v1`

**Combined format preset:** `bf_viral_micro_v1`

**Snapshot:** 16 July 2026

## Απόφαση

Αυτό είναι το νέο επιθυμητό production format για τα Budget Friendly Shorts:

- μαύρο κάθετο 9:16 canvas,
- οριζόντιο 16:9 podcast inset στο κέντρο με rounded corners,
- high-contrast black-and-white εικόνα,
- kinetic editorial typography μέσα στο inset,
- ένα μεγάλο “hero word” ανά ιδέα,
- πολύ σύντομη, shareable πρόταση,
- reaction/payoff cut όταν υπάρχει πραγματικά στο source,
- μικρό branded tail που οδηγεί ομαλά πίσω στο πρώτο frame.

Δεν θα αντιγραφούν το `LL.` logo, τα source clips, τα fonts ή τα assets του page. Θα αναπαραχθεί η **οπτική και αφηγηματική γραμματική** με δικό μας branding, rights-cleared footage και versioned renderer profile.

## 1. Evidence that the reference page performs

The format is not merely an isolated viral post. At the snapshot:

| Public signal | Value |
| --- | ---: |
| Leysath Lab followers | 93.4K |
| Total posts | 43 |
| Target Reel views | 4.2M |
| Target Reel likes | 264.5K |
| Target Reel comments | ~1.9K |
| Target Reel reposts | 21.9K |
| Other pinned Reel views | 3.3M |
| Highest pinned Reel views | 17.4M |

The public feed exposed 41 Reels from 1 May–15 July 2026 with roughly **44.93M total plays** and a median of **136,989**. Nine of 41 reached at least 1M. The distribution is still highly uneven: the top three produced about 58.1% of the observed plays.

This confirms that the account repeatedly earns distribution. It does **not** prove that layout alone causes the views. Topic selection, the existing audience, source personalities, shareable writing and account history are major confounders.

### Performance pattern

The largest posts use semantic tension, not generic motivational labels:

| Hook | Plays at snapshot |
| --- | ---: |
| `A NICE GUY vs. A GOOD MAN` | 17.4M |
| `IF YOU HAVE AN IDEA` | 4.48M |
| `Before you win` | 4.22M |
| `IF YOUR LIFE WAS A MOVIE` | 3.38M |
| `Consistently work` | 3.29M |

In a small directional comparison, six tension/open-loop hooks had a median near 3.8M, while six generic labels such as `BELIEVE`, `SUCCESS` and `PATIENCE` had a median near 43K. Speaker identity alone did not explain performance: the same speakers ranged from tens of thousands to several million plays.

This is especially relevant to Budget Friendly: its recent `A Good Man Is Not a Nice Guy` topic matches the semantic structure of Leysath Lab’s largest observed Reel. The engine must therefore reproduce both the **tension-selection policy** and the visual grammar; applying the layout to a weak quote is insufficient.

## 2. Measured reference anatomy

### Technical

| Property | Observed |
| --- | --- |
| Canvas | Public rendition 720×1280 at 30fps; browser also exposed a 1080×1920 rendition |
| Duration | 10.749s |
| Source panel | Horizontal 16:9 inset |
| Background | Pure/near-pure black |
| Source treatment | High-contrast monochrome |
| Caption placement | Inside the horizontal source panel |
| Audio label | Original audio |
| Publish date | 20 May 2026 |

### Timeline

| Time | Function | Observed treatment |
| --- | --- | --- |
| 0.00–1.10s | Immediate hook | `Before` exists on frame one; `Before you WIN.` completes by about 0.6s |
| 1.10–5.15s | Setup/contrast | Hard cut to close-up; `everyone will ask`, `why you're working so hard`, `after you win`, then `lucky / how you got` |
| 5.15–7.25s | Anticipation | The quote completes around 5.8s; brief text-free pause and smile |
| 7.25–8.87s | Payoff/reaction | `Holy…`, then hard cut to the reacting guest with oversized `Holy f*ck.` |
| 8.87–9.13s | Separator | Short black frame |
| 9.13–10.75s | Brand tail | Minimal `LL.` mark on black |

The most-liked visible comment paraphrases the spoken idea as:

> Before you win, people ask why you work so hard; after you win, they say you were lucky.

That is the real content engine: one compact before/after contradiction that viewers can instantly understand and repost.

## 3. Visual geometry

Target 1080×1920 geometry:

| Element | Specification |
| --- | --- |
| Canvas fill | `#000000` |
| Inset at 720×1280 | Approximately 680×382px at x≈20, y≈450 |
| Inset at 1080×1920 | Approximately 1020×574px at x≈30, y≈673 |
| Inset maximum width | About 94% of canvas |
| Inset maximum height | About 30–36% of canvas |
| Inset position | Horizontally and vertically centered |
| Corner radius | Approximately 45–70px at 720×1280; about 68–105px at 1080×1920, roughly 12–18% of the inset’s shorter dimension |
| Outside-inset content | Black only; no blur, gradient, texture or duplicated background video |
| Source grade | Grayscale, restrained contrast lift, slight vignette, protected skin highlights |
| Source crop | Preserve original horizontal composition; do not convert to a full-height face crop |

The current code already expresses almost exactly this geometry in:

- `shorts_generator/local/clipper.py::_editorial_render_size`
- `shorts_generator/local/clipper.py::_editorial_inset_box`
- `shorts_generator/local/clipper.py::_compose_editorial_inset`

Those helpers are now reached by a prototype `reference_editorial` branch, but the behavior is still coupled to the existing motivational profile rather than isolated behind the new render/selection versions. The production task is to separate, harden and manifest the contract—not to rewrite the compositor.

## 4. Content contract

This format requires a different candidate contract from a 30–40 second podcast clip.

### Preferred candidate

- 10–18 seconds; hard range 8–22 seconds.
- One self-contained contradiction, rule or identity statement.
- Roughly 18–38 spoken words.
- No setup question, biography, greeting, sponsor language or attribution inside the video.
- Hook begins on the first audible phrase.
- A payoff/reframe arrives by 70–80% of the runtime.
- Optional final reaction is part of the original source sequence.
- Ending is semantically complete before the brand tail.

### High-fit structures

```text
Before X / after X
People think X / the truth is Y
If you want X / stop doing Y
You are not lacking X / you are avoiding Y
The cost before success / the interpretation after success
```

### Reject

- The interesting phrase begins after 1.0 second.
- The statement needs the host’s previous question.
- More than one core idea.
- Payoff requires more than 22 seconds.
- Generic praise or motivation without tension.
- Artificial reaction footage from another context.
- Near-duplicate wording or source footage from a recent upload.

## 5. Kinetic typography

### Behavior

- Reveal on measured word starts; no random timer animation.
- Keep each phrase’s bounding box stable while words appear.
- Use 1–4 visible words at a time.
- Select one semantic anchor or “hero word” per phrase.
- Hero word scale: approximately 1.8–2.4× the support text; reaction text may reach 4× when it still fits safely.
- Function words may be 0.65–0.85×.
- Use sentence case or deliberate all-caps emphasis; do not uppercase every word.
- White/soft-gray text with a restrained black shadow/stroke only when the footage needs it.
- Place text inside the inset and, where possible, opposite the detected face.
- Permit brief text-free beats around the reaction/payoff.
- Use short fade, scale-up and mask/gradient reveals; easing and placement must come from an immutable phrase plan.

### Type roles

| Role | Use |
| --- | --- |
| `support` | Short connectors and setup words |
| `statement` | Normal phrase text |
| `headline` | Main conflict or conclusion |
| `hero` | One high-impact noun/verb such as `WIN`, `LUCKY`, `DISCIPLINE` |
| `reaction` | Large payoff/reaction phrase |

Use licensed fonts with similar functional contrast, not copied brand typography:

- bold grotesk/condensed sans for headline and hero;
- optional bold italic serif/script for at most one semantic accent;
- no more than two font families in one Short.

The current progressive cue, phrase grouping, typography and face-protection code can be reused. The missing piece is constraining it to the inset coordinate system and adding a deterministic `hero` role.

## 6. Shot and motion grammar

- Preserve the original horizontal source shot.
- Default to one speaker shot.
- Allow one genuine source cut or one genuine reaction cut.
- No generated B-roll, stock reaction, speed ramp, transition pack or automatic punch-in.
- No synthetic camera pan.
- Rounded inset remains geometrically locked across cuts.
- Cuts should coincide with the semantic turn or reaction, not a fixed interval.
- Use the speaker’s natural facial/microphone motion as the visual movement.

## 7. Audio

- Dialogue remains dominant and intelligible on phone speakers.
- Loudness target: approximately -15 to -16 LUFS integrated, ≤ -1.5 dBTP.
- Preserve the genuine reaction and room tone.
- The reference includes a low background music bed under clear speech.
- Use a licensed replacement bed, not audio extracted from the reference.
- Reference integrated loudness was measured around -14.1 LUFS with approximately -3.7 dBFS true peak; production may target -14 to -16 LUFS and ≤ -1.5 dBTP.
- Music must remain well below dialogue and duck during the reaction/payoff.
- Never publish an Instagram-extracted track as the new video’s music asset.

## 8. Branding and loop

Create a distinct Budget Friendly mark, for example `BF.`—not `LL.`.

Platform treatment:

- brand tail starts after the spoken semantic ending;
- Instagram-style export: 1.3–1.7 seconds on pure black;
- YouTube Shorts control: shorten to 0.2–0.4 seconds or keep the mark as a final overlay, because the original tail consumes roughly 18% of this 10.75s Reel;
- quick opacity/scale settle, no sound-logo blast;
- last black frame should transition cleanly into the black canvas of frame one, although the reference itself is a branded cut rather than a seamless visual loop;
- no “follow for more” voice CTA inside the 8–22 second video;
- channel promise and CTA live in metadata, pinned comment and related video.

The reference holds its mark longer, but tail duration should be tested because YouTube retention and Instagram loop behavior may differ.

### Cover and platform packaging

The Instagram grid cover is a separate composition, not the first playback frame:

- full-height monochrome portrait;
- faint repeated-text pattern in the background;
- short high-contrast headline in the upper half;
- one oversized hero word such as `WIN`;
- face in the lower half, clear of grid overlays.

Add a versioned `CoverManifest`. For Instagram, export the dedicated cover. For YouTube Shorts, ensure a selectable playback frame carries a strong equivalent composition because thumbnail controls differ by surface.

The Leysath captions use a consistent metadata template: short hook, `By [speaker]`, a long speaker bio and the same follow CTA, with no hashtags in the 41-post sample. Budget Friendly should preserve the consistency but use concise source attribution and its own channel promise; the long bio is not assumed to cause distribution.

## 9. Target profile contract

```json
{
  "profileId": "bf_editorial_inset_v1",
  "formatProfile": "bf_viral_micro_v1",
  "selectionPolicy": "motivational_tension_micro_v1",
  "contentType": "motivational_podcast",
  "preferredDurationSeconds": [10, 18],
  "hardDurationSeconds": [8, 22],
  "layoutHint": "editorial_inset",
  "canvas": {
    "width": 1080,
    "height": 1920,
    "background": "#000000"
  },
  "inset": {
    "maxWidthRatio": 0.9444,
    "maxHeightRatio": 0.36,
    "verticalAnchor": 0.50,
    "cornerRadiusRatio": 0.18
  },
  "grade": "high_contrast_grayscale_v1",
  "captions": {
    "style": "kinetic_editorial_v1",
    "coordinateSpace": "inset",
    "wordsPerPhrase": [1, 4],
    "heroScale": [1.8, 2.4],
    "reactionScaleMax": 4.0,
    "maxFontFamilies": 2
  },
  "sourceCutLimit": 2,
  "artificialCutLimit": 0,
  "music": "licensed_low_bed_v1",
  "brandTailSecondsYouTube": [0.2, 0.4],
  "brandTailSecondsInstagram": [1.3, 1.7],
  "loopBridge": true
}
```

## 10. Engine changes

### P0 — Wire what already exists

1. Add `BF_EDITORIAL_INSET_STYLE = "bf_editorial_inset_v1"` to `shorts_generator/profiles.py`; keep the existing `budget_friendly_v2` behavior unchanged as a legacy control.
2. Add `layout_hint="editorial_inset"` rather than overloading `motivational_editorial`.
3. Route `editorial_inset` to `_compose_editorial_inset` in `_reframe_vertical.base_frame`.
4. Set `editorial_caption_safe_box = _editorial_inset_box(source_size, output_size)`.
5. Map detected face boxes through `_map_editorial_bbox` before collision avoidance.
6. Add a deterministic grayscale grade; do not use the current warm motivational grade.
7. Add a separate `motivational_tension_micro_v1` selection policy with 8–22s hard bounds; do not silently change legacy candidate rules.
8. Record style, layout, grade, type-plan and brand-tail versions in `RenderManifest`.
9. Expose the combined `bf_viral_micro_v1` preset through `main.py`/`pipeline.py`, persist it in the ranking manifest and fail closed in remote/API render mode when the provider cannot reproduce the inset contract.

### P1 — Complete the typography grammar

1. Add `hero` and `reaction` typography roles.
2. Select hero words from hook/payoff fields, not only generic impact-word lists; the current sparse hero budget and ~1.58× scale are not sufficient for this reference.
3. Constrain all caption boxes to the inset.
4. Add phrase-level scale/placement plus fade/scale/mask easing plans to the immutable edit plan.
5. Add a Budget Friendly brand-tail renderer.
6. Preserve a genuine reaction shot when it belongs to the approved candidate interval.
7. Add an explicit reaction/brand-tail timeline instead of treating them as normal caption cues.

### P2 — Make it measurable

1. Record time-coded style events: phrase reveal, hero reveal, source cut, payoff and logo start.
2. Align those events with YouTube retention data.
3. Compare `bf_editorial_inset_v1` only against equal-age Shorts with balanced topic/speaker/duration.

## 11. QA gates

| Gate | Pass condition |
| --- | --- |
| Output | Exactly 1080×1920, stable FPS, H.264/AAC delivery |
| Inset geometry | 92–95% width, ≤36% height, centered, rounded, no spill |
| Background | Black outside inset on ≥99% of sampled pixels |
| Grade | Monochrome within declared chroma tolerance |
| Hook | First meaningful word and visible text by 0.25s |
| Typography | All text inside inset; no face-critical overlap; hero word present |
| Phrase stability | No unintended bounding-box jump during progressive reveal |
| Cuts | 0 artificial cuts; ≤2 genuine source cuts |
| Payoff | Complete by 80–90% of content runtime |
| Brand tail | YouTube 0.2–0.4s / Instagram 1.3–1.7s, correct original mark, no copied `LL.` |
| Loop | End-to-start black-frame delta below declared threshold |
| Rights | Source and all audio/font licenses recorded |
| Similarity | No near-duplicate script, hook or source interval |

Required regression tests include panel geometry/radius tolerance, grayscale channel delta, dominant-word scale ≥1.8×, first caption on frame one, acceptance of a 10.75s clip only under the micro selection policy, and unchanged behavior for the legacy profile.

## 12. Rollout

### Renderer proof — 3 private Shorts

- One 10–12s contradiction.
- One 13–16s concrete rule.
- One 17–20s identity statement.

Review at phone size for geometry, typography readability, reaction integrity, audio and loop. Do not publish until all QA gates pass.

### Public pilot — 10 Shorts

- Hold `bf_editorial_inset_v1` and `motivational_tension_micro_v1` fixed.
- Publish one per day, five per week.
- Balance topic, speaker and duration.
- Snapshot at 24h, 72h, 7d and 28d.
- Compare stayed-to-watch, average percentage viewed, engaged views, repost/share proxies and subscribers per 1,000 engaged views.

Success is not “one video reached millions”. The profile advances when the **median** improves the channel’s current 44.5% stayed-to-watch baseline while preserving satisfaction and subscriber conversion.

## Final implementation note

The repository is closer than it appears: the inset compositor, progressive reveal, multi-font typography and reference assets from another Leysath Lab Reel already exist. The remaining work is to bind the exact inset, grayscale, radius, kinetic-type and platform-tail behavior to an explicit versioned style contract and prevent it from drifting through generic motivational defaults.
