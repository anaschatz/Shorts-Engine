#!/usr/bin/env python3
"""Match edited video timestamps back to source timestamps using audio correlation."""

import argparse
import json
import subprocess

import numpy as np
from scipy.signal import fftconvolve


def decode_audio(path, sample_rate):
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1",
            "-ar", str(sample_rate), "-f", "f32le", "pipe:1",
        ],
        check=True,
        stdout=subprocess.PIPE,
    )
    return np.frombuffer(result.stdout, dtype=np.float32)


def normalized_match(source, template):
    template = template.astype(np.float64)
    template -= template.mean()
    template_energy = np.sum(template * template)
    correlation = fftconvolve(source, template[::-1], mode="valid")
    cumulative = np.concatenate(([0.0], np.cumsum(source, dtype=np.float64)))
    cumulative_sq = np.concatenate(([0.0], np.cumsum(source * source, dtype=np.float64)))
    size = len(template)
    sums = cumulative[size:] - cumulative[:-size]
    sums_sq = cumulative_sq[size:] - cumulative_sq[:-size]
    source_energy = np.maximum(sums_sq - sums * sums / size, 1e-12)
    scores = correlation / np.sqrt(source_energy * max(template_energy, 1e-12))
    index = int(np.argmax(scores))
    return index, float(scores[index])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--edit", required=True)
    parser.add_argument("--edit-times", required=True)
    parser.add_argument("--window", type=float, default=2.0)
    parser.add_argument("--sample-rate", type=int, default=2000)
    args = parser.parse_args()

    source = decode_audio(args.source, args.sample_rate)
    edit = decode_audio(args.edit, args.sample_rate)
    half_window = args.window / 2.0
    matches = []
    for raw_time in args.edit_times.split(","):
        edit_time = float(raw_time)
        start = max(0, round((edit_time - half_window) * args.sample_rate))
        finish = min(len(edit), start + round(args.window * args.sample_rate))
        template = edit[start:finish]
        match_index, score = normalized_match(source, template)
        matches.append({
            "editTime": edit_time,
            "sourceTime": round((match_index + len(template) / 2) / args.sample_rate, 3),
            "score": round(score, 5),
        })
    print(json.dumps(matches, indent=2))


if __name__ == "__main__":
    main()
