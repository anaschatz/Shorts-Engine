# Codex Plugin Reference

The cloned OpenViking repo includes `examples/codex-memory-plugin`.

Useful ideas:

- UserPromptSubmit can recall relevant memories.
- Stop can append turns to an OpenViking session.
- PreCompact can commit the session and extract long-term memory.
- Codex MCP can talk to OpenViking's `/mcp` endpoint when a server is configured.

This workspace implementation does not modify global Codex config. It keeps everything local under `viking-brain/`.
