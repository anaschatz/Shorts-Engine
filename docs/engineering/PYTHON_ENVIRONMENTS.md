# Python environments

Supported verification runtime: CPython 3.13.

Create a development environment:

```text
python3.13 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements-dev.txt
```

Dependency groups:

- `requirements-core.txt`: offline evaluation, contracts, configuration, and
  non-rendering runtime work;
- `requirements-local-video.txt`: local download, transcription, OpenCV,
  rendering, and provider integrations;
- `requirements-dev.txt`: the complete local test environment;
- `requirements.txt` and `requirements-local.txt`: compatibility entrypoints
  that compose the new groups.

Verification:

```text
.venv/bin/python -m unittest discover -s tests -v
.venv/bin/python scripts/run_python_tests_isolated.py
.venv/bin/python research/eval.py
```

For a lightweight offline-only check, install only
`requirements-core.txt`. Importing `research.runner` in this environment does
not import live evaluation, NumPy, or OpenCV.
