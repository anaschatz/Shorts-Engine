#!/usr/bin/env python3
"""Pinned-model live finalist evaluation with no production fallback."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Dict


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from shorts_generator.highlights import get_highlights
from shorts_generator.local.clipper import crop_highlights_local
from shorts_generator.local.llm import _response_schema_for_prompt
from shorts_generator.local.transcriber import _load_srt_cache
from shorts_generator.local.visual_features import analyze_candidate_visuals
from shorts_generator.ranker import eligible_highlights, rank_highlights


FIXTURE_PATH = ROOT / "research" / "fixtures" / "tutorial_airc.json"
CANDIDATE_CACHE_DIR = ROOT / "research" / "candidate-cache"
VISUAL_CACHE_DIR = ROOT / "research" / "visual-cache"


def _hash_bytes(*parts: bytes) -> str:
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part)
    return digest.hexdigest()


def _media_report(path: Path) -> Dict:
    probe = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries",
            "format=duration,size:stream=codec_name,width,height,pix_fmt",
            "-of", "json", str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    decode = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "null", "-"],
        capture_output=True,
        text=True,
    )
    return {
        "probe": json.loads(probe.stdout),
        "decode_ok": decode.returncode == 0,
        "decode_error": decode.stderr[-2000:] if decode.returncode else "",
    }


def run_live_eval(
    model: str,
    seed: int,
    run_dir: Path,
    render: bool = False,
    refresh: bool = False,
) -> Dict:
    from dotenv import load_dotenv
    from google import genai

    load_dotenv(ROOT / ".env")
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is missing")

    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    transcript_path = ROOT / fixture["video_metadata"]["transcript_cache"]
    video_path = ROOT / fixture["video_metadata"]["video_cache"]
    if not transcript_path.exists() or not video_path.exists():
        raise RuntimeError("Live fixture media cache is missing")
    transcript = _load_srt_cache(transcript_path)
    prompt_source = (ROOT / "shorts_generator" / "highlights.py").read_bytes()
    schema_source = (ROOT / "shorts_generator" / "local" / "llm.py").read_bytes()
    cache_key = _hash_bytes(
        transcript_path.read_bytes(),
        prompt_source,
        schema_source,
        model.encode("utf-8"),
        str(seed).encode("utf-8"),
    )
    CANDIDATE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    VISUAL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    candidate_cache = CANDIDATE_CACHE_DIR / f"{cache_key}.json"
    visual_cache = VISUAL_CACHE_DIR / f"{cache_key}.json"

    if candidate_cache.exists() and visual_cache.exists() and not refresh:
        generation = json.loads(candidate_cache.read_text(encoding="utf-8"))
        visual_candidates = json.loads(visual_cache.read_text(encoding="utf-8"))
        cache_hit = True
    else:
        client = genai.Client(api_key=key)

        def call_pinned(prompt: str) -> str:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config={
                    "temperature": 0,
                    "seed": seed,
                    "response_mime_type": "application/json",
                    "response_schema": _response_schema_for_prompt(prompt),
                    "max_output_tokens": 8192,
                    "thinking_config": {"thinking_level": "medium"},
                },
            )
            return response.text or ""

        generation = get_highlights(transcript, num_clips=3, llm_fn=call_pinned)
        visual_candidates = analyze_candidate_visuals(video_path.as_posix(), generation["highlights"])
        candidate_cache.write_text(json.dumps(generation, indent=2), encoding="utf-8")
        visual_cache.write_text(json.dumps(visual_candidates, indent=2), encoding="utf-8")
        cache_hit = False

    ranked = rank_highlights(
        visual_candidates,
        transcript,
        content_type=generation.get("content_info", {}).get("content_type", fixture["category"]),
    )
    selected = eligible_highlights(ranked, limit=1)
    if not selected:
        raise RuntimeError("Pinned model produced no eligible live candidate")

    selected_item = selected[0]
    accepted_ids = {item["id"] for item in fixture["accepted_intervals"]}
    accepted = any(
        float(selected_item["end_time"]) > float(interval["start"])
        and float(selected_item["start_time"]) < float(interval["end"])
        for interval in fixture["accepted_intervals"]
    )
    report = {
        "model": model,
        "seed": seed,
        "cache_key": cache_key,
        "cache_hit": cache_hit,
        "selected": selected_item,
        "accepted": accepted,
        "reference_accepted_ids": sorted(accepted_ids),
        "render": None,
    }

    if render:
        render_dir = run_dir / "render"
        render_dir.mkdir(parents=True, exist_ok=True)
        rendered = crop_highlights_local(
            video_path.as_posix(),
            selected,
            transcript=transcript,
            out_dir=render_dir.as_posix(),
        )
        output_path = Path(rendered[0]["clip_url"])
        report["render"] = {
            "path": str(output_path),
            **_media_report(output_path),
        }
    return report
