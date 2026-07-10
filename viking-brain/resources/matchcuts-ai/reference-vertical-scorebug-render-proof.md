# Reference Vertical Scorebug Render Proof

## Decision

Confirmed-goal compilations use a full-height `9:16` center crop and copy the validated live scorebug ROI to the top center of the rendered frame. This replaces the former landscape letterbox proof layout.

The renderer accepts this layout only when all of the following are true:

- crop mode is `reference_fill`;
- the output uses a full-height action crop;
- a validated `source_roi` scorebug overlay was rendered;
- the scorebug region identifier is present;
- no blurred or duplicated background was used;
- no split caption layout was used.

Uncertain tracking still fails closed outside this explicit confirmed-goal proof path. Tracking and scoreboard overlays never create goal claims.

## Render Contract

- Base video: scale to fill `1080x1920`, then center crop.
- Scorebug: crop from the validated source ROI, scale to a bounded width, and place at top center.
- Captions: render after scorebug composition and avoid the scorebug safe area.
- Multi-goal transitions: retain rendered fades and report hard-cut fallbacks explicitly.
- Public reports: expose only safe layout mode, crop mode, overlay status, and relative artifact references.

## Validation

- Focused render, output-gate, rendered-goal-proof, social-proof, and YouTube runtime tests passed.
- Full test suite passed: `1019/1019`.
- Eval and reference eval remained `98` with framing safety `1.0` and no false-goal regression.
- Rights-confirmed live proof for `WuuGus5Obkg` passed with five clear visible goals.
- Final MP4: `1080x1920`, 111.75 seconds, scorebug visible throughout sampled goal frames.
- `ci:reports`, `release:check`, and `brain:health` passed.

## Limitations

- `reference_fill` is a conservative center crop, not per-object dynamic tracking.
- The operator proof download needs a bounded limit above 80 MiB for full-resolution long compilations.
- Offline research scoring does not measure final rendered pixels, so it remained neutral despite the live visual improvement.
