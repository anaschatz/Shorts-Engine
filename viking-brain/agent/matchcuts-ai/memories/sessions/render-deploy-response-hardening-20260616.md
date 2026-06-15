# Render Deploy Response Hardening - 2026-06-16

Production risk-reduction pass for the ShortsEngine staging deploy boundary.

Decisions:

- Keep `staging:deploy` as the only helper allowed to call the Render API.
- Bound successful Render deploy response bodies before JSON parsing.
- Reject invalid provider JSON with a safe structured error instead of treating it as a successful deploy summary.
- Reduce provider output to safe metadata only: request accepted, deploy id present and sanitized status.
- Keep provider `none` as the default readiness-only path.

Validation focus:

- Oversized Render responses fail closed.
- Invalid Render JSON fails closed.
- Suspicious provider status strings are normalized to `unknown`.
- Raw provider fields, storage keys and token-like values are not copied into summaries.

Limitations:

- Deployed staging smoke remains `/health` only.
- Full deployed upload/render smoke still needs durable storage and persistence strategy.
