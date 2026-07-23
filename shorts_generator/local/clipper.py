"""Local clipping: ffmpeg subclip + OpenCV face-aware vertical crop.

Two stages per highlight:
  1. Cut the source video to [start, end] with ffmpeg (re-encoded, audio kept).
  2. Reframe the cut to the target aspect ratio. For 9:16 we slide a vertical
     window horizontally across the frame to keep faces centred (Haar
     cascade — same approach as the original repo, no external models).
"""
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import tempfile
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Lock, get_ident
from typing import Dict, List, Optional, Tuple

from ..config import (
    LOCAL_CACHE_DIR,
    LOCAL_AUDIO_BITRATE,
    LOCAL_AUDIO_LOUDNESS,
    LOCAL_AUDIO_TRUE_PEAK,
    LOCAL_CAPTION_LEAD_MS,
    LOCAL_MOTIVATIONAL_MUSIC,
    LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS,
    LOCAL_MOTIVATIONAL_MUSIC_PROFILE,
    LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS,
    LOCAL_MOTIVATIONAL_MUSIC_TRACK,
    LOCAL_OUTPUT_DIR,
    LOCAL_OUTPUT_HEIGHT,
    LOCAL_OUTPUT_FPS,
    LOCAL_OUTPUT_WIDTH,
    LOCAL_REAL_ESRGAN,
    LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES,
    LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE,
    LOCAL_REAL_ESRGAN_MODEL,
    LOCAL_REAL_ESRGAN_PATH,
    LOCAL_REAL_ESRGAN_REFERENCE_BLEND,
    LOCAL_RENDER_WORKERS,
    LOCAL_VIDEO_CRF,
    LOCAL_VIDEO_PRESET,
    LOCAL_VIDEO_PROFILE,
    LOCAL_WORK_DIR,
)
from ..profiles import (
    BF_EDITORIAL_INSET_V1,
    BF_EDITORIAL_INSET_V2,
    BF_NATURAL_TAIL_V6,
    BF_REFERENCE_TAIL_V2,
    BF_SMOOTH_TAIL_V3,
    BF_SMOOTH_TAIL_V4,
    BF_SMOOTH_TAIL_V5,
    BUDGET_FRIENDLY_CAPTION_STYLE,
    MOTIVATIONAL_MUSIC_DRIVING,
    MOTIVATIONAL_MUSIC_REFLECTIVE,
    MOTIVATIONAL_MUSIC_WARM,
)


CAPTION_FONT_SIZE = 50
CAPTION_MIN_FONT_SIZE = 18
CAPTION_FILL = (255, 221, 0)
CAPTION_INACTIVE_FILL = (255, 255, 255)
CAPTION_STROKE_FILL = (0, 0, 0)
CAPTION_MAX_WIDTH_RATIO = 0.86
CAPTION_VERTICAL_POSITION_RATIO = 0.72
CAPTION_SPLIT_VERTICAL_POSITION_RATIO = 0.52
MOTIVATIONAL_CAPTION_VERTICAL_POSITION_RATIO = 0.50
CAPTION_MIN_ACTIVE_SECONDS = 0.12
CAPTION_MIN_GROUP_SECONDS = 0.22
CAPTION_VISUAL_LEAD_SECONDS = LOCAL_CAPTION_LEAD_MS / 1000.0
MOTIVATIONAL_MIN_REVEAL_SECONDS = 0.09
MOTIVATIONAL_MIN_PHRASE_SECONDS = 0.72
MOTIVATIONAL_CAPTION_VISUAL_LEAD_SECONDS = 0.0
MOTIVATIONAL_WORD_REVEAL_PROGRESS = 0.40
MOTIVATIONAL_MIN_WORD_REVEAL_DELAY_SECONDS = 0.04
MOTIVATIONAL_MAX_WORD_REVEAL_DELAY_SECONDS = 0.10
MOTIVATIONAL_MIN_VISIBLE_PHRASE_SECONDS = 0.68
MOTIVATIONAL_MIN_COMPLETE_PHRASE_SECONDS = 0.28
MOTIVATIONAL_MAX_COMPLETE_PHRASE_SECONDS = 0.52
MOTIVATIONAL_SEMANTIC_ANCHOR_HOLD_SECONDS = 0.50
MOTIVATIONAL_MAX_HANDOFF_OVERLAP_SECONDS = 0.0
MOTIVATIONAL_PHRASE_HOLD_SECONDS = 0.42
MOTIVATIONAL_HANDOFF_GAP_SECONDS = 0.04
MOTIVATIONAL_MAX_HANDOFF_GAP_SECONDS = 0.10
MOTIVATIONAL_SENTENCE_HOLD_SECONDS = 0.65
MOTIVATIONAL_TRACK_POSITIONS = (0.40, 0.50, 0.60)
MOTIVATIONAL_CAPTION_BLOCK_GAP = 8
MOTIVATIONAL_MAX_HERO_PHRASES = 4
BF_EDITORIAL_INSET_RENDER_PROFILE = BF_EDITORIAL_INSET_V1
BF_EDITORIAL_INSET_LAYOUT = "editorial_inset"
BF_EDITORIAL_INSET_MAX_WIDTH_RATIO = 0.94
BF_EDITORIAL_INSET_MAX_HEIGHT_RATIO = 0.36
BF_EDITORIAL_INSET_CORNER_RADIUS_RATIO = 0.18
BF_EDITORIAL_MIN_PHRASE_WORDS = 1
BF_EDITORIAL_MAX_PHRASE_WORDS = 4
BF_EDITORIAL_HERO_SCALE_MIN = 1.8
BF_EDITORIAL_HERO_SCALE_MAX = 2.4
BF_EDITORIAL_REACTION_SCALE_MAX = 4.0
BF_EDITORIAL_KINETIC_ENTRY_SECONDS = 0.12
BF_EDITORIAL_KINETIC_EXIT_SECONDS = 0.12
BF_EDITORIAL_YOUTUBE_TAIL_SECONDS = 1.25
BF_EDITORIAL_YOUTUBE_TAIL_MIN_SECONDS = 1.15
BF_EDITORIAL_YOUTUBE_TAIL_MAX_SECONDS = 1.35
BF_EDITORIAL_SMOOTH_TAIL_SECONDS = 0.85
BF_EDITORIAL_SMOOTH_TAIL_MIN_SECONDS = 0.80
BF_EDITORIAL_SMOOTH_TAIL_MAX_SECONDS = 0.90
BF_EDITORIAL_MAX_NATURAL_TAIL_SECONDS = 0.75
BF_EDITORIAL_NEXT_SPEECH_SAFETY_SECONDS = 0.04
BF_EDITORIAL_TAIL_CROSSFADE_SECONDS = 0.30
# v3 shipped with a 200ms visual fade. v4/v5 use a shorter 130ms fade.
BF_EDITORIAL_SMOOTH_V3_VISUAL_FADE_SECONDS = 0.20
BF_EDITORIAL_SMOOTH_VISUAL_FADE_SECONDS = 0.13
# When a verified visual guard ends before the verified next-speech guard,
# v5 may repeat only the final safe frame for this sub-perceptual interval.
# At 30fps the cap is fewer than three frames, never the old 0.5s freeze.
BF_EDITORIAL_V5_MAX_SETTLE_HOLD_SECONDS = 0.08
BF_EDITORIAL_SMOOTH_AUDIO_FADE_SECONDS = 0.04
BF_EDITORIAL_SMOOTH_MUSIC_RELEASE_SECONDS = 0.18
BF_EDITORIAL_OUTPUT_MAX_SECONDS = 24.50
BF_GROWTH_V2_OUTPUT_MAX_SECONDS = 31.50
BF_EDITORIAL_AUDIO_DECLICK_SECONDS = 0.012
BF_EDITORIAL_BRAND_MARK = "BF."
BF_EDITORIAL_OUTPUT_FPS = 30.0
CAPTION_MAX_PHRASE_WORDS = 6
CAPTION_MIN_PHRASE_WORDS = 3
CAPTION_FORBIDDEN_ENDINGS = {
    "a", "an", "and", "any", "are", "at", "be", "by", "each", "for", "from",
    "in", "into", "is", "no", "not", "of", "on", "or", "our", "some", "that",
    "the", "this", "to", "very", "was", "were", "with",
}
MAX_OPENING_DEAD_AIR_SECONDS = 0.60
OPENING_SPEECH_LEAD_SECONDS = 0.45
CAPTION_FONT_CANDIDATES = (
    "Impact",
    "Montserrat Black",
    "Arial Black",
    "DejaVu Sans Bold",
)
MOTIVATIONAL_CAPTION_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Black.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "Montserrat ExtraBold",
    "Arial Black",
    "Helvetica Neue Bold",
    "Impact",
)
MOTIVATIONAL_SUPPORT_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/HelveticaNeue.ttc",
    "Helvetica Neue Bold",
    "Arial Bold",
    "DejaVu Sans Bold",
)
MOTIVATIONAL_ACCENT_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf",
    "Georgia Bold Italic",
    "Times New Roman Bold Italic",
    "Baskerville Bold Italic",
    "DejaVu Serif Bold Italic",
)
MOTIVATIONAL_SCRIPT_FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/SignPainter.ttc",
    "SignPainter",
    "Snell Roundhand",
    "Brush Script MT",
    "Apple Chancery",
)
MOTIVATIONAL_IMPACT_WORDS = {
    "believe", "boundaries", "change", "choose",
    "consequences", "continue", "dream", "enough", "failure", "fear",
    "focus", "freedom", "future", "hard", "harder", "hardest", "life",
    "matter", "matters",
    "never", "power", "present", "protect", "right", "standards",
    "success", "truth", "wrong",
}
BF_EDITORIAL_REACTION_WORDS = {
    "amazing", "crazy", "damn", "exactly", "fuck", "fucking", "holy",
    "insane", "no", "really", "unbelievable", "what", "whoa", "wow", "yes",
}
MOTIVATIONAL_CONNECTOR_WORDS = {
    "and", "because", "but", "if", "so", "then", "when", "while",
}
MOTIVATIONAL_CONTRAST_WORDS = {
    "against", "but", "except", "instead", "never", "not", "only",
    "otherwise", "rather", "unlike", "versus", "vs", "without",
}
MOTIVATIONAL_INTENSIFIER_WORDS = {
    "absolutely", "deeply", "extremely", "really", "so", "truly", "very",
}
MOTIVATIONAL_REFLECTIVE_ANCHOR_WORDS = {
    "believe", "belief", "dream", "faith", "freedom", "future", "hope",
    "identity", "life", "love", "meaning", "purpose", "soul", "truth",
    "value", "values", "worth",
}
MOTIVATIONAL_GENERIC_ANCHOR_WORDS = {
    "actually", "also", "do", "doing", "going", "got", "know", "mean",
    "let", "said", "say", "saying", "tell", "thing", "things", "think",
    "went",
}
MOTIVATIONAL_CAPTION_STOP_WORDS = CAPTION_FORBIDDEN_ENDINGS | {
    "about", "actually", "also", "am", "been", "being", "can", "could",
    "did", "does", "doing", "going", "got", "had", "has", "have", "he",
    "her", "here", "him", "his", "how", "i", "i'm", "i've", "just",
    "like", "me", "more", "my", "really", "she", "should", "something",
    "there", "they", "they're", "thing", "things", "think", "those",
    "through", "too", "very", "we", "we're", "what", "when", "where",
    "which", "who", "why", "will", "would", "you", "you're", "your",
}
MOTIVATIONAL_DANGLING_ENDINGS = CAPTION_FORBIDDEN_ENDINGS | {
    "he", "her", "him", "his", "i", "i'm", "it", "it's", "its", "me", "my",
    "she", "that's", "their", "them", "there's", "they", "they're", "us",
    "we", "we're", "you", "you're", "your",
}
MOTIVATIONAL_CONTEXT_FIELDS = (
    ("title", 6.0),
    ("topic", 5.0),
    ("hook_sentence", 4.0),
    ("final_takeaway_sentence", 4.0),
    ("thesis", 3.0),
    ("context_summary", 1.0),
)
FACECAM_SAMPLE_COUNT = 18
FACECAM_MIN_SAMPLE_RATIO = 0.45
FACECAM_MIN_AREA_RATIO = 0.0008
FACECAM_MAX_AREA_RATIO = 0.08
FACECAM_EDGE_RATIO = 0.38
SPLIT_GAMEPLAY_HEIGHT_RATIO = 0.60
GAMEPLAY_CENTER_MIN_X_RATIO = 0.30
GAMEPLAY_CENTER_MAX_X_RATIO = 0.70
MOTION_TARGET_MIN_X_RATIO = 0.20
MOTION_TARGET_MAX_X_RATIO = 0.80
PRESENTATION_VISUAL_HEIGHT_RATIO = 0.64
PRESENTATION_MARGIN_X_RATIO = 0.02
PRESENTATION_MARGIN_Y_RATIO = 0.03
ENDING_FADE_SECONDS = 0.10
MOTIVATIONAL_MUSIC_FADE_IN_SECONDS = 0.35
MOTIVATIONAL_MUSIC_FADE_OUT_SECONDS = 0.80
MOTIVATIONAL_MUSIC_PROFILE_SETTINGS = {
    MOTIVATIONAL_MUSIC_REFLECTIVE: {
        "filename": "mixkit-forest-mist-whispers-148.mp3",
        "start_seconds": 18.0,
        "gains": (0.48, 0.72, 0.50, 1.00),
    },
    MOTIVATIONAL_MUSIC_DRIVING: {
        "filename": "mixkit-driving-ambition-32.mp3",
        "start_seconds": 6.0,
        "gains": (0.52, 0.76, 0.54, 1.02),
    },
    MOTIVATIONAL_MUSIC_WARM: {
        "filename": "mixkit-i-believe-in-us-1030.mp3",
        "start_seconds": 8.0,
        "gains": (0.50, 0.74, 0.52, 0.96),
    },
}
FACE_DETECTION_HZ = 5.0
REAL_ESRGAN_BATCH_FRAMES = max(
    8,
    min(480, int(os.getenv("LOCAL_REAL_ESRGAN_BATCH_FRAMES", "360"))),
)
REAL_ESRGAN_CACHE_ENABLED = os.getenv(
    "LOCAL_REAL_ESRGAN_CACHE",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
REAL_ESRGAN_SHARED_PREWARM_ENABLED = os.getenv(
    "LOCAL_REAL_ESRGAN_SHARED_PREWARM",
    "false",
).strip().lower() in {"1", "true", "yes", "on"}
REAL_ESRGAN_CACHE_DIR = Path(
    os.getenv(
        "LOCAL_REAL_ESRGAN_CACHE_DIR",
        str(Path(LOCAL_CACHE_DIR) / "realesrgan-v2"),
    )
).expanduser()
REAL_ESRGAN_CACHE_MAX_BYTES = max(
    512 * 1024 * 1024,
    int(float(os.getenv("LOCAL_REAL_ESRGAN_CACHE_MAX_GB", "8")) * 1024**3),
)
REAL_ESRGAN_CACHE_SCHEMA = "realesrgan-frame-v2"
VISUAL_ANALYSIS_CACHE_ENABLED = os.getenv(
    "LOCAL_VISUAL_ANALYSIS_CACHE",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
VISUAL_ANALYSIS_CACHE_DIR = Path(
    os.getenv(
        "LOCAL_VISUAL_ANALYSIS_CACHE_DIR",
        str(Path(LOCAL_CACHE_DIR) / "visual-analysis-v1"),
    )
).expanduser()
VISUAL_ANALYSIS_CACHE_SCHEMA = "visual-analysis-v1"
LOSSLESS_CUT_CACHE_ENABLED = os.getenv(
    "LOCAL_LOSSLESS_CUT_CACHE",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
LOSSLESS_CUT_CACHE_DIR = Path(
    os.getenv(
        "LOCAL_LOSSLESS_CUT_CACHE_DIR",
        str(Path(LOCAL_CACHE_DIR) / "lossless-cuts-v1"),
    )
).expanduser()
LOSSLESS_CUT_CACHE_MAX_BYTES = max(
    2 * 1024**3,
    int(float(os.getenv("LOCAL_LOSSLESS_CUT_CACHE_MAX_GB", "20")) * 1024**3),
)
LOSSLESS_CUT_CACHE_SCHEMA = "lossless-cut-v1"

BBox = Tuple[int, int, int, int]
_REAL_ESRGAN_PROCESS_LOCK = Lock()


def _local_temporary_directory(prefix: str):
    """Create heavy frame staging outside cloud-backed project folders."""
    work_dir = Path(LOCAL_WORK_DIR)
    work_dir.mkdir(parents=True, exist_ok=True)
    return tempfile.TemporaryDirectory(prefix=prefix, dir=str(work_dir))


def _run_realesrgan_process(command: List[str]):
    """Keep GPU inference serialized while CPU/IO work overlaps across clips."""
    with _REAL_ESRGAN_PROCESS_LOCK:
        return subprocess.run(
            command,
            capture_output=True,
            text=True,
        )


def _is_bf_editorial_profile(value: Optional[str]) -> bool:
    """Return whether a value selects the versioned inset renderer."""
    return str(value or "").strip().lower() in {
        BF_EDITORIAL_INSET_V1,
        BF_EDITORIAL_INSET_V2,
    }


def _uses_editorial_caption_style(
    caption_style: Optional[str],
    render_profile: Optional[str] = None,
) -> bool:
    """Keep legacy editorial captions while allowing the new renderer explicitly."""
    return (
        caption_style == BUDGET_FRIENDLY_CAPTION_STYLE
        or _is_bf_editorial_profile(caption_style)
        or _is_bf_editorial_profile(render_profile)
    )


def _word_timings_for_segment(segment: Dict) -> List[Dict]:
    """Return only measured Whisper word timings."""
    exact_words = segment.get("words")
    if isinstance(exact_words, list):
        cleaned = []
        for word in exact_words:
            if not isinstance(word, dict):
                continue
            text = str(word.get("word") or word.get("text") or "").strip()
            try:
                start = float(word["start"])
                end = float(word["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if text and end > start:
                cleaned.append({"text": text, "start": start, "end": end})
        if cleaned:
            return cleaned
    return []


def _trim_opening_dead_air(
    transcript: Optional[Dict],
    clip_start: float,
    clip_end: float,
    max_dead_air_seconds: float = MAX_OPENING_DEAD_AIR_SECONDS,
    speech_lead_seconds: float = OPENING_SPEECH_LEAD_SECONDS,
) -> float:
    if not transcript:
        return clip_start
    starts = [
        float(word["start"])
        for segment in transcript.get("segments", [])
        for word in _word_timings_for_segment(segment)
        if float(word["end"]) > clip_start and float(word["start"]) < clip_end
    ]
    if not starts:
        return clip_start
    first_word_start = min(starts)
    if first_word_start - clip_start <= max_dead_air_seconds:
        return clip_start
    return max(clip_start, first_word_start - speech_lead_seconds)


def _bf_editorial_tail_plan(
    transcript: Optional[Dict],
    speech_end_time: float,
    brand_tail_seconds: float,
    *,
    tail_profile: str = BF_REFERENCE_TAIL_V2,
    verified_acoustic_speech_end_time: Optional[float] = None,
    verified_next_spoken_word_start: Optional[float] = None,
    verified_next_speech_safety_seconds: Optional[float] = None,
    verified_acoustic_boundary_evidence: Optional[str] = None,
    verified_visual_safe_end_time: Optional[float] = None,
    verified_visual_boundary_evidence: Optional[str] = None,
    semantic_closure_decision_version: Optional[str] = None,
    planned_natural_tail_end_time: Optional[float] = None,
) -> Dict:
    """Use the guarded source landing, a bounded micro-settle, then fade.

    ``speech_end_time`` remains the semantic/caption boundary.  A reviewed
    candidate may additionally carry an acoustic speech end and next-word
    onset measured from the source audio.  Keeping those boundaries separate
    lets the source land naturally after the final phoneme without extending
    captions or admitting the first phoneme of the next sentence. v5 can use
    at most 80ms of the last verified-safe frame when the visual guard ends
    just before the acoustic next-speech guard.
    """
    speech_end = float(speech_end_time)
    profile = str(tail_profile or BF_REFERENCE_TAIL_V2).strip().lower()
    closure_version = (
        str(semantic_closure_decision_version or "").strip() or None
    )
    planned_tail_end = (
        float(planned_natural_tail_end_time)
        if planned_natural_tail_end_time is not None
        else None
    )
    if profile == BF_NATURAL_TAIL_V6:
        if closure_version is None or planned_tail_end is None:
            raise ValueError(
                "bf_natural_tail_v6 requires a sealed semantic-closure "
                "decision and planned authentic source-tail endpoint"
            )
        if not math.isfinite(planned_tail_end):
            raise ValueError("planned natural-tail endpoint must be finite")
        if planned_tail_end < speech_end - 0.001:
            raise ValueError(
                "planned natural-tail endpoint cannot precede semantic speech end"
            )
    verified_values = (
        verified_acoustic_speech_end_time,
        verified_next_spoken_word_start,
        verified_next_speech_safety_seconds,
    )
    has_verified_boundary = any(value is not None for value in verified_values)
    if has_verified_boundary and not all(value is not None for value in verified_values):
        raise ValueError(
            "verified acoustic tail timing requires speech end, next-word "
            "start, and safety seconds"
        )

    acoustic_speech_end = speech_end
    verified_next_word_start = None
    next_speech_safety_seconds = BF_EDITORIAL_NEXT_SPEECH_SAFETY_SECONDS
    if has_verified_boundary:
        acoustic_speech_end = float(verified_acoustic_speech_end_time)
        verified_next_word_start = float(verified_next_spoken_word_start)
        next_speech_safety_seconds = float(
            verified_next_speech_safety_seconds
        )
        if not all(
            math.isfinite(value)
            for value in (
                speech_end,
                acoustic_speech_end,
                verified_next_word_start,
                next_speech_safety_seconds,
            )
        ):
            raise ValueError("verified acoustic tail timing must be finite")
        if acoustic_speech_end > speech_end + 0.001:
            raise ValueError(
                "verified acoustic speech end cannot follow the semantic ending"
            )
        if verified_next_word_start < speech_end - 0.001:
            raise ValueError(
                "verified next spoken word cannot precede the semantic ending"
            )
        if not 0.0 <= next_speech_safety_seconds <= 0.25:
            raise ValueError(
                "verified next-speech safety must be between 0.0 and 0.25 seconds"
            )

    transcript_next_word_start = None
    if transcript:
        starts = [
            float(word["start"])
            for segment in transcript.get("segments", [])
            for word in _word_timings_for_segment(segment)
            if (
                float(word["start"]) >= speech_end - 0.001
                and float(word["end"]) > speech_end + 0.001
            )
        ]
        if starts:
            transcript_next_word_start = min(starts)

    next_word_start = (
        verified_next_word_start
        if has_verified_boundary
        else transcript_next_word_start
    )

    acoustic_safe_source_end = float("inf")
    if next_word_start is not None:
        acoustic_safe_source_end = max(
            acoustic_speech_end,
            next_word_start - next_speech_safety_seconds,
        )
    if transcript and transcript.get("duration") is not None:
        acoustic_safe_source_end = min(
            acoustic_safe_source_end,
            float(transcript["duration"]),
        )
    if not math.isfinite(acoustic_safe_source_end):
        acoustic_safe_source_end = acoustic_speech_end + (
            BF_EDITORIAL_MAX_NATURAL_TAIL_SECONDS
            + BF_EDITORIAL_TAIL_CROSSFADE_SECONDS
        )
    acoustic_safe_source_end = max(
        acoustic_speech_end,
        acoustic_safe_source_end,
    )

    visual_safe_end = None
    visual_evidence = str(verified_visual_boundary_evidence or "").strip() or None
    if visual_evidence is not None and verified_visual_safe_end_time is None:
        raise ValueError(
            "verified visual boundary evidence requires a visual safe-end time"
        )
    if verified_visual_safe_end_time is not None:
        if profile not in {
            BF_SMOOTH_TAIL_V4,
            BF_SMOOTH_TAIL_V5,
            BF_NATURAL_TAIL_V6,
        }:
            raise ValueError(
                "verified visual safe-end timing is supported only by "
                "bf_smooth_tail_v4, bf_smooth_tail_v5, or "
                "bf_natural_tail_v6"
            )
        visual_safe_end = float(verified_visual_safe_end_time)
        if not math.isfinite(visual_safe_end):
            raise ValueError("verified visual safe-end timing must be finite")
        if visual_safe_end < speech_end - 0.001:
            raise ValueError(
                "verified visual safe end cannot precede the semantic ending"
            )

    # Speech and picture are independent guards.  A scene change can require
    # an earlier visual landing even when the next spoken word starts later;
    # never rewrite the acoustic next-word evidence to represent that cut.
    safe_source_end = acoustic_safe_source_end
    if visual_safe_end is not None:
        safe_source_end = min(safe_source_end, visual_safe_end)
    safe_source_end = max(acoustic_speech_end, safe_source_end)
    available_source_tail = max(0.0, safe_source_end - acoustic_speech_end)
    post_source_settle = 0.0
    if profile in {
        BF_SMOOTH_TAIL_V3,
        BF_SMOOTH_TAIL_V4,
        BF_SMOOTH_TAIL_V5,
        BF_NATURAL_TAIL_V6,
    }:
        if profile == BF_NATURAL_TAIL_V6:
            if planned_tail_end > safe_source_end + 0.001:
                raise ValueError(
                    "planned natural-tail endpoint crosses the next-speech "
                    "or verified visual safety boundary"
                )
            authentic_source_margin = min(
                BF_EDITORIAL_MAX_NATURAL_TAIL_SECONDS,
                max(0.0, planned_tail_end - acoustic_speech_end),
                available_source_tail,
            )
        else:
            authentic_source_margin = min(
                BF_EDITORIAL_MAX_NATURAL_TAIL_SECONDS,
                available_source_tail,
            )
        clean_source_end = acoustic_speech_end + authentic_source_margin
        visual_fade_seconds = (
            BF_EDITORIAL_SMOOTH_VISUAL_FADE_SECONDS
            if profile in {
                BF_SMOOTH_TAIL_V4,
                BF_SMOOTH_TAIL_V5,
                BF_NATURAL_TAIL_V6,
            }
            else BF_EDITORIAL_SMOOTH_V3_VISUAL_FADE_SECONDS
        )
        if profile == BF_NATURAL_TAIL_V6:
            # The complete point and every available breath/reaction frame
            # remain live and full-strength. The fade starts only after the
            # sealed authentic source endpoint; no repeated settle frame.
            post_source_settle = 0.0
            transition_tail = visual_fade_seconds
            transition_start = clean_source_end
            brand_tail_start = transition_start + transition_tail
        elif profile == BF_SMOOTH_TAIL_V5:
            # Preserve the complete verified source landing at full opacity.
            # If a visual guard ends slightly before the next-speech guard,
            # keep only that final safe frame for the remaining micro-gap. This
            # creates the requested breath without admitting the next phrase
            # or recreating the old visible half-second freeze.
            post_source_settle = min(
                BF_EDITORIAL_V5_MAX_SETTLE_HOLD_SECONDS,
                max(0.0, acoustic_safe_source_end - clean_source_end),
            )
            transition_tail = visual_fade_seconds
            transition_start = clean_source_end + post_source_settle
            brand_tail_start = transition_start + transition_tail
        else:
            # Keep historical v3/v4 manifests pixel-stable.  Those profiles
            # place the picture fade inside the source window.
            brand_tail_start = clean_source_end
            transition_tail = min(
                visual_fade_seconds,
                max(0.0, brand_tail_start),
            )
            transition_start = max(0.0, brand_tail_start - transition_tail)
        natural_tail = authentic_source_margin
        speech_audio_end = clean_source_end
        speech_audio_tail = authentic_source_margin
        audio_transition_tail = (
            min(
                BF_EDITORIAL_SMOOTH_AUDIO_FADE_SECONDS,
                authentic_source_margin,
            )
            if profile == BF_NATURAL_TAIL_V6
            else min(
                BF_EDITORIAL_SMOOTH_AUDIO_FADE_SECONDS,
                max(
                    BF_EDITORIAL_AUDIO_DECLICK_SECONDS,
                    authentic_source_margin,
                ),
            )
        )
        music_release_tail = BF_EDITORIAL_SMOOTH_MUSIC_RELEASE_SECONDS
    else:
        # v2 reserves the end of the available clean source tail for a
        # post-phoneme audio/video crossfade. Keep it stable for old manifests.
        planned_transition_tail = min(
            BF_EDITORIAL_TAIL_CROSSFADE_SECONDS,
            available_source_tail,
        )
        natural_tail = min(
            BF_EDITORIAL_MAX_NATURAL_TAIL_SECONDS,
            max(0.0, available_source_tail - planned_transition_tail),
        )
        transition_start = acoustic_speech_end + natural_tail
        clean_source_end = min(
            transition_start + planned_transition_tail,
            safe_source_end,
        )
        clean_source_end = max(transition_start, clean_source_end)
        transition_tail = max(
            0.0,
            clean_source_end - transition_start,
        )
        brand_tail_start = clean_source_end
        speech_audio_end = transition_start
        speech_audio_tail = natural_tail
        audio_transition_tail = transition_tail
        music_release_tail = 0.0
    output_end = brand_tail_start + max(0.0, brand_tail_seconds)
    return {
        "tail_profile": profile,
        "semantic_closure_decision_version": closure_version,
        "planned_natural_tail_end_time": planned_tail_end,
        "speech_end_time": speech_end,
        "acoustic_speech_end_time": acoustic_speech_end,
        "speech_audio_end_time": speech_audio_end,
        "speech_audio_tail_seconds": speech_audio_tail,
        "source_content_end_time": clean_source_end,
        "output_end_time": output_end,
        "post_point_hold_seconds": natural_tail + post_source_settle,
        "natural_tail_seconds": natural_tail,
        "transition_tail_seconds": transition_tail,
        "visual_transition_start_time": transition_start,
        "audio_transition_tail_seconds": audio_transition_tail,
        "audio_transition_start_time": max(
            0.0,
            speech_audio_end - audio_transition_tail,
        ),
        "music_release_tail_seconds": music_release_tail,
        "semantic_source_margin_seconds": max(
            0.0,
            clean_source_end - speech_end,
        ),
        "freeze_hold_seconds": post_source_settle,
        "next_spoken_word_start": next_word_start,
        "transcript_next_spoken_word_start": transcript_next_word_start,
        "next_speech_safety_seconds": next_speech_safety_seconds,
        "acoustic_boundary_source": (
            "candidate_verified_acoustic"
            if has_verified_boundary
            else "transcript"
        ),
        "verified_acoustic_speech_end_time": (
            acoustic_speech_end if has_verified_boundary else None
        ),
        "verified_next_spoken_word_start": (
            verified_next_word_start if has_verified_boundary else None
        ),
        "verified_next_speech_safety_seconds": (
            next_speech_safety_seconds if has_verified_boundary else None
        ),
        "verified_acoustic_boundary_evidence": (
            str(verified_acoustic_boundary_evidence or "").strip() or None
            if has_verified_boundary
            else None
        ),
        "acoustic_safe_source_end_time": acoustic_safe_source_end,
        "verified_visual_safe_end_time": visual_safe_end,
        "verified_visual_boundary_evidence": (
            visual_evidence if visual_safe_end is not None else None
        ),
        "visual_safe_end_guard_passed": bool(
            visual_safe_end is None
            or clean_source_end <= visual_safe_end + 0.001
        ),
        "source_speech_leak_guard_passed": bool(
            next_word_start is None
            or clean_source_end
            <= next_word_start
            - (
                next_speech_safety_seconds
                if profile in {
                    BF_SMOOTH_TAIL_V3,
                    BF_SMOOTH_TAIL_V4,
                    BF_SMOOTH_TAIL_V5,
                }
                else 0.0
            )
            + 0.001
        ),
    }


def _bf_brand_transition_progress(
    elapsed: float,
    brand_tail_start: float,
    transition_seconds: float,
    *,
    smooth: bool = False,
) -> Optional[float]:
    """Return blend progress, or None while the source must remain untouched."""
    duration = max(0.0, float(transition_seconds))
    start = max(0.0, float(brand_tail_start) - duration)
    if float(elapsed) < start:
        return None
    if duration <= 0.0:
        return 1.0 if float(elapsed) >= float(brand_tail_start) else None
    progress = min(1.0, max(0.0, (float(elapsed) - start) / duration))
    if smooth:
        return progress * progress * (3.0 - 2.0 * progress)
    return progress


def _caption_word_key(text: str) -> str:
    return re.sub(r"[^a-z']", "", text.lower())


def _caption_has_weak_ending(
    word: Dict,
    extra_endings: Optional[set] = None,
) -> bool:
    text = str(word["text"])
    key = _caption_word_key(text)
    sentence_complete_copula = (
        key in {"are", "be", "is", "was", "were"}
        and bool(re.search(r"[.!?][\"')\]]?$", text))
    )
    forbidden = CAPTION_FORBIDDEN_ENDINGS | (extra_endings or set())
    return key in forbidden and not sentence_complete_copula


def _caption_is_filler_singleton(group: List[Dict]) -> bool:
    return (
        len(group) == 1
        and _caption_word_key(str(group[0].get("text") or ""))
        in {"yeah", "right", "exactly", "okay", "ok"}
    )


def _partition_caption_block(
    words: List[Dict],
    min_words: int = CAPTION_MIN_PHRASE_WORDS,
    max_words: int = CAPTION_MAX_PHRASE_WORDS,
    target_words: float = 4.5,
    extra_forbidden_endings: Optional[set] = None,
) -> List[List[Dict]]:
    """Split one spoken clause into balanced groups without weak trailing words."""
    words = list(words)
    while (
        len(words) > 1
        and not re.search(
            r"[.!?,;:][\"')\]]?$",
            str(words[-1].get("text") or ""),
        )
        and _caption_has_weak_ending(
            words[-1],
            extra_endings=extra_forbidden_endings,
        )
    ):
        words.pop()
    if len(words) < min_words:
        return [words]

    best: Dict[int, Tuple[float, List[List[Dict]]]] = {len(words): (0.0, [])}
    for start in range(len(words) - 1, -1, -1):
        options = []
        for size in range(min_words, max_words + 1):
            end = start + size
            if end > len(words) or end not in best:
                continue
            if _caption_has_weak_ending(
                words[end - 1],
                extra_endings=extra_forbidden_endings,
            ):
                continue
            remainder_cost, remainder = best[end]
            cost = remainder_cost + (size - target_words) ** 2
            options.append((cost, [words[start:end], *remainder]))
        if options:
            best[start] = min(options, key=lambda option: option[0])

    if 0 in best:
        return best[0][1]

    if (
        len(words) <= min(6, max_words + 2)
        and re.search(
            r"[.!?,;:][\"')\]]?$",
            str(words[-1].get("text") or ""),
        )
    ):
        return [words]

    # An incomplete source clause can make the strict partition impossible.
    # Keep bounded groups; semantic boundary checks reject the source cut itself.
    group_count = max(1, int(math.ceil(len(words) / max(1.0, target_words))))
    while int(math.ceil(len(words) / group_count)) > max_words:
        group_count += 1
    base_size, larger_groups = divmod(len(words), group_count)
    groups = []
    start = 0
    for group_index in range(group_count):
        size = base_size + (1 if group_index < larger_groups else 0)
        groups.append(words[start:start + size])
        start += size
    return groups


def _merge_short_caption_groups(
    groups: List[List[Dict]],
    max_words: int = CAPTION_MAX_PHRASE_WORDS,
) -> List[List[Dict]]:
    merged = [list(group) for group in groups if group]
    index = 0
    while index < len(merged):
        group = merged[index]
        duration = float(group[-1]["end"]) - float(group[0]["start"])
        needs_merge = len(group) == 1 and duration < CAPTION_MIN_GROUP_SECONDS
        if not needs_merge:
            index += 1
            continue
        if index > 0 and len(merged[index - 1]) + len(group) <= max_words:
            merged[index - 1].extend(group)
            del merged[index]
            continue
        if index + 1 < len(merged) and len(group) + len(merged[index + 1]) <= max_words:
            merged[index + 1] = group + merged[index + 1]
            del merged[index]
            continue
        index += 1
    return merged


def _caption_sentence_break_after(
    group: List[Dict],
    next_group: Optional[List[Dict]],
    silence_seconds: float = 1.0,
) -> bool:
    if not group or next_group is None:
        return True
    if re.search(r"[.!?][\"')\]]?$", str(group[-1].get("text") or "")):
        return True
    gap = float(next_group[0]["start"]) - float(group[-1]["end"])
    return gap > silence_seconds


def _caption_clause_break_after(
    group: List[Dict],
    next_group: Optional[List[Dict]],
) -> bool:
    if _caption_sentence_break_after(group, next_group):
        return True
    return bool(re.search(r"[,;:][\"')\]]?$", str(group[-1].get("text") or "")))


def _merge_fast_editorial_caption_groups(
    groups: List[List[Dict]],
    max_words: int = 4,
    minimum_seconds: float = MOTIVATIONAL_MIN_PHRASE_SECONDS,
) -> List[List[Dict]]:
    """Remove flashes by merging short phrases without crossing sentences."""
    merged = [list(group) for group in groups if group]
    index = 0
    while index < len(merged):
        group = merged[index]
        duration = float(group[-1]["end"]) - float(group[0]["start"])
        if duration >= minimum_seconds or len(group) >= max_words:
            index += 1
            continue
        if (
            index + 1 < len(merged)
            and not _caption_clause_break_after(group, merged[index + 1])
            and len(group) + len(merged[index + 1]) <= max_words
        ):
            group.extend(merged[index + 1])
            del merged[index + 1]
            continue
        if (
            index > 0
            and not _caption_clause_break_after(merged[index - 1], group)
            and len(merged[index - 1]) + len(group) <= max_words
        ):
            merged[index - 1].extend(group)
            del merged[index]
            index = max(0, index - 1)
            continue
        index += 1
    return merged


def _rebalance_editorial_caption_groups(
    groups: List[List[Dict]],
    max_words: int = CAPTION_MAX_PHRASE_WORDS,
) -> List[List[Dict]]:
    """Move a dangling pronoun/function word into the phrase it introduces."""
    balanced = [list(group) for group in groups if group]
    for index in range(len(balanced) - 1):
        current = balanced[index]
        following = balanced[index + 1]
        while (
            len(current) > 1
            and len(following) < max_words
            and _caption_word_key(str(current[-1].get("text") or ""))
            in MOTIVATIONAL_DANGLING_ENDINGS
        ):
            following.insert(0, current.pop())
    return balanced


def _group_caption_words(
    words: List[Dict],
    min_words: int = CAPTION_MIN_PHRASE_WORDS,
    max_words: int = CAPTION_MAX_PHRASE_WORDS,
    target_words: float = 4.5,
    extra_forbidden_endings: Optional[set] = None,
    break_on_clauses: bool = False,
    merge_short_groups: bool = True,
) -> List[List[Dict]]:
    blocks: List[List[Dict]] = []
    current: List[Dict] = []
    for index, word in enumerate(words):
        current.append(word)
        next_word = words[index + 1] if index + 1 < len(words) else None
        gap = (
            float(next_word["start"]) - float(word["end"])
            if next_word is not None
            else float("inf")
        )
        ends_sentence = bool(re.search(r"[.!?][\"')\]]?$", str(word["text"])))
        ends_clause = (
            break_on_clauses
            and len(current) >= min_words
            and bool(re.search(r"[,;:][\"')\]]?$", str(word["text"])))
        )
        weak_ending = _caption_has_weak_ending(
            word,
            extra_endings=extra_forbidden_endings,
        )
        if (
            ends_sentence
            or ends_clause
            or next_word is None
            or (gap > 0.45 and not weak_ending)
        ):
            blocks.append(current)
            current = []
    if current:
        blocks.append(current)

    groups = [
        group
        for block in blocks
        for group in _partition_caption_block(
            block,
            min_words=min_words,
            max_words=max_words,
            target_words=target_words,
            extra_forbidden_endings=extra_forbidden_endings,
        )
    ]
    return (
        _merge_short_caption_groups(groups, max_words=max_words)
        if merge_short_groups
        else groups
    )


def _caption_context_scores(caption_context: Optional[Dict]) -> Dict[str, float]:
    """Weight words already chosen by the selector; no extra model call is needed."""
    scores: Dict[str, float] = {}
    for field, weight in MOTIVATIONAL_CONTEXT_FIELDS:
        value = str((caption_context or {}).get(field) or "")
        for raw_word in value.split():
            key = _caption_word_key(raw_word)
            if len(key) < 3 or key in MOTIVATIONAL_CAPTION_STOP_WORDS:
                continue
            scores[key] = scores.get(key, 0.0) + weight
    return scores


def _caption_word_importance(
    key: str,
    context_scores: Dict[str, float],
    frequencies: Counter,
) -> float:
    if not key:
        return -100.0
    score = min(2.5, context_scores.get(key, 0.0))
    if key in MOTIVATIONAL_IMPACT_WORDS:
        score += 3.0
    if key not in MOTIVATIONAL_CAPTION_STOP_WORDS:
        score += min(10, len(key)) * 0.05
    else:
        score -= 3.0
    return score


def _caption_emphasis_index(
    group: List[Dict],
    context_scores: Optional[Dict[str, float]] = None,
    frequencies: Optional[Counter] = None,
) -> int:
    """Choose the most meaningful word, not merely the longest word."""
    context_scores = context_scores or {}
    frequencies = frequencies or Counter(
        _caption_word_key(str(word.get("text") or "")) for word in group
    )
    candidates = []
    for index, word in enumerate(group):
        key = _caption_word_key(str(word.get("text") or ""))
        score = _caption_word_importance(key, context_scores, frequencies)
        candidates.append((score, len(key), -index, index))
    return max(candidates, default=(0.0, 0, 0, 0))[-1]


def _caption_secondary_index(group: List[Dict], emphasis_index: int) -> int:
    """Pick at most one quiet support word for the script-font treatment."""
    candidates = []
    for index, word in enumerate(group):
        if index == emphasis_index:
            continue
        key = _caption_word_key(str(word.get("text") or ""))
        if not key:
            continue
        support_score = 0.0
        if key in MOTIVATIONAL_CONNECTOR_WORDS or key in CAPTION_FORBIDDEN_ENDINGS:
            support_score += 3.0
        if len(key) <= 4:
            support_score += 1.0
        support_score -= abs(index - emphasis_index) * 0.15
        candidates.append((support_score, -index, index))
    best = max(candidates, default=(-100.0, 0, -1))
    return best[-1] if best[0] >= 1.0 else -1


def _caption_anchor_font_style(anchor_key: str) -> str:
    """Map a semantic anchor to one deliberate display family."""
    return (
        "serif"
        if anchor_key in MOTIVATIONAL_REFLECTIVE_ANCHOR_WORDS
        else "base"
    )


def _caption_is_reaction_group(group: List[Dict]) -> bool:
    """Detect a short, genuine spoken reaction without inventing reaction footage."""
    keys = {
        _caption_word_key(str(word.get("text") or ""))
        for word in group
    }
    phrase = " ".join(str(word.get("text") or "") for word in group)
    emphatic = bool(re.search(r"[!?][\"')\]]?$", phrase.strip()))
    return bool(
        group
        and len(group) <= 4
        and (
            keys & BF_EDITORIAL_REACTION_WORDS
            or (len(group) <= 2 and emphatic)
        )
    )


def _bf_editorial_typography_plan(
    groups: List[List[Dict]],
    caption_context: Optional[Dict] = None,
) -> List[Dict]:
    """Assign one dominant semantic word to every micro-format phrase."""
    context_scores = _caption_context_scores(caption_context)
    frequencies = Counter(
        key
        for group in groups
        for key in (
            _caption_word_key(str(word.get("text") or ""))
            for word in group
        )
        if key
    )
    plan = []
    for group in groups:
        emphasis_index = _caption_emphasis_index(
            group,
            context_scores=context_scores,
            frequencies=frequencies,
        )
        anchor_key = (
            _caption_word_key(str(group[emphasis_index].get("text") or ""))
            if group
            else ""
        )
        reaction = _caption_is_reaction_group(group)
        if reaction:
            anchor_scale = (
                BF_EDITORIAL_REACTION_SCALE_MAX
                if len(group) == 1
                else 3.2
                if len(group) == 2
                else 2.6
            )
            role = "reaction"
            base_scale = 0.72
        else:
            semantic_score = context_scores.get(anchor_key, 0.0)
            impact = anchor_key in MOTIVATIONAL_IMPACT_WORDS
            anchor_scale = (
                BF_EDITORIAL_HERO_SCALE_MAX
                if len(group) == 1
                else 2.25
                if semantic_score > 0.0 or impact
                else 2.0
            )
            role = "hero"
            base_scale = 0.80
        anchor_font_style = _caption_anchor_font_style(anchor_key)
        anchor_scale = max(
            BF_EDITORIAL_HERO_SCALE_MIN,
            min(BF_EDITORIAL_REACTION_SCALE_MAX, anchor_scale),
        )
        plan.append(
            {
                "emphasis_index": emphasis_index,
                "typography_role": role,
                "typography_reason": f"{role}:{anchor_key}:{anchor_font_style}",
                "typography_variant": role,
                "typography_base_scale": base_scale,
                "typography_anchor_scale": anchor_scale,
                "typography_accent_style": anchor_font_style,
                "typography_body_style": "support",
                "typography_motif": "bf_kinetic_editorial_v1",
                "typography_secondary_index": -1,
                "typography_secondary_scale": 0.72,
                "typography_secondary_style": "support",
                "typography_semantic_score": round(
                    float(context_scores.get(anchor_key, 0.0)),
                    3,
                ),
            }
        )
    return plan


def _caption_typography_plan(
    groups: List[List[Dict]],
    caption_context: Optional[Dict] = None,
    sentence_layout: Optional[List[Dict]] = None,
    render_profile: Optional[str] = None,
) -> List[Dict]:
    """Direct typography by narrative role instead of recurring word motifs."""
    if _is_bf_editorial_profile(render_profile):
        return _bf_editorial_typography_plan(
            groups,
            caption_context=caption_context,
        )
    keys_by_group = [
        [_caption_word_key(str(word.get("text") or "")) for word in group]
        for group in groups
    ]
    frequencies = Counter(key for keys in keys_by_group for key in keys if key)
    context_scores = _caption_context_scores(caption_context)
    sentence_layout = sentence_layout or _caption_sentence_layout(groups)
    emphasis_indexes = [
        _caption_emphasis_index(group, context_scores, frequencies)
        for group in groups
    ]
    hero_candidates = []
    semantic_scores = []
    for index, (group, keys, emphasis_index, layout) in enumerate(
        zip(groups, keys_by_group, emphasis_indexes, sentence_layout)
    ):
        anchor_key = keys[emphasis_index] if keys else ""
        sentence_end = bool(group) and re.search(
            r"[.!?][\"')\]]?$",
            str(group[-1].get("text") or ""),
        )
        has_contrast = bool(set(keys) & MOTIVATIONAL_CONTRAST_WORDS)
        semantic_score = min(3.5, context_scores.get(anchor_key, 0.0))
        if anchor_key in MOTIVATIONAL_IMPACT_WORDS:
            semantic_score += 3.0
        if len(anchor_key) >= 6:
            semantic_score += 0.35
        if has_contrast:
            semantic_score += 0.75
        if sentence_end:
            semantic_score += 1.35
        if index == len(groups) - 1:
            semantic_score += 0.35
        if (
            not anchor_key
            or anchor_key in MOTIVATIONAL_CAPTION_STOP_WORDS
            or anchor_key in MOTIVATIONAL_GENERIC_ANCHOR_WORDS
        ):
            semantic_score -= 4.0
        semantic_scores.append(semantic_score)
        if semantic_score >= 3.0:
            hero_candidates.append(
                (
                    semantic_score,
                    int(layout["sentence_id"]),
                    -index,
                    index,
                )
            )

    # One display anchor per sentence and a small clip-wide emphasis budget.
    best_by_sentence: Dict[int, Tuple[float, int, int, int]] = {}
    for candidate in hero_candidates:
        sentence_id = candidate[1]
        if sentence_id not in best_by_sentence or candidate > best_by_sentence[sentence_id]:
            best_by_sentence[sentence_id] = candidate
    hero_budget = min(
        MOTIVATIONAL_MAX_HERO_PHRASES,
        max(1, int(math.ceil(len(groups) / 6.0))),
    )
    selected_set = {
        candidate[3]
        for candidate in sorted(best_by_sentence.values(), reverse=True)[:hero_budget]
    }

    plan = []
    for index, emphasis_index in enumerate(emphasis_indexes):
        keys = keys_by_group[index]
        anchor_key = keys[emphasis_index] if keys else ""
        is_headline = index in selected_set
        has_contrast = bool(set(keys) & MOTIVATIONAL_CONTRAST_WORDS)
        phrase_position = int(sentence_layout[index]["sentence_phrase_index"])
        if is_headline:
            role = "payoff"
            variant = "headline"
            base_scale = 0.82
            anchor_scale = 1.58
            accent_style = _caption_anchor_font_style(anchor_key)
        elif has_contrast:
            role = "contrast"
            variant = "contrast"
            base_scale = 0.90
            anchor_scale = 1.0
            accent_style = "support"
        elif phrase_position == 0:
            role = "setup"
            variant = "support"
            base_scale = 0.82
            anchor_scale = 1.0
            accent_style = "support"
        else:
            role = "statement"
            variant = "statement"
            base_scale = 0.86
            anchor_scale = 1.0
            accent_style = "support"

        secondary_index = -1
        if is_headline:
            for candidate_index in range(max(0, emphasis_index - 1), emphasis_index):
                if keys[candidate_index] in MOTIVATIONAL_INTENSIFIER_WORDS:
                    secondary_index = candidate_index
                    break
        plan.append(
            {
                "emphasis_index": emphasis_index,
                "typography_role": role,
                "typography_reason": (
                    f"semantic_payoff:{anchor_key}"
                    if is_headline
                    else f"narrative_{role}"
                ),
                "typography_variant": variant,
                "typography_base_scale": base_scale,
                "typography_anchor_scale": anchor_scale,
                "typography_accent_style": accent_style,
                "typography_body_style": "support",
                "typography_motif": "",
                "typography_secondary_index": secondary_index,
                "typography_secondary_scale": 0.58,
                "typography_secondary_style": (
                    "script" if secondary_index >= 0 else "support"
                ),
                "typography_semantic_score": round(semantic_scores[index], 3),
            }
        )
    return plan


def _caption_sentence_layout(groups: List[List[Dict]]) -> List[Dict]:
    """Assign each sentence to a stable three-stop top-to-bottom track."""
    if not groups:
        return []

    sentence_ids = []
    sentence_id = 0
    for index, group in enumerate(groups):
        sentence_ids.append(sentence_id)
        next_group = groups[index + 1] if index + 1 < len(groups) else None
        if _caption_sentence_break_after(group, next_group):
            sentence_id += 1

    counts = Counter(sentence_ids)
    indexes = Counter()
    layout = []
    for current_sentence_id in sentence_ids:
        phrase_index = indexes[current_sentence_id]
        phrase_count = counts[current_sentence_id]
        indexes[current_sentence_id] += 1
        progress = (
            phrase_index / (phrase_count - 1)
            if phrase_count > 1
            else 0.5
        )
        track_slot = (
            1
            if phrase_count == 1
            else min(2, max(0, int(round(progress * 2))))
        )
        layout.append(
            {
                "sentence_id": current_sentence_id,
                "sentence_phrase_index": phrase_index,
                "sentence_phrase_count": phrase_count,
                "sentence_progress": progress,
                "caption_track_slot": track_slot,
                "caption_track_progress": MOTIVATIONAL_TRACK_POSITIONS[track_slot],
            }
        )
    return layout


def _caption_group_metrics(groups: List[List[Dict]]) -> Dict:
    durations = [
        float(group[-1]["end"]) - float(group[0]["start"])
        for group in groups
        if group
    ]
    return {
        "group_count": len(groups),
        "singleton_count": sum(len(group) == 1 for group in groups),
        "forbidden_ending_count": sum(
            bool(group) and _caption_has_weak_ending(group[-1])
            for group in groups
        ),
        "max_words_per_group": max((len(group) for group in groups), default=0),
        "average_words_per_group": round(
            sum(len(group) for group in groups) / max(1, len(groups)),
            3,
        ),
        "minimum_group_duration": round(min(durations, default=0.0), 3),
    }


def _editorial_handoff_gap_seconds(
    spoken_end: float,
    next_spoken_start: float,
) -> float:
    """Use a clean reset only when the source contains a real pause."""
    natural_pause = max(0.0, float(next_spoken_start) - float(spoken_end))
    return min(
        MOTIVATIONAL_MAX_HANDOFF_GAP_SECONDS,
        MOTIVATIONAL_HANDOFF_GAP_SECONDS + natural_pause * 0.50,
    )


def _editorial_complete_phrase_hold_seconds(
    cue: Dict,
    sentence_final: bool = False,
) -> float:
    """Budget reading time from the final reveal, with extra time for payoff."""
    words = [str(word) for word in (cue.get("words") or [])]
    character_count = sum(len(_caption_word_key(word)) for word in words)
    hold = 0.20 + len(words) * 0.035 + character_count * 0.006
    hold = max(
        MOTIVATIONAL_MIN_COMPLETE_PHRASE_SECONDS,
        min(MOTIVATIONAL_MAX_COMPLETE_PHRASE_SECONDS, hold),
    )
    if (
        len(words) <= 2
        and str(cue.get("typography_role") or "") in {"hero", "reaction", "payoff"}
    ):
        hold = max(hold, MOTIVATIONAL_SEMANTIC_ANCHOR_HOLD_SECONDS)
    if sentence_final:
        hold = max(hold, MOTIVATIONAL_SENTENCE_HOLD_SECONDS)
    return hold


def _progressive_editorial_cues(
    group: List[Dict],
    phrase_id: int,
    clip_duration: float,
    typography: Dict,
    sentence_layout: Dict,
) -> List[Dict]:
    """Reveal a stable phrase during each spoken word, never before it."""
    phrase_words = [str(word["text"]) for word in group]
    phrase_text = " ".join(phrase_words)
    phrase_start = max(0.0, float(group[0]["start"]))
    phrase_end = min(clip_duration, float(group[-1]["end"]))
    reveal_steps: List[Dict] = []
    for word_index, word in enumerate(group):
        word_start = float(word["start"])
        word_end = max(word_start, float(word["end"]))
        word_duration = word_end - word_start
        reveal_delay = min(
            MOTIVATIONAL_MAX_WORD_REVEAL_DELAY_SECONDS,
            max(
                MOTIVATIONAL_MIN_WORD_REVEAL_DELAY_SECONDS,
                word_duration * MOTIVATIONAL_WORD_REVEAL_PROGRESS,
            ),
        )
        reveal_delay = min(
            reveal_delay,
            max(0.02, word_duration * 0.85),
        )
        reveal_start = max(
            0.0,
            word_start
            + reveal_delay
            - MOTIVATIONAL_CAPTION_VISUAL_LEAD_SECONDS,
        )
        reveal_event = {
            "word_index": word_index,
            "word": phrase_words[word_index],
            "spoken_start": word_start,
            "spoken_end": word_end,
            "reveal_start": reveal_start,
            "reveal_delay_seconds": reveal_start - word_start,
        }
        if (
            reveal_steps
            and reveal_start - float(reveal_steps[-1]["start"])
            < MOTIVATIONAL_MIN_REVEAL_SECONDS
        ):
            reveal_steps[-1]["active_index"] = word_index
            reveal_steps[-1]["visible_word_count"] = word_index + 1
            reveal_steps[-1]["reveal_events"].append(reveal_event)
            continue
        reveal_steps.append(
            {
                "text": phrase_text,
                "words": phrase_words,
                "phrase_id": phrase_id,
                "active_index": word_index,
                "visible_word_count": word_index + 1,
                "phrase_start": phrase_start,
                "phrase_end": phrase_end,
                "reveal_events": [reveal_event],
                "timing_reason": "speech_locked_progressive_reveal",
                **typography,
                **sentence_layout,
                "start": reveal_start,
            }
        )

    for index, cue in enumerate(reveal_steps):
        cue["end"] = (
            float(reveal_steps[index + 1]["start"])
            if index + 1 < len(reveal_steps)
            else phrase_end
        )
    return [
        cue
        for cue in reveal_steps
        if float(cue["end"]) > float(cue["start"])
    ]


def _extend_editorial_phrase_gaps(
    cues: List[Dict],
    clip_duration: float,
) -> List[Dict]:
    """Hold completed phrases, then leave a clean beat before each handoff."""
    sentence_ids = sorted(
        {
            int(cue["sentence_id"])
            for cue in cues
            if cue.get("sentence_id") is not None
        }
    )
    for sentence_index, sentence_id in enumerate(sentence_ids):
        sentence_cues = [
            cue for cue in cues if int(cue.get("sentence_id", -1)) == sentence_id
        ]
        if not sentence_cues:
            continue
        spoken_end = max(
            float(cue.get("phrase_end", cue["end"]))
            for cue in sentence_cues
        )
        next_sentence_cues = (
            [
                cue
                for cue in cues
                if int(cue.get("sentence_id", -1))
                == sentence_ids[sentence_index + 1]
            ]
            if sentence_index + 1 < len(sentence_ids)
            else []
        )
        next_sentence_start = (
            min(
                float(cue["start"])
                for cue in next_sentence_cues
            )
            if next_sentence_cues
            else clip_duration
        )
        next_sentence_spoken_start = (
            min(
                float(cue.get("phrase_start", cue["start"]))
                for cue in next_sentence_cues
            )
            if next_sentence_cues
            else clip_duration
        )
        sentence_handoff_gap = _editorial_handoff_gap_seconds(
            spoken_end,
            next_sentence_spoken_start,
        )
        sentence_handoff_end = (
            max(
                0.0,
                next_sentence_start - sentence_handoff_gap,
            )
            if next_sentence_cues
            else next_sentence_start
        )
        phrase_ids = sorted(
            {
                int(cue["phrase_id"])
                for cue in sentence_cues
                if cue.get("phrase_id") is not None
            },
            key=lambda phrase_id: min(
                float(cue["start"])
                for cue in sentence_cues
                if int(cue.get("phrase_id", -1)) == phrase_id
            ),
        )
        phrase_starts = {
            phrase_id: min(
                float(cue["start"])
                for cue in sentence_cues
                if int(cue.get("phrase_id", -1)) == phrase_id
            )
            for phrase_id in phrase_ids
        }
        phrase_spoken_starts = {
            phrase_id: min(
                float(cue.get("phrase_start", cue["start"]))
                for cue in sentence_cues
                if int(cue.get("phrase_id", -1)) == phrase_id
            )
            for phrase_id in phrase_ids
        }
        sentence_final_cues = [
            cue
            for cue in sentence_cues
            if int(cue.get("phrase_id", -1)) == phrase_ids[-1]
        ]
        sentence_final_cue = max(
            sentence_final_cues,
            key=lambda cue: int(cue.get("visible_word_count", 0)),
        )
        sentence_complete_hold = _editorial_complete_phrase_hold_seconds(
            sentence_final_cue,
            sentence_final=True,
        )
        display_end = min(
            clip_duration,
            sentence_handoff_end,
            max(
                spoken_end + MOTIVATIONAL_SENTENCE_HOLD_SECONDS,
                float(sentence_final_cue["start"]) + sentence_complete_hold,
            ),
        )
        for phrase_index, phrase_id in enumerate(phrase_ids):
            phrase_cues = [
                cue
                for cue in sentence_cues
                if int(cue.get("phrase_id", -1)) == phrase_id
            ]
            final_cue = max(
                phrase_cues,
                key=lambda cue: int(cue.get("visible_word_count", 0)),
            )
            sentence_final = phrase_index == len(phrase_ids) - 1
            complete_hold = _editorial_complete_phrase_hold_seconds(
                final_cue,
                sentence_final=sentence_final,
            )
            hold_reason = (
                "sentence_closure"
                if sentence_final
                else "semantic_anchor"
                if complete_hold >= MOTIVATIONAL_SEMANTIC_ANCHOR_HOLD_SECONDS
                else "progressive_readability"
            )
            if phrase_index + 1 < len(phrase_ids):
                next_phrase_start = phrase_starts[phrase_ids[phrase_index + 1]]
                next_phrase_spoken_start = phrase_spoken_starts[
                    phrase_ids[phrase_index + 1]
                ]
                phrase_spoken_end = max(
                    float(cue.get("phrase_end", cue["end"]))
                    for cue in phrase_cues
                )
                handoff_gap = _editorial_handoff_gap_seconds(
                    phrase_spoken_end,
                    next_phrase_spoken_start,
                )
                minimum_visible_end = (
                    phrase_starts[phrase_id]
                    + MOTIVATIONAL_MIN_VISIBLE_PHRASE_SECONDS
                )
                minimum_complete_end = (
                    float(final_cue["start"]) + complete_hold
                )
                preferred_end = min(
                    max(
                        phrase_spoken_end + MOTIVATIONAL_PHRASE_HOLD_SECONDS,
                        minimum_complete_end,
                    ),
                    max(
                        0.0,
                        next_phrase_start - handoff_gap,
                    ),
                )
                handoff_end = min(
                    next_phrase_start + MOTIVATIONAL_MAX_HANDOFF_OVERLAP_SECONDS,
                    max(minimum_visible_end, preferred_end),
                )
            else:
                handoff_end = display_end
                handoff_gap = sentence_handoff_gap
            final_cue["end"] = max(
                float(final_cue["start"]) + 0.01,
                min(display_end, handoff_end),
            )
            final_cue["complete_phrase_target_seconds"] = round(
                complete_hold,
                3,
            )
            final_cue["complete_phrase_visible_seconds"] = round(
                max(0.0, float(final_cue["end"]) - float(final_cue["start"])),
                3,
            )
            final_cue["post_speech_hold_seconds"] = round(
                max(
                    0.0,
                    float(final_cue["end"])
                    - float(final_cue.get("phrase_end", final_cue["end"])),
                ),
                3,
            )
            final_cue["handoff_gap_seconds"] = round(
                max(0.0, handoff_gap),
                3,
            )
            final_cue["timing_hold_reason"] = hold_reason
    return cues


def _caption_timing_metrics(cues: List[Dict]) -> Dict:
    """Summarize actual on-screen timing for QA and cached research runs."""
    phrase_cues: Dict[int, List[Dict]] = {}
    sentence_cues: Dict[int, List[Dict]] = {}
    reveal_delays = []
    word_visible_durations = []
    complete_phrase_durations = []
    sentence_tail_holds = []

    for cue in cues:
        if cue.get("phrase_id") is not None:
            phrase_cues.setdefault(int(cue["phrase_id"]), []).append(cue)
        if cue.get("sentence_id") is not None:
            sentence_cues.setdefault(int(cue["sentence_id"]), []).append(cue)
        for event in cue.get("reveal_events") or []:
            reveal_delays.append(
                float(event["reveal_start"]) - float(event["spoken_start"])
            )

    for items in phrase_cues.values():
        display_end = max(float(cue["end"]) for cue in items)
        final_cue = max(
            items,
            key=lambda cue: int(cue.get("visible_word_count", 0)),
        )
        complete_phrase_durations.append(
            max(0.0, display_end - float(final_cue["start"]))
        )
        for cue in items:
            for event in cue.get("reveal_events") or []:
                word_visible_durations.append(
                    max(0.0, display_end - float(event["reveal_start"]))
                )

    for items in sentence_cues.values():
        display_end = max(float(cue["end"]) for cue in items)
        spoken_end = max(
            float(cue.get("phrase_end", cue["end"]))
            for cue in items
        )
        sentence_tail_holds.append(max(0.0, display_end - spoken_end))

    def median(values: List[float]) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        middle = len(ordered) // 2
        return (
            ordered[middle]
            if len(ordered) % 2
            else (ordered[middle - 1] + ordered[middle]) / 2
        )

    return {
        "word_count": len(reveal_delays),
        "phrase_count": len(phrase_cues),
        "sentence_count": len(sentence_cues),
        "early_reveal_count": sum(delay < -0.001 for delay in reveal_delays),
        "median_reveal_delay_ms": round(median(reveal_delays) * 1000),
        "max_reveal_delay_ms": round(max(reveal_delays, default=0.0) * 1000),
        "median_word_visible_ms": round(
            median(word_visible_durations) * 1000
        ),
        "minimum_word_visible_ms": round(
            min(word_visible_durations, default=0.0) * 1000
        ),
        "median_complete_phrase_ms": round(
            median(complete_phrase_durations) * 1000
        ),
        "minimum_complete_phrase_ms": round(
            min(complete_phrase_durations, default=0.0) * 1000
        ),
        "median_sentence_tail_hold_ms": round(
            median(sentence_tail_holds) * 1000
        ),
    }


def _build_word_cues(
    transcript: Optional[Dict],
    clip_start: float,
    clip_end: float,
    speech_start: Optional[float] = None,
    caption_style: Optional[str] = None,
    caption_context: Optional[Dict] = None,
    render_profile: Optional[str] = None,
    display_end: Optional[float] = None,
) -> List[Dict]:
    """Build phrase-stable cues from exact Whisper word timestamps."""
    if not transcript or clip_end <= clip_start:
        return []

    words = []
    clip_duration = max(
        0.0,
        float(display_end if display_end is not None else clip_end) - clip_start,
    )
    for segment in transcript.get("segments", []):
        try:
            segment_start = float(segment["start"])
            segment_end = float(segment["end"])
        except (KeyError, TypeError, ValueError):
            continue
        if segment_end <= clip_start or segment_start >= clip_end:
            continue

        for word in _word_timings_for_segment(segment):
            if speech_start is not None and float(word["start"]) < speech_start - 0.02:
                continue
            if float(word["end"]) > clip_end + 0.02:
                continue
            start = max(float(word["start"]), clip_start) - clip_start
            end = min(float(word["end"]), clip_end) - clip_start
            if not word["text"] or end <= start:
                continue
            words.append(
                {
                    "text": str(word["text"]).strip(),
                    "start": max(0.0, start),
                    "end": min(clip_duration, end),
                }
            )

    words.sort(key=lambda cue: (cue["start"], cue["end"]))
    cues = []
    bf_editorial_style = _is_bf_editorial_profile(render_profile) or (
        _is_bf_editorial_profile(caption_style)
    )
    motivational_style = _uses_editorial_caption_style(
        caption_style,
        render_profile,
    )
    groups = _group_caption_words(
        words,
        min_words=(
            BF_EDITORIAL_MIN_PHRASE_WORDS
            if bf_editorial_style
            else 2
            if motivational_style
            else CAPTION_MIN_PHRASE_WORDS
        ),
        max_words=(
            BF_EDITORIAL_MAX_PHRASE_WORDS
            if bf_editorial_style
            else 6
            if motivational_style
            else CAPTION_MAX_PHRASE_WORDS
        ),
        target_words=(
            2.6
            if bf_editorial_style
            else 4.0
            if motivational_style
            else 4.5
        ),
        extra_forbidden_endings=(
            MOTIVATIONAL_DANGLING_ENDINGS if motivational_style else None
        ),
        break_on_clauses=motivational_style,
        merge_short_groups=not bf_editorial_style,
    )
    if motivational_style:
        groups = [group for group in groups if not _caption_is_filler_singleton(group)]
        groups = _merge_fast_editorial_caption_groups(
            groups,
            max_words=(
                BF_EDITORIAL_MAX_PHRASE_WORDS
                if bf_editorial_style
                else 6
            ),
        )
    sentence_layout = _caption_sentence_layout(groups) if motivational_style else []
    typography_plan = (
        _caption_typography_plan(
            groups,
            caption_context=caption_context,
            sentence_layout=sentence_layout,
            render_profile=(
                BF_EDITORIAL_INSET_RENDER_PROFILE
                if bf_editorial_style
                else render_profile
            ),
        )
        if motivational_style
        else []
    )
    for group_index, group in enumerate(groups):
        phrase_words = [str(word["text"]) for word in group]
        phrase_text = " ".join(phrase_words)
        if motivational_style:
            cues.extend(
                _progressive_editorial_cues(
                    group,
                    phrase_id=group_index,
                    clip_duration=clip_duration,
                    typography=typography_plan[group_index],
                    sentence_layout=sentence_layout[group_index],
                )
            )
            continue
        for active_index, word in enumerate(group):
            start = max(0.0, float(word["start"]) - CAPTION_VISUAL_LEAD_SECONDS)
            end = max(float(word["end"]), start + CAPTION_MIN_ACTIVE_SECONDS)
            if active_index + 1 < len(group):
                next_start = max(
                    0.0,
                    float(group[active_index + 1]["start"]) - CAPTION_VISUAL_LEAD_SECONDS,
                )
                end = max(start + CAPTION_MIN_ACTIVE_SECONDS, next_start)
            cues.append(
                {
                    "text": phrase_text,
                    "words": phrase_words,
                    "active_index": active_index,
                    "start": start,
                    "end": min(clip_duration, end),
                }
            )
    filtered = [cue for cue in cues if float(cue["end"]) > float(cue["start"])]
    return (
        _extend_editorial_phrase_gaps(filtered, clip_duration)
        if motivational_style
        else filtered
    )


def _resolve_font_path(
    candidates: List[str],
    common_paths: Tuple[str, ...],
) -> Optional[str]:
    for candidate in candidates:
        if candidate and Path(candidate).expanduser().is_file():
            return str(Path(candidate).expanduser())

    for candidate in candidates:
        if not candidate:
            continue
        try:
            result = subprocess.run(
                ["fc-match", "-f", "%{file}", candidate],
                check=True,
                capture_output=True,
                text=True,
            )
        except (FileNotFoundError, subprocess.CalledProcessError):
            break
        path = result.stdout.strip()
        if path and os.path.isfile(path):
            return path
    return next((path for path in common_paths if os.path.isfile(path)), None)


def _resolve_caption_font(caption_style: Optional[str] = None) -> Optional[str]:
    configured = os.getenv("LOCAL_CAPTION_FONT", "").strip()
    style_candidates = (
        MOTIVATIONAL_CAPTION_FONT_CANDIDATES
        if _uses_editorial_caption_style(caption_style)
        else CAPTION_FONT_CANDIDATES
    )
    candidates = ([configured] if configured else []) + list(style_candidates)
    return _resolve_font_path(
        candidates,
        (
            "/System/Library/Fonts/Supplemental/Impact.ttf",
            "/Library/Fonts/Impact.ttf",
            "C:/Windows/Fonts/impact.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ),
    )


def _resolve_motivational_support_font() -> Optional[str]:
    configured = os.getenv("LOCAL_MOTIVATIONAL_SUPPORT_FONT", "").strip()
    candidates = ([configured] if configured else []) + list(
        MOTIVATIONAL_SUPPORT_FONT_CANDIDATES
    )
    return _resolve_font_path(
        candidates,
        (
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/HelveticaNeue.ttc",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        ),
    )


def _resolve_motivational_accent_font() -> Optional[str]:
    configured = os.getenv("LOCAL_MOTIVATIONAL_ACCENT_FONT", "").strip()
    candidates = ([configured] if configured else []) + list(
        MOTIVATIONAL_ACCENT_FONT_CANDIDATES
    )
    return _resolve_font_path(
        candidates,
        (
            "/System/Library/Fonts/Supplemental/Georgia Bold Italic.ttf",
            "/System/Library/Fonts/Supplemental/Times New Roman Bold Italic.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSerif-BoldItalic.ttf",
        ),
    )


def _resolve_motivational_script_font() -> Optional[str]:
    configured = os.getenv("LOCAL_MOTIVATIONAL_SCRIPT_FONT", "").strip()
    candidates = ([configured] if configured else []) + list(
        MOTIVATIONAL_SCRIPT_FONT_CANDIDATES
    )
    return _resolve_font_path(
        candidates,
        (
            "/System/Library/Fonts/Supplemental/SignPainter.ttc",
            "/System/Library/Fonts/Supplemental/SnellRoundhand.ttc",
            "/System/Library/Fonts/Supplemental/Brush Script.ttf",
            "/System/Library/Fonts/Supplemental/Apple Chancery.ttf",
        ),
    )


def _rect_intersection_area(left: BBox, right: BBox) -> int:
    left_x1, left_y1 = left[0] + left[2], left[1] + left[3]
    right_x1, right_y1 = right[0] + right[2], right[1] + right[3]
    width = max(0, min(left_x1, right_x1) - max(left[0], right[0]))
    height = max(0, min(left_y1, right_y1) - max(left[1], right[1]))
    return width * height


def _expand_protected_face(box: BBox, frame_size: Tuple[int, int]) -> BBox:
    frame_width, frame_height = frame_size
    x, y, width, height = box
    pad_x = int(width * 0.16)
    pad_top = int(height * 0.10)
    pad_bottom = int(height * 0.28)
    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_top)
    x1 = min(frame_width, x + width + pad_x)
    y1 = min(frame_height, y + height + pad_bottom)
    return x0, y0, x1 - x0, y1 - y0


def _choose_editorial_caption_top(
    frame_size: Tuple[int, int],
    caption_size: Tuple[int, int],
    preferred_center_y: float,
    safe_box: Optional[BBox] = None,
    protected_boxes: Optional[List[BBox]] = None,
) -> int:
    """Place type near the speaker while keeping every detected face readable."""
    frame_width, frame_height = frame_size
    caption_width, caption_height = caption_size
    caption_x = max(0, int((frame_width - caption_width) / 2))
    protected_boxes = protected_boxes or []
    if safe_box:
        _, safe_top, _, safe_height = safe_box
        safe_bottom = safe_top + safe_height
        below_faces = (
            max(box[1] + box[3] for box in protected_boxes) + 10
            if protected_boxes
            else None
        )
        above_faces = (
            min(box[1] for box in protected_boxes) - caption_height - 10
            if protected_boxes
            else None
        )
        stable_baseline = safe_top + safe_height * 0.82
        candidates = [
            stable_baseline - caption_height,
            below_faces,
            safe_top + safe_height * 0.22,
            above_faces,
            safe_bottom - caption_height - 10,
            safe_top + 10,
            safe_bottom + 16,
            safe_top - caption_height - 16,
        ]
    else:
        candidates = [preferred_center_y - caption_height / 2]

    max_top = max(12, frame_height - caption_height - 12)
    ordered_tops = []
    for candidate in candidates:
        if candidate is None:
            continue
        top = max(12, min(max_top, int(round(candidate))))
        if top not in ordered_tops:
            ordered_tops.append(top)

    for top in ordered_tops:
        caption_box = (caption_x, top, caption_width, caption_height)
        if all(
            _rect_intersection_area(caption_box, protected) == 0
            for protected in protected_boxes
        ):
            return top

    return min(
        ordered_tops,
        key=lambda top: sum(
            _rect_intersection_area(
                (caption_x, top, caption_width, caption_height),
                protected,
            )
            for protected in protected_boxes
        ),
    )


def _editorial_caption_lane(
    safe_box: Optional[BBox],
    protected_boxes: Optional[List[BBox]],
) -> Tuple[int, int, int, int, str]:
    """Choose the wider side opposite one speaker, or a stable full-width lane."""
    if safe_box is None:
        return 0, 0, 0, 0, "full"
    safe_x, safe_y, safe_width, safe_height = safe_box
    faces = [
        box
        for box in (protected_boxes or [])
        if _rect_intersection_area(box, safe_box) > 0
    ]
    if len(faces) != 1:
        return safe_x, safe_y, safe_width, safe_height, "full"

    face_x, _, face_width, _ = faces[0]
    safe_right = safe_x + safe_width
    margin = max(12, int(safe_width * 0.025))
    left = (safe_x, max(0, face_x - margin - safe_x))
    right_x = min(safe_right, face_x + face_width + margin)
    right = (right_x, max(0, safe_right - right_x))
    lane_x, lane_width = max((left, right), key=lambda lane: lane[1])
    if lane_width < safe_width * 0.30:
        return safe_x, safe_y, safe_width, safe_height, "full"
    return lane_x, safe_y, lane_width, safe_height, "side"


def _editorial_kinetic_state(cue: Dict, elapsed: float) -> Dict[str, float]:
    """Return restrained phrase-level fade, scale and mask-reveal values."""
    phrase_start = float(cue.get("phrase_start", cue.get("start", 0.0)))
    entry_progress = max(
        0.0,
        min(
            1.0,
            (float(elapsed) - phrase_start)
            / max(0.001, BF_EDITORIAL_KINETIC_ENTRY_SECONDS),
        ),
    )
    eased = entry_progress * entry_progress * (3.0 - 2.0 * entry_progress)
    words = list(cue.get("words") or [])
    is_complete_phrase = bool(words) and int(
        cue.get("visible_word_count", len(words))
    ) >= len(words)
    exit_progress = 1.0
    if is_complete_phrase:
        exit_progress = max(
            0.0,
            min(
                1.0,
                (float(cue.get("end", elapsed)) - float(elapsed))
                / max(0.001, BF_EDITORIAL_KINETIC_EXIT_SECONDS),
            ),
        )
    exit_eased = exit_progress * exit_progress * (3.0 - 2.0 * exit_progress)
    return {
        "progress": entry_progress,
        "exit_progress": exit_progress,
        "opacity": (0.35 + 0.65 * eased) * exit_eased,
        "scale": 0.98 + 0.02 * eased,
        # Keep complete glyphs visible; partial letter masks read as jitter.
        "mask_reveal": 1.0,
    }


def _blend_caption_kinetic_roi(
    cv2,
    frame,
    captioned,
    box: Optional[BBox],
    *,
    mask_reveal: float,
    opacity: float,
):
    """Blend only the caption ROI while preserving full-frame pixel parity.

    The previous implementation copied and blended the complete 1080x1920
    frame even though ``masked`` differed from ``frame`` only inside the
    caption box.  OpenCV's weighted blend of a pixel with itself is identical,
    so restricting the operation to that changed rectangle produces the same
    bytes and avoids a second full-frame allocation/blend.
    """
    output = frame.copy()
    if not box:
        return output
    x, y, width, height = box
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(frame.shape[1], int(x + width))
    y1 = min(frame.shape[0], int(y + height))
    reveal_top = max(
        y0,
        min(
            y1,
            y0 + int(round((y1 - y0) * (1.0 - float(mask_reveal)))),
        ),
    )
    if x1 <= x0 or y1 <= reveal_top:
        return output
    output[reveal_top:y1, x0:x1] = cv2.addWeighted(
        captioned[reveal_top:y1, x0:x1],
        float(opacity),
        frame[reveal_top:y1, x0:x1],
        1.0 - float(opacity),
        0.0,
    )
    return output


class _CaptionRenderer:
    def __init__(
        self,
        frame_width: int,
        frame_height: int = 360,
        vertical_position_ratio: float = CAPTION_VERTICAL_POSITION_RATIO,
        caption_style: Optional[str] = None,
        render_profile: Optional[str] = None,
    ):
        try:
            from PIL import Image, ImageDraw, ImageFont
        except ImportError as e:
            raise RuntimeError(
                "Pillow is required for dynamic local captions. Install it with:\n"
                "    pip install -r requirements-local.txt"
            ) from e

        self.Image = Image
        self.ImageDraw = ImageDraw
        self.ImageFont = ImageFont
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.vertical_position_ratio = vertical_position_ratio
        self.caption_style = caption_style
        self.render_profile = render_profile
        self.bf_editorial_style = (
            _is_bf_editorial_profile(render_profile)
            or _is_bf_editorial_profile(caption_style)
        )
        self.editorial_style = _uses_editorial_caption_style(
            caption_style,
            render_profile,
        )
        self.base_font_size = (
            max(44, min(72, int(frame_height * 0.038)))
            if self.editorial_style
            else max(CAPTION_FONT_SIZE, int(frame_height * 0.06))
        )
        self.font_path = _resolve_caption_font(caption_style)
        self.support_font_path = (
            _resolve_motivational_support_font()
            if self.editorial_style
            else None
        )
        self.accent_font_path = (
            _resolve_motivational_accent_font()
            if self.editorial_style
            else None
        )
        self.script_font_path = (
            _resolve_motivational_script_font()
            if self.editorial_style
            else None
        )
        self.font_cache: Dict[Tuple[str, int], object] = {}
        self.last_layout_line_count = 0
        self.last_drawn_box: Optional[BBox] = None
        self.last_typography_variant: Optional[str] = None
        self.last_visible_word_count = 0
        self.editorial_phrase_tops: Dict[int, int] = {}
        self.editorial_phrase_lanes: Dict[int, Tuple[int, int, int, int, str]] = {}
        self.editorial_sentence_lanes: Dict[int, Tuple[int, int, int, int, str]] = {}
        self.last_kinetic_state: Optional[Dict[str, float]] = None
        # Editorial layout depends only on the words, typography plan, and lane
        # width.  It does not depend on the underlying video frame.  Reusing the
        # exact Pillow measurements avoids repeating the same font fitting work
        # for every frame in a held phrase without changing any drawn pixels.
        self.editorial_layout_cache: Dict[Tuple, Tuple] = {}
        self.editorial_layout_cache_hits = 0
        self.editorial_layout_cache_misses = 0
    def _font(self, size: int, style: str = "base"):
        if style == "script" and self.script_font_path:
            path = self.script_font_path
        elif style == "serif" and self.accent_font_path:
            path = self.accent_font_path
        elif style == "support" and self.support_font_path:
            path = self.support_font_path
        else:
            path = self.font_path
        key = (path or "default", size)
        if key not in self.font_cache:
            if path:
                self.font_cache[key] = self.ImageFont.truetype(path, size=size)
            else:
                self.font_cache[key] = self.ImageFont.load_default(size=size)
        return self.font_cache[key]

    def _layout(self, draw, words: List[str]):
        max_width = self.frame_width * CAPTION_MAX_WIDTH_RATIO
        for size in range(self.base_font_size, CAPTION_MIN_FONT_SIZE - 1, -2):
            font = self._font(size)
            space_width = float(draw.textlength(" ", font=font))
            lines: List[List[Tuple[int, str, float]]] = [[]]
            line_widths = [0.0]
            fits = True
            for index, word in enumerate(words):
                width = float(draw.textlength(word, font=font))
                extra = width + (space_width if lines[-1] else 0.0)
                if lines[-1] and line_widths[-1] + extra > max_width:
                    if len(lines) == 2:
                        fits = False
                        break
                    lines.append([])
                    line_widths.append(0.0)
                    extra = width
                lines[-1].append((index, word, width))
                line_widths[-1] += extra
            if fits:
                return font, size, lines, line_widths, space_width
        font = self._font(CAPTION_MIN_FONT_SIZE)
        widths = [float(draw.textlength(word, font=font)) for word in words]
        return font, CAPTION_MIN_FONT_SIZE, [list(zip(range(len(words)), words, widths))], [sum(widths)], 4.0

    def _editorial_layout(
        self,
        draw,
        words: List[str],
        emphasis_index: int,
        typography: Dict,
        max_width: Optional[float] = None,
    ):
        max_width = max_width or self.frame_width * 0.82
        initial_size = max(
            34,
            int(round(self.base_font_size * float(typography["base_scale"]))),
        )
        anchor_scale = float(typography["anchor_scale"])
        accent_style = str(typography["accent_style"])
        body_style = str(typography.get("body_style", "support"))
        secondary_index = int(typography.get("secondary_index", -1))
        secondary_scale = float(typography.get("secondary_scale", 0.78))
        secondary_style = str(typography.get("secondary_style", "base"))
        cache_key = (
            tuple(words),
            int(emphasis_index),
            float(max_width).hex(),
            int(initial_size),
            float(anchor_scale).hex(),
            accent_style,
            body_style,
            secondary_index,
            float(secondary_scale).hex(),
            secondary_style,
        )
        cached = self.editorial_layout_cache.get(cache_key)
        if cached is not None:
            self.editorial_layout_cache_hits += 1
            return cached
        self.editorial_layout_cache_misses += 1
        for base_size in range(initial_size, 17, -2):
            base_font = self._font(base_size)
            space_width = float(draw.textlength(" ", font=base_font))
            lines = [[]]
            line_widths = [0.0]
            fits = True
            for index, raw_word in enumerate(words):
                is_anchor = index == emphasis_index
                is_secondary = index == secondary_index and not is_anchor
                word_style = (
                    accent_style
                    if is_anchor
                    else secondary_style
                    if is_secondary
                    else body_style
                )
                if word_style == "script" and not self.script_font_path:
                    word_style = "serif"
                if word_style == "serif" and not self.accent_font_path:
                    word_style = "base"
                display_word = raw_word.strip(" \t\n,.;:!?\"“”")
                word_size = (
                    max(30, int(round(base_size * anchor_scale)))
                    if is_anchor
                    else max(28, int(round(base_size * secondary_scale)))
                    if is_secondary
                    else base_size
                )
                font = self._font(word_size, style=word_style)
                width = float(draw.textlength(display_word, font=font))
                if width > max_width:
                    fits = False
                    break
                extra = width + (space_width if lines[-1] else 0.0)
                if lines[-1] and line_widths[-1] + extra > max_width:
                    if len(lines) == 3:
                        fits = False
                        break
                    lines.append([])
                    line_widths.append(0.0)
                    extra = width
                lines[-1].append((index, display_word, width, font))
                line_widths[-1] += extra
            if fits:
                result = (lines, line_widths, space_width)
                self.editorial_layout_cache[cache_key] = result
                return result
        font = self._font(18)
        fallback_lines = [
            [(index, word, float(draw.textlength(word, font=font)), font)]
            for index, word in enumerate(words)
        ]
        result = (
            fallback_lines,
            [line[0][2] for line in fallback_lines],
            4.0,
        )
        self.editorial_layout_cache[cache_key] = result
        return result

    def _draw_editorial(
        self,
        image,
        draw,
        words: List[str],
        emphasis_index: int,
        typography: Dict,
        visible_word_count: int,
        phrase_id: Optional[int],
        sentence_id: Optional[int],
        sentence_phrase_index: int,
        sentence_phrase_count: int,
        caption_track_progress: Optional[float],
        protected_boxes: Optional[List[BBox]] = None,
        safe_box: Optional[BBox] = None,
        occupied_caption_boxes: Optional[List[BBox]] = None,
    ):
        fresh_lane = _editorial_caption_lane(safe_box, protected_boxes)
        if fresh_lane[2] <= 0:
            fresh_lane = (0, 0, image.width, image.height, "full")
        if sentence_id is not None:
            cached_lane = self.editorial_sentence_lanes.get(sentence_id)
        elif phrase_id is not None:
            cached_lane = self.editorial_phrase_lanes.get(phrase_id)
        else:
            cached_lane = None
        lane = cached_lane or fresh_lane
        lane_changed = False
        if cached_lane is not None:
            cached_box = cached_lane[:4]
            obstructed = any(
                _rect_intersection_area(cached_box, protected)
                > protected[2] * protected[3] * 0.08
                for protected in (protected_boxes or [])
            )
            if (
                cached_lane[4] == "full"
                and fresh_lane[4] == "side"
            ) or obstructed:
                lane = fresh_lane
                lane_changed = lane != cached_lane
        if sentence_id is not None:
            self.editorial_sentence_lanes[sentence_id] = lane
        elif phrase_id is not None:
            self.editorial_phrase_lanes[phrase_id] = lane
        if lane_changed and phrase_id is not None:
            self.editorial_phrase_tops.pop(phrase_id, None)
        planned_vertical_progress = caption_track_progress
        if planned_vertical_progress is None and sentence_id is not None:
            progress = (
                sentence_phrase_index / max(1, sentence_phrase_count - 1)
                if sentence_phrase_count > 1
                else 0.5
            )
            track_slot = (
                1
                if sentence_phrase_count == 1
                else min(2, max(0, int(round(progress * 2))))
            )
            planned_vertical_progress = MOTIVATIONAL_TRACK_POSITIONS[track_slot]
        if (
            planned_vertical_progress is not None
            and safe_box is not None
            and protected_boxes
        ):
            safe_x, safe_y, safe_width, safe_height = safe_box
            planned_center_y = safe_y + safe_height * planned_vertical_progress
            protected_top = min(box[1] for box in protected_boxes)
            protected_bottom = max(box[1] + box[3] for box in protected_boxes)
            clearance = self.base_font_size * 1.2
            if (
                planned_center_y < protected_top - clearance
                or planned_center_y > protected_bottom + clearance
            ):
                lane = (safe_x, safe_y, safe_width, safe_height, "full")
        lane_x, lane_y, lane_width, lane_height, lane_mode = lane
        layout_width = (
            lane_width * 0.92
            if lane_mode == "side"
            else image.width * 0.82
        )
        effective_typography = dict(typography)
        lines, line_widths, space_width = self._editorial_layout(
            draw,
            words,
            emphasis_index,
            effective_typography,
            max_width=layout_width,
        )
        self.last_layout_line_count = len(lines)
        self.last_typography_variant = str(typography["variant"])
        line_heights = []
        line_bboxes = []
        for line in lines:
            bboxes = [draw.textbbox((0, 0), word, font=font) for _, word, _, font in line]
            top = min((bbox[1] for bbox in bboxes), default=0)
            bottom = max((bbox[3] for bbox in bboxes), default=self.base_font_size)
            line_bboxes.append((top, bottom))
            line_heights.append(bottom - top + 10)
        block_height = sum(line_heights)
        max_line_width = max(line_widths, default=0.0)
        if phrase_id is not None and phrase_id in self.editorial_phrase_tops:
            y = self.editorial_phrase_tops[phrase_id]
        else:
            side_face = None
            if lane_mode == "side" and safe_box is not None:
                visible_faces = [
                    box
                    for box in (protected_boxes or [])
                    if _rect_intersection_area(box, safe_box) > 0
                ]
                if len(visible_faces) == 1:
                    side_face = visible_faces[0]
            if sentence_id is not None:
                if side_face is not None:
                    track_offset = max(
                        -1.0,
                        min(
                            1.0,
                            (
                                float(planned_vertical_progress) - 0.50
                            ) / 0.10,
                        ),
                    )
                    target_center = (
                        side_face[1]
                        + side_face[3] * 0.46
                        + track_offset * side_face[3] * 0.18
                    )
                else:
                    target_center = lane_y + lane_height * float(
                        planned_vertical_progress
                    )
                y = int(round(target_center - block_height / 2))
                y = max(
                    lane_y + 8,
                    min(lane_y + lane_height - block_height - 8, y),
                )
            elif lane_mode == "side":
                target_center = (
                    side_face[1] + side_face[3] * 0.46
                    if side_face is not None
                    else lane_y + lane_height * 0.50
                )
                y = int(round(target_center - block_height / 2))
                y = max(
                    lane_y + 8,
                    min(lane_y + lane_height - block_height - 8, y),
                )
            else:
                y = _choose_editorial_caption_top(
                    (image.width, image.height),
                    (int(math.ceil(max_line_width)) + 12, block_height + 8),
                    image.height * self.vertical_position_ratio,
                    safe_box=safe_box,
                    protected_boxes=protected_boxes,
                )
        self.last_visible_word_count = visible_word_count
        lane_padding = max(8, int(lane_width * 0.04))
        side_is_left = lane_x + lane_width / 2 <= image.width / 2
        if lane_mode == "side" and side_is_left:
            block_x = lane_x + lane_padding
        elif lane_mode == "side":
            block_x = lane_x + lane_width - max_line_width - lane_padding
        else:
            block_x = (image.width - max_line_width) / 2
        box_x = max(0, int(block_x) - 6)
        box_width = min(image.width, int(math.ceil(max_line_width)) + 12)
        box_height = min(image.height, block_height + 8)
        for occupied in occupied_caption_boxes or []:
            horizontal_overlap = (
                box_x < occupied[0] + occupied[2]
                and box_x + box_width > occupied[0]
            )
            candidate_top = max(0, y - 4)
            candidate_bottom = candidate_top + box_height
            occupied_top = occupied[1]
            occupied_bottom = occupied_top + occupied[3]
            if (
                horizontal_overlap
                and candidate_top < occupied_bottom + MOTIVATIONAL_CAPTION_BLOCK_GAP
                and candidate_bottom > occupied_top - MOTIVATIONAL_CAPTION_BLOCK_GAP
            ):
                y += occupied_bottom + MOTIVATIONAL_CAPTION_BLOCK_GAP - candidate_top
                y = min(y, lane_y + lane_height - block_height - 8)
        if phrase_id is not None:
            self.editorial_phrase_tops[phrase_id] = y
        self.last_drawn_box = (
            box_x,
            max(0, y - 4),
            box_width,
            min(image.height - max(0, y - 4), block_height + 8),
        )
        if occupied_caption_boxes is not None:
            occupied_caption_boxes.append(self.last_drawn_box)
        for line, line_width, line_height, (top, _) in zip(
            lines,
            line_widths,
            line_heights,
            line_bboxes,
        ):
            if lane_mode == "side" and side_is_left:
                x = lane_x + lane_padding
            elif lane_mode == "side":
                x = lane_x + lane_width - line_width - lane_padding
            else:
                x = (image.width - line_width) / 2
            for word_index, word, width, font in line:
                stroke_width = (
                    2
                    if typography["variant"] in {"headline", "hero", "reaction"}
                    else 1
                )
                text_y = y - top
                if word_index < visible_word_count:
                    draw.text(
                        (x + 1, text_y + 2),
                        word,
                        font=font,
                        fill=(0, 0, 0),
                        stroke_width=stroke_width + 1,
                        stroke_fill=(0, 0, 0),
                    )
                    draw.text(
                        (x, text_y),
                        word,
                        font=font,
                        fill=CAPTION_INACTIVE_FILL,
                        stroke_width=stroke_width,
                        stroke_fill=CAPTION_STROKE_FILL,
                    )
                x += width + space_width
            y += line_height

    def draw(
        self,
        frame,
        cue,
        protected_boxes: Optional[List[BBox]] = None,
        safe_box: Optional[BBox] = None,
        occupied_caption_boxes: Optional[List[BBox]] = None,
    ):
        import cv2  # type: ignore
        import numpy as np

        if isinstance(cue, dict):
            words = [str(word).strip() for word in cue.get("words", [])]
            active_index = int(cue.get("active_index", 0))
            emphasis_index = int(cue.get("emphasis_index", active_index))
            visible_word_count = max(
                0,
                min(len(words), int(cue.get("visible_word_count", len(words)))),
            )
            phrase_id_value = cue.get("phrase_id")
            phrase_id = (
                int(phrase_id_value)
                if phrase_id_value is not None
                else None
            )
            sentence_id_value = cue.get("sentence_id")
            sentence_id = (
                int(sentence_id_value)
                if sentence_id_value is not None
                else None
            )
            sentence_phrase_index = int(cue.get("sentence_phrase_index", 0))
            sentence_phrase_count = max(
                1,
                int(cue.get("sentence_phrase_count", 1)),
            )
            caption_track_progress_value = cue.get("caption_track_progress")
            caption_track_progress = (
                float(caption_track_progress_value)
                if caption_track_progress_value is not None
                else None
            )
            typography = {
                "variant": str(cue.get("typography_variant") or "statement"),
                "base_scale": float(cue.get("typography_base_scale", 1.0)),
                "anchor_scale": float(cue.get("typography_anchor_scale", 1.2)),
                "accent_style": str(cue.get("typography_accent_style") or "serif"),
                "body_style": str(cue.get("typography_body_style") or "support"),
                "secondary_index": int(cue.get("typography_secondary_index", -1)),
                "secondary_scale": float(cue.get("typography_secondary_scale", 0.78)),
                "secondary_style": str(cue.get("typography_secondary_style") or "base"),
            }
            kinetic_state = (
                _editorial_kinetic_state(
                    cue,
                    float(cue.get("_render_elapsed", cue.get("start", 0.0))),
                )
                if self.bf_editorial_style
                else None
            )
            if kinetic_state:
                typography["base_scale"] *= kinetic_state["scale"]
        else:
            words = str(cue).strip().split()
            active_index = 0
            emphasis_index = 0
            visible_word_count = len(words)
            phrase_id = None
            sentence_id = None
            sentence_phrase_index = 0
            sentence_phrase_count = 1
            caption_track_progress = None
            typography = {
                "variant": "statement",
                "base_scale": 1.0,
                "anchor_scale": 1.2,
                "accent_style": "serif",
                "body_style": "support",
                "secondary_index": -1,
                "secondary_scale": 0.78,
                "secondary_style": "base",
            }
            kinetic_state = None
        if not self.editorial_style:
            words = [word.upper() for word in words]
        words = [word for word in words if word]
        if not words:
            return frame
        image = self.Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        draw = self.ImageDraw.Draw(image)
        if self.editorial_style:
            self._draw_editorial(
                image,
                draw,
                words,
                emphasis_index,
                typography,
                visible_word_count,
                phrase_id,
                sentence_id,
                sentence_phrase_index,
                sentence_phrase_count,
                caption_track_progress,
                protected_boxes=protected_boxes,
                safe_box=safe_box,
                occupied_caption_boxes=occupied_caption_boxes,
            )
            captioned = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)
            self.last_kinetic_state = kinetic_state
            return captioned
        font, size, lines, line_widths, space_width = self._layout(draw, words)
        self.last_layout_line_count = len(lines)
        stroke_width = (
            max(2, min(3, size // 20))
            if self.caption_style == BUDGET_FRIENDLY_CAPTION_STYLE
            else max(2, size // 12)
        )
        bbox = draw.textbbox((0, 0), "Ag", font=font, stroke_width=stroke_width)
        line_height = bbox[3] - bbox[1] + max(6, size // 8)
        block_height = line_height * len(lines)
        y = image.height * self.vertical_position_ratio - block_height / 2
        for line, line_width in zip(lines, line_widths):
            x = (image.width - line_width) / 2
            for index, word, width in line:
                draw.text(
                    (x, y - bbox[1]),
                    word,
                    font=font,
                    fill=(
                        CAPTION_FILL
                        if (
                            self.caption_style != BUDGET_FRIENDLY_CAPTION_STYLE
                            and index == active_index
                        )
                        else CAPTION_INACTIVE_FILL
                    ),
                    stroke_width=stroke_width,
                    stroke_fill=CAPTION_STROKE_FILL,
                )
                x += width + space_width
            y += line_height
        return cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)


def _ratio(aspect_ratio: str) -> float:
    """Parse '9:16' → 9/16, '1:1' → 1.0."""
    try:
        w, h = aspect_ratio.split(":")
        return float(w) / float(h)
    except (ValueError, ZeroDivisionError):
        return 9.0 / 16.0


def _even(value: int) -> int:
    return max(2, value - (value % 2))


def _output_dimensions(
    aspect_ratio: str,
    render_profile: Optional[str] = None,
) -> Tuple[int, int]:
    target_ratio = _ratio(aspect_ratio)
    if (
        _is_bf_editorial_profile(render_profile)
        and abs(target_ratio - 9.0 / 16.0) < 0.01
    ):
        return 1080, 1920
    if abs(target_ratio - 9.0 / 16.0) < 0.01:
        return _even(max(720, LOCAL_OUTPUT_WIDTH)), _even(max(1280, LOCAL_OUTPUT_HEIGHT))
    height = _even(max(720, LOCAL_OUTPUT_HEIGHT))
    return _even(int(height * target_ratio)), height


def _resolve_realesrgan_runtime() -> Optional[Tuple[str, str]]:
    """Locate the bundled Real-ESRGAN binary and model directory."""
    candidates = []
    if LOCAL_REAL_ESRGAN_PATH:
        candidates.append(Path(LOCAL_REAL_ESRGAN_PATH).expanduser())
    module_path = Path(__file__).resolve()
    candidates.extend(
        [
            module_path.parents[2] / "var/runtimes/realesrgan-ncnn-vulkan",
            module_path.parents[3] / "var/runtimes/realesrgan-ncnn-vulkan",
        ]
    )
    on_path = shutil.which("realesrgan-ncnn-vulkan")
    if on_path:
        candidates.append(Path(on_path).parent)

    for candidate in candidates:
        binary = candidate if candidate.is_file() else candidate / "realesrgan-ncnn-vulkan"
        models = binary.parent / "models"
        if binary.is_file() and os.access(binary, os.X_OK) and models.is_dir():
            return str(binary), str(models)
    return None


def _realesrgan_scale(
    frame_size: Tuple[int, int],
    output_size: Tuple[int, int],
) -> Optional[int]:
    width, height = frame_size
    output_width, output_height = output_size
    required = max(output_width / max(1, width), output_height / max(1, height))
    if required <= 2.0:
        return 2
    if required <= 3.0:
        return 3
    return 4


def _realesrgan_runtime_scale(model_name: str, requested_scale: int) -> int:
    """Use each model at its native scale; x4plus is corrupt at x2 in NCNN."""
    normalized_model = str(model_name or "").strip().lower()
    if normalized_model in {
        "realesrgan-x4plus",
        "realesrgan-x4plus-anime",
        "realesrnet-x4plus",
    }:
        return 4
    return requested_scale


def _realesrgan_command(
    runtime: Tuple[str, str],
    input_dir: str,
    output_dir: str,
    scale: int,
    model_name: str = "realesr-animevideov3",
) -> List[str]:
    binary, models = runtime
    runtime_scale = _realesrgan_runtime_scale(model_name, scale)
    return [
        binary,
        "-i", input_dir,
        "-o", output_dir,
        "-m", models,
        "-n", model_name,
        "-s", str(runtime_scale),
        "-j", "2:2:2",
        "-f", "png",
    ]


def _realesrgan_runtime_fingerprint(
    runtime: Tuple[str, str],
    model_name: str,
) -> str:
    """Fingerprint the executable and weights so stale cache entries never mix."""
    binary, models = runtime
    paths = [Path(binary)]
    paths.extend(sorted(Path(models).glob(f"{model_name}*")))
    digest = hashlib.blake2b(digest_size=16)
    for path in paths:
        try:
            stat = path.stat()
        except OSError:
            continue
        digest.update(path.name.encode("utf-8", errors="replace"))
        digest.update(str(stat.st_size).encode("ascii"))
        digest.update(str(stat.st_mtime_ns).encode("ascii"))
    return digest.hexdigest()


def _realesrgan_cache_key(
    frame_bytes: bytes,
    input_size: Tuple[int, int],
    target_size: Tuple[int, int],
    model_name: str,
    working_scale: int,
    runtime_scale: int,
    runtime_fingerprint: str,
) -> str:
    """Build a content-addressed key for the lossless pre-caption enhancement."""
    digest = hashlib.blake2b(digest_size=32)
    metadata = "|".join(
        (
            REAL_ESRGAN_CACHE_SCHEMA,
            runtime_fingerprint,
            model_name,
            str(working_scale),
            str(runtime_scale),
            f"{input_size[0]}x{input_size[1]}",
            f"{target_size[0]}x{target_size[1]}",
        )
    )
    digest.update(metadata.encode("utf-8"))
    digest.update(frame_bytes)
    return digest.hexdigest()


def _realesrgan_cache_path(cache_dir: Path, cache_key: str) -> Path:
    return cache_dir / cache_key[:2] / f"{cache_key}.png"


def _read_realesrgan_cache_frame(cv2, path: Path, target_size: Tuple[int, int]):
    if not path.is_file():
        return None
    frame = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if frame is None or (frame.shape[1], frame.shape[0]) != target_size:
        return None
    try:
        os.utime(path, None)
    except OSError:
        pass
    return frame


def _write_realesrgan_cache_frame(cv2, path: Path, frame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(
        f".{path.stem}.{os.getpid()}.{get_ident()}.png"
    )
    if not cv2.imwrite(
        str(temporary_path),
        frame,
        [cv2.IMWRITE_PNG_COMPRESSION, 3],
    ):
        raise RuntimeError(f"could not write Real-ESRGAN cache frame: {path}")
    os.replace(temporary_path, path)


def _prune_realesrgan_cache(
    cache_dir: Path,
    max_bytes: int = REAL_ESRGAN_CACHE_MAX_BYTES,
) -> Tuple[int, int]:
    """Remove least-recently-used PNGs only after the configured budget is exceeded."""
    if not cache_dir.is_dir():
        return 0, 0
    entries = []
    total_bytes = 0
    for path in cache_dir.glob("*/*.png"):
        try:
            stat = path.stat()
        except OSError:
            continue
        total_bytes += stat.st_size
        entries.append((stat.st_mtime_ns, stat.st_size, path))
    if total_bytes <= max_bytes:
        return 0, total_bytes

    target_bytes = int(max_bytes * 0.90)
    removed = 0
    for _, size, path in sorted(entries):
        try:
            path.unlink()
        except OSError:
            continue
        total_bytes -= size
        removed += 1
        if total_bytes <= target_bytes:
            break
    return removed, total_bytes


def _blend_realesrgan_reference(
    cv2,
    enhanced,
    reference,
    reference_weight: Optional[float] = None,
):
    """Restore measured source detail while retaining the ESRGAN reconstruction."""
    weight = (
        LOCAL_REAL_ESRGAN_REFERENCE_BLEND
        if reference_weight is None
        else max(0.0, min(0.5, float(reference_weight)))
    )
    if weight <= 0.0:
        return enhanced
    return cv2.addWeighted(enhanced, 1.0 - weight, reference, weight, 0.0)


def _mux_audio_command(silent_path: str, in_path: str, out_path: str) -> List[str]:
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-i", silent_path,
        "-i", in_path,
        "-c:v", "libx264",
        "-preset", LOCAL_VIDEO_PRESET,
        "-crf", str(LOCAL_VIDEO_CRF),
        "-profile:v", LOCAL_VIDEO_PROFILE,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", LOCAL_AUDIO_BITRATE, "-ar", "48000",
        "-af", f"loudnorm=I={LOCAL_AUDIO_LOUDNESS}:LRA=7:TP={LOCAL_AUDIO_TRUE_PEAK}",
        "-map", "0:v:0", "-map", "1:a:0?",
        "-shortest",
        out_path,
    ]


def _resolve_motivational_music_profile(requested: Optional[str]) -> str:
    configured = str(LOCAL_MOTIVATIONAL_MUSIC_PROFILE or "auto").strip().lower()
    profile = configured if configured != "auto" else str(requested or "").strip().lower()
    if not profile or profile == "auto":
        profile = MOTIVATIONAL_MUSIC_REFLECTIVE
    if profile not in MOTIVATIONAL_MUSIC_PROFILE_SETTINGS:
        allowed = ", ".join(sorted(MOTIVATIONAL_MUSIC_PROFILE_SETTINGS))
        raise RuntimeError(f"Unknown motivational music profile {profile!r}; use {allowed} or auto")
    return profile


def _resolve_motivational_music_track(
    enabled: bool,
    music_profile: Optional[str] = None,
) -> Optional[str]:
    if not enabled or not LOCAL_MOTIVATIONAL_MUSIC:
        return None
    profile = _resolve_motivational_music_profile(music_profile)
    configured = LOCAL_MOTIVATIONAL_MUSIC_TRACK.strip()
    path = (
        Path(configured).expanduser()
        if configured
        else Path(__file__).resolve().parents[2]
        / "assets"
        / "music"
        / str(MOTIVATIONAL_MUSIC_PROFILE_SETTINGS[profile]["filename"])
    )
    if not path.is_absolute():
        path = Path.cwd() / path
    if not path.is_file():
        raise RuntimeError(
            "Motivational background music is enabled but the track is missing: "
            f"{path}. Set LOCAL_MOTIVATIONAL_MUSIC_TRACK or disable the layer."
        )
    return str(path.resolve())


def _motivational_payoff_start(caption_cues: List[Dict], duration: float) -> float:
    phrase_ids = [
        int(cue["phrase_id"])
        for cue in caption_cues
        if cue.get("phrase_id") is not None
    ]
    if phrase_ids:
        last_phrase = max(phrase_ids)
        starts = [
            float(cue["start"])
            for cue in caption_cues
            if int(cue.get("phrase_id", -1)) == last_phrase
        ]
        if starts:
            return max(0.0, min(duration, min(starts)))
    if caption_cues:
        return max(0.0, min(duration, float(caption_cues[-1]["start"])))
    return max(0.0, duration * 0.78)


def _motivational_music_volume_filter(
    duration: float,
    music_profile: str,
    payoff_start: Optional[float],
) -> str:
    intro_end = max(0.80, min(3.00, duration * 0.18))
    resolved_payoff = duration * 0.78 if payoff_start is None else float(payoff_start)
    resolved_payoff = max(intro_end + 0.35, min(max(0.0, duration - 0.15), resolved_payoff))
    dip_start = max(intro_end, resolved_payoff - 0.32)
    intro_gain, bed_gain, dip_gain, payoff_gain = MOTIVATIONAL_MUSIC_PROFILE_SETTINGS[
        music_profile
    ]["gains"]
    return (
        "volume='if(lt(t,{intro_end:.3f}),"
        "{intro_gain:.3f}+({bed_gain:.3f}-{intro_gain:.3f})*t/{intro_end:.3f},"
        "if(lt(t,{dip_start:.3f}),{bed_gain:.3f},"
        "if(lt(t,{payoff:.3f}),{dip_gain:.3f},{payoff_gain:.3f})))':eval=frame"
    ).format(
        intro_end=intro_end,
        intro_gain=intro_gain,
        bed_gain=bed_gain,
        dip_start=dip_start,
        payoff=resolved_payoff,
        dip_gain=dip_gain,
        payoff_gain=payoff_gain,
    )


def _motivational_audio_filter(
    duration: float,
    music_profile: str = MOTIVATIONAL_MUSIC_REFLECTIVE,
    payoff_start: Optional[float] = None,
    brand_tail_start_seconds: Optional[float] = None,
    speech_end_seconds: Optional[float] = None,
    brand_tail_transition_seconds: Optional[float] = None,
    brand_tail_audio_transition_seconds: Optional[float] = None,
    brand_tail_music_release_seconds: Optional[float] = None,
) -> str:
    music_fade_start = max(0.0, duration - MOTIVATIONAL_MUSIC_FADE_OUT_SECONDS)
    output_fade_start = max(0.0, duration - ENDING_FADE_SECONDS)
    music_volume = _motivational_music_volume_filter(
        duration,
        music_profile,
        payoff_start,
    )
    mute_start = (
        max(0.0, float(brand_tail_start_seconds))
        if brand_tail_start_seconds is not None
        else None
    )
    requested_audio_transition = (
        brand_tail_transition_seconds
        if brand_tail_audio_transition_seconds is None
        else brand_tail_audio_transition_seconds
    )
    audio_transition_seconds = max(
        0.0,
        min(
            BF_EDITORIAL_TAIL_CROSSFADE_SECONDS,
            BF_EDITORIAL_TAIL_CROSSFADE_SECONDS
            if requested_audio_transition is None
            else float(requested_audio_transition),
        ),
    )
    music_release_seconds = max(
        0.0,
        min(
            0.30,
            float(brand_tail_music_release_seconds or 0.0),
        ),
    )
    separate_smooth_landing = bool(
        mute_start is not None and music_release_seconds > 0.0
    )
    final_mix = (
        "[speech_mix][ducked_music]amix=inputs=2:duration=first:normalize=0,"
        f"alimiter=limit=0.75:level=false,afade=t=out:st={output_fade_start:.3f}:"
        f"d={ENDING_FADE_SECONDS:.3f}"
    )
    if mute_start is not None and not separate_smooth_landing:
        fade_start = max(
            0.0,
            mute_start - audio_transition_seconds,
        )
        if audio_transition_seconds > 0.0:
            final_mix += (
                f",afade=t=out:st={fade_start:.3f}:"
                f"d={max(0.001, mute_start - fade_start):.3f}"
            )
        final_mix += f",volume='if(gte(t,{mute_start:.3f}),0,1)':eval=frame"
    final_mix += "[aout]"
    speech_filter = (
        f"[1:a]aresample=48000,loudnorm=I={LOCAL_AUDIO_LOUDNESS}:"
        f"LRA=7:TP={LOCAL_AUDIO_TRUE_PEAK}"
    )
    if speech_end_seconds is not None:
        speech_end = max(0.0, min(duration, float(speech_end_seconds)))
        speech_fade_seconds = (
            audio_transition_seconds
            if separate_smooth_landing
            else BF_EDITORIAL_AUDIO_DECLICK_SECONDS
        )
        speech_fade_start = max(
            0.0,
            speech_end - speech_fade_seconds,
        )
        speech_filter += (
            f",atrim=end={speech_end:.3f},"
            f"afade=t=out:st={speech_fade_start:.3f}:"
            f"d={max(0.001, speech_end - speech_fade_start):.3f}"
        )
    speech_filter += f",apad,atrim=duration={duration:.3f}[speech]"
    music_landing_filter = ""
    if separate_smooth_landing and mute_start is not None:
        music_release_end = min(duration, mute_start + music_release_seconds)
        music_landing_filter = (
            f",afade=t=out:st={mute_start:.3f}:"
            f"d={max(0.001, music_release_end - mute_start):.3f}"
            f",volume='if(gte(t,{music_release_end:.3f}),0,1)':eval=frame"
        )
    return ";".join(
        [
            speech_filter,
            "[speech]asplit=2[speech_mix][speech_key]",
            f"[2:a]aresample=48000,atrim=duration={duration:.3f},"
            f"asetpts=PTS-STARTPTS,loudnorm=I={LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS}:"
            "LRA=5:TP=-6,highpass=f=70,lowpass=f=14000,"
            f"{music_volume},"
            f"afade=t=in:st=0:d={MOTIVATIONAL_MUSIC_FADE_IN_SECONDS:.3f},"
            f"afade=t=out:st={music_fade_start:.3f}:"
            f"d={MOTIVATIONAL_MUSIC_FADE_OUT_SECONDS:.3f}"
            f"{music_landing_filter}[music]",
            "[music][speech_key]sidechaincompress=threshold=0.055:ratio=4:"
            "attack=15:release=260[ducked_music]",
            final_mix,
        ]
    )


def _raw_video_command(
    audio_path: str,
    out_path: str,
    output_size: Tuple[int, int],
    fps: float,
    duration: Optional[float] = None,
    lossless: bool = False,
    music_path: Optional[str] = None,
    music_start_seconds: float = LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS,
    music_profile: str = MOTIVATIONAL_MUSIC_REFLECTIVE,
    music_payoff_seconds: Optional[float] = None,
    brand_tail_start_seconds: Optional[float] = None,
    speech_end_seconds: Optional[float] = None,
    brand_tail_transition_seconds: Optional[float] = None,
    brand_tail_audio_transition_seconds: Optional[float] = None,
    brand_tail_music_release_seconds: Optional[float] = None,
) -> List[str]:
    width, height = output_size
    loudness_filter = f"loudnorm=I={LOCAL_AUDIO_LOUDNESS}:LRA=7:TP={LOCAL_AUDIO_TRUE_PEAK}"
    fade_start = max(0.0, float(duration or 0.0) - ENDING_FADE_SECONDS)
    audio_filter = loudness_filter
    video_filter = None
    if (
        duration
        and duration > ENDING_FADE_SECONDS
        and brand_tail_start_seconds is None
    ):
        audio_filter += f",afade=t=out:st={fade_start:.3f}:d={ENDING_FADE_SECONDS:.3f}"
        video_filter = f"fade=t=out:st={fade_start:.3f}:d={ENDING_FADE_SECONDS:.3f}"
    command = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-f", "rawvideo", "-pix_fmt", "bgr24",
        "-s:v", f"{width}x{height}", "-r", f"{fps:.6f}", "-i", "pipe:0",
        "-i", audio_path,
    ]
    use_music = bool(music_path and duration and not lossless)
    if use_music:
        command.extend(
            [
                "-stream_loop", "-1",
                "-ss", f"{max(0.0, music_start_seconds):.3f}",
                "-i", str(music_path),
            ]
        )
    if lossless:
        command.extend(
            [
                "-map", "0:v:0", "-map", "1:a:0?",
                "-c:v", "ffv1", "-level", "3",
                "-c:a", "pcm_s16le", "-shortest", out_path,
            ]
        )
        return command
    if video_filter:
        command.extend(["-vf", video_filter])
    command.extend(["-map", "0:v:0"])
    if use_music:
        command.extend(
            [
                "-filter_complex", _motivational_audio_filter(
                    float(duration),
                    music_profile=music_profile,
                    payoff_start=music_payoff_seconds,
                    brand_tail_start_seconds=brand_tail_start_seconds,
                    speech_end_seconds=speech_end_seconds,
                    brand_tail_transition_seconds=brand_tail_transition_seconds,
                    brand_tail_audio_transition_seconds=(
                        brand_tail_audio_transition_seconds
                    ),
                    brand_tail_music_release_seconds=(
                        brand_tail_music_release_seconds
                    ),
                ),
                "-map", "[aout]",
            ]
        )
    else:
        command.extend(["-map", "1:a:0?"])
    command.extend([
        "-c:v", "libx264",
        "-preset", LOCAL_VIDEO_PRESET,
        "-crf", str(LOCAL_VIDEO_CRF),
        "-profile:v", LOCAL_VIDEO_PROFILE,
        "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", LOCAL_AUDIO_BITRATE, "-ar", "48000",
    ])
    if not use_music:
        if speech_end_seconds is not None:
            speech_end = max(
                0.0,
                min(float(duration or speech_end_seconds), float(speech_end_seconds)),
            )
            separate_smooth_landing = bool(
                brand_tail_start_seconds is not None
                and float(brand_tail_music_release_seconds or 0.0) > 0.0
            )
            speech_fade_seconds = (
                max(
                    0.0,
                    min(
                        BF_EDITORIAL_TAIL_CROSSFADE_SECONDS,
                        float(brand_tail_audio_transition_seconds or 0.0),
                    ),
                )
                if separate_smooth_landing
                else BF_EDITORIAL_AUDIO_DECLICK_SECONDS
            )
            speech_fade_start = max(
                0.0,
                speech_end - speech_fade_seconds,
            )
            audio_filter += (
                f",atrim=end={speech_end:.3f},"
                f"afade=t=out:st={speech_fade_start:.3f}:"
                f"d={max(0.001, speech_end - speech_fade_start):.3f}"
            )
        if duration:
            audio_filter += f",apad,atrim=duration={float(duration):.3f}"
        if (
            brand_tail_start_seconds is not None
            and not bool(float(brand_tail_music_release_seconds or 0.0) > 0.0)
        ):
            mute_start = max(0.0, float(brand_tail_start_seconds))
            requested_audio_transition = (
                brand_tail_transition_seconds
                if brand_tail_audio_transition_seconds is None
                else brand_tail_audio_transition_seconds
            )
            transition_seconds = max(
                0.0,
                min(
                    BF_EDITORIAL_TAIL_CROSSFADE_SECONDS,
                    BF_EDITORIAL_TAIL_CROSSFADE_SECONDS
                    if requested_audio_transition is None
                    else float(requested_audio_transition),
                ),
            )
            fade_start = max(
                0.0,
                mute_start - transition_seconds,
            )
            if transition_seconds > 0.0:
                audio_filter += (
                    f",afade=t=out:st={fade_start:.3f}:"
                    f"d={max(0.001, mute_start - fade_start):.3f}"
                )
            audio_filter += (
                f",volume='if(gte(t,{mute_start:.3f}),0,1)':eval=frame"
            )
        command.extend(["-af", audio_filter])
    command.extend(["-shortest", out_path])
    return command


def _composite_encode_command(
    beat_paths: List[str],
    beat_durations: List[float],
    out_path: str,
    transition_seconds: float,
) -> List[str]:
    command = ["ffmpeg", "-y", "-loglevel", "error"]
    for path in beat_paths:
        command.extend(["-i", path])

    filters = []
    for index in range(len(beat_paths)):
        filters.append(
            f"[{index}:v]format=yuv420p,settb=AVTB,setpts=PTS-STARTPTS[v{index}]"
        )
        filters.append(f"[{index}:a]aresample=async=1:first_pts=0[a{index}]")
    video_label = "v0"
    audio_label = "a0"
    composed_duration = float(beat_durations[0])
    if transition_seconds <= 0.0 and len(beat_paths) > 1:
        concat_inputs = "".join(f"[v{index}][a{index}]" for index in range(len(beat_paths)))
        filters.append(
            f"{concat_inputs}concat=n={len(beat_paths)}:v=1:a=1[vcat][acat]"
        )
        video_label = "vcat"
        audio_label = "acat"
        composed_duration = sum(float(duration) for duration in beat_durations)
    else:
        for index in range(1, len(beat_paths)):
            offset = max(0.0, composed_duration - transition_seconds)
            next_video = f"vx{index}"
            next_audio = f"ax{index}"
            filters.append(
                f"[{video_label}][v{index}]xfade=transition=fade:"
                f"duration={transition_seconds:.3f}:offset={offset:.3f}[{next_video}]"
            )
            filters.append(
                f"[{audio_label}][a{index}]acrossfade=d={transition_seconds:.3f}:"
                f"c1=qsin:c2=qsin[{next_audio}]"
            )
            video_label = next_video
            audio_label = next_audio
            composed_duration += float(beat_durations[index]) - transition_seconds

    fade_start = max(0.0, composed_duration - ENDING_FADE_SECONDS)
    filters.append(
        f"[{video_label}]fade=t=out:st={fade_start:.3f}:d={ENDING_FADE_SECONDS:.3f}[vout]"
    )
    filters.append(
        f"[{audio_label}]loudnorm=I={LOCAL_AUDIO_LOUDNESS}:LRA=7:TP={LOCAL_AUDIO_TRUE_PEAK},"
        f"afade=t=out:st={fade_start:.3f}:d={ENDING_FADE_SECONDS:.3f}[aout]"
    )
    command.extend(
        [
            "-filter_complex", ";".join(filters),
            "-map", "[vout]", "-map", "[aout]",
            "-c:v", "libx264", "-preset", LOCAL_VIDEO_PRESET,
            "-crf", str(LOCAL_VIDEO_CRF), "-profile:v", LOCAL_VIDEO_PROFILE,
            "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", LOCAL_AUDIO_BITRATE, "-ar", "48000",
            "-movflags", "+faststart",
            out_path,
        ]
    )
    return command


def _probe_duration(path: str) -> float:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "default=nw=1:nk=1", path,
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return float(result.stdout.strip())


def _visual_analysis_cache_key(
    source_path: str,
    start: float,
    end: float,
    fps: float,
    layout_hint: Optional[str],
    render_profile: Optional[str],
    shot_change_times: Optional[List[float]],
) -> str:
    """Key deterministic face/layout work by source identity and exact interval."""
    source = Path(source_path).expanduser()
    try:
        stat = source.stat()
        source_identity = (
            str(source.resolve()),
            str(stat.st_size),
            str(stat.st_mtime_ns),
        )
    except OSError:
        source_identity = (str(source), "missing", "missing")
    metadata = {
        "schema": VISUAL_ANALYSIS_CACHE_SCHEMA,
        "source": source_identity,
        "start": round(float(start), 6),
        "end": round(float(end), 6),
        "fps": round(float(fps), 6),
        "layout_hint": str(layout_hint or ""),
        "render_profile": str(render_profile or ""),
        "shot_changes": [
            round(float(value), 6)
            for value in (shot_change_times or [])
        ],
    }
    payload = json.dumps(metadata, sort_keys=True, separators=(",", ":"))
    return hashlib.blake2b(payload.encode("utf-8"), digest_size=24).hexdigest()


def _visual_analysis_cache_path(cache_key: str) -> Path:
    return VISUAL_ANALYSIS_CACHE_DIR / cache_key[:2] / f"{cache_key}.json"


def _normalize_cached_bbox(value) -> Optional[BBox]:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    return tuple(int(component) for component in value)  # type: ignore[return-value]


def _read_visual_analysis_cache(cache_key: Optional[str]) -> Optional[Dict]:
    if not VISUAL_ANALYSIS_CACHE_ENABLED or not cache_key:
        return None
    path = _visual_analysis_cache_path(cache_key)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if payload.get("schema") != VISUAL_ANALYSIS_CACHE_SCHEMA:
        return None
    layout = str(payload.get("layout") or "")
    if not layout:
        return None
    plan = []
    for shot in payload.get("locked_speaker_plan") or []:
        if not isinstance(shot, dict):
            return None
        plan.append(
            {
                "start": float(shot.get("start", 0.0)),
                "end": float(shot.get("end", 0.0)),
                "bbox": _normalize_cached_bbox(shot.get("bbox")),
            }
        )
    try:
        os.utime(path, None)
    except OSError:
        pass
    return {
        "layout": layout,
        "tracked_face": _normalize_cached_bbox(payload.get("tracked_face")),
        "locked_speaker_plan": plan,
    }


def _write_visual_analysis_cache(
    cache_key: Optional[str],
    layout: str,
    tracked_face: Optional[BBox],
    locked_speaker_plan: List[Dict],
) -> None:
    if not VISUAL_ANALYSIS_CACHE_ENABLED or not cache_key:
        return
    path = _visual_analysis_cache_path(cache_key)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "schema": VISUAL_ANALYSIS_CACHE_SCHEMA,
        "layout": layout,
        "tracked_face": list(tracked_face) if tracked_face else None,
        "locked_speaker_plan": [
            {
                "start": float(shot["start"]),
                "end": float(shot["end"]),
                "bbox": list(shot["bbox"]) if shot.get("bbox") else None,
            }
            for shot in locked_speaker_plan
        ],
    }
    temporary_path = path.with_name(
        f".{path.stem}.{os.getpid()}.{get_ident()}.json"
    )
    temporary_path.write_text(
        json.dumps(payload, sort_keys=True, separators=(",", ":")),
        encoding="utf-8",
    )
    os.replace(temporary_path, path)


def _detect_faces(cv2, face_cascade, frame, min_size: int = 20) -> List[BBox]:
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.equalizeHist(gray)
    faces = face_cascade.detectMultiScale(
        gray,
        scaleFactor=1.08,
        minNeighbors=6,
        minSize=(min_size, min_size),
    )
    return [tuple(int(value) for value in face) for face in faces]


def _detect_profile_faces(
    cv2,
    profile_face_cascade,
    frame,
    min_size: int = 20,
) -> List[BBox]:
    """Detect persistent side-profile speakers while ignoring tiny UI marks."""
    if profile_face_cascade is None:
        return []
    gray = cv2.equalizeHist(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY))
    frame_height, frame_width = gray.shape[:2]
    frame_area = max(1, frame_width * frame_height)
    candidates = []
    for image, mirrored in ((gray, False), (cv2.flip(gray, 1), True)):
        faces = profile_face_cascade.detectMultiScale(
            image,
            scaleFactor=1.08,
            minNeighbors=4,
            minSize=(min_size, min_size),
        )
        for raw_box in faces:
            x, y, width, height = (int(value) for value in raw_box)
            if mirrored:
                x = frame_width - x - width
            area_ratio = width * height / frame_area
            if 0.006 <= area_ratio <= 0.30:
                candidates.append((x, y, width, height))

    deduplicated: List[BBox] = []
    for box in sorted(candidates, key=lambda item: item[2] * item[3], reverse=True):
        box_area = max(1, box[2] * box[3])
        if any(
            _rect_intersection_area(box, current)
            / min(box_area, max(1, current[2] * current[3]))
            >= 0.45
            for current in deduplicated
        ):
            continue
        deduplicated.append(box)
    return deduplicated


def _median_bbox(boxes: List[BBox]) -> BBox:
    values = []
    for index in range(4):
        ordered = sorted(box[index] for box in boxes)
        values.append(int(ordered[len(ordered) // 2]))
    return tuple(values)  # type: ignore[return-value]


def _facecam_corner(box: BBox, frame_width: int, frame_height: int) -> Optional[str]:
    x, y, width, height = box
    center_x = (x + width / 2) / frame_width
    center_y = (y + height / 2) / frame_height
    horizontal = "left" if center_x <= FACECAM_EDGE_RATIO else "right" if center_x >= 1 - FACECAM_EDGE_RATIO else None
    vertical = "top" if center_y <= FACECAM_EDGE_RATIO else "bottom" if center_y >= 1 - FACECAM_EDGE_RATIO else None
    return f"{vertical}-{horizontal}" if horizontal and vertical else None


def _classify_facecam_candidates(
    candidates: List[Tuple[int, BBox]],
    frame_size: Tuple[int, int],
    sample_count: int,
) -> Optional[BBox]:
    """Find a small face that persists in the same screen corner."""
    frame_width, frame_height = frame_size
    frame_area = frame_width * frame_height
    by_sample_and_corner: Dict[Tuple[int, str], BBox] = {}
    for sample_index, box in candidates:
        area_ratio = box[2] * box[3] / frame_area
        corner = _facecam_corner(box, frame_width, frame_height)
        if not corner or not FACECAM_MIN_AREA_RATIO <= area_ratio <= FACECAM_MAX_AREA_RATIO:
            continue
        key = (sample_index, corner)
        current = by_sample_and_corner.get(key)
        if current is None or box[2] * box[3] > current[2] * current[3]:
            by_sample_and_corner[key] = box

    clusters: Dict[str, List[BBox]] = {}
    for (_, corner), box in by_sample_and_corner.items():
        clusters.setdefault(corner, []).append(box)
    if not clusters:
        return None

    minimum_hits = max(3, int(math.ceil(sample_count * FACECAM_MIN_SAMPLE_RATIO)))
    _, boxes = max(clusters.items(), key=lambda item: len(item[1]))
    if len(boxes) < minimum_hits:
        return None

    median = _median_bbox(boxes)
    median_center = (median[0] + median[2] / 2, median[1] + median[3] / 2)
    inliers = [
        box
        for box in boxes
        if abs((box[0] + box[2] / 2) - median_center[0]) <= frame_width * 0.14
        and abs((box[1] + box[3] / 2) - median_center[1]) <= frame_height * 0.14
    ]
    return _median_bbox(inliers) if len(inliers) >= minimum_hits else None


def _classify_speaker_candidates(
    candidates: List[Tuple[int, BBox]],
    frame_size: Tuple[int, int],
    sample_count: int,
) -> Optional[BBox]:
    """Preserve face-follow framing for ordinary talking-head footage."""
    frame_width, frame_height = frame_size
    largest_by_sample: Dict[int, BBox] = {}
    for sample_index, box in candidates:
        current = largest_by_sample.get(sample_index)
        if current is None or box[2] * box[3] > current[2] * current[3]:
            largest_by_sample[sample_index] = box
    boxes = list(largest_by_sample.values())
    minimum_hits = max(3, (sample_count + 3) // 4)
    if len(boxes) < minimum_hits:
        return None

    median = _median_bbox(boxes)
    median_center = (median[0] + median[2] / 2, median[1] + median[3] / 2)
    inliers = [
        box
        for box in boxes
        if abs((box[0] + box[2] / 2) - median_center[0]) <= frame_width * 0.22
        and abs((box[1] + box[3] / 2) - median_center[1]) <= frame_height * 0.22
    ]
    return _median_bbox(inliers) if len(inliers) >= minimum_hits else None


def _foreground_bbox(cv2, frame) -> Tuple[Optional[BBox], float, float]:
    """Find content against a mostly uniform slide/animation background."""
    import numpy as np

    height, width = frame.shape[:2]
    border = np.concatenate(
        [frame[0], frame[-1], frame[:, 0], frame[:, -1]],
        axis=0,
    ).astype(np.int16)
    background = np.median(border, axis=0)
    border_distance = np.max(np.abs(border - background), axis=1)
    uniformity = float(np.mean(border_distance < 24))
    distance = np.max(np.abs(frame.astype(np.int16) - background), axis=2)
    mask = (distance > 30).astype(np.uint8) * 255
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    points = cv2.findNonZero(mask)
    occupancy = float(np.count_nonzero(mask)) / max(1, width * height)
    return (tuple(cv2.boundingRect(points)) if points is not None else None), occupancy, uniformity


def _presentation_subject(cv2, frames: List) -> Optional[BBox]:
    boxes = []
    occupancies = []
    uniformities = []
    for frame in frames:
        box, occupancy, uniformity = _foreground_bbox(cv2, frame)
        occupancies.append(occupancy)
        uniformities.append(uniformity)
        if box and occupancy >= 0.002:
            boxes.append(box)
    if not boxes:
        return None
    ordered_occupancy = sorted(occupancies)
    ordered_uniformity = sorted(uniformities)
    median_occupancy = ordered_occupancy[len(ordered_occupancy) // 2]
    median_uniformity = ordered_uniformity[len(ordered_uniformity) // 2]
    if median_uniformity < 0.78 or median_occupancy > 0.35:
        return None

    x0 = min(box[0] for box in boxes)
    y0 = min(box[1] for box in boxes)
    x1 = max(box[0] + box[2] for box in boxes)
    y1 = max(box[1] + box[3] for box in boxes)
    return x0, y0, x1 - x0, y1 - y0


def _detect_clip_layout(
    cv2,
    cap,
    face_cascade,
    frame_size: Tuple[int, int],
    layout_hint: Optional[str] = None,
    profile_face_cascade=None,
) -> Tuple[str, Optional[BBox]]:
    frame_count = max(1, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    sample_count = min(FACECAM_SAMPLE_COUNT, frame_count)
    candidates: List[Tuple[int, BBox]] = []
    profile_candidates: List[Tuple[int, BBox]] = []
    sample_frames = []
    min_size = max(18, min(frame_size) // 24)

    for sample_index in range(sample_count):
        position = int(sample_index * (frame_count - 1) / max(1, sample_count - 1))
        cap.set(cv2.CAP_PROP_POS_FRAMES, position)
        ok, frame = cap.read()
        if not ok:
            continue
        sample_frames.append(frame)
        for box in _detect_faces(cv2, face_cascade, frame, min_size=min_size):
            candidates.append((sample_index, box))
        if layout_hint in {
            BF_EDITORIAL_INSET_LAYOUT,
            "motivational_editorial",
        }:
            for box in _detect_profile_faces(
                cv2,
                profile_face_cascade,
                frame,
                min_size=min_size,
            ):
                profile_candidates.append((sample_index, box))
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    if layout_hint == "presentation":
        presentation = _presentation_subject(cv2, sample_frames)
        return "presentation", presentation or (0, 0, frame_size[0], frame_size[1])
    if layout_hint == "motion":
        return "motion", None

    if layout_hint == BF_EDITORIAL_INSET_LAYOUT:
        speaker = _classify_speaker_candidates(
            profile_candidates,
            frame_size,
            sample_count,
        ) or _classify_speaker_candidates(candidates, frame_size, sample_count)
        return BF_EDITORIAL_INSET_LAYOUT, speaker
    if layout_hint == "motivational_editorial":
        speaker = _classify_speaker_candidates(
            profile_candidates,
            frame_size,
            sample_count,
        ) or _classify_speaker_candidates(candidates, frame_size, sample_count)
        return "editorial_speaker", speaker
    if layout_hint == "motivational_speaker":
        speaker = _classify_speaker_candidates(candidates, frame_size, sample_count)
        return "stable_speaker", speaker

    facecam = _classify_facecam_candidates(candidates, frame_size, sample_count)
    if facecam:
        return "split", facecam
    if layout_hint in {"gaming", "gameplay", "motion"}:
        return "motion", None
    speaker = _classify_speaker_candidates(candidates, frame_size, sample_count)
    if speaker:
        return "speaker", speaker
    presentation = _presentation_subject(cv2, sample_frames)
    if presentation:
        return "presentation", presentation
    return "motion", None


def _smooth_bbox(previous: BBox, current: BBox, smoothing: float = 0.18) -> BBox:
    return tuple(
        int(old + (new - old) * smoothing)
        for old, new in zip(previous, current)
    )  # type: ignore[return-value]


def _update_stable_speaker_bbox(
    previous: BBox,
    current: BBox,
    frame_size: Tuple[int, int],
) -> BBox:
    """Follow editorial camera cuts without creating a visible digital pan."""
    frame_width, frame_height = frame_size
    old_center = (previous[0] + previous[2] / 2, previous[1] + previous[3] / 2)
    new_center = (current[0] + current[2] / 2, current[1] + current[3] / 2)
    normalized_distance = math.hypot(
        (new_center[0] - old_center[0]) / max(1, frame_width),
        (new_center[1] - old_center[1]) / max(1, frame_height),
    )
    old_area = max(1, previous[2] * previous[3])
    area_ratio = (current[2] * current[3]) / old_area
    if normalized_distance >= 0.18 or area_ratio < 0.45 or area_ratio > 2.2:
        return current
    return _smooth_bbox(previous, current, smoothing=0.12)


def _select_locked_speaker_bbox(
    candidates: List[Tuple[int, BBox]],
    frame_size: Tuple[int, int],
    previous: Optional[BBox] = None,
) -> Optional[BBox]:
    """Choose one persistent face for a source shot and never switch mid-shot."""
    if not candidates:
        return None
    frame_width, frame_height = frame_size
    clusters: List[Dict] = []
    for sample_index, box in candidates:
        center = (
            (box[0] + box[2] / 2) / max(1, frame_width),
            (box[1] + box[3] / 2) / max(1, frame_height),
        )
        nearest = None
        nearest_distance = float("inf")
        for cluster in clusters:
            distance = math.hypot(
                center[0] - cluster["center"][0],
                center[1] - cluster["center"][1],
            )
            if distance < nearest_distance:
                nearest = cluster
                nearest_distance = distance
        if nearest is None or nearest_distance > 0.18:
            clusters.append(
                {
                    "boxes": [box],
                    "samples": {sample_index},
                    "center": center,
                }
            )
            continue
        nearest["boxes"].append(box)
        nearest["samples"].add(sample_index)
        median = _median_bbox(nearest["boxes"])
        nearest["center"] = (
            (median[0] + median[2] / 2) / max(1, frame_width),
            (median[1] + median[3] / 2) / max(1, frame_height),
        )

    previous_center = None
    if previous is not None:
        previous_center = (
            (previous[0] + previous[2] / 2) / max(1, frame_width),
            (previous[1] + previous[3] / 2) / max(1, frame_height),
        )

    def cluster_area(cluster: Dict) -> float:
        median = _median_bbox(cluster["boxes"])
        return median[2] * median[3] / max(1, frame_width * frame_height)

    max_persistence = max(len(cluster["samples"]) for cluster in clusters)
    persistent = [
        cluster
        for cluster in clusters
        if len(cluster["samples"]) >= max(1, max_persistence - 1)
    ]
    max_area = max(cluster_area(cluster) for cluster in persistent)
    plausible = [
        cluster
        for cluster in persistent
        if cluster_area(cluster) >= max_area * 0.65
    ]

    def cluster_key(cluster: Dict):
        area = cluster_area(cluster)
        continuity = (
            -math.hypot(
                cluster["center"][0] - previous_center[0],
                cluster["center"][1] - previous_center[1],
            )
            if previous_center is not None
            else 0.0
        )
        return len(cluster["samples"]), continuity, area

    winner = max(plausible, key=cluster_key)
    return _median_bbox(winner["boxes"])


def _build_locked_speaker_plan(
    cv2,
    cap,
    face_cascade,
    frame_size: Tuple[int, int],
    fps: float,
    clip_duration: float,
    shot_change_times: Optional[List[float]],
    initial_face: Optional[BBox] = None,
    profile_face_cascade=None,
) -> List[Dict]:
    boundaries = [
        0.0,
        *sorted(
            float(value)
            for value in (shot_change_times or [])
            if 0.10 < float(value) < clip_duration - 0.10
        ),
        clip_duration,
    ]
    plan = []
    previous = initial_face
    min_size = max(18, min(frame_size) // 24)
    for shot_index in range(len(boundaries) - 1):
        start = boundaries[shot_index]
        end = boundaries[shot_index + 1]
        duration = max(0.001, end - start)
        sample_count = max(3, min(7, int(math.ceil(duration * 1.5))))
        candidates: List[Tuple[int, BBox]] = []
        profile_candidates: List[Tuple[int, BBox]] = []
        for sample_index in range(sample_count):
            fraction = (sample_index + 1) / (sample_count + 1)
            timestamp = start + duration * fraction
            cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
            ok, frame = cap.read()
            if not ok:
                continue
            for box in _detect_faces(cv2, face_cascade, frame, min_size=min_size):
                candidates.append((sample_index, box))
            for box in _detect_profile_faces(
                cv2,
                profile_face_cascade,
                frame,
                min_size=min_size,
            ):
                profile_candidates.append((sample_index, box))
        minimum_profile_hits = max(2, min(3, int(math.ceil(sample_count * 0.35))))
        profile_hits = len(
            {sample_index for sample_index, _ in profile_candidates}
        )
        selected = (
            _select_locked_speaker_bbox(
                profile_candidates,
                frame_size,
                previous=previous,
            )
            if profile_hits >= minimum_profile_hits
            else None
        ) or _select_locked_speaker_bbox(
            candidates,
            frame_size,
            previous=previous,
        )
        if selected is None and len(boundaries) == 2:
            selected = initial_face
        plan.append({"start": start, "end": end, "bbox": selected})
        if selected is not None:
            previous = selected
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
    return plan


def _locked_speaker_bbox_at(plan: List[Dict], elapsed: float) -> Optional[BBox]:
    for shot in plan:
        if float(shot["start"]) <= elapsed < float(shot["end"]):
            return shot.get("bbox")
    return plan[-1].get("bbox") if plan else None


def _nearest_face(faces: List[BBox], reference: BBox) -> Optional[BBox]:
    if not faces:
        return None
    ref_x = reference[0] + reference[2] / 2
    ref_y = reference[1] + reference[3] / 2
    return min(
        faces,
        key=lambda box: (
            (box[0] + box[2] / 2 - ref_x) ** 2
            + (box[1] + box[3] / 2 - ref_y) ** 2
        ),
    )


def _aspect_crop(
    frame,
    center: Tuple[float, float],
    target_ratio: float,
    zoom: float = 1.0,
):
    src_height, src_width = frame.shape[:2]
    zoom = max(1.0, zoom)
    if target_ratio < src_width / src_height:
        crop_height = int(src_height / zoom)
        crop_width = int(crop_height * target_ratio)
    else:
        crop_width = int(src_width / zoom)
        crop_height = int(crop_width / target_ratio)
    crop_width = max(2, min(src_width, crop_width))
    crop_height = max(2, min(src_height, crop_height))
    center_x, center_y = center
    x0 = max(0, min(src_width - crop_width, int(center_x - crop_width / 2)))
    y0 = max(0, min(src_height - crop_height, int(center_y - crop_height / 2)))
    return frame[y0:y0 + crop_height, x0:x0 + crop_width]


def _crop_safe_center(
    center: Tuple[float, float],
    frame_size: Tuple[int, int],
    target_ratio: float,
) -> Tuple[float, float]:
    """Keep the tracked center inside the valid crop range without edge sticking."""
    frame_width, frame_height = frame_size
    if target_ratio < frame_width / frame_height:
        crop_height = frame_height
        crop_width = crop_height * target_ratio
    else:
        crop_width = frame_width
        crop_height = crop_width / target_ratio
    half_width = min(frame_width / 2, crop_width / 2)
    half_height = min(frame_height / 2, crop_height / 2)
    return (
        max(half_width, min(frame_width - half_width, center[0])),
        max(half_height, min(frame_height - half_height, center[1])),
    )


def _editorial_crop_geometry(
    frame_size: Tuple[int, int],
    face_box: Optional[BBox],
    target_ratio: float,
) -> Tuple[Tuple[float, float], BBox]:
    """Place a speaker right-of-center while filling the vertical canvas."""
    frame_width, frame_height = frame_size
    if target_ratio < frame_width / frame_height:
        crop_height = frame_height
        crop_width = max(2, int(crop_height * target_ratio))
    else:
        crop_width = frame_width
        crop_height = max(2, int(crop_width / target_ratio))

    if face_box:
        x, y, width, height = face_box
        face_center_x = x + width / 2
        face_center_y = y + height / 2
        center = (
            face_center_x - crop_width * 0.18,
            face_center_y,
        )
    else:
        center = (frame_width / 2, frame_height / 2)
    center = _crop_safe_center(center, frame_size, target_ratio)
    x0 = max(0, min(frame_width - crop_width, int(center[0] - crop_width / 2)))
    y0 = max(0, min(frame_height - crop_height, int(center[1] - crop_height / 2)))
    return center, (x0, y0, crop_width, crop_height)


def _map_bbox_to_crop(
    box: BBox,
    crop_box: BBox,
    output_size: Tuple[int, int],
) -> BBox:
    crop_x, crop_y, crop_width, crop_height = crop_box
    output_width, output_height = output_size
    x, y, width, height = box
    scale_x = output_width / max(1, crop_width)
    scale_y = output_height / max(1, crop_height)
    return (
        int(round((x - crop_x) * scale_x)),
        int(round((y - crop_y) * scale_y)),
        max(1, int(round(width * scale_x))),
        max(1, int(round(height * scale_y))),
    )


def _editorial_composition_geometry(
    frame_size: Tuple[int, int],
    face_box: Optional[BBox],
    target_ratio: float,
    output_size: Tuple[int, int],
) -> Tuple[BBox, BBox, bool]:
    """Zoom out close shots so captions and the complete face can coexist."""
    _, vertical_crop = _editorial_crop_geometry(
        frame_size,
        face_box,
        target_ratio,
    )
    output_width, output_height = output_size
    if face_box and face_box[2] / max(1, vertical_crop[2]) > 0.68:
        _, source_crop = _editorial_crop_geometry(frame_size, face_box, 1.0)
        render_height = min(
            output_height,
            max(2, _even(int(output_width * source_crop[3] / source_crop[2]))),
        )
        render_box = (
            0,
            (output_height - render_height) // 2,
            output_width,
            render_height,
        )
        return source_crop, render_box, True
    return vertical_crop, (0, 0, output_width, output_height), False


def _map_bbox_to_render(
    box: BBox,
    crop_box: BBox,
    render_box: BBox,
) -> BBox:
    crop_x, crop_y, crop_width, crop_height = crop_box
    render_x, render_y, render_width, render_height = render_box
    x, y, width, height = box
    scale_x = render_width / max(1, crop_width)
    scale_y = render_height / max(1, crop_height)
    return (
        int(round(render_x + (x - crop_x) * scale_x)),
        int(round(render_y + (y - crop_y) * scale_y)),
        max(1, int(round(width * scale_x))),
        max(1, int(round(height * scale_y))),
    )


def _compose_editorial_frame(
    cv2,
    frame,
    output_size: Tuple[int, int],
    face_box: Optional[BBox],
    target_ratio: float,
):
    """Fill 9:16 while adaptively zooming out only oversized close-ups."""
    import numpy as np

    output_width, output_height = output_size
    source_height, source_width = frame.shape[:2]
    crop_box, render_box, uses_closeup_canvas = _editorial_composition_geometry(
        (source_width, source_height),
        face_box,
        target_ratio,
        output_size,
    )
    crop_x, crop_y, crop_width, crop_height = crop_box
    foreground = frame[crop_y:crop_y + crop_height, crop_x:crop_x + crop_width]
    render_x, render_y, render_width, render_height = render_box
    foreground = cv2.resize(
        foreground,
        (render_width, render_height),
        interpolation=cv2.INTER_AREA,
    )
    if not uses_closeup_canvas:
        return foreground

    normal_center, _ = _editorial_crop_geometry(
        (source_width, source_height),
        face_box,
        target_ratio,
    )
    background_crop = _aspect_crop(frame, normal_center, target_ratio)
    background_small = cv2.resize(background_crop, (180, 320), interpolation=cv2.INTER_AREA)
    background_small = cv2.GaussianBlur(background_small, (0, 0), sigmaX=14, sigmaY=14)
    canvas = cv2.resize(
        background_small,
        (output_width, output_height),
        interpolation=cv2.INTER_CUBIC,
    )
    canvas = cv2.convertScaleAbs(canvas, alpha=0.72, beta=-10)

    feather = min(24, max(0, render_height // 10))
    alpha = np.ones((render_height, 1, 1), dtype=np.float32)
    if feather:
        edge = np.linspace(0.0, 1.0, feather, dtype=np.float32).reshape(-1, 1, 1)
        alpha[:feather] = edge
        alpha[-feather:] = edge[::-1]
    region = canvas[
        render_y:render_y + render_height,
        render_x:render_x + render_width,
    ].astype(np.float32)
    blended = foreground.astype(np.float32) * alpha + region * (1.0 - alpha)
    canvas[
        render_y:render_y + render_height,
        render_x:render_x + render_width,
    ] = np.clip(blended, 0, 255).astype(frame.dtype)
    return canvas


def _compose_split_screen(
    cv2,
    frame,
    output_size: Tuple[int, int],
    face_box: BBox,
    gameplay_center: Optional[Tuple[float, float]] = None,
):
    output_width, output_height = output_size
    top_height = int(output_height * SPLIT_GAMEPLAY_HEIGHT_RATIO)
    bottom_height = output_height - top_height
    src_height, src_width = frame.shape[:2]

    center_x, center_y = gameplay_center or (src_width / 2, src_height / 2)
    center_x = max(
        src_width * GAMEPLAY_CENTER_MIN_X_RATIO,
        min(src_width * GAMEPLAY_CENTER_MAX_X_RATIO, center_x),
    )
    gameplay = _aspect_crop(
        frame,
        (center_x, center_y),
        output_width / top_height,
    )
    gameplay = cv2.resize(gameplay, (output_width, top_height), interpolation=cv2.INTER_AREA)

    x, y, width, height = face_box
    face_center = (x + width / 2, y + height / 2)
    panel_ratio = output_width / bottom_height
    desired_height = max(height * 2.8, src_height * 0.22)
    desired_width = max(width * 2.2, desired_height * panel_ratio)
    zoom = max(1.0, min(src_width / desired_width, src_height / (desired_width / panel_ratio)))
    face_crop = _aspect_crop(frame, face_center, panel_ratio, zoom=zoom)
    face_crop = cv2.resize(face_crop, (output_width, bottom_height), interpolation=cv2.INTER_CUBIC)

    canvas = cv2.vconcat([gameplay, face_crop])
    separator_y = max(0, top_height - 2)
    canvas[separator_y:min(output_height, separator_y + 4), :] = 0
    return canvas


def _mask_bbox(frame, box: BBox, padding_ratio: float = 0.20):
    """Hide a facecam from motion analysis so gameplay drives the crop."""
    result = frame.copy()
    frame_height, frame_width = result.shape[:2]
    x, y, width, height = box
    pad_x = int(width * padding_ratio)
    pad_y = int(height * padding_ratio)
    x0 = max(0, x - pad_x)
    y0 = max(0, y - pad_y)
    x1 = min(frame_width, x + width + pad_x)
    y1 = min(frame_height, y + height + pad_y)
    result[y0:y1, x0:x1] = 0
    return result


def _compose_presentation(cv2, frame, output_size: Tuple[int, int], subject_box: BBox):
    """Fit all sampled presentation content above a caption-safe lower third."""
    import numpy as np

    output_width, output_height = output_size
    source_height, source_width = frame.shape[:2]
    x, y, width, height = subject_box
    margin_x = max(4, int(width * PRESENTATION_MARGIN_X_RATIO))
    margin_y = max(4, int(height * PRESENTATION_MARGIN_Y_RATIO))
    x0 = max(0, x - margin_x)
    y0 = max(0, y - margin_y)
    x1 = min(source_width, x + width + margin_x)
    y1 = min(source_height, y + height + margin_y)
    subject = frame[y0:y1, x0:x1]
    if subject.size == 0:
        subject = frame

    panel_height = int(output_height * PRESENTATION_VISUAL_HEIGHT_RATIO)
    scale = min(output_width / subject.shape[1], panel_height / subject.shape[0])
    render_width = max(2, int(subject.shape[1] * scale))
    render_height = max(2, int(subject.shape[0] * scale))
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    resized = cv2.resize(subject, (render_width, render_height), interpolation=interpolation)
    canvas = np.zeros((output_height, output_width, 3), dtype=frame.dtype)
    left = (output_width - render_width) // 2
    top = max(0, (panel_height - render_height) // 2)
    canvas[top:top + render_height, left:left + render_width] = resized
    return canvas


def _editorial_render_size(
    source_size: Tuple[int, int],
    output_size: Tuple[int, int],
) -> Tuple[int, int]:
    del source_size  # The versioned panel is always 16:9, independent of source shape.
    output_width, output_height = output_size
    panel_ratio = 16.0 / 9.0
    max_width = int(output_width * BF_EDITORIAL_INSET_MAX_WIDTH_RATIO)
    max_height = int(output_height * BF_EDITORIAL_INSET_MAX_HEIGHT_RATIO)
    render_width = min(max_width, int(max_height * panel_ratio))
    render_width = max(2, _even(render_width))
    render_height = max(2, _even(int(round(render_width / panel_ratio))))
    return render_width, render_height


def _editorial_source_crop_box(source_size: Tuple[int, int]) -> BBox:
    """Return a centered 16:9 source crop for the immutable inset panel."""
    source_width, source_height = source_size
    panel_ratio = 16.0 / 9.0
    source_ratio = source_width / max(1, source_height)
    if source_ratio > panel_ratio:
        crop_height = source_height
        crop_width = min(source_width, int(round(crop_height * panel_ratio)))
        return (source_width - crop_width) // 2, 0, crop_width, crop_height
    crop_width = source_width
    crop_height = min(source_height, int(round(crop_width / panel_ratio)))
    return 0, (source_height - crop_height) // 2, crop_width, crop_height


def _editorial_panel_source_coverage(
    source_size: Tuple[int, int],
    output_size: Tuple[int, int],
) -> float:
    """Return the minimum linear source coverage of the rendered inset panel."""
    _, _, crop_width, crop_height = _editorial_source_crop_box(source_size)
    render_width, render_height = _editorial_render_size(source_size, output_size)
    return min(
        crop_width / max(1, render_width),
        crop_height / max(1, render_height),
    )


def _should_bypass_editorial_realesrgan(
    source_size: Tuple[int, int],
    output_size: Tuple[int, int],
) -> bool:
    """Keep a single resample when the visible source already has enough detail."""
    if not LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES:
        return False
    return (
        _editorial_panel_source_coverage(source_size, output_size)
        >= LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE
    )


def _probe_video_frame_size(cv2, source_path: str) -> Optional[Tuple[int, int]]:
    """Read encoded frame dimensions without decoding the source timeline."""
    cap = cv2.VideoCapture(source_path)
    try:
        if not cap.isOpened():
            return None
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    except (AttributeError, TypeError, ValueError):
        return None
    finally:
        cap.release()
    if width <= 0 or height <= 0:
        return None
    return width, height


def _editorial_inset_box(
    source_size: Tuple[int, int],
    output_size: Tuple[int, int],
) -> BBox:
    output_width, output_height = output_size
    render_width, render_height = _editorial_render_size(source_size, output_size)
    return (
        (output_width - render_width) // 2,
        (output_height - render_height) // 2,
        render_width,
        render_height,
    )


def _extract_editorial_panel(frame):
    """Extract the centered 16:9 source region used by the editorial inset."""
    source_height, source_width = frame.shape[:2]
    crop_x, crop_y, crop_width, crop_height = _editorial_source_crop_box(
        (source_width, source_height)
    )
    return frame[crop_y:crop_y + crop_height, crop_x:crop_x + crop_width]


def _resize_editorial_panel(
    cv2,
    panel,
    render_size: Tuple[int, int],
):
    """Resize one prepared 16:9 panel using the versioned interpolation."""
    panel_height, panel_width = panel.shape[:2]
    render_width, render_height = render_size
    if (panel_width, panel_height) != (render_width, render_height):
        return cv2.resize(
            panel,
            (render_width, render_height),
            interpolation=(
                cv2.INTER_AREA
                if panel_width > render_width or panel_height > render_height
                else cv2.INTER_LANCZOS4
            ),
        )
    return panel


def _editorial_inset_mask(cv2, render_size: Tuple[int, int]):
    """Build the immutable binary rounded-panel mask."""
    import numpy as np

    render_width, render_height = render_size
    radius = max(
        10,
        int(round(min(render_width, render_height) * BF_EDITORIAL_INSET_CORNER_RADIUS_RATIO)),
    )
    mask = np.zeros((render_height, render_width), dtype=np.uint8)
    cv2.rectangle(mask, (radius, 0), (render_width - radius, render_height), 255, -1)
    cv2.rectangle(mask, (0, radius), (render_width, render_height - radius), 255, -1)
    for center in (
        (radius, radius),
        (render_width - radius - 1, radius),
        (radius, render_height - radius - 1),
        (render_width - radius - 1, render_height - radius - 1),
    ):
        cv2.circle(mask, center, radius, 255, -1)
    return mask


def _compose_editorial_panel(
    cv2,
    panel,
    output_size: Tuple[int, int],
):
    """Place a prepared 16:9 panel on the immutable rounded editorial canvas."""
    import numpy as np

    output_width, output_height = output_size
    panel_height, panel_width = panel.shape[:2]
    left, top, render_width, render_height = _editorial_inset_box(
        (panel_width, panel_height),
        output_size,
    )
    resized = _resize_editorial_panel(
        cv2,
        panel,
        (render_width, render_height),
    )
    canvas = np.zeros((output_height, output_width, 3), dtype=panel.dtype)
    mask = _editorial_inset_mask(cv2, (render_width, render_height))
    region = canvas[top:top + render_height, left:left + render_width]
    region[mask > 0] = resized[mask > 0]
    return canvas


class _EditorialInsetComposer:
    """Per-render reusable BF panel mask and canvas.

    ``compose_*`` returns a borrowed canvas that is overwritten by the next
    call.  The renderer consumes it synchronously and keeps its final hold as a
    copy, so one allocation is sufficient for the whole clip and remains safe
    when separate clips render on separate worker threads.
    """

    def __init__(
        self,
        cv2,
        source_size: Tuple[int, int],
        output_size: Tuple[int, int],
    ):
        import numpy as np

        self.cv2 = cv2
        self.output_size = output_size
        self.source_crop_box = _editorial_source_crop_box(source_size)
        self.inset_box = _editorial_inset_box(source_size, output_size)
        _, _, render_width, render_height = self.inset_box
        self.mask = _editorial_inset_mask(
            cv2,
            (render_width, render_height),
        )
        self.visible_mask = self.mask > 0
        output_width, output_height = output_size
        self.canvas = np.zeros(
            (output_height, output_width, 3),
            dtype=np.uint8,
        )

    def compose_panel(self, panel, *, apply_bf_grade: bool = False):
        left, top, render_width, render_height = self.inset_box
        resized = _resize_editorial_panel(
            self.cv2,
            panel,
            (render_width, render_height),
        )
        if apply_bf_grade:
            resized = _apply_bf_editorial_grade(self.cv2, resized)
        if self.canvas.dtype != resized.dtype:
            # Production frames are uint8.  Keeping this fallback preserves the
            # helper's behavior for synthetic callers with another image dtype.
            import numpy as np

            self.canvas = np.zeros(
                (self.output_size[1], self.output_size[0], 3),
                dtype=resized.dtype,
            )
        else:
            self.canvas.fill(0)
        region = self.canvas[
            top:top + render_height,
            left:left + render_width,
        ]
        region[self.visible_mask] = resized[self.visible_mask]
        return self.canvas

    def compose_source(self, frame, *, apply_bf_grade: bool = False):
        crop_x, crop_y, crop_width, crop_height = self.source_crop_box
        panel = frame[
            crop_y:crop_y + crop_height,
            crop_x:crop_x + crop_width,
        ]
        return self.compose_panel(panel, apply_bf_grade=apply_bf_grade)


def _realesrgan_working_geometry(
    source_size: Tuple[int, int],
    output_size: Tuple[int, int],
    scale: int,
    editorial_panel_only: bool = False,
) -> Tuple[Tuple[int, int], Tuple[int, int]]:
    """Return Real-ESRGAN input and enhanced target sizes for a render path."""
    target_size = (
        _editorial_render_size(source_size, output_size)
        if editorial_panel_only
        else output_size
    )
    return (
        (
            max(2, target_size[0] // scale),
            max(2, target_size[1] // scale),
        ),
        target_size,
    )


def _realesrgan_unique_frame_index(
    frame,
    unique_frame_bytes: List[bytes],
    digest_buckets: Dict[bytes, List[int]],
) -> Tuple[int, bool]:
    """Return an exact-match frame index so repeated FPS frames run only once."""
    frame_bytes = frame.tobytes()
    digest = hashlib.blake2b(frame_bytes, digest_size=16).digest()
    for candidate_index in digest_buckets.get(digest, ()):
        if unique_frame_bytes[candidate_index] == frame_bytes:
            return candidate_index, False

    unique_index = len(unique_frame_bytes)
    unique_frame_bytes.append(frame_bytes)
    digest_buckets.setdefault(digest, []).append(unique_index)
    return unique_index, True


def _map_editorial_bbox(
    box: BBox,
    source_size: Tuple[int, int],
    output_size: Tuple[int, int],
) -> BBox:
    crop_x, crop_y, crop_width, crop_height = _editorial_source_crop_box(source_size)
    left, top, render_width, render_height = _editorial_inset_box(
        source_size,
        output_size,
    )
    scale_x = render_width / max(1, crop_width)
    scale_y = render_height / max(1, crop_height)
    x, y, width, height = box
    return (
        int(round(left + (x - crop_x) * scale_x)),
        int(round(top + (y - crop_y) * scale_y)),
        max(1, int(round(width * scale_x))),
        max(1, int(round(height * scale_y))),
    )


def _compose_editorial_inset(cv2, frame, output_size: Tuple[int, int]):
    """Preserve the source composition in a calm, high-contrast vertical canvas."""
    return _compose_editorial_panel(
        cv2,
        _extract_editorial_panel(frame),
        output_size,
    )


def _apply_motivational_grade(cv2, frame):
    """Match the restrained monochrome reference treatment."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.convertScaleAbs(gray, alpha=1.10, beta=-7)
    graded = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    graded[frame.max(axis=2) < 4] = 0
    return graded


def _apply_bf_editorial_grade(cv2, frame):
    """Deterministic high-contrast grayscale grade for bf_editorial_inset_v1."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    gray = cv2.convertScaleAbs(gray, alpha=1.18, beta=-12)
    graded = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    graded[frame.max(axis=2) < 4] = 0
    return graded


def _draw_bf_brand_tail(
    cv2,
    output_size: Tuple[int, int],
    progress: float,
    mark: str = BF_EDITORIAL_BRAND_MARK,
):
    """Render the original Budget Friendly mark on black; never copy LL. assets."""
    import numpy as np

    width, height = output_size
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    progress = max(0.0, min(1.0, float(progress)))
    eased = progress * progress * (3.0 - 2.0 * progress)
    font = cv2.FONT_HERSHEY_DUPLEX
    scale = max(0.7, width / 720.0) * (0.94 + 0.06 * eased)
    thickness = max(2, int(round(width / 360.0)))
    (text_width, text_height), baseline = cv2.getTextSize(mark, font, scale, thickness)
    x = max(0, (width - text_width) // 2)
    y = max(text_height, (height + text_height - baseline) // 2)
    value = int(round(150 + 105 * eased))
    cv2.putText(
        canvas,
        mark,
        (x, y),
        font,
        scale,
        (value, value, value),
        thickness,
        cv2.LINE_AA,
    )
    return canvas


def _resolve_bf_brand_tail_seconds(
    render_profile: Optional[str],
    brand_tail_profile: Optional[str] = None,
    requested_seconds: Optional[float] = None,
) -> float:
    if not _is_bf_editorial_profile(render_profile):
        return 0.0
    profile = str(brand_tail_profile or BF_REFERENCE_TAIL_V2).strip().lower()
    if profile in {"none", "off", "disabled"}:
        return 0.0
    if profile == BF_REFERENCE_TAIL_V2:
        requested = (
            BF_EDITORIAL_YOUTUBE_TAIL_SECONDS
            if requested_seconds is None
            else float(requested_seconds)
        )
        return max(
            BF_EDITORIAL_YOUTUBE_TAIL_MIN_SECONDS,
            min(BF_EDITORIAL_YOUTUBE_TAIL_MAX_SECONDS, requested),
        )
    if profile in {
        BF_SMOOTH_TAIL_V3,
        BF_SMOOTH_TAIL_V4,
        BF_SMOOTH_TAIL_V5,
        BF_NATURAL_TAIL_V6,
    }:
        requested = (
            BF_EDITORIAL_SMOOTH_TAIL_SECONDS
            if requested_seconds is None
            else float(requested_seconds)
        )
        return max(
            BF_EDITORIAL_SMOOTH_TAIL_MIN_SECONDS,
            min(BF_EDITORIAL_SMOOTH_TAIL_MAX_SECONDS, requested),
        )
    if "instagram" in profile:
        return max(0.0, min(1.7, float(requested_seconds or 1.5)))
    if requested_seconds is not None:
        return max(0.2, min(0.4, float(requested_seconds)))
    return 0.30


def _draw_context_overlay(cv2, frame, text: str):
    """Draw a short bridge label without introducing a card or extra transition."""
    text = str(text or "").strip().upper()
    if not text:
        return frame
    height, width = frame.shape[:2]
    font = cv2.FONT_HERSHEY_SIMPLEX
    scale = max(0.48, width / 900.0)
    thickness = max(1, width // 480)
    while scale > 0.38:
        (text_width, text_height), _ = cv2.getTextSize(text, font, scale, thickness)
        if text_width <= width * 0.84:
            break
        scale -= 0.04
    x = max(0, (width - text_width) // 2)
    y = max(text_height + 8, int(height * 0.08))
    cv2.putText(
        frame,
        text,
        (x, y),
        font,
        scale,
        (0, 0, 0),
        thickness + 4,
        cv2.LINE_AA,
    )
    cv2.putText(
        frame,
        text,
        (x, y),
        font,
        scale,
        (255, 255, 255),
        thickness,
        cv2.LINE_AA,
    )
    return frame


class _MotionTracker:
    """Track persistent gameplay action with a damped, rate-limited crop center."""

    def __init__(self, cv2, frame_size: Tuple[int, int], fps: float):
        self.cv2 = cv2
        self.frame_width, self.frame_height = frame_size
        self.center = [self.frame_width / 2, self.frame_height / 2]
        self.velocity = [0.0, 0.0]
        self.background = cv2.createBackgroundSubtractorMOG2(
            history=max(60, int(fps * 4)),
            varThreshold=32,
            detectShadows=False,
        )
        self.max_step_x = max(0.75, self.frame_width * 0.070 / max(fps, 1.0))
        self.max_step_y = max(0.75, self.frame_height * 0.06 / max(fps, 1.0))
        self.dead_zone_x = self.frame_width * 0.050
        self.dead_zone_y = self.frame_height * 0.05

    def update(self, frame) -> Tuple[int, int]:
        cv2 = self.cv2
        mask = self.background.apply(frame, learningRate=0.015)
        _, mask = cv2.threshold(mask, 220, 255, cv2.THRESH_BINARY)
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
        mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
        mask = cv2.dilate(mask, kernel, iterations=2)
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        frame_area = self.frame_width * self.frame_height
        candidates = []
        for contour in contours:
            area = float(cv2.contourArea(contour))
            if not frame_area * 0.0004 <= area <= frame_area * 0.35:
                continue
            x, y, width, height = cv2.boundingRect(contour)
            if width >= self.frame_width * 0.85 and height >= self.frame_height * 0.85:
                continue
            center_x = x + width / 2
            center_y = y + height / 2
            horizontal_distance = abs(center_x - self.frame_width / 2) / max(
                1.0,
                self.frame_width / 2,
            )
            center_prior = 0.40 + 0.60 * max(0.0, 1.0 - horizontal_distance)
            lower_screen_prior = 0.75 + 0.25 * center_y / max(1.0, self.frame_height)
            candidates.append((area * center_prior * lower_screen_prior, center_x, center_y))

        if candidates:
            strongest = sorted(candidates, reverse=True)[:5]
            total_area = sum(item[0] for item in strongest)
            target_x = sum(item[0] * item[1] for item in strongest) / total_area
            target_y = sum(item[0] * item[2] for item in strongest) / total_area
            target_x = 0.65 * target_x + 0.35 * (self.frame_width / 2)
        else:
            target_x = self.frame_width / 2
            target_y = self.frame_height / 2

        target_x = max(
            self.frame_width * MOTION_TARGET_MIN_X_RATIO,
            min(self.frame_width * MOTION_TARGET_MAX_X_RATIO, target_x),
        )

        delta_x = target_x - self.center[0]
        delta_y = target_y - self.center[1]
        desired_x = max(-self.max_step_x, min(self.max_step_x, delta_x * 0.060))
        desired_y = max(-self.max_step_y, min(self.max_step_y, delta_y * 0.075))
        if abs(delta_x) <= self.dead_zone_x:
            desired_x = 0.0
        if abs(delta_y) <= self.dead_zone_y:
            desired_y = 0.0
        self.velocity[0] = 0.88 * self.velocity[0] + 0.12 * desired_x
        self.velocity[1] = 0.82 * self.velocity[1] + 0.18 * desired_y
        self.center[0] += self.velocity[0]
        self.center[1] += self.velocity[1]
        return int(self.center[0]), int(self.center[1])


def _cut_subclip_command(
    source_path: str,
    start: float,
    end: float,
    out_path: str,
    fps: float = LOCAL_OUTPUT_FPS,
) -> List[str]:
    duration = max(0.001, end - start)
    return [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", f"{start:.3f}",
        "-i", source_path,
        "-t", f"{duration:.3f}",
        "-vf", f"fps={float(fps):g}",
        "-c:v", "ffv1", "-level", "3",
        "-c:a", "pcm_s16le",
        out_path,
    ]


def _cut_subclip(
    source_path: str,
    start: float,
    end: float,
    out_path: str,
    fps: float = LOCAL_OUTPUT_FPS,
) -> str:
    """Create an accurate lossless temporary cut for OpenCV processing."""
    cmd = _cut_subclip_command(source_path, start, end, out_path, fps=fps)
    subprocess.run(cmd, check=True)
    return out_path


def _lossless_cut_cache_key(
    source_path: str,
    start: float,
    end: float,
    fps: float,
) -> str:
    source = Path(source_path).expanduser()
    try:
        stat = source.stat()
        source_identity = (
            str(source.resolve()),
            stat.st_size,
            stat.st_mtime_ns,
        )
    except OSError:
        source_identity = (str(source), 0, 0)
    payload = json.dumps(
        {
            "schema": LOSSLESS_CUT_CACHE_SCHEMA,
            "source": source_identity,
            "start": round(float(start), 6),
            "end": round(float(end), 6),
            "fps": round(float(fps), 6),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.blake2b(payload.encode("utf-8"), digest_size=24).hexdigest()


def _lossless_cut_cache_path(cache_key: str) -> Path:
    return LOSSLESS_CUT_CACHE_DIR / cache_key[:2] / f"{cache_key}.mkv"


def _prune_lossless_cut_cache(
    cache_dir: Optional[Path] = None,
    max_bytes: Optional[int] = None,
) -> Tuple[int, int]:
    cache_dir = cache_dir or LOSSLESS_CUT_CACHE_DIR
    max_bytes = max_bytes or LOSSLESS_CUT_CACHE_MAX_BYTES
    if not cache_dir.is_dir():
        return 0, 0
    entries = []
    total_bytes = 0
    for path in cache_dir.glob("*/*.mkv"):
        try:
            stat = path.stat()
        except OSError:
            continue
        entries.append((stat.st_mtime_ns, stat.st_size, path))
        total_bytes += stat.st_size
    if total_bytes <= max_bytes:
        return 0, total_bytes

    target_bytes = int(max_bytes * 0.90)
    removed = 0
    for _, size, path in sorted(entries):
        try:
            path.unlink()
        except OSError:
            continue
        total_bytes -= size
        removed += 1
        if total_bytes <= target_bytes:
            break
    return removed, total_bytes


def _get_or_create_lossless_cut(
    source_path: str,
    start: float,
    end: float,
    fps: float,
    fallback_path: str,
) -> Tuple[str, bool]:
    """Return an exact FFV1/PCM cut and whether it is persistent."""
    if not LOSSLESS_CUT_CACHE_ENABLED:
        return _cut_subclip(
            source_path,
            start,
            end,
            fallback_path,
            fps=fps,
        ), False

    cache_key = _lossless_cut_cache_key(source_path, start, end, fps)
    cache_path = _lossless_cut_cache_path(cache_key)
    if cache_path.is_file() and cache_path.stat().st_size > 0:
        try:
            os.utime(cache_path, None)
        except OSError:
            pass
        print(f"[clip/local] lossless cut cache hit: {cache_key[:10]}", flush=True)
        return str(cache_path), True

    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = cache_path.with_name(
        f".{cache_path.stem}.{os.getpid()}.{get_ident()}.mkv"
    )
    try:
        _cut_subclip(
            source_path,
            start,
            end,
            str(temporary_path),
            fps=fps,
        )
        os.replace(temporary_path, cache_path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()
    _prune_lossless_cut_cache()
    return str(cache_path), True


def _reframe_vertical(
    in_path: str,
    out_path: str,
    aspect_ratio: str,
    caption_cues: Optional[List[Dict]] = None,
    lossless_output: bool = False,
    layout_hint: Optional[str] = None,
    context_overlay: Optional[Dict] = None,
    caption_style: Optional[str] = None,
    enhancement_model: Optional[str] = None,
    enhancement_scale: Optional[int] = None,
    enhancement_reference_blend: Optional[float] = None,
    shot_change_times: Optional[List[float]] = None,
    background_music: bool = False,
    music_profile: Optional[str] = None,
    render_profile: Optional[str] = None,
    brand_tail_profile: Optional[str] = None,
    brand_tail_seconds: Optional[float] = None,
    visual_analysis_cache_key: Optional[str] = None,
    output_duration: Optional[float] = None,
    speech_end_seconds: Optional[float] = None,
    brand_tail_transition_seconds: Optional[float] = None,
    brand_tail_audio_transition_seconds: Optional[float] = None,
    brand_tail_music_release_seconds: Optional[float] = None,
) -> str:
    """Crop the cut clip to the target aspect ratio, tracking faces if possible."""
    try:
        import cv2  # type: ignore
    except ImportError as e:
        raise RuntimeError(
            "opencv-python is required for --mode local. Install it with:\n"
            "    pip install -r requirements-local.txt"
        ) from e

    target_ratio = _ratio(aspect_ratio)
    cap = cv2.VideoCapture(in_path)
    if not cap.isOpened():
        raise RuntimeError(f"could not open {in_path}")

    bf_editorial_profile = _is_bf_editorial_profile(render_profile)
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    if bf_editorial_profile and abs(float(fps) - BF_EDITORIAL_OUTPUT_FPS) > 0.01:
        cap.release()
        raise RuntimeError(
            "bf_editorial_inset_v1 requires an exact 30fps intermediate; "
            f"received {fps:.3f}fps"
        )
    frame_count = max(1, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    source_duration = frame_count / fps
    clip_duration = max(
        source_duration,
        float(output_duration) if output_duration is not None else source_duration,
    )
    target_frame_count = max(
        frame_count,
        int(round(clip_duration * fps)),
    )

    output_width, output_height = _output_dimensions(
        aspect_ratio,
        render_profile=render_profile,
    )
    if bf_editorial_profile:
        layout_hint = BF_EDITORIAL_INSET_LAYOUT

    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    profile_face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_profileface.xml"
    )
    if profile_face_cascade.empty():
        profile_face_cascade = None
    cached_visual_analysis = _read_visual_analysis_cache(
        visual_analysis_cache_key,
    )
    if cached_visual_analysis is not None:
        layout = cached_visual_analysis["layout"]
        tracked_face = cached_visual_analysis["tracked_face"]
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        print(f"[clip/local] visual layout: {layout} (cache hit)", flush=True)
    else:
        layout, tracked_face = _detect_clip_layout(
            cv2,
            cap,
            face_cascade,
            (src_w, src_h),
            layout_hint=layout_hint,
            profile_face_cascade=profile_face_cascade,
        )
        print(f"[clip/local] visual layout: {layout}", flush=True)
    reference_editorial = (
        bf_editorial_profile
        and layout == BF_EDITORIAL_INSET_LAYOUT
    )
    editorial_composer = (
        _EditorialInsetComposer(
            cv2,
            (src_w, src_h),
            (output_width, output_height),
        )
        if reference_editorial
        else None
    )
    editorial_inset_box = (
        _editorial_inset_box((src_w, src_h), (output_width, output_height))
        if reference_editorial
        else None
    )
    if editorial_inset_box:
        inset_x, inset_y, inset_width, inset_height = editorial_inset_box
        inset_pad_x = max(12, int(inset_width * 0.035))
        inset_pad_y = max(10, int(inset_height * 0.06))
        reference_caption_safe_box = (
            inset_x + inset_pad_x,
            inset_y + inset_pad_y,
            inset_width - inset_pad_x * 2,
            inset_height - inset_pad_y * 2,
        )
    else:
        reference_caption_safe_box = None
    editorial_caption_safe_box = (
        reference_caption_safe_box
        or (
            int(output_width * 0.025),
            int(output_height * 0.06),
            int(output_width * 0.95),
            int(output_height * 0.88),
        )
        if layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
        else None
    )
    motion_tracker = (
        _MotionTracker(cv2, (src_w, src_h), fps)
        if layout in {"motion", "split"}
        else None
    )
    detection_interval = max(1, int(fps / FACE_DETECTION_HZ))
    if cached_visual_analysis is not None:
        locked_speaker_plan = cached_visual_analysis["locked_speaker_plan"]
    else:
        locked_speaker_plan = (
            _build_locked_speaker_plan(
                cv2,
                cap,
                face_cascade,
                (src_w, src_h),
                fps,
                source_duration,
                shot_change_times,
                initial_face=tracked_face,
                profile_face_cascade=(
                    profile_face_cascade
                    if layout in {
                        "editorial_speaker",
                        BF_EDITORIAL_INSET_LAYOUT,
                    }
                    else None
                ),
            )
            if layout in {
                "stable_speaker",
                "editorial_speaker",
                BF_EDITORIAL_INSET_LAYOUT,
            }
            else []
        )
        _write_visual_analysis_cache(
            visual_analysis_cache_key,
            layout,
            tracked_face,
            locked_speaker_plan,
        )
    if locked_speaker_plan:
        print(
            f"[clip/local] shot-locked speaker plan: {len(locked_speaker_plan)} shots",
            flush=True,
        )

    caption_cues = caption_cues or []
    caption_renderer = (
        _CaptionRenderer(
            output_width,
            output_height,
            vertical_position_ratio=(
                CAPTION_SPLIT_VERTICAL_POSITION_RATIO
                if layout == "split"
                else MOTIVATIONAL_CAPTION_VERTICAL_POSITION_RATIO
                if layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
                else CAPTION_VERTICAL_POSITION_RATIO
            ),
            caption_style=caption_style,
            render_profile=render_profile,
        )
        if caption_cues
        else None
    )
    def base_frame(frame, frame_index: int):
        nonlocal tracked_face
        if layout in ("split", "speaker") and tracked_face and frame_index % detection_interval == 0:
            faces = _detect_faces(
                cv2,
                face_cascade,
                frame,
                min_size=max(18, min(src_w, src_h) // 24),
            )
            nearest = _nearest_face(faces, tracked_face)
            if nearest:
                tracked_face = _smooth_bbox(tracked_face, nearest)

        if layout == "split" and tracked_face:
            motion_frame = _mask_bbox(frame, tracked_face)
            gameplay_center = (
                motion_tracker.update(motion_frame)
                if motion_tracker
                else (src_w // 2, src_h // 2)
            )
            cropped = _compose_split_screen(
                cv2,
                frame,
                (output_width, output_height),
                tracked_face,
                gameplay_center=gameplay_center,
            )
        elif layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}:
            if reference_editorial:
                cropped = editorial_composer.compose_source(
                    frame,
                    apply_bf_grade=True,
                )
            else:
                shot_face = _locked_speaker_bbox_at(
                    locked_speaker_plan,
                    frame_index / fps,
                )
                cropped = _compose_editorial_frame(
                    cv2,
                    frame,
                    (output_width, output_height),
                    shot_face or tracked_face,
                    target_ratio,
                )
        elif layout == "stable_speaker":
            shot_face = _locked_speaker_bbox_at(
                locked_speaker_plan,
                frame_index / fps,
            )
            if shot_face is None:
                center = _crop_safe_center(
                    (src_w // 2, src_h // 2),
                    (src_w, src_h),
                    target_ratio,
                )
                return _aspect_crop(frame, center, target_ratio)
            x, y, width, height = shot_face
            face_center = _crop_safe_center(
                (x + width / 2, y + height / 2),
                (src_w, src_h),
                target_ratio,
            )
            cropped = _aspect_crop(frame, face_center, target_ratio)
        elif layout == "speaker" and tracked_face:
            x, y, width, height = tracked_face
            face_center = _crop_safe_center(
                (x + width / 2, y + height / 2),
                (src_w, src_h),
                target_ratio,
            )
            cropped = _aspect_crop(frame, face_center, target_ratio)
        elif layout == "presentation" and tracked_face:
            cropped = _compose_presentation(
                cv2,
                frame,
                (output_width, output_height),
                tracked_face,
            )
        else:
            center = motion_tracker.update(frame) if motion_tracker else (src_w // 2, src_h // 2)
            center = _crop_safe_center(center, (src_w, src_h), target_ratio)
            action_crop = _aspect_crop(frame, center, target_ratio)
            cropped = action_crop
        return cropped

    enhancer_requested = bool(LOCAL_REAL_ESRGAN)
    if (
        enhancer_requested
        and reference_editorial
        and _should_bypass_editorial_realesrgan(
            (src_w, src_h),
            (output_width, output_height),
        )
    ):
        _, _, crop_width, crop_height = _editorial_source_crop_box(
            (src_w, src_h)
        )
        render_width, render_height = _editorial_render_size(
            (src_w, src_h),
            (output_width, output_height),
        )
        coverage = _editorial_panel_source_coverage(
            (src_w, src_h),
            (output_width, output_height),
        )
        print(
            "[clip/local] Real-ESRGAN bypassed: direct source panel "
            f"{crop_width}x{crop_height} -> {render_width}x{render_height} "
            f"(coverage={coverage:.2f}, single resample)",
            flush=True,
        )
        enhancer_requested = False

    enhancer_runtime = (
        _resolve_realesrgan_runtime() if enhancer_requested else None
    )
    if enhancer_requested and enhancer_runtime is None:
        cap.release()
        raise RuntimeError(
            "Real-ESRGAN is enabled but its runtime/models are unavailable. "
            "Set LOCAL_REAL_ESRGAN_PATH to the bundled runtime directory."
        )
    use_enhancer = bool(enhancer_runtime)
    selected_music_profile = _resolve_motivational_music_profile(music_profile)
    music_path = _resolve_motivational_music_track(
        background_music,
        selected_music_profile,
    )
    music_payoff_seconds = _motivational_payoff_start(caption_cues, clip_duration)
    profile_start = float(
        MOTIVATIONAL_MUSIC_PROFILE_SETTINGS[selected_music_profile]["start_seconds"]
    )
    music_start_seconds = (
        LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS
        if LOCAL_MOTIVATIONAL_MUSIC_TRACK.strip()
        else profile_start
    )
    if music_path:
        print(
            f"[clip/local] background music: {Path(music_path).name} "
            f"({selected_music_profile}, payoff={music_payoff_seconds:.2f}s) at "
            f"{LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS:.1f} LUFS with speech ducking",
            flush=True,
        )
    resolved_brand_tail_seconds = min(
        _resolve_bf_brand_tail_seconds(
            render_profile,
            brand_tail_profile=brand_tail_profile,
            requested_seconds=brand_tail_seconds,
        ),
        max(0.0, clip_duration * 0.20),
    )
    brand_tail_start = max(0.0, clip_duration - resolved_brand_tail_seconds)
    resolved_tail_profile = str(brand_tail_profile or "").strip().lower()
    smooth_tail_profile = resolved_tail_profile in {
        BF_SMOOTH_TAIL_V3,
        BF_SMOOTH_TAIL_V4,
        BF_SMOOTH_TAIL_V5,
    }
    visual_transition_limit = (
        (
            BF_EDITORIAL_SMOOTH_VISUAL_FADE_SECONDS
            if resolved_tail_profile in {BF_SMOOTH_TAIL_V4, BF_SMOOTH_TAIL_V5}
            else BF_EDITORIAL_SMOOTH_V3_VISUAL_FADE_SECONDS
        )
        if smooth_tail_profile
        else BF_EDITORIAL_TAIL_CROSSFADE_SECONDS
    )
    resolved_tail_transition_seconds = max(
        0.0,
        min(
            visual_transition_limit,
            visual_transition_limit
            if brand_tail_transition_seconds is None
            else float(brand_tail_transition_seconds),
        ),
    )
    resolved_audio_transition_seconds = max(
        0.0,
        min(
            BF_EDITORIAL_TAIL_CROSSFADE_SECONDS,
            (
                BF_EDITORIAL_SMOOTH_AUDIO_FADE_SECONDS
                if smooth_tail_profile
                else resolved_tail_transition_seconds
            )
            if brand_tail_audio_transition_seconds is None
            else float(brand_tail_audio_transition_seconds),
        ),
    )
    if resolved_brand_tail_seconds > 0.0:
        print(
            f"[clip/local] brand tail: {resolved_brand_tail_seconds:.2f}s "
            f"({brand_tail_profile or BF_REFERENCE_TAIL_V2})",
            flush=True,
        )

    temporary_frames = None
    encoder = None
    last_hold_frame = None
    try:
        encoder = subprocess.Popen(
            _raw_video_command(
                in_path,
                out_path,
                (output_width, output_height),
                fps,
                duration=clip_duration,
                lossless=lossless_output,
                music_path=music_path,
                music_start_seconds=music_start_seconds,
                music_profile=selected_music_profile,
                music_payoff_seconds=music_payoff_seconds,
                brand_tail_start_seconds=(
                    brand_tail_start
                    if resolved_brand_tail_seconds > 0.0
                    else None
                ),
                speech_end_seconds=speech_end_seconds,
                brand_tail_transition_seconds=resolved_tail_transition_seconds,
                brand_tail_audio_transition_seconds=(
                    resolved_audio_transition_seconds
                ),
                brand_tail_music_release_seconds=(
                    brand_tail_music_release_seconds
                ),
            ),
            stdin=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if encoder.stdin is None or encoder.stderr is None:
            cap.release()
            raise RuntimeError("could not open FFmpeg raw-video encoder")

        caption_index = 0
        initial_editorial_face = (
            _locked_speaker_bbox_at(locked_speaker_plan, 0.0) or tracked_face
            if layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
            else None
        )
        if initial_editorial_face:
            if reference_editorial:
                mapped_initial_face = _map_editorial_bbox(
                    initial_editorial_face,
                    (src_w, src_h),
                    (output_width, output_height),
                )
            else:
                initial_crop_box, initial_render_box, _ = _editorial_composition_geometry(
                    (src_w, src_h),
                    initial_editorial_face,
                    target_ratio,
                    (output_width, output_height),
                )
                mapped_initial_face = _map_bbox_to_render(
                    initial_editorial_face,
                    initial_crop_box,
                    initial_render_box,
                )
            caption_protected_faces: List[BBox] = [
                _expand_protected_face(
                    mapped_initial_face,
                    (output_width, output_height),
                )
            ]
        else:
            caption_protected_faces = []
        caption_face_last_seen_frame = 0 if caption_protected_faces else -frame_count
        caption_face_last_detection_frame = -frame_count

        def write_output_frame(cropped, frame_index: int, reference=None):
            nonlocal caption_index, caption_protected_faces
            nonlocal caption_face_last_seen_frame, caption_face_last_detection_frame
            if cropped.shape[1] != output_width or cropped.shape[0] != output_height:
                is_upscale = cropped.shape[1] < output_width or cropped.shape[0] < output_height
                cropped = cv2.resize(
                    cropped,
                    (output_width, output_height),
                    interpolation=cv2.INTER_LANCZOS4 if is_upscale else cv2.INTER_AREA,
                )
            if reference is not None:
                cropped = _blend_realesrgan_reference(
                    cv2,
                    cropped,
                    reference,
                    reference_weight=enhancement_reference_blend,
                )
            elapsed = frame_index / fps
            if bf_editorial_profile and not reference_editorial:
                cropped = _apply_bf_editorial_grade(cv2, cropped)
            elif caption_style == BUDGET_FRIENDLY_CAPTION_STYLE:
                cropped = _apply_motivational_grade(cv2, cropped)
            transition_progress = _bf_brand_transition_progress(
                elapsed,
                brand_tail_start,
                resolved_tail_transition_seconds,
                smooth=smooth_tail_profile,
            )
            transition_target_frame = None
            if resolved_brand_tail_seconds > 0.0 and transition_progress is not None:
                if smooth_tail_profile and elapsed < brand_tail_start:
                    # Fade only the source plate to black. Captions are drawn
                    # afterwards and therefore remain readable until their
                    # semantic boundary instead of disappearing with the plate.
                    brand_frame = cropped * 0
                else:
                    brand_frame = _draw_bf_brand_tail(
                        cv2,
                        (output_width, output_height),
                        max(0.0, elapsed - brand_tail_start)
                        / max(0.001, resolved_brand_tail_seconds),
                    )
                if transition_progress >= 1.0:
                    cropped = brand_frame
                    try:
                        encoder.stdin.write(cropped.tobytes())
                    except BrokenPipeError as error:
                        details = encoder.stderr.read().decode("utf-8", errors="replace")[-2000:]
                        raise RuntimeError(
                            f"FFmpeg raw-video encoder failed: {details}"
                        ) from error
                    return
                transition_target_frame = brand_frame

            if context_overlay:
                overlay_start = float(context_overlay.get("start", 0.0))
                overlay_end = float(context_overlay.get("end", overlay_start))
                if overlay_start <= elapsed < overlay_end:
                    cropped = _draw_context_overlay(
                        cv2,
                        cropped,
                        str(context_overlay.get("text") or ""),
                    )
            persistent_editorial = (
                _uses_editorial_caption_style(caption_style, render_profile)
                and layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
            )
            if persistent_editorial:
                active_caption_cues = sorted(
                    (
                        cue
                        for cue in caption_cues
                        if float(cue["start"]) <= elapsed < float(cue["end"])
                    ),
                    key=lambda cue: (
                        int(cue.get("sentence_phrase_index", 0)),
                        int(cue.get("phrase_id", 0)),
                    ),
                )
                if len(active_caption_cues) > 1:
                    cues_by_track = {}
                    for cue in active_caption_cues:
                        track_key = (
                            int(cue.get("sentence_id", -1)),
                            int(cue.get("caption_track_slot", 1)),
                        )
                        previous = cues_by_track.get(track_key)
                        if previous is None or float(cue["start"]) >= float(
                            previous["start"]
                        ):
                            cues_by_track[track_key] = cue
                    active_caption_cues = sorted(
                        cues_by_track.values(),
                        key=lambda cue: (
                            int(cue.get("sentence_phrase_index", 0)),
                            int(cue.get("phrase_id", 0)),
                        ),
                    )
                    if len(active_caption_cues) > 2:
                        active_caption_cues = sorted(
                            sorted(
                                active_caption_cues,
                                key=lambda cue: float(cue["start"]),
                            )[-2:],
                            key=lambda cue: (
                                int(cue.get("sentence_phrase_index", 0)),
                                int(cue.get("phrase_id", 0)),
                            ),
                        )
            else:
                while (
                    caption_index < len(caption_cues)
                    and elapsed >= float(caption_cues[caption_index]["end"])
                ):
                    caption_index += 1
                active_caption_cues = (
                    [caption_cues[caption_index]]
                    if (
                        caption_index < len(caption_cues)
                        and float(caption_cues[caption_index]["start"]) <= elapsed
                    )
                    else []
                )
            if caption_renderer and active_caption_cues:
                if (
                    layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
                    and frame_index - caption_face_last_detection_frame >= detection_interval
                ):
                    caption_face_last_detection_frame = frame_index
                    source_face = _locked_speaker_bbox_at(
                        locked_speaker_plan,
                        elapsed,
                    )
                    if source_face:
                        if reference_editorial:
                            mapped_source_face = _map_editorial_bbox(
                                source_face,
                                (src_w, src_h),
                                (output_width, output_height),
                            )
                        else:
                            source_crop_box, source_render_box, _ = _editorial_composition_geometry(
                                (src_w, src_h),
                                source_face,
                                target_ratio,
                                (output_width, output_height),
                            )
                            mapped_source_face = _map_bbox_to_render(
                                source_face,
                                source_crop_box,
                                source_render_box,
                            )
                        caption_protected_faces = [
                            _expand_protected_face(
                                mapped_source_face,
                                (output_width, output_height),
                            )
                        ]
                        caption_face_last_seen_frame = frame_index
                occupied_caption_boxes: List[BBox] = []
                for active_caption_cue in active_caption_cues:
                    active_caption_cue = {
                        **active_caption_cue,
                        "_render_elapsed": elapsed,
                    }
                    cropped = caption_renderer.draw(
                        cropped,
                        active_caption_cue,
                        protected_boxes=caption_protected_faces,
                        safe_box=editorial_caption_safe_box,
                        occupied_caption_boxes=occupied_caption_boxes,
                    )
            if transition_target_frame is not None:
                # Apply the eased fade to the fully composed source frame so
                # the last caption fades with the speaker instead of popping
                # off while its background is already near black.
                cropped = cv2.addWeighted(
                    cropped,
                    1.0 - transition_progress,
                    transition_target_frame,
                    transition_progress,
                    0.0,
                )
            try:
                encoder.stdin.write(cropped.tobytes())
            except BrokenPipeError as error:
                details = encoder.stderr.read().decode("utf-8", errors="replace")[-2000:]
                raise RuntimeError(f"FFmpeg raw-video encoder failed: {details}") from error

        if use_enhancer:
            temporary_frames = _local_temporary_directory("shorts-esrgan-")
            input_dir = Path(temporary_frames.name) / "input"
            enhanced_dir = Path(temporary_frames.name) / "enhanced"
            input_dir.mkdir()
            enhanced_dir.mkdir()
            frame_index = 0
            native_size = None
            enhancement_target_size = (output_width, output_height)
            selected_enhancement_scale = enhancement_scale
            if reference_editorial:
                selected_enhancement_scale = 2
            elif (
                layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
                and enhancement_model == "realesrgan-x4plus"
            ):
                selected_enhancement_scale = 4
            elif (
                layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
                and selected_enhancement_scale is None
            ):
                selected_enhancement_scale = 4
            if selected_enhancement_scale:
                (
                    enhancement_input_size,
                    enhancement_target_size,
                ) = _realesrgan_working_geometry(
                    (src_w, src_h),
                    (output_width, output_height),
                    selected_enhancement_scale,
                    editorial_panel_only=reference_editorial,
                )
            else:
                enhancement_input_size = None
            printed_profile = False
            total_unique_frames = 0
            total_cache_hits = 0
            runtime_fingerprint = None
            enhancement_cache_dir = (
                REAL_ESRGAN_CACHE_DIR if REAL_ESRGAN_CACHE_ENABLED else None
            )
            while True:
                for directory in (input_dir, enhanced_dir):
                    for path in directory.glob("frame_*.png"):
                        path.unlink()
                references = []
                frame_to_unique = []
                unique_frame_bytes = []
                unique_frames = []
                digest_buckets = {}
                batch_count = 0
                for local_index in range(REAL_ESRGAN_BATCH_FRAMES):
                    ret, frame = cap.read()
                    if not ret:
                        break
                    if reference_editorial:
                        reference_panel = _extract_editorial_panel(frame)
                        reference = cv2.resize(
                            reference_panel,
                            enhancement_target_size,
                            interpolation=(
                                cv2.INTER_AREA
                                if (
                                    reference_panel.shape[1]
                                    > enhancement_target_size[0]
                                    or reference_panel.shape[0]
                                    > enhancement_target_size[1]
                                )
                                else cv2.INTER_LANCZOS4
                            ),
                        )
                    else:
                        reference_frame = base_frame(
                            frame,
                            frame_index + local_index,
                        )
                        reference = cv2.resize(
                            reference_frame,
                            (output_width, output_height),
                            interpolation=(
                                cv2.INTER_AREA
                                if reference_frame.shape[1] > output_width
                                or reference_frame.shape[0] > output_height
                                else cv2.INTER_LANCZOS4
                            ),
                        )
                    native = (
                        _extract_editorial_panel(frame)
                        if reference_editorial
                        else reference_frame
                    )
                    native_size = (native.shape[1], native.shape[0])
                    if selected_enhancement_scale is None:
                        selected_enhancement_scale = _realesrgan_scale(
                            native_size,
                            (output_width, output_height),
                        )
                        (
                            enhancement_input_size,
                            enhancement_target_size,
                        ) = _realesrgan_working_geometry(
                            native_size,
                            (output_width, output_height),
                            selected_enhancement_scale,
                        )
                    if enhancement_input_size and native_size != enhancement_input_size:
                        is_downscale = (
                            native.shape[1] > enhancement_input_size[0]
                            or native.shape[0] > enhancement_input_size[1]
                        )
                        native = cv2.resize(
                            native,
                            enhancement_input_size,
                            interpolation=(
                                cv2.INTER_AREA if is_downscale else cv2.INTER_LANCZOS4
                            ),
                        )
                    unique_index, is_unique = _realesrgan_unique_frame_index(
                        native,
                        unique_frame_bytes,
                        digest_buckets,
                    )
                    if is_unique:
                        unique_frames.append(native.copy())
                    frame_to_unique.append(unique_index)
                    references.append(reference)
                    batch_count += 1

                if batch_count == 0:
                    break
                unique_count = len(unique_frame_bytes)
                scale = selected_enhancement_scale
                runtime_scale = _realesrgan_runtime_scale(
                    enhancement_model or "realesr-animevideov3",
                    scale,
                )
                if enhancement_cache_dir is not None and runtime_fingerprint is None:
                    runtime_fingerprint = _realesrgan_runtime_fingerprint(
                        enhancer_runtime,
                        enhancement_model or "realesr-animevideov3",
                    )
                if not printed_profile:
                    enhanced_width = enhancement_input_size[0] * runtime_scale
                    enhanced_height = enhancement_input_size[1] * runtime_scale
                    if reference_editorial:
                        full_input_size, _ = _realesrgan_working_geometry(
                            (src_w, src_h),
                            (output_width, output_height),
                            scale,
                        )
                        input_reduction = 1.0 - (
                            enhancement_input_size[0] * enhancement_input_size[1]
                        ) / max(1, full_input_size[0] * full_input_size[1])
                        canvas_note = (
                            f" -> panel {enhancement_target_size[0]}x"
                            f"{enhancement_target_size[1]} -> canvas "
                            f"{output_width}x{output_height}; panel-only, "
                            f"{input_reduction:.1%} fewer input pixels"
                        )
                    else:
                        canvas_note = (
                            f" -> canvas {output_width}x{output_height}"
                            if layout in {"editorial_speaker", BF_EDITORIAL_INSET_LAYOUT}
                            else ""
                        )
                    print(
                        f"[clip/local] Real-ESRGAN "
                        f"{enhancement_model or 'realesr-animevideov3'} "
                        f"x{runtime_scale}"
                        f"{f' (working x{scale})' if runtime_scale != scale else ''}: "
                        f"{enhancement_input_size[0]}x{enhancement_input_size[1]} "
                        f"(native {native_size[0]}x{native_size[1]}) -> "
                        f"{enhanced_width}x{enhanced_height}{canvas_note}; "
                        f"tile=auto; "
                        f"cache={'on' if enhancement_cache_dir else 'off'}; "
                        f"batch={REAL_ESRGAN_BATCH_FRAMES}",
                        flush=True,
                    )
                    printed_profile = True

                enhanced_frames = [None] * unique_count
                cache_paths = [None] * unique_count
                missing_unique_indices = []
                batch_cache_hits = 0
                for unique_index, native in enumerate(unique_frames):
                    cache_path = None
                    if enhancement_cache_dir is not None:
                        cache_key = _realesrgan_cache_key(
                            unique_frame_bytes[unique_index],
                            enhancement_input_size,
                            enhancement_target_size,
                            enhancement_model or "realesr-animevideov3",
                            scale,
                            runtime_scale,
                            runtime_fingerprint,
                        )
                        cache_path = _realesrgan_cache_path(
                            enhancement_cache_dir,
                            cache_key,
                        )
                        enhanced_frames[unique_index] = _read_realesrgan_cache_frame(
                            cv2,
                            cache_path,
                            enhancement_target_size,
                        )
                        cache_paths[unique_index] = cache_path
                    if enhanced_frames[unique_index] is not None:
                        batch_cache_hits += 1
                        continue

                    missing_index = len(missing_unique_indices)
                    frame_path = input_dir / f"frame_{missing_index:08d}.png"
                    if not cv2.imwrite(str(frame_path), native):
                        raise RuntimeError(
                            f"could not write Real-ESRGAN frame: {frame_path}"
                        )
                    missing_unique_indices.append(unique_index)

                if missing_unique_indices:
                    result = _run_realesrgan_process(
                        _realesrgan_command(
                            enhancer_runtime,
                            str(input_dir),
                            str(enhanced_dir),
                            scale,
                            model_name=enhancement_model or "realesr-animevideov3",
                        )
                    )
                    if result.returncode != 0:
                        raise RuntimeError(
                            "Real-ESRGAN failed; output was not rendered without enhancement: "
                            + (result.stderr or result.stdout)[-1000:]
                        )
                    frame_paths = sorted(enhanced_dir.glob("frame_*.png"))
                    if len(frame_paths) != len(missing_unique_indices):
                        raise RuntimeError(
                            "Real-ESRGAN frame count mismatch: "
                            f"expected {len(missing_unique_indices)}, "
                            f"received {len(frame_paths)}"
                        )
                    for missing_index, frame_path in enumerate(frame_paths):
                        enhanced_frame = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
                        if enhanced_frame is None:
                            raise RuntimeError(
                                f"could not read enhanced frame: {frame_path}"
                            )
                        if (
                            enhanced_frame.shape[1],
                            enhanced_frame.shape[0],
                        ) != enhancement_target_size:
                            is_downscale = (
                                enhanced_frame.shape[1] > enhancement_target_size[0]
                                or enhanced_frame.shape[0] > enhancement_target_size[1]
                            )
                            enhanced_frame = cv2.resize(
                                enhanced_frame,
                                enhancement_target_size,
                                interpolation=(
                                    cv2.INTER_AREA
                                    if is_downscale
                                    else cv2.INTER_LANCZOS4
                                ),
                            )
                        unique_index = missing_unique_indices[missing_index]
                        enhanced_frames[unique_index] = enhanced_frame
                        cache_path = cache_paths[unique_index]
                        if cache_path is not None:
                            _write_realesrgan_cache_frame(
                                cv2,
                                cache_path,
                                enhanced_frame,
                            )

                for local_index in range(batch_count):
                    cropped = enhanced_frames[frame_to_unique[local_index]].copy()
                    if reference_editorial:
                        cropped = _blend_realesrgan_reference(
                            cv2,
                            cropped,
                            references[local_index],
                            reference_weight=enhancement_reference_blend,
                        )
                        cropped = editorial_composer.compose_panel(
                            cropped,
                            apply_bf_grade=True,
                        )
                    last_hold_frame = cropped.copy()
                    write_output_frame(
                        cropped,
                        frame_index + local_index,
                        reference=(
                            None
                            if reference_editorial
                            else references[local_index]
                        ),
                    )
                frame_index += batch_count
                total_unique_frames += unique_count
                total_cache_hits += batch_cache_hits
                print(
                    f"[clip/local] Real-ESRGAN progress: "
                    f"{min(frame_index, frame_count)}/{frame_count} frames "
                    f"({total_unique_frames} unique, "
                    f"{total_cache_hits} cache hits)",
                    flush=True,
                )
            if enhancement_cache_dir is not None:
                removed_cache_frames, cache_bytes = _prune_realesrgan_cache(
                    enhancement_cache_dir,
                )
                if removed_cache_frames:
                    print(
                        f"[clip/local] Real-ESRGAN cache pruned "
                        f"{removed_cache_frames} frames; "
                        f"{cache_bytes / 1024**3:.2f} GiB retained",
                        flush=True,
                    )
        else:
            frame_index = 0
            while True:
                ret, frame = cap.read()
                if not ret:
                    break
                cropped = base_frame(frame, frame_index)
                last_hold_frame = cropped.copy()
                write_output_frame(cropped, frame_index)
                frame_index += 1

        if last_hold_frame is None:
            raise RuntimeError("source cut did not contain a renderable frame")
        while frame_index < target_frame_count:
            write_output_frame(last_hold_frame.copy(), frame_index)
            frame_index += 1

        cap.release()
        encoder.stdin.close()
        details = encoder.stderr.read().decode("utf-8", errors="replace")
        return_code = encoder.wait()
        if return_code != 0:
            raise RuntimeError(f"FFmpeg raw-video encoder failed: {details[-2000:]}")
    finally:
        cap.release()
        if encoder is not None and encoder.poll() is None:
            if encoder.stdin is not None and not encoder.stdin.closed:
                encoder.stdin.close()
            encoder.terminate()
            encoder.wait()
        if temporary_frames is not None:
            temporary_frames.cleanup()
    return out_path


def crop_clip_local(
    source_path: str,
    start_time: float,
    end_time: float,
    aspect_ratio: str,
    out_path: str,
    transcript: Optional[Dict] = None,
    speech_start_time: Optional[float] = None,
    speech_end_time: Optional[float] = None,
    speech_audio_end_time: Optional[float] = None,
    lossless_output: bool = False,
    layout_hint: Optional[str] = None,
    context_overlay: Optional[Dict] = None,
    caption_style: Optional[str] = None,
    enhancement_model: Optional[str] = None,
    enhancement_scale: Optional[int] = None,
    enhancement_reference_blend: Optional[float] = None,
    source_scene_change_times: Optional[List[float]] = None,
    caption_context: Optional[Dict] = None,
    background_music: bool = False,
    music_profile: Optional[str] = None,
    render_profile: Optional[str] = None,
    brand_tail_profile: Optional[str] = None,
    brand_tail_seconds: Optional[float] = None,
    source_content_end_time: Optional[float] = None,
    brand_tail_transition_seconds: Optional[float] = None,
    brand_tail_audio_transition_seconds: Optional[float] = None,
    brand_tail_music_release_seconds: Optional[float] = None,
) -> str:
    """Cut, reframe, and burn dynamic captions into one highlight."""
    fallback_cut_path = out_path + ".cut.mkv"
    cut_path = fallback_cut_path
    cut_is_persistent = False
    if os.path.exists(out_path):
        os.remove(out_path)
    try:
        bf_editorial_profile = _is_bf_editorial_profile(render_profile)
        render_start = _trim_opening_dead_air(
            transcript,
            start_time,
            end_time,
            max_dead_air_seconds=(
                0.25 if bf_editorial_profile else MAX_OPENING_DEAD_AIR_SECONDS
            ),
            speech_lead_seconds=(
                0.08 if bf_editorial_profile else OPENING_SPEECH_LEAD_SECONDS
            ),
        )
        cut_fps = BF_EDITORIAL_OUTPUT_FPS if bf_editorial_profile else LOCAL_OUTPUT_FPS
        source_end_time = min(
            end_time,
            max(
                render_start,
                float(source_content_end_time)
                if source_content_end_time is not None
                else end_time,
            ),
        )
        local_shot_changes = [
            float(value) - render_start
            for value in (source_scene_change_times or [])
            if render_start < float(value) < source_end_time
        ]
        visual_analysis_cache_key = _visual_analysis_cache_key(
            source_path,
            render_start,
            source_end_time,
            cut_fps,
            layout_hint,
            render_profile,
            local_shot_changes,
        )
        cut_path, cut_is_persistent = _get_or_create_lossless_cut(
            source_path,
            render_start,
            source_end_time,
            cut_fps,
            fallback_cut_path,
        )
        caption_end = min(end_time, speech_end_time) if speech_end_time is not None else end_time
        cues = _build_word_cues(
            transcript,
            render_start,
            caption_end,
            speech_start=speech_start_time,
            caption_style=caption_style,
            caption_context=caption_context,
            render_profile=render_profile,
            display_end=caption_end if bf_editorial_profile else end_time,
        )
        _reframe_vertical(
            cut_path,
            out_path,
            aspect_ratio,
            caption_cues=cues,
            lossless_output=lossless_output,
            layout_hint=layout_hint,
            context_overlay=context_overlay,
            caption_style=caption_style,
            enhancement_model=enhancement_model,
            enhancement_scale=enhancement_scale,
            enhancement_reference_blend=enhancement_reference_blend,
            shot_change_times=local_shot_changes,
            background_music=background_music,
            music_profile=music_profile,
            render_profile=render_profile,
            brand_tail_profile=brand_tail_profile,
            brand_tail_seconds=brand_tail_seconds,
            visual_analysis_cache_key=visual_analysis_cache_key,
            output_duration=end_time - render_start,
            speech_end_seconds=(
                max(
                    0.0,
                    float(
                        speech_audio_end_time
                        if speech_audio_end_time is not None
                        else speech_end_time
                    )
                    - render_start,
                )
                if (
                    speech_audio_end_time is not None
                    or speech_end_time is not None
                )
                else None
            ),
            brand_tail_transition_seconds=brand_tail_transition_seconds,
            brand_tail_audio_transition_seconds=(
                brand_tail_audio_transition_seconds
            ),
            brand_tail_music_release_seconds=(
                brand_tail_music_release_seconds
            ),
        )
    finally:
        if not cut_is_persistent and os.path.exists(cut_path):
            os.remove(cut_path)
    return out_path


def crop_composite_local(
    source_path: str,
    source_beats: List[Dict],
    aspect_ratio: str,
    out_path: str,
    transcript: Dict,
) -> str:
    from ..composite import COMPOSITE_TRANSITION_SECONDS

    beat_dir = Path(out_path + ".beats")
    if beat_dir.exists():
        shutil.rmtree(beat_dir)
    beat_dir.mkdir(parents=True)
    beat_paths = []
    try:
        for index, beat in enumerate(source_beats, start=1):
            beat_path = beat_dir / f"beat_{index:02d}.mkv"
            print(
                f"[clip/local] composite beat {index}/{len(source_beats)}: {beat['role']}",
                flush=True,
            )
            crop_clip_local(
                source_path,
                float(beat["render_start_time"]),
                float(beat["render_end_time"]),
                aspect_ratio,
                str(beat_path),
                transcript=transcript,
                speech_start_time=float(beat["speech_start_time"]),
                speech_end_time=float(beat["speech_end_time"]),
                lossless_output=True,
                layout_hint=str(beat.get("layout_hint") or "presentation"),
                context_overlay=(
                    dict(beat["context_overlay"])
                    if isinstance(beat.get("context_overlay"), dict)
                    else None
                ),
            )
            beat_paths.append(str(beat_path))
        durations = [_probe_duration(path) for path in beat_paths]
        transition_seconds = (
            0.0
            if any(beat.get("transition_style") == "cut" for beat in source_beats[1:])
            else COMPOSITE_TRANSITION_SECONDS
        )
        subprocess.run(
            _composite_encode_command(
                beat_paths,
                durations,
                out_path,
                transition_seconds,
            ),
            check=True,
        )
    finally:
        shutil.rmtree(beat_dir, ignore_errors=True)
    return out_path


def _run_realesrgan_prewarm_batch(
    cv2,
    runtime: Tuple[str, str],
    model_name: str,
    working_scale: int,
    enhancement_target_size: Tuple[int, int],
    batch: List[Dict],
) -> int:
    if not batch:
        return 0
    with _local_temporary_directory("shorts-esrgan-prewarm-") as batch_dir:
        input_dir = Path(batch_dir) / "input"
        enhanced_dir = Path(batch_dir) / "enhanced"
        input_dir.mkdir()
        enhanced_dir.mkdir()
        for index, item in enumerate(batch):
            input_path = input_dir / f"frame_{index:08d}.png"
            if not cv2.imwrite(str(input_path), item["frame"]):
                raise RuntimeError(f"could not write prewarm frame: {input_path}")
        result = _run_realesrgan_process(
            _realesrgan_command(
                runtime,
                str(input_dir),
                str(enhanced_dir),
                working_scale,
                model_name=model_name,
            )
        )
        if result.returncode != 0:
            raise RuntimeError(
                "Shared Real-ESRGAN prewarm failed: "
                + (result.stderr or result.stdout)[-1000:]
            )
        output_paths = sorted(enhanced_dir.glob("frame_*.png"))
        if len(output_paths) != len(batch):
            raise RuntimeError(
                "Shared Real-ESRGAN frame count mismatch: "
                f"expected {len(batch)}, received {len(output_paths)}"
            )
        for item, output_path in zip(batch, output_paths):
            enhanced = cv2.imread(str(output_path), cv2.IMREAD_COLOR)
            if enhanced is None:
                raise RuntimeError(f"could not read prewarmed frame: {output_path}")
            if (
                enhanced.shape[1],
                enhanced.shape[0],
            ) != enhancement_target_size:
                enhanced = cv2.resize(
                    enhanced,
                    enhancement_target_size,
                    interpolation=(
                        cv2.INTER_AREA
                        if (
                            enhanced.shape[1] > enhancement_target_size[0]
                            or enhanced.shape[0] > enhancement_target_size[1]
                        )
                        else cv2.INTER_LANCZOS4
                    ),
                )
            _write_realesrgan_cache_frame(
                cv2,
                item["cache_path"],
                enhanced,
            )
    return len(batch)


def _prewarm_bf_editorial_realesrgan_cache(
    source_path: str,
    highlights: List[Dict],
    transcript: Optional[Dict],
    aspect_ratio: str,
    render_profile: Optional[str],
) -> Dict:
    """Enhance all BF cache misses in bounded shared batches."""
    if not (
        LOCAL_REAL_ESRGAN
        and REAL_ESRGAN_CACHE_ENABLED
        and REAL_ESRGAN_SHARED_PREWARM_ENABLED
        and len(highlights) > 1
    ):
        return {"eligible_clips": 0, "cache_hits": 0, "enhanced_frames": 0}

    eligible = []
    for highlight in highlights:
        if highlight.get("source_beats"):
            continue
        resolved_profile = (
            str(highlight["render_profile"])
            if highlight.get("render_profile")
            else render_profile
        )
        if _is_bf_editorial_profile(resolved_profile):
            eligible.append(highlight)
    if len(eligible) < 2:
        return {"eligible_clips": len(eligible), "cache_hits": 0, "enhanced_frames": 0}

    try:
        import cv2  # type: ignore
    except ImportError as error:
        raise RuntimeError("opencv-python is required for Real-ESRGAN prewarm") from error

    output_size = _output_dimensions(
        aspect_ratio,
        render_profile=BF_EDITORIAL_INSET_RENDER_PROFILE,
    )
    if output_size != (1080, 1920):
        return {"eligible_clips": 0, "cache_hits": 0, "enhanced_frames": 0}
    source_size = _probe_video_frame_size(cv2, source_path)
    if (
        source_size is not None
        and _should_bypass_editorial_realesrgan(source_size, output_size)
    ):
        coverage = _editorial_panel_source_coverage(source_size, output_size)
        print(
            "[clip/local] shared Real-ESRGAN prewarm bypassed: "
            f"source panel coverage={coverage:.2f}",
            flush=True,
        )
        return {
            "eligible_clips": len(eligible),
            "bypassed_clips": len(eligible),
            "cache_hits": 0,
            "enhanced_frames": 0,
        }

    runtime = _resolve_realesrgan_runtime()
    if runtime is None:
        raise RuntimeError("Real-ESRGAN runtime is unavailable for shared prewarm")

    working_scale = 2
    enhancement_input_size, enhancement_target_size = (
        _realesrgan_working_geometry(
            (1920, 1080),
            output_size,
            working_scale,
            editorial_panel_only=True,
        )
    )
    groups: Dict[Tuple[str, int], Dict] = {}
    cache_hits = 0
    duplicate_frames = 0
    enhanced_frames = 0

    print(
        f"[clip/local] shared Real-ESRGAN prewarm: {len(eligible)} clips",
        flush=True,
    )
    with _local_temporary_directory("shorts-prewarm-cuts-") as cut_temp_dir:
        for clip_index, highlight in enumerate(eligible):
            requested_start = float(
                highlight.get("render_start_time", highlight["start_time"])
            )
            requested_end = float(
                highlight.get("render_end_time", highlight["end_time"])
            )
            actual_start = _trim_opening_dead_air(
                transcript,
                requested_start,
                requested_end,
                max_dead_air_seconds=0.25,
                speech_lead_seconds=0.08,
            )
            model_name = (
                LOCAL_REAL_ESRGAN_MODEL
                or (
                    str(highlight["enhancement_model"])
                    if highlight.get("enhancement_model")
                    else "realesrgan-x4plus"
                )
            )
            runtime_scale = _realesrgan_runtime_scale(
                model_name,
                working_scale,
            )
            group_key = (model_name, runtime_scale)
            group = groups.get(group_key)
            if group is None:
                group = {
                    "seen": set(),
                    "pending": [],
                    "runtime_fingerprint": _realesrgan_runtime_fingerprint(
                        runtime,
                        model_name,
                    ),
                }
                groups[group_key] = group
            fallback_path = str(
                Path(cut_temp_dir) / f"clip_{clip_index:03d}.mkv"
            )
            cut_path, _ = _get_or_create_lossless_cut(
                source_path,
                actual_start,
                requested_end,
                BF_EDITORIAL_OUTPUT_FPS,
                fallback_path,
            )
            cap = cv2.VideoCapture(cut_path)
            if not cap.isOpened():
                raise RuntimeError(f"could not open prewarm cut: {cut_path}")
            try:
                while True:
                    ok, frame = cap.read()
                    if not ok:
                        break
                    native = _extract_editorial_panel(frame)
                    if (
                        native.shape[1],
                        native.shape[0],
                    ) != enhancement_input_size:
                        native = cv2.resize(
                            native,
                            enhancement_input_size,
                            interpolation=(
                                cv2.INTER_AREA
                                if (
                                    native.shape[1] > enhancement_input_size[0]
                                    or native.shape[0] > enhancement_input_size[1]
                                )
                                else cv2.INTER_LANCZOS4
                            ),
                        )
                    frame_bytes = native.tobytes()
                    cache_key = _realesrgan_cache_key(
                        frame_bytes,
                        enhancement_input_size,
                        enhancement_target_size,
                        model_name,
                        working_scale,
                        runtime_scale,
                        group["runtime_fingerprint"],
                    )
                    if cache_key in group["seen"]:
                        duplicate_frames += 1
                        continue
                    group["seen"].add(cache_key)
                    cache_path = _realesrgan_cache_path(
                        REAL_ESRGAN_CACHE_DIR,
                        cache_key,
                    )
                    cached = _read_realesrgan_cache_frame(
                        cv2,
                        cache_path,
                        enhancement_target_size,
                    )
                    if cached is not None:
                        cache_hits += 1
                        continue
                    group["pending"].append(
                        {
                            "cache_path": cache_path,
                            "frame": native.copy(),
                        }
                    )
                    if len(group["pending"]) >= REAL_ESRGAN_BATCH_FRAMES:
                        enhanced_frames += _run_realesrgan_prewarm_batch(
                            cv2,
                            runtime,
                            model_name,
                            working_scale,
                            enhancement_target_size,
                            group["pending"],
                        )
                        group["pending"].clear()
                        print(
                            f"[clip/local] shared Real-ESRGAN prewarm progress: "
                            f"{enhanced_frames} enhanced",
                            flush=True,
                        )
            finally:
                cap.release()

    for (model_name, _runtime_scale), group in groups.items():
        enhanced_frames += _run_realesrgan_prewarm_batch(
            cv2,
            runtime,
            model_name,
            working_scale,
            enhancement_target_size,
            group["pending"],
        )
        group["pending"].clear()

    total_unique_frames = sum(len(group["seen"]) for group in groups.values())
    _prune_realesrgan_cache(REAL_ESRGAN_CACHE_DIR)
    print(
        f"[clip/local] shared Real-ESRGAN prewarm complete: "
        f"{total_unique_frames} unique, {duplicate_frames} duplicates, "
        f"{cache_hits} cache hits, {enhanced_frames} enhanced",
        flush=True,
    )
    return {
        "eligible_clips": len(eligible),
        "unique_frames": total_unique_frames,
        "duplicate_frames": duplicate_frames,
        "cache_hits": cache_hits,
        "enhanced_frames": enhanced_frames,
    }


def crop_highlights_local(
    source_path: str,
    highlights: List[Dict],
    aspect_ratio: str = "9:16",
    out_dir: Optional[str] = None,
    transcript: Optional[Dict] = None,
    render_profile: Optional[str] = None,
    brand_tail_profile: Optional[str] = None,
    brand_tail_seconds: Optional[float] = None,
    _allow_parallel: bool = True,
) -> List[Dict]:
    out_dir = out_dir or LOCAL_OUTPUT_DIR
    os.makedirs(out_dir, exist_ok=True)
    try:
        _prewarm_bf_editorial_realesrgan_cache(
            source_path,
            highlights,
            transcript,
            aspect_ratio,
            render_profile,
        )
    except Exception as error:
        print(
            f"[clip/local] shared Real-ESRGAN prewarm skipped: {error}",
            flush=True,
        )
    worker_count = min(2, LOCAL_RENDER_WORKERS, len(highlights))
    if _allow_parallel and worker_count > 1:
        print(
            f"[clip/local] parallel render batch: {len(highlights)} clips "
            f"with {worker_count} workers",
            flush=True,
        )

        def render_one(job):
            index, highlight, staging_root = job
            final_path = Path(out_dir) / f"short_{index:02d}.mp4"
            job_dir = staging_root / f"job_{index:02d}"
            try:
                final_path.unlink(missing_ok=True)
                job_dir.mkdir(parents=True, exist_ok=True)
                rendered = crop_highlights_local(
                    source_path,
                    [highlight],
                    aspect_ratio=aspect_ratio,
                    out_dir=str(job_dir),
                    transcript=transcript,
                    render_profile=render_profile,
                    brand_tail_profile=brand_tail_profile,
                    brand_tail_seconds=brand_tail_seconds,
                    _allow_parallel=False,
                )
                if len(rendered) != 1:
                    raise RuntimeError(
                        "single-highlight renderer returned an invalid result count"
                    )
                result = rendered[0]
                staged_value = result.get("clip_url")
                if not staged_value:
                    return result
                staged_path = Path(str(staged_value))
                if not staged_path.is_file() or staged_path.stat().st_size <= 0:
                    raise RuntimeError(
                        "single-highlight renderer did not produce a valid MP4"
                    )
                try:
                    os.replace(staged_path, final_path)
                except OSError:
                    temporary_path = final_path.with_name(
                        f".{final_path.stem}.{os.getpid()}.{get_ident()}.mp4"
                    )
                    try:
                        shutil.copy2(staged_path, temporary_path)
                        os.replace(temporary_path, final_path)
                    finally:
                        temporary_path.unlink(missing_ok=True)
                    staged_path.unlink(missing_ok=True)
                return {**result, "clip_url": str(final_path)}
            except Exception as error:
                print(
                    f"[clip/local] {index} failed: {error}",
                    flush=True,
                )
                return {
                    **highlight,
                    "clip_url": None,
                    "error": str(error),
                }

        with _local_temporary_directory("shorts-render-batch-") as staging_dir:
            staging_root = Path(staging_dir)
            jobs = [
                (index, highlight, staging_root)
                for index, highlight in enumerate(highlights, start=1)
            ]
            with ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="short-render",
            ) as executor:
                return list(executor.map(render_one, jobs))

    results: List[Dict] = []
    for i, h in enumerate(highlights, 1):
        out_path = os.path.join(out_dir, f"short_{i:02d}.mp4")
        print(f"[clip/local] {i}/{len(highlights)}: {h.get('title', '(untitled)')}", flush=True)
        render_metadata: Dict = {}
        try:
            if h.get("source_beats"):
                if transcript is None:
                    raise RuntimeError("Composite rendering requires exact transcript timestamps")
                crop_composite_local(
                    source_path,
                    list(h["source_beats"]),
                    aspect_ratio,
                    out_path,
                    transcript,
                )
            else:
                resolved_render_profile = (
                    str(h["render_profile"])
                    if h.get("render_profile")
                    else render_profile
                )
                resolved_brand_tail_profile = (
                    str(h["brand_tail_profile"])
                    if h.get("brand_tail_profile")
                    else brand_tail_profile
                )
                requested_brand_tail_seconds = (
                    float(h["brand_tail_seconds"])
                    if h.get("brand_tail_seconds") is not None
                    else brand_tail_seconds
                )
                resolved_caption_style = (
                    str(h["caption_style"])
                    if h.get("caption_style")
                    else (
                        BF_EDITORIAL_INSET_RENDER_PROFILE
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else None
                    )
                )
                resolved_caption_context = {
                    key: h.get(key)
                    for key in (
                        "title",
                        "topic",
                        "hook_sentence",
                        "final_takeaway_sentence",
                        "thesis",
                        "context_summary",
                    )
                }
                requested_render_start = float(
                    h.get("render_start_time", h["start_time"])
                )
                requested_render_end = float(
                    h.get("render_end_time", h["end_time"])
                )
                actual_render_start = _trim_opening_dead_air(
                    transcript,
                    requested_render_start,
                    requested_render_end,
                    max_dead_air_seconds=(
                        0.25
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else MAX_OPENING_DEAD_AIR_SECONDS
                    ),
                    speech_lead_seconds=(
                        0.08
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else OPENING_SPEECH_LEAD_SECONDS
                    ),
                )
                resolved_render_duration = max(
                    0.0,
                    requested_render_end - actual_render_start,
                )
                configured_brand_tail_seconds = _resolve_bf_brand_tail_seconds(
                    resolved_render_profile,
                    brand_tail_profile=resolved_brand_tail_profile,
                    requested_seconds=requested_brand_tail_seconds,
                )
                resolved_brand_tail_seconds = (
                    configured_brand_tail_seconds
                    if _is_bf_editorial_profile(resolved_render_profile)
                    else min(
                        configured_brand_tail_seconds,
                        resolved_render_duration * 0.20,
                    )
                )
                if _is_bf_editorial_profile(resolved_render_profile):
                    speech_end_time = (
                        float(h["speech_end_time"])
                        if h.get("speech_end_time") is not None
                        else requested_render_end
                    )
                    tail_plan = _bf_editorial_tail_plan(
                        transcript,
                        speech_end_time,
                        resolved_brand_tail_seconds,
                        tail_profile=(
                            resolved_brand_tail_profile
                            or BF_REFERENCE_TAIL_V2
                        ),
                        verified_acoustic_speech_end_time=h.get(
                            "verified_acoustic_speech_end_time"
                        ),
                        verified_next_spoken_word_start=h.get(
                            "verified_next_spoken_word_start"
                        ),
                        verified_next_speech_safety_seconds=h.get(
                            "verified_next_speech_safety_seconds"
                        ),
                        verified_acoustic_boundary_evidence=h.get(
                            "verified_acoustic_boundary_evidence"
                        ),
                        verified_visual_safe_end_time=h.get(
                            "verified_visual_safe_end_time"
                        ),
                        verified_visual_boundary_evidence=h.get(
                            "verified_visual_boundary_evidence"
                        ),
                        semantic_closure_decision_version=h.get(
                            "semantic_closure_decision_version"
                        ),
                        planned_natural_tail_end_time=h.get(
                            "natural_tail_end_time"
                        ),
                    )
                    requested_render_end = float(tail_plan["output_end_time"])
                    resolved_render_duration = max(
                        0.0,
                        requested_render_end - actual_render_start,
                    )
                    output_max_seconds = (
                        BF_GROWTH_V2_OUTPUT_MAX_SECONDS
                        if resolved_brand_tail_profile
                        == BF_NATURAL_TAIL_V6
                        else BF_EDITORIAL_OUTPUT_MAX_SECONDS
                    )
                    if resolved_render_duration > output_max_seconds + 0.001:
                        raise RuntimeError(
                            f"{resolved_brand_tail_profile or BF_REFERENCE_TAIL_V2} "
                            f"output exceeds the {output_max_seconds:.1f}s delivery "
                            "ceiling; re-cut or replace the candidate"
                        )
                    caption_end = min(
                        requested_render_end,
                        speech_end_time,
                    )
                    caption_display_end = (
                        requested_render_end - resolved_brand_tail_seconds
                    )
                    if caption_end > caption_display_end + 0.001:
                        raise RuntimeError(
                            "bf_editorial_inset_v1 requires at least 0.20s of "
                            "post-speech source time for the BF. tail"
                        )
                    qa_cues = _build_word_cues(
                        transcript,
                        actual_render_start,
                        caption_end,
                        speech_start=(
                            float(h["speech_start_time"])
                            if h.get("speech_start_time") is not None
                            else None
                        ),
                        caption_style=resolved_caption_style,
                        caption_context=resolved_caption_context,
                        render_profile=resolved_render_profile,
                        display_end=caption_end,
                    )
                    semantic_end_seconds = max(
                        (float(cue["end"]) for cue in qa_cues),
                        default=0.0,
                    )
                    available_post_speech_seconds = max(
                        0.0,
                        resolved_render_duration - semantic_end_seconds,
                    )
                    resolved_brand_tail_seconds = min(
                        resolved_brand_tail_seconds,
                        available_post_speech_seconds,
                    )
                    if resolved_brand_tail_seconds < 0.20:
                        raise RuntimeError(
                            "bf_editorial_inset_v1 requires at least 0.20s of "
                            "post-speech source time for the BF. tail"
                        )
                    brand_tail_start_seconds = max(
                        semantic_end_seconds,
                        resolved_render_duration - resolved_brand_tail_seconds,
                    )
                    first_visible_text_seconds = (
                        min(float(cue["start"]) for cue in qa_cues)
                        if qa_cues
                        else None
                    )
                    phrases_by_id: Dict[int, Dict] = {}
                    for cue in sorted(qa_cues, key=lambda item: float(item["start"])):
                        phrase_id = cue.get("phrase_id")
                        if phrase_id is None:
                            continue
                        phrases_by_id.setdefault(int(phrase_id), cue)
                    phrase_events = [
                        {
                            "type": "phrase_reveal",
                            "time_seconds": round(float(cue["start"]), 3),
                            "phrase_id": phrase_id,
                            "role": str(cue.get("typography_role") or "hero"),
                            "anchor_scale": round(
                                float(cue.get("typography_anchor_scale", 1.0)),
                                3,
                            ),
                            "text": str(cue.get("text") or ""),
                        }
                        for phrase_id, cue in sorted(phrases_by_id.items())
                    ]
                    max_hero_scale = max(
                        (
                            float(cue.get("typography_anchor_scale", 1.0))
                            for cue in phrases_by_id.values()
                        ),
                        default=0.0,
                    )
                    role_counts = Counter(
                        str(cue.get("typography_role") or "hero")
                        for cue in phrases_by_id.values()
                    )
                    brand_tail_event = {
                        "type": "brand_tail",
                        "profile": (
                            resolved_brand_tail_profile
                            or BF_REFERENCE_TAIL_V2
                        ),
                        "start_seconds": round(
                            brand_tail_start_seconds,
                            3,
                        ),
                        "end_seconds": round(
                            resolved_render_duration,
                            3,
                        ),
                    }
                    render_metadata = {
                        "render_profile": resolved_render_profile,
                        "layout_profile": BF_EDITORIAL_INSET_LAYOUT,
                        "grade_profile": "high_contrast_grayscale_v1",
                        "typography_profile": "kinetic_editorial_v1",
                        "artificial_cut_limit": 0,
                        "brand_tail_profile": (
                            resolved_brand_tail_profile or BF_REFERENCE_TAIL_V2
                        ),
                        "brand_tail_seconds": round(
                            resolved_brand_tail_seconds,
                            3,
                        ),
                        "brand_tail_start_seconds": round(
                            brand_tail_start_seconds,
                            3,
                        ),
                        "semantic_end_seconds": round(
                            semantic_end_seconds,
                            3,
                        ),
                        "brand_tail_clearance_seconds": round(
                            brand_tail_start_seconds - semantic_end_seconds,
                            3,
                        ),
                        "post_point_hold_seconds": round(
                            float(tail_plan["post_point_hold_seconds"]),
                            3,
                        ),
                        "natural_tail_seconds": round(
                            float(tail_plan["natural_tail_seconds"]),
                            3,
                        ),
                        "speech_audio_tail_seconds": round(
                            float(tail_plan["speech_audio_tail_seconds"]),
                            3,
                        ),
                        "freeze_hold_seconds": round(
                            float(tail_plan["freeze_hold_seconds"]),
                            3,
                        ),
                        "transition_tail_seconds": round(
                            float(tail_plan["transition_tail_seconds"]),
                            3,
                        ),
                        "visual_transition_start_time": round(
                            float(tail_plan["visual_transition_start_time"]),
                            3,
                        ),
                        "audio_transition_tail_seconds": round(
                            float(tail_plan["audio_transition_tail_seconds"]),
                            3,
                        ),
                        "audio_transition_start_time": round(
                            float(tail_plan["audio_transition_start_time"]),
                            3,
                        ),
                        "speech_audio_end_time": round(
                            float(tail_plan["speech_audio_end_time"]),
                            3,
                        ),
                        "semantic_source_margin_seconds": round(
                            float(tail_plan["semantic_source_margin_seconds"]),
                            3,
                        ),
                        "music_release_tail_seconds": round(
                            float(tail_plan["music_release_tail_seconds"]),
                            3,
                        ),
                        "next_spoken_word_start": (
                            round(float(tail_plan["next_spoken_word_start"]), 3)
                            if tail_plan["next_spoken_word_start"] is not None
                            else None
                        ),
                        "source_content_end_time": round(
                            float(tail_plan["source_content_end_time"]),
                            3,
                        ),
                        "next_speech_safety_seconds": round(
                            float(tail_plan["next_speech_safety_seconds"]),
                            3,
                        ),
                        "acoustic_speech_end_time": round(
                            float(tail_plan["acoustic_speech_end_time"]),
                            3,
                        ),
                        "transcript_next_spoken_word_start": (
                            round(
                                float(
                                    tail_plan[
                                        "transcript_next_spoken_word_start"
                                    ]
                                ),
                                3,
                            )
                            if tail_plan["transcript_next_spoken_word_start"]
                            is not None
                            else None
                        ),
                        "acoustic_boundary_source": str(
                            tail_plan["acoustic_boundary_source"]
                        ),
                        "verified_acoustic_speech_end_time": (
                            round(
                                float(
                                    tail_plan[
                                        "verified_acoustic_speech_end_time"
                                    ]
                                ),
                                3,
                            )
                            if tail_plan["verified_acoustic_speech_end_time"]
                            is not None
                            else None
                        ),
                        "verified_next_spoken_word_start": (
                            round(
                                float(
                                    tail_plan[
                                        "verified_next_spoken_word_start"
                                    ]
                                ),
                                3,
                            )
                            if tail_plan["verified_next_spoken_word_start"]
                            is not None
                            else None
                        ),
                        "verified_next_speech_safety_seconds": (
                            round(
                                float(
                                    tail_plan[
                                        "verified_next_speech_safety_seconds"
                                    ]
                                ),
                                3,
                            )
                            if tail_plan[
                                "verified_next_speech_safety_seconds"
                            ]
                            is not None
                            else None
                        ),
                        "verified_acoustic_boundary_evidence": tail_plan[
                            "verified_acoustic_boundary_evidence"
                        ],
                        "acoustic_safe_source_end_time": round(
                            float(tail_plan["acoustic_safe_source_end_time"]),
                            3,
                        ),
                        "verified_visual_safe_end_time": (
                            round(
                                float(
                                    tail_plan[
                                        "verified_visual_safe_end_time"
                                    ]
                                ),
                                3,
                            )
                            if tail_plan["verified_visual_safe_end_time"]
                            is not None
                            else None
                        ),
                        "verified_visual_boundary_evidence": tail_plan[
                            "verified_visual_boundary_evidence"
                        ],
                        "visual_safe_end_guard_passed": bool(
                            tail_plan["visual_safe_end_guard_passed"]
                        ),
                        "source_speech_leak_guard_passed": bool(
                            tail_plan["source_speech_leak_guard_passed"]
                        ),
                        "semantic_closure_decision_version": tail_plan[
                            "semantic_closure_decision_version"
                        ],
                        "semantic_closure_status": h.get(
                            "semantic_closure_status"
                        ),
                        "semantic_closure_speech_end_time": h.get(
                            "semantic_closure_speech_end_time"
                        ),
                        "captions_source_end_time": h.get(
                            "captions_source_end_time"
                        ),
                        "planned_natural_tail_end_time": tail_plan[
                            "planned_natural_tail_end_time"
                        ],
                        "captions_clear_at_seconds": round(
                            caption_end - actual_render_start,
                            3,
                        ),
                        "render_end_time": round(
                            requested_render_end,
                            3,
                        ),
                        "first_visible_text_seconds": (
                            round(first_visible_text_seconds, 3)
                            if first_visible_text_seconds is not None
                            else None
                        ),
                        "max_hero_scale": round(max_hero_scale, 3),
                        "type_plan_summary": {
                            "phrase_count": len(phrases_by_id),
                            "hero_count": int(role_counts.get("hero", 0)),
                            "reaction_count": int(role_counts.get("reaction", 0)),
                            "max_words_per_phrase": max(
                                (
                                    len(cue.get("words") or [])
                                    for cue in phrases_by_id.values()
                                ),
                                default=0,
                            ),
                            "max_anchor_scale": round(max_hero_scale, 3),
                        },
                        "caption_timing_summary": _caption_timing_metrics(
                            qa_cues
                        ),
                        "declared_render_events": [brand_tail_event],
                        "render_timeline_events": [
                            *phrase_events,
                            brand_tail_event,
                        ],
                    }
                crop_clip_local(
                    source_path,
                    requested_render_start,
                    requested_render_end,
                    aspect_ratio,
                    out_path,
                    transcript=transcript,
                    speech_start_time=(
                        float(h["speech_start_time"])
                        if h.get("speech_start_time") is not None
                        else None
                    ),
                    speech_end_time=(
                        float(h["speech_end_time"])
                        if h.get("speech_end_time") is not None
                        else None
                    ),
                    speech_audio_end_time=(
                        float(tail_plan["speech_audio_end_time"])
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else None
                    ),
                    layout_hint=(
                        str(h["layout_hint"])
                        if h.get("layout_hint")
                        else None
                    ),
                    context_overlay=(
                        dict(h["context_overlay"])
                        if isinstance(h.get("context_overlay"), dict)
                        else None
                    ),
                    caption_style=resolved_caption_style,
                    enhancement_model=(
                        LOCAL_REAL_ESRGAN_MODEL
                        or str(h["enhancement_model"])
                        if h.get("enhancement_model")
                        else LOCAL_REAL_ESRGAN_MODEL or None
                    ),
                    enhancement_scale=(
                        int(h["enhancement_scale"])
                        if h.get("enhancement_scale") is not None
                        else None
                    ),
                    enhancement_reference_blend=(
                        float(h["enhancement_reference_blend"])
                        if h.get("enhancement_reference_blend") is not None
                        else None
                    ),
                    source_scene_change_times=(
                        [float(value) for value in h["source_scene_change_times"]]
                        if isinstance(h.get("source_scene_change_times"), list)
                        else None
                    ),
                    caption_context=resolved_caption_context,
                    background_music=bool(h.get("background_music", False)),
                    music_profile=(
                        str(h["music_profile"])
                        if h.get("music_profile")
                        else None
                    ),
                    render_profile=resolved_render_profile,
                    brand_tail_profile=resolved_brand_tail_profile,
                    brand_tail_seconds=resolved_brand_tail_seconds,
                    source_content_end_time=(
                        float(tail_plan["source_content_end_time"])
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else None
                    ),
                    brand_tail_transition_seconds=(
                        float(tail_plan["transition_tail_seconds"])
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else None
                    ),
                    brand_tail_audio_transition_seconds=(
                        float(tail_plan["audio_transition_tail_seconds"])
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else None
                    ),
                    brand_tail_music_release_seconds=(
                        float(tail_plan["music_release_tail_seconds"])
                        if _is_bf_editorial_profile(resolved_render_profile)
                        else None
                    ),
                )
            results.append({**h, **render_metadata, "clip_url": out_path})
        except Exception as e:
            print(f"[clip/local] {i} failed: {e}", flush=True)
            results.append(
                {**h, **render_metadata, "clip_url": None, "error": str(e)}
            )
    return results
