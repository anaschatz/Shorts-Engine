# Session Memory: Human Review Public Response Hardening

## Decision

The human review API should never expose raw persisted review report objects.
Even leak-guarded reports can contain unexpected nested keys, so public review
responses are now built from explicit allowlists.

## Contract

- MP4 refs must be safe relative paths with no traversal or absolute prefixes.
- `machineStructuralMetrics` returns only known metric keys.
- `operatorReview.flags` returns only known human review flags.
- Failed/borderline criteria and improvement hints are sanitized summaries.
- Public `productReady` fails closed when comparison refs are malformed.

## Tests

Add regression coverage with malformed nested report fields such as storage-like
keys, raw-provider-shaped keys, unknown flags and unsafe refs. The public summary
must strip them before response serialization.
