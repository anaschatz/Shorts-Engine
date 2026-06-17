# Strict Provider Output Hardening

Decision date: 2026-06-17

ShortsEngine should reject malformed provider/edit-plan semantics at the adapter boundary instead of silently converting them into generic output.

Applied contracts:

- Visual labels must be in the `VISUAL_SIGNAL_TYPES` allowlist.
- Visual-only goal labels remain disallowed.
- External vision cancellation must interrupt pending provider work with `JOB_CANCELLED`.
- Edit-plan `highlightType`, `framingMode`, visual evidence labels/reasons, effects and caption-emphasis styles must use explicit allowlists.
- Public responses and logs should expose only safe codes/metadata, never raw provider output, paths or secrets.

Risk reduced:

- Typos or unexpected provider labels no longer influence ranking as `unknown_visual_action`.
- Bad edit-plan effects/styles cannot reach render silently.
- Cancelled jobs avoid waiting for a pending external vision provider until timeout.

Validation:

- `tests/vision.test.cjs` covers unknown label rejection and in-flight cancellation.
- `tests/backend.test.cjs` covers edit-plan controlled vocabulary rejection.
