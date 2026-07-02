# Optional Agent Tooling

ShortsEngine keeps third-party agent tools outside the production runtime. The local checkouts are useful references and optional operator tools, but they are not committed, not installed automatically and not required for CI or local demos.

Run:

```bash
npm run agent:tools:doctor
```

The doctor performs read-only checks and prints safe JSON. It verifies that the expected local checkouts exist, point at the expected GitHub remotes, include their manifests and have a recognized license. It does not install packages, call remote APIs, mutate repositories, read secrets or include absolute local paths.

## Ruflo

Local checkout:

```text
ruflo/
```

Source:

```text
https://github.com/ruvnet/ruflo.git
```

Use Ruflo as an optional workflow and agent-harness reference for larger planning, review and production-hardening milestones. Do not run `npx ruflo init`, install hooks or create assistant config files inside ShortsEngine unless the operator explicitly asks for that change in a dedicated milestone.

Safe default:

```bash
npm run agent:tools:doctor
```

Operator-only exploration:

```bash
npx ruflo@latest --help
```

## Graphify

Local checkout:

```text
graphify/
```

Source:

```text
https://github.com/safishamsi/graphify.git
```

Use Graphify as an optional knowledge-graph tool for architecture review and codebase navigation. Generated output should stay in `graphify-out/`, which is ignored by git. Do not commit graph exports unless a future milestone explicitly defines a small, safe, reviewed artifact contract.

Safe default:

```bash
npm run agent:tools:doctor
```

Operator-only graph run:

```bash
uvx --from graphifyy graphify .
```

This can download Python dependencies and may read a large portion of the repo, so it should remain an explicit operator action. Do not run it in CI or release gates by default.

## Safety Rules

- No hardcoded secrets.
- No automatic installs.
- No automatic assistant hook installation.
- No third-party generated reports in release gates by default.
- No raw command output, tokens, local absolute paths or generated graph artifacts in public reports.
- Treat both tools as optional development aids until a milestone promotes a specific adapter or report contract.
