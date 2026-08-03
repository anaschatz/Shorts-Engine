# HookGate V2/V3 governed dataset

`research/hookgate_benchmark.py` compares V2 and V3 only after validating a
versioned dataset of at least 30 consecutive real projects.

The dataset must:

- contain football, motivational, and narrated-animation projects;
- include both train and evaluation splits;
- be collected consecutively, not only from successful or selected outputs;
- use SHA-256 project and reviewer keys rather than identities, paths, URLs, or
  filenames;
- contain human-accepted candidates and pairwise preferences;
- record ranking, boundary completeness, caption readability, visual subject
  coverage, attribution failures, latency, and estimated cost for both V2 and
  V3.

Run:

```text
python research/hookgate_benchmark.py --dataset /safe/path/dataset.json --pretty
```

The committed test data is synthetic and exists only to test the validator and
metric formulas. It is never accepted or reported as product-quality evidence.
No real dataset is committed because it has not yet been collected and
anonymized.
