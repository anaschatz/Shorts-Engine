#!/usr/bin/env python3
"""Acquire an allowlisted Faster-Whisper model into a managed local cache."""
import argparse
import json
import pathlib

from faster_whisper import WhisperModel


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=("tiny", "base", "small"), required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--device", choices=("cpu",), default="cpu")
    parser.add_argument("--compute-type", choices=("int8",), default="int8")
    args = parser.parse_args()
    cache = pathlib.Path(args.cache_dir).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    WhisperModel(args.model, device=args.device, compute_type=args.compute_type, download_root=str(cache))
    print(json.dumps({"status": "ready", "model": args.model, "device": args.device, "computeType": args.compute_type}))


if __name__ == "__main__":
    main()
