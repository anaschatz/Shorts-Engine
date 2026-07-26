# Node/Python worker protocol v1

This directory is the runtime boundary between the Node control plane and the
Python media subsystem.

- Node owns API/authentication boundaries, projects, orchestration, quotas, and
  persistence interfaces.
- Python owns analysis, candidate extraction/ranking, HookGate, rendering, and
  media QA.
- Payloads contain opaque artifact IDs plus hashes. Local paths, storage keys,
  credentials, and provider tokens are runtime-private and are never contract
  fields.
- Top-level objects are strict. Backward-compatible v1 additions belong under
  the optional `extensions` namespace. A breaking change requires a new major
  directory and validators on both sides.
- `protocol.schema.json` is the canonical documentation schema. Runtime
  validation is implemented in `server/python-worker-contracts.cjs` and
  `shorts_generator/worker_contracts.py`.
