# OpenViking Adoption For MatchCuts AI

This project now has a local OpenViking-style brain under `viking-brain/`.

It implements the concepts requested by the user without requiring global Codex configuration, OpenViking server setup, API keys, or embedding/VLM provider configuration.

## What Is Applied

| OpenViking Concept | Local Implementation |
| --- | --- |
| Filesystem management paradigm | `viking-brain/resources`, `viking-brain/user/default/memories`, `viking-brain/agent/matchcuts-ai/skills` |
| Tiered context loading | `.abstract` = L0, `.overview` = L1, normal markdown/source references = L2 |
| Directory recursive retrieval | `node tools/openviking-lite.mjs find "query"` scores directories first, then files |
| Visualized retrieval trajectory | Every retrieval writes JSON and HTML under `viking-brain/trajectories/` |
| Automatic session management | `session-add` appends turns, `session-commit` compresses them into agent memories |

## Common Commands

```bash
npm run brain:init -- --refresh
npm run brain:tree -- --depth 4
npm run brain:find -- "upload validation idempotency export jobs"
npm run brain:health
```

Session self-iteration:

```bash
node tools/openviking-lite.mjs session-add --session launch-hardening --role user --text "Need safer exports and upload validation."
node tools/openviking-lite.mjs session-add --session launch-hardening --role assistant --text "Implemented validation, idempotency, status states, and tests."
node tools/openviking-lite.mjs session-commit --session launch-hardening
```

The committed memory will appear in:

```text
viking-brain/agent/matchcuts-ai/memories/sessions/
```

## Native OpenViking Upgrade Path

When you are ready to use the full OpenViking server:

1. Configure `ov.conf` with a VLM provider and embedding provider.
2. Run `openviking-server doctor`.
3. Start `openviking-server`.
4. Add this project as a resource:

```bash
ov add-resource "/Users/anastaseschatzedakes/Desktop/short form " --wait
ov tree viking://resources -L 3
ov find "upload validation idempotency export jobs"
```

5. Optional Codex integration: use `OpenViking/examples/codex-memory-plugin` after reviewing its hooks and MCP config.

I did not install the Codex plugin or write to `~/.openviking` because that would change global agent behavior. The local implementation is scoped to this workspace and safe to inspect.

## Notes

- The local retriever is lexical, not a full embedding/vector retriever.
- The trajectory files are still useful for debugging directory selection.
- The session commit is deterministic summarization, not model-based memory extraction.
- The directory structure is intentionally compatible with OpenViking's L0/L1/L2 mental model, so it can be migrated later.
