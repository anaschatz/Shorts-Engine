# Disposable production integration

Requirements:

- Docker with Compose v2;
- Node.js 22;
- no `.env` file or cloud credentials are required.

Run:

```text
docker compose -f compose.production-test.yml up -d --wait
npm ci
npm run integration:production
docker compose -f compose.production-test.yml down --volumes
```

The environment binds PostgreSQL to `127.0.0.1:55432` and MinIO to
`127.0.0.1:59000`. Credentials in the Compose file are test-only, fixed, local
and backed by tmpfs. They are not valid for any external system.

The integration runner covers migrations, two-worker queue claims, fencing,
lease recovery, retry, cancellation, DLQ, owner isolation, atomic football
review decisions, shared S3-compatible artifacts, durable attempt history and
cost records.

If Docker or either service is unavailable, the integration tests skip rather
than pretending to pass. Unit tests still run, but production readiness remains
blocked.
