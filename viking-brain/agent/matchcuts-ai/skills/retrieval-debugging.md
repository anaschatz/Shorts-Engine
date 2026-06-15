# Skill: Retrieval Debugging

Use when a search returns wrong or noisy context.

Steps:

1. Open the latest file in `viking-brain/trajectories/`.
2. Check which directories scored highest.
3. Inspect whether `.abstract` or `.overview` is misleading.
4. Tighten directory summaries before changing detailed files.
5. Re-run `npm run brain:find -- "query"`.
