# Session Memory: Operator-Approved Source Cache

## Date

2026-07-04

## Context

The previous live YouTube proof reached real downloader progress but still failed with a bounded long-source timeout. The safe next step was not cookies or scraping, but an operator-approved source cache for rights-cleared MP4 sources keyed by YouTube `videoId`.

## Decisions

- Added a local source cache adapter under the source acquisition boundary.
- Kept cache disabled by default and gated by `SHORTSENGINE_SOURCE_CACHE_ENABLED`.
- Required normal YouTube URL validation and rights confirmation before cache lookup.
- Copied cache hits into managed staging before upload/media validation and artifact commit.
- Preserved downloader fallback for cache miss only; invalid/corrupt/checksum-mismatched cache files fail closed.
- Kept public reports limited to safe cache diagnostics and checksum hashes.

## Validation Notes

Focused tests passed for YouTube ingest, YouTube runtime doctor/smoke contracts and environment readiness. The new tests cover cache disabled defaults, unsafe cache dirs, cache hit, cache miss fallback, checksum mismatch, corrupt cache rejection, no records on failure and safe source-cache doctor readiness.

## Limitation

This does not acquire source media automatically, bypass platform restrictions, store credentials or solve long-source OCR/render quality by itself. It only provides a safe authorized source backend so the existing render pipeline can continue after source acquisition.
