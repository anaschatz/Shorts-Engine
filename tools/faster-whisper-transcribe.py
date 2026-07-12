#!/usr/bin/env python3
import argparse
import json
import pathlib
import re
import sys


def parser():
    value = argparse.ArgumentParser()
    value.add_argument("--probe", action="store_true")
    value.add_argument("--probe-model", action="store_true")
    value.add_argument("--audio")
    value.add_argument("--model", default="base")
    value.add_argument("--language", default="auto")
    value.add_argument("--device", default="cpu")
    value.add_argument("--compute-type", default="int8")
    value.add_argument("--cache-dir", required=True)
    return value


def main():
    args = parser().parse_args()

    if args.probe:
        from faster_whisper import WhisperModel  # noqa: F401
        print(json.dumps({"available": True}))
        return 0
    if args.probe_model:
        if args.model not in ("tiny", "base", "small"):
            return 2
        root = pathlib.Path(args.cache_dir).resolve()
        repository = root / f"models--Systran--faster-whisper-{args.model}"
        revision_file = repository / "refs" / "main"
        if not revision_file.is_file():
            return 1
        revision = revision_file.read_text(encoding="utf-8").strip()
        if not re.fullmatch(r"[a-f0-9]{40,64}", revision):
            return 1
        snapshot = repository / "snapshots" / revision
        required = {"config.json": 2, "model.bin": 1024 * 1024, "tokenizer.json": 2, "vocabulary.txt": 2}
        if any(not (snapshot / name).is_file() or (snapshot / name).stat().st_size < minimum for name, minimum in required.items()):
            return 1
        print(json.dumps({"available": True}))
        return 0
    if not args.audio:
        return 2

    from faster_whisper import WhisperModel
    model = WhisperModel(
        args.model,
        device=args.device,
        compute_type=args.compute_type,
        local_files_only=True,
        download_root=args.cache_dir,
    )
    language = None if args.language == "auto" else args.language
    segments, info = model.transcribe(
        args.audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    output_segments = []
    for segment in segments:
        words = []
        for word in segment.words or []:
            if word.start is None or word.end is None:
                continue
            words.append({
                "start": round(float(word.start), 3),
                "end": round(float(word.end), 3),
                "word": str(word.word).strip(),
                "probability": round(float(word.probability or 0), 4),
            })
        output_segments.append({
            "start": round(float(segment.start), 3),
            "end": round(float(segment.end), 3),
            "text": str(segment.text).strip(),
            "words": words,
        })
    print(json.dumps({
        "provider": "faster-whisper",
        "language": str(info.language or args.language),
        "languageProbability": round(float(info.language_probability or 0), 4),
        "segments": output_segments,
    }, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(type(error).__name__, file=sys.stderr)
        sys.exit(1)
