# Reference Fixture Contracts

`eval/reference-fixtures/*.json` are deterministic reference-style analysis fixtures used by `npm run eval:reference`.
They must keep the existing transcript/media/expected schema so the offline eval runner can load every JSON file in this directory.

For live generated-video comparison, use `eval/reference-comparison-fixtures/*.json`.
Those fixtures describe reference expectations such as:

- reference id and title
- optional HTTPS source URL
- optional safe local reference video ref
- expected duration and aspect ratio
- expected counted-goal behavior
- expected pacing, captions, transitions and phase coverage
- pass thresholds for the generated short

Reference comparison fixtures must not download, store or require external copyrighted videos.
If an operator provides a local reference video, keep it as a safe relative path under an ignored directory such as `manual-downloads/`.
