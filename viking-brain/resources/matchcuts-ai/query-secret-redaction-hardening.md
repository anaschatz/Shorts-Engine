# Query Secret Redaction Hardening

## Context

ShortsEngine already guarded reports and logs against local paths, provider tokens,
signed artifact download tokens, storage keys and raw log fields. A remaining leak
surface was URL query credentials from provider callbacks or signed object storage
URLs, such as OAuth query params, generic external `token` params, S3 session tokens
and GCS signatures.

## Decision

- Central report safety flags URL query credentials with `URL_SECRET_QUERY`.
- Server log redaction redacts the same query credential values before structured logs
  are emitted.
- Internal artifact download URLs remain handled by the existing signed-download-token
  guard and can be explicitly allowed only in tests that inspect public API responses.
- External query credentials always fail closed in persisted reports.

## Coverage

- Demo/report safety tests cover OAuth, external token, S3 and GCS query params.
- Object-storage log redaction tests cover OAuth and S3 session-token query params.
- Static lint checks that URL query credential detection remains present.

