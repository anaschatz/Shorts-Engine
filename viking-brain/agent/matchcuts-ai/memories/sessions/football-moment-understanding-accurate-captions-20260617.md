# Football Moment Understanding + Accurate Captions - 2026-06-17

## Decisions

- Goal classification now requires explicit goal evidence, not generic excitement.
- "What a finish" alone is not goal evidence.
- Mock transcription fallback uses neutral football pressure captions and must not invent goals.
- No-goal football moments can rank by crowd/audio/commentary/scene signals as `crowd_reaction`, `commentator_peak`, `audio_energy_spike`, `skill_move`, or other non-goal types.
- Default landscape football rendering uses `wide_safe_vertical` with blurred-fill background and full-frame foreground containment.
- Fallback captions no longer duplicate the hook; the hook is the primary short-form title and captions are supporting beats.

## Real Smoke

- Sample: `https://www.youtube.com/watch?v=gxiRyFZXJV8`
- Result after change: `crowd_reaction`, confidence `0.55`, hook `ΑΚΟΥ ΤΗΝ ΚΕΡΚΙΔΑ`.
- Evidence reported `goalEvidence: false`, audio peak score `0.95`, scene changes `2`.
- Rendered MP4 verified as `1080x1920`, duration about `7.96s`.

## Checks

- `npm run lint`
- `npm run build`
- `npm test`
- `npm run eval`
- `npm run brain:health`

## Limitations

- This is still deterministic transcript/media-signal analysis.
- Real ball/player tracking and vision-backed event understanding remain the next quality milestone.
