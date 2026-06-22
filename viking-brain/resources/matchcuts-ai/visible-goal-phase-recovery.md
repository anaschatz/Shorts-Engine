# Visible Goal Phase Recovery

## Decision

Score changes are anchors for searching the source timeline, not proof that the generated short shows a valid goal. A counted goal should only become a primary rendered segment when the system recovers a live-action window with visible shot and payoff evidence.

## Contract

- Search backward from score-change or confirmation anchors for the real live phase, then forward briefly for payoff/confirmation context.
- Prefer live action with shot, goalmouth context, and visible ball-in-net payoff over replay, celebration, or scoreboard-only windows.
- Reject scoreboard-only, replay-only, celebration-only, and shot-without-payoff candidates as primary goal segments.
- Expose safe recovery diagnostics: selected live-action windows, rejected support windows, sampled timestamps, and failure codes.
- Keep replay and celebration evidence as support only after a live phase has been found.

## Safety Notes

- Do not infer goals from scorebug changes alone.
- Do not expose raw frames, local paths, provider output, logs, storage keys, or secrets in recovery reports.
- If no visible live goal phase is found, fail closed with a safe failure code instead of rendering a misleading goal segment.
