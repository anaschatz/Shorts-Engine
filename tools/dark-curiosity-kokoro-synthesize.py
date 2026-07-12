#!/usr/bin/env python3
"""Bounded stdin-to-WAV helper for the managed local Kokoro runtime."""

import json
import os
import sys
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


def main():
    try:
        payload = json.loads(sys.stdin.read(8192))
    except Exception:
        fail("KOKORO_INPUT_INVALID")
    if not isinstance(payload, dict) or set(payload) != {"text", "voice", "speed", "language", "modelPath", "voicesPath", "outputPath"}:
        fail("KOKORO_INPUT_INVALID")
    text = str(payload["text"]).strip()
    voice = str(payload["voice"]).strip().lower()
    language = str(payload["language"]).strip().lower()
    try:
        speed = float(payload["speed"])
    except Exception:
        fail("KOKORO_INPUT_INVALID")
    if not text or len(text) > 4096 or voice not in ALLOWED_VOICES or language not in {"en", "en-us", "en-gb"} or speed < 0.5 or speed > 2.0:
        fail("KOKORO_INPUT_INVALID")
    model_path = Path(str(payload["modelPath"])).resolve()
    voices_path = Path(str(payload["voicesPath"])).resolve()
    output_path = Path(str(payload["outputPath"])).resolve()
    if not model_path.is_file() or not voices_path.is_file() or output_path.suffix.lower() != ".wav" or not output_path.parent.is_dir():
        fail("KOKORO_RUNTIME_INVALID")
    try:
        import soundfile as sf
        from kokoro_onnx import Kokoro

        kokoro = Kokoro(str(model_path), str(voices_path))
        samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us" if language != "en-gb" else "en-gb")
        sf.write(str(output_path), samples, sample_rate, format="WAV", subtype="PCM_16")
        if not output_path.is_file() or output_path.stat().st_size <= 44:
            fail("KOKORO_AUDIO_INVALID")
        sys.stdout.write(json.dumps({"status": "complete", "sampleRate": int(sample_rate), "bytes": output_path.stat().st_size}) + "\n")
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
