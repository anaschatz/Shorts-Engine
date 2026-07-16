#!/usr/bin/env python3
"""Bounded stdin-to-WAV helper for the managed local Kokoro runtime."""

import json
import math
import sys
import wave
from array import array
from pathlib import Path


ALLOWED_VOICES = {
    "af_alloy", "af_aoede", "af_bella", "af_heart", "af_jessica", "af_kore",
    "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky", "am_adam",
    "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx",
    "am_puck", "bf_alice", "bf_emma", "bf_isabella", "bf_lily", "bm_daniel",
    "bm_fable", "bm_george", "bm_lewis",
}


def fail(code):
    sys.stderr.write(json.dumps({"status": "failed", "code": code}) + "\n")
    raise SystemExit(1)


def normalize_segments(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 16:
        fail("KOKORO_INPUT_INVALID")
    segments = []
    total_characters = 0
    for item in value:
        if not isinstance(item, dict) or set(item) != {"text", "speed", "pauseAfterMs"}:
            fail("KOKORO_INPUT_INVALID")
        text = str(item["text"]).strip()
        try:
            speed = float(item["speed"])
        except Exception:
            fail("KOKORO_INPUT_INVALID")
        if not isinstance(item["pauseAfterMs"], int) or isinstance(item["pauseAfterMs"], bool):
            fail("KOKORO_INPUT_INVALID")
        pause_after_ms = item["pauseAfterMs"]
        if not text or len(text) > 1000 or speed < 0.5 or speed > 2.0 or pause_after_ms < 0 or pause_after_ms > 1500:
            fail("KOKORO_INPUT_INVALID")
        total_characters += len(text)
        segments.append({"text": text, "speed": speed, "pauseAfterMs": pause_after_ms})
    if total_characters > 4096:
        fail("KOKORO_INPUT_INVALID")
    return segments


def trim_segment(samples, sample_rate):
    try:
        values = array("f", (float(sample) for sample in samples))
    except Exception:
        fail("KOKORO_AUDIO_INVALID")
    if not values or any(not math.isfinite(sample) for sample in values):
        fail("KOKORO_AUDIO_INVALID")
    threshold = 0.001
    first = next((index for index, sample in enumerate(values) if abs(sample) >= threshold), None)
    if first is None:
        fail("KOKORO_AUDIO_INVALID")
    last = next(index for index in range(len(values) - 1, -1, -1) if abs(values[index]) >= threshold)
    edge_padding = round(sample_rate * 0.04)
    start = max(0, first - edge_padding)
    end = min(len(values), last + 1 + edge_padding)
    trimmed = array("f", values[start:end])
    fade_samples = min(round(sample_rate * 0.008), len(trimmed) // 2)
    if fade_samples > 1:
        denominator = fade_samples - 1
        for index in range(fade_samples):
            gain = index / denominator
            trimmed[index] *= gain
            trimmed[-1 - index] *= gain
    return trimmed


def pcm16(samples):
    output = array("h")
    for sample in samples:
        bounded = max(-1.0, min(1.0, float(sample)))
        output.append(-32768 if bounded <= -1.0 else 32767 if bounded >= 1.0 else round(bounded * 32767))
    if sys.byteorder != "little":
        output.byteswap()
    return output


def main():
    try:
        payload = json.loads(sys.stdin.read(16384))
    except Exception:
        fail("KOKORO_INPUT_INVALID")
    if not isinstance(payload, dict) or set(payload) != {"segments", "voice", "language", "modelPath", "voicesPath", "outputPath"}:
        fail("KOKORO_INPUT_INVALID")
    segments = normalize_segments(payload["segments"])
    voice = str(payload["voice"]).strip().lower()
    language = str(payload["language"]).strip().lower()
    if voice not in ALLOWED_VOICES or language not in {"en", "en-us", "en-gb"}:
        fail("KOKORO_INPUT_INVALID")
    model_path = Path(str(payload["modelPath"])).resolve()
    voices_path = Path(str(payload["voicesPath"])).resolve()
    output_path = Path(str(payload["outputPath"])).resolve()
    if not model_path.is_file() or not voices_path.is_file() or output_path.suffix.lower() != ".wav" or not output_path.parent.is_dir():
        fail("KOKORO_RUNTIME_INVALID")
    try:
        from kokoro_onnx import Kokoro

        kokoro = Kokoro(str(model_path), str(voices_path))
        combined = array("f")
        sample_rate = None
        pause_ranges = []
        for segment in segments:
            samples, current_rate = kokoro.create(segment["text"], voice=voice, speed=segment["speed"], lang="en-us" if language != "en-gb" else "en-gb")
            current_rate = int(current_rate)
            if current_rate < 8000 or current_rate > 192000 or (sample_rate is not None and current_rate != sample_rate):
                fail("KOKORO_AUDIO_INVALID")
            sample_rate = current_rate
            combined.extend(trim_segment(samples, sample_rate))
            pause_samples = round(sample_rate * segment["pauseAfterMs"] / 1000)
            pause_ranges.append({"startSample": len(combined), "sampleCount": pause_samples})
            if pause_samples:
                combined.extend(array("f", [0.0]) * pause_samples)
        if sample_rate is None or not combined:
            fail("KOKORO_AUDIO_INVALID")
        with wave.open(str(output_path), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(sample_rate)
            wav.writeframes(pcm16(combined).tobytes())
        if not output_path.is_file() or output_path.stat().st_size <= 44:
            fail("KOKORO_AUDIO_INVALID")
        sys.stdout.write(json.dumps({"status": "complete", "sampleRate": sample_rate, "bytes": output_path.stat().st_size, "segmentCount": len(segments), "totalPauseMs": sum(segment["pauseAfterMs"] for segment in segments), "totalPauseSamples": sum(item["sampleCount"] for item in pause_ranges), "pauseRanges": pause_ranges}) + "\n")
    except SystemExit:
        raise
    except Exception:
        try:
            output_path.unlink(missing_ok=True)
        except Exception:
            pass
        fail("KOKORO_SYNTHESIS_FAILED")


if __name__ == "__main__":
    main()
