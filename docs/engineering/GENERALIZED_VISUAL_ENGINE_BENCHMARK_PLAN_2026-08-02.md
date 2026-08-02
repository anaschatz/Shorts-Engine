# Generalized Visual Engine benchmark plan — 2026-08-02

## Objective

The benchmark must prove that one compiler can turn ten source- and story-distinct validated inputs into comprehensible vertical animation without story-specific JavaScript, SVG templates, executable markup, or coordinates.

It is not a render-volume benchmark. It is a generalization, comprehension, and visual-quality benchmark.

## Benchmark invariants

- One compiler and one versioned VisualProgram schema for all ten stories.
- Zero story-specific renderer files.
- Zero story-owned coordinates or transforms.
- Zero arbitrary SVG, HTML, CSS, JavaScript, URLs, or executable visual code in story input.
- Only allowlisted, hash/provenance-bound assets and engine-owned primitives.
- 1080×1920, 30 fps, H.264/AAC final technical profile.
- Exact narration-owned word/phrase timing.
- One dominant focal object and at most one helper unless a recipe explicitly proves a bounded comparison.
- Stable identity for persistent primary objects.
- No more than two consecutive scenes with the same composition family.
- Human comprehension score of at least 80%.
- Human narration–visual alignment of at least 4/5.
- Human focal clarity of at least 4/5.
- No more than 30 minutes of manual correction per Short, measured and recorded.
- No publishability claim without explicit human approval.

## Proposed ten-story corpus

“Verified” below means an existing local claim ledger or a named authoritative source that must be ingested into the same claim-ledger contract before the case may enter the scored corpus. Identification of a source is not itself completed verification.

| # | Story | Semantic family | Primary object | Required helper recipe | Expected visual payoff | Verified sources/claims status | Existing fixture? | New asset without new renderer? |
| ---: | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | GPS week-number rollover | Finite mechanism; counter/rollover; before/after | GPS receiver counter | Range, carry, interpretation, patch | 1023 rolls to 0000 while real time continues; corrected cycle restores the date | Existing ledger cites GPS.gov and CISA; claims already bounded against “time reversed” | Yes: `002_gps_week_rollover.json`; mechanism calibration also exists | Optional generalized receiver icon only |
| 2 | Odometer rollover | Finite mechanism; counter/rollover | Six-digit odometer | Range, carry, same-entity continuity | 999999 carries to 000000 while the vehicle remains the same | Calibration-only data exists; no verified claim ledger yet, so it cannot be a publishable benchmark case until sourced | Calibration fixture only | General odometer skin, no renderer |
| 3 | The 1977 Wow Signal | Evidence inspection; bounded uncertainty; unresolved mystery | Persistent signal printout/curve | Evidence lens, duration marker, hypothesis comparison, unresolved boundary | One candidate survives inspection but no repeatable proof remains | Existing ledger cites Big Ear and SETI sources and explicitly rejects alien certainty | Yes: `001_wow_signal_mystery.json` | General receiver/printout assets; no Wow-specific pose kit |
| 4 | Baychimo's crewless Arctic drift | Map/route; disappearance/reappearance; chronology | Persistent ship | Approximate route, negative space, sighting markers, archive timeline | The ship disappears from crew view, reappears in sightings, and ends at a bounded unknown | Existing ledger cites Manitoba, UAF, and Cambridge sources; route must remain approximate | Yes: `003_baychimo_icebound_drift.json` | General vessel/ice/map symbols |
| 5 | Mars Climate Orbiter unit mismatch | Comparison; before/after; cause-effect | Spacecraft trajectory | Unit comparison, process flow, deviation path | Two unit systems diverge from one expected path to the failed trajectory | NASA mishap report identified; claims not yet ingested/verified locally | No | General spacecraft and trajectory icons |
| 6 | Apollo 11 program alarm 1202 | Timeline/chronology; bounded uncertainty; process flow | Guidance-computer state | Timeline, load indicator, decision branch | Alarm appears, is interpreted under time pressure, and the landing continues after the bounded decision | NASA mission transcripts/history identified; claims not yet ingested/verified locally | No | General computer/display and lander assets |
| 7 | Franklin expedition wreck rediscovery | Map/route; disappearance/reappearance; chronology | Expedition ship/route | Route, timeline, search-area narrowing, evidence reveal | Historical route disappears into uncertainty; modern discovery pins two wreck locations without inventing the human story | Parks Canada authoritative material identified; claims not yet ingested/verified locally | No | General historical ship, ice, and sonar marker assets |
| 8 | Vela Incident double flash | Evidence inspection; comparison; bounded uncertainty; unresolved mystery | Sensor event trace | Evidence lens, side-by-side explanations, confidence boundary | A measured event is compared against competing explanations and remains unresolved | Declassified/official reports must be selected and ingested; no local verified ledger | No | General satellite/sensor trace assets |
| 9 | Antikythera mechanism prediction cycle | Finite mechanism; chronology; comparison | Gear train/dial | Gear linkage, cycle counter, before/after dial | Input rotation propagates through a bounded gear chain to a predicted cycle/dial state | Peer-reviewed/authoritative museum sources must be selected and ingested; no local verified ledger | No | Allowlisted gear and dial primitives/assets |
| 10 | Lake Nyos limnic eruption | Before/after; cause-effect; map/context | Lake cross-section | Layer accumulation, threshold, release flow, before/after | Invisible gas accumulation crosses a threshold and produces a visible causal release diagram | USGS/authoritative scientific sources must be selected and ingested; no local verified ledger | No | General terrain, lake-layer, and flow assets |

The corpus deliberately includes two finite counters so the engine must show both reuse and visual differentiation. Cases 5–10 remain *proposed*, not verified fixtures. They must not be scored or rendered as factual publishable stories until their claim ledgers, source excerpts, rights state, and uncertainty language pass the existing validation boundary.

## Coverage matrix

| Required family | Covered by |
| --- | --- |
| Finite mechanism | GPS, odometer, Antikythera |
| Timeline/chronology | Baychimo, Apollo 11, Franklin |
| Before/after | GPS, Mars Climate Orbiter, Lake Nyos |
| Comparison | Wow, Mars Climate Orbiter, Vela |
| Map/route | Baychimo, Franklin |
| Evidence inspection | Wow, Vela, Franklin |
| Bounded uncertainty | Wow, Apollo 11 at alarm-decision stage, Vela |
| Counter/rollover | GPS, odometer |
| Disappearance/reappearance | Baychimo, Franklin wreck rediscovery |
| Unresolved mystery | Wow, Vela |

## Required VisualProgram capabilities

The benchmark should be blocked until the compiler supports the following data-only capabilities:

1. Persistent primary entity with state transitions and identity lock.
2. Engine-owned layout selection from semantic family, density, and focal budget.
3. Finite counter/carry/rollover.
4. Timeline/chronology with bounded event count.
5. Before/after and side-by-side comparison.
6. Map/route using normalized semantic points generated by a trusted server-side geometry factory, never story coordinates.
7. Evidence lens and evidence/hypothesis classification.
8. Negative-space disappearance and reappearance.
9. Cause-effect/process flow.
10. Bounded uncertainty and unresolved verdict.
11. Narration-triggered enter/update/settle/exit timing and comprehension holds.
12. Style tokens that vary palette/background/texture within contrast and accessibility limits.

## Evaluation protocol

### Phase A — contract and security

- Validate every fixture and claim ledger.
- Reject unknown recipes/assets, geometry keys, executable fields, remote URLs, excessive text, non-finite values, and fresh-hash rebinding.
- Confirm identical compiler source hash for all ten cases.
- Record that no story-specific file is loaded.

### Phase B — deterministic technical render

- Render each story twice from a clean managed output root.
- Verify 1080×1920, 30 fps, H.264/AAC, exact narration duration, caption timing, and deterministic sampled-frame/runtime-state evidence.
- Compare output manifests, not necessarily encoded MP4 byte identity when codec metadata is nondeterministic.

### Phase C — structural visual QA

- Measure focal-object count, safe-zone occupancy, centering, minimum element scale, caption overlap, continuity, transition visibility, settle duration, repeated composition runs, and blank frames.
- Fail if any story bypasses engine-owned geometry or exceeds the action/complexity budget.

### Phase D — blinded human review

- At least five reviewers who have not seen the script implementation.
- Play the Short once at normal speed on a phone-sized viewport.
- Ask three factual comprehension questions and one “what remained uncertain?” question where applicable.
- Score narration–visual alignment, focal clarity, pace, visual variety, and confidence that the animation helped rather than distracted.
- Record correction time separately from review time.

### Phase E — generalization gate

Pass only when all ten cases meet every invariant. Aggregate averages cannot hide a failing story. A renderer edit, template edit, or new coordinate for any individual case invalidates the run and resets the benchmark.

## Benchmark result schema

Each sanitized result should contain only:

```text
schemaVersion
commitSha
compiler/profile/style versions
fixture and claim-ledger content hashes
asset-manifest hash
technical pass/fail fields
bounded structural metrics
bounded human scores and reviewer count
manual correction minutes
publishable=false unless separately approved
```

It must exclude source URLs with private parameters, local paths, user identifiers, raw reviewer notes, generated storage keys, credentials, and executable content.

## Exit criterion for Step 8

The engine is generalized only when the scored benchmark passes without any story-specific production-code change. Until then, the honest product state is “generalized contract under calibration,” not “AI animation engine ready for arbitrary stories.”
