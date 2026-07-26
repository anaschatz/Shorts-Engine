# Budget Friendly pilot readiness — 2026-07-17

Status: candidate discovery completed; production render and YouTube upload are blocked.

## Decision

Neither available source contains a candidate that satisfies the frozen
`bf_viral_micro_v1` contract. No candidate was approved, rendered, or uploaded.
The correct next input is a new source with documented publication rights and a
clean 8–22 second tension/payoff moment.

## Sealed discovery evidence

| Source | Candidates | Eligible | Selected | Ranking content hash |
| --- | ---: | ---: | ---: | --- |
| `9qJHRvHU8IM` | 3 | 0 | 0 | `8add74d650bc50a1025f7f6bf4f16024d4aad711b63c44d2ee9aca8d3f4ebc15` |
| `s0DohADRRlY` | 18 | 0 | 0 | `39677fd2239b70218d180cc39fc41ccd99135db01d615de58c283788627cb173` |

Both `RankingManifest` seals were recomputed and verified locally.

Evidence:

- `AI-Youtube-Shorts-Generator/output/pilot-bf-9qJHRvHU8IM-2026-07-17/ranking.json`
- `AI-Youtube-Shorts-Generator/output/pilot-bf-s0DohADRRlY-2026-07-17/ranking.json`

The first source produced sexual/profane subject matter that is not suitable for
the current channel direction. The second source produced stronger semantic
moments, but 17 of 18 candidates exceeded the two-source-cut limit and 14 exceeded
the 22-second maximum.

## Strongest near-misses

### The Power of Going First

- Speech duration: 15.36 seconds
- Final score: 72.885
- Semantic tension / contrast / listener payoff: 75 / 80 / 85
- Only rejection: 3 genuine source cuts; the frozen limit is 2

This candidate was not manually forced through. Its cleaner repeated-hook suffix
is shorter than the 8-second minimum. Extending that suffix merely repeats the
already-complete payoff, so it would optimize for the gate rather than improve
the story.

### The Secret to Habit Longevity

- Edit duration: 19.60 seconds
- Final score: 81.072
- Semantic tension / contrast / listener payoff: 90 / 90 / 95
- Rejections: second topic after the earliest complete takeaway and 3 source cuts

The higher score does not override hard editorial gates.

## Engine changes validated in this pilot

1. Gemini structured generation now uses the official REST `generateContent`
   boundary with the API key in the request header, verified TLS, JSON schema,
   bounded response size, and primary/fallback model routing.
2. The micro-highlight response schema now requires the semantic tension,
   contrast, conflict, reversal, listener payoff, self-contained arc, context,
   and reaction-tail evidence requested by the prompt.
3. Candidate caches are namespaced by structured-output schema version, so stale
   model output cannot be reused after a contract change.
4. More than two measured source cuts is now a hard ranking rejection, matching
   the later approval contract.
5. `--select-only` now persists a sealed zero-selection manifest when every
   candidate is rejected. It does not invoke the renderer or disguise the result
   as a pipeline failure.
6. The full local Python suite passes: 213 tests.

## Acceptance brief for the next source

The next source should meet all of the following before production rendering:

- Rights: owned, licensed, or explicit permission for edited YouTube publication;
  the evidence must be available for the later `SourceRightsManifest`.
- Technical: 1080p preferred, intelligible speech, exact word timestamps, stable
  subject framing, and at least 0.20 seconds of post-speech tail clearance.
- Hook: direct tension, contradiction, boundary, reversal, or concrete rule in the
  first sentence; the hook payoff must land within 5 seconds.
- Arc: one standalone topic with setup, development, and the earliest complete
  takeaway in 8–22 seconds.
- Context: no host question, attribution lead-in, callback, unexplained pronoun,
  CTA, outro, or second topic after the takeaway.
- Semantics: at least one tension dimension at 40 or above, self-contained micro
  arc at 60 or above, and context dependence below 55.
- Editability: no more than 2 genuine source cuts and 0 generated/artificial cuts.
- Originality: not the same source interval or substantially the same hook as a
  recent Budget Friendly publication.

## Next operator action

Place the licensed local file in the workspace or provide its source URL plus the
rights basis. Then run discovery only:

```bash
cd "/Users/anastaseschatzedakes/Desktop/short form /AI-Youtube-Shorts-Generator"
export LOCAL_OUTPUT_DIR="$PWD/output/pilot-bf-<source>-<date>"

.venv/bin/python main.py "<SOURCE_URL_OR_LOCAL_PATH>" \
  --mode local \
  --select-only \
  --format 1080 \
  --language en \
  --aspect-ratio 9:16 \
  --format-profile bf_viral_micro_v1 \
  --num-clips 6 \
  --output-json "$LOCAL_OUTPUT_DIR/discovery-result.json"
```

Rendering remains a separate, hash-bound step after an eligible candidate is
human-approved and its experiment is declared.
