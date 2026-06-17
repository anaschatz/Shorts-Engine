# Session Memory: Strict Provider Output Hardening

Date: 2026-06-17

Implemented a scoped production risk-reduction pass for provider and edit-plan boundaries.

Decisions:

- Unknown vision provider labels fail closed with `AI_OUTPUT_INVALID`.
- Disallowed visual goal labels remain rejected.
- External vision provider cancellation now interrupts pending provider work.
- Edit-plan validation now rejects unsupported highlight types, framing modes, effects, visual evidence labels/reasons and caption-emphasis styles.

Tests:

- Focused `tests/vision.test.cjs` passed.
- Focused `tests/backend.test.cjs` passed.

Limitations:

- This does not add real object/ball tracking.
- External paid vision providers remain opt-in and disabled by default.
