# ADR: Versioned Node/Python worker boundary v1

Status: accepted for incremental adoption
Date: 2026-07-26

## Context

ShortsEngine currently has strong artifact hashes but an uneven runtime
boundary. Node owns the application and orchestration while Python owns most
motivational media work. The legacy bridge passes absolute local paths and
internal artifact documents to a vendored Python checkout. Root Python has a
second implementation, so unversioned evolution can drift silently.

## Decision

Node remains the control plane:

- API and authentication boundary;
- projects and human review;
- job orchestration and quotas;
- persistence interfaces and artifact-ID resolution.

Python remains the media subsystem:

- content analysis and candidate extraction;
- ranking and HookGate;
- clip/render processing;
- media QA.

The boundary is a worker process, not a new microservice. Canonical protocol v1
is defined in `contracts/node-python/v1/protocol.schema.json`, with matching
runtime validators in:

- `server/python-worker-contracts.cjs`;
- `shorts_generator/worker_contracts.py`.

The v1 contract includes analysis request/result, render request/result,
candidate information, HookGate decision, artifact manifest, and structured
error response.

Payloads contain opaque IDs and SHA-256 bindings. They never contain local
absolute paths, storage keys, credentials, or provider tokens. Each runtime
resolves its own opaque references after validation. Top-level objects are
strict; compatible additions use the `extensions` namespace. Breaking changes
require a new major schema directory and dual-version migration tests.

## Migration

The legacy motivational bridge remains supported until its upstream job
contains complete candidate timing and HookGate data. It must not fabricate
those fields from a candidate hash. Adoption order:

1. analysis produces a validated v1 `analysisResult`;
2. Node persists opaque candidate/artifact data;
3. human review selects an exact candidate;
4. Node emits a v1 `renderRequest`;
5. Python returns a v1 `renderResult` or `errorResponse`;
6. only then remove the legacy control-input envelope.

During migration, contract tests require the same fixture to pass in both
runtimes. Legacy payloads continue to be validated by their existing strict
validators.

## Consequences

- Runtime ownership is explicit and testable.
- Filesystem layout is no longer part of the public protocol.
- A vendored/root Python unification can happen behind the boundary.
- The bridge is not yet fully migrated; claiming otherwise would hide missing
  candidate timing data in the current Node job.
- No rendering or editorial behavior changes as part of this ADR.
