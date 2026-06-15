# OpenViking Concepts Used

Filesystem paradigm:

- `viking://resources/` maps to durable source material.
- `viking://user/default/memories/` maps to user preferences and goals.
- `viking://agent/matchcuts-ai/skills/` maps to reusable procedures.

Tiered context:

- L0: `.abstract`, a one-sentence relevance signal.
- L1: `.overview`, a compact planning summary.
- L2: detailed markdown files or direct source files opened only when needed.

Retrieval:

- Analyze query tokens.
- Score directory L0/L1 content.
- Descend recursively into high-signal branches.
- Score L2 files.
- Write trace JSON and HTML for observability.

Session:

- Append conversation turns.
- Commit session into long-term memories.
- Keep raw transcript and extracted memory linked.
