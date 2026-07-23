import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


def _default_local_cache_dir() -> Path:
    """Return an OS-local cache root that is normally outside cloud sync."""
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "Shorts-Engine"
    if os.name == "nt":
        base = Path(os.getenv("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
        return base / "Shorts-Engine" / "Cache"
    base = Path(os.getenv("XDG_CACHE_HOME", Path.home() / ".cache"))
    return base / "shorts-engine"

MUAPI_API_KEY = os.getenv("MUAPI_API_KEY", "").strip()
MUAPI_BASE_URL = os.getenv("MUAPI_BASE_URL", "https://api.muapi.ai/api/v1").rstrip("/")

POLL_INTERVAL_SECONDS = float(os.getenv("MUAPI_POLL_INTERVAL", "5"))
POLL_TIMEOUT_SECONDS = float(os.getenv("MUAPI_POLL_TIMEOUT", "600"))

# Local-mode (--mode local) settings — only consulted when running offline.
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
GEMINI_FALLBACK_MODEL = os.getenv(
    "GEMINI_FALLBACK_MODEL",
    "gemini-3.1-flash-lite",
).strip()
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "openai").strip().lower()
LOCAL_WHISPER_MODEL = os.getenv("LOCAL_WHISPER_MODEL", "base")
LOCAL_WHISPER_DEVICE = os.getenv("LOCAL_WHISPER_DEVICE", "auto")  # auto / cpu / cuda
LOCAL_OUTPUT_DIR = os.getenv("LOCAL_OUTPUT_DIR", "output")
LOCAL_PERFORMANCE_REPORT_DIR = str(
    Path(
        os.getenv(
            "LOCAL_PERFORMANCE_REPORT_DIR",
            str(Path(LOCAL_OUTPUT_DIR) / "performance"),
        )
    ).expanduser()
)
LOCAL_CACHE_DIR = str(
    Path(
        os.getenv("LOCAL_CACHE_DIR", str(_default_local_cache_dir()))
    ).expanduser()
)
LOCAL_WORK_DIR = str(
    Path(
        os.getenv("LOCAL_WORK_DIR", str(Path(LOCAL_CACHE_DIR) / "work"))
    ).expanduser()
)
LOCAL_SOURCE_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_SOURCE_CACHE_DIR",
            str(Path(LOCAL_CACHE_DIR) / "sources"),
        )
    ).expanduser()
)
LOCAL_DOWNLOAD_CONCURRENT_FRAGMENTS = max(
    1,
    min(16, int(os.getenv("LOCAL_DOWNLOAD_CONCURRENT_FRAGMENTS", "4"))),
)
LOCAL_TRANSCRIPT_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_TRANSCRIPT_CACHE_DIR",
            str(Path(LOCAL_CACHE_DIR) / "transcripts"),
        )
    ).expanduser()
)
LOCAL_YOUTUBE_CAPTIONS = os.getenv(
    "LOCAL_YOUTUBE_CAPTIONS",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
LOCAL_CANDIDATE_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_CANDIDATE_CACHE_DIR",
            str(Path(LOCAL_CACHE_DIR) / "candidate-cache"),
        )
    ).expanduser()
)
LOCAL_RENDER_CACHE = os.getenv("LOCAL_RENDER_CACHE", "true").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
LOCAL_RENDER_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_RENDER_CACHE_DIR",
            str(Path(LOCAL_CACHE_DIR) / "production-renders-v1"),
        )
    ).expanduser()
)
LOCAL_RENDER_WORKERS = max(
    1,
    min(2, int(os.getenv("LOCAL_RENDER_WORKERS", "2"))),
)
LOCAL_SHOT_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_SHOT_CACHE_DIR",
            str(Path(LOCAL_CACHE_DIR) / "shot-cache"),
        )
    ).expanduser()
)
LOCAL_CANDIDATE_VISUAL_WORKERS = max(
    1,
    min(4, int(os.getenv("LOCAL_CANDIDATE_VISUAL_WORKERS", "4"))),
)
LOCAL_SHOT_ANALYSIS_WORKERS = max(
    1,
    min(4, int(os.getenv("LOCAL_SHOT_ANALYSIS_WORKERS", "4"))),
)
LOCAL_VISUAL_ANALYSIS_CACHE = os.getenv(
    "LOCAL_VISUAL_ANALYSIS_CACHE",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
LOCAL_VISUAL_ANALYSIS_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_VISUAL_ANALYSIS_CACHE_DIR",
            str(Path(LOCAL_CACHE_DIR) / "visual-analysis-v1"),
        )
    ).expanduser()
)
LOCAL_CANDIDATE_VISUAL_CACHE_DIR = str(
    Path(
        os.getenv(
            "LOCAL_CANDIDATE_VISUAL_CACHE_DIR",
            str(Path(LOCAL_VISUAL_ANALYSIS_CACHE_DIR) / "candidate-metrics-v1"),
        )
    ).expanduser()
)
LOCAL_OUTPUT_WIDTH = int(os.getenv("LOCAL_OUTPUT_WIDTH", "720"))
LOCAL_OUTPUT_HEIGHT = int(os.getenv("LOCAL_OUTPUT_HEIGHT", "1280"))
LOCAL_OUTPUT_FPS = max(24, min(60, int(os.getenv("LOCAL_OUTPUT_FPS", "30"))))
LOCAL_VIDEO_CRF = int(os.getenv("LOCAL_VIDEO_CRF", "21"))
LOCAL_VIDEO_PRESET = os.getenv("LOCAL_VIDEO_PRESET", "fast").strip()
LOCAL_VIDEO_PROFILE = os.getenv("LOCAL_VIDEO_PROFILE", "high").strip()
LOCAL_AUDIO_BITRATE = os.getenv("LOCAL_AUDIO_BITRATE", "192k").strip()
LOCAL_AUDIO_LOUDNESS = float(os.getenv("LOCAL_AUDIO_LOUDNESS", "-15"))
LOCAL_AUDIO_TRUE_PEAK = float(os.getenv("LOCAL_AUDIO_TRUE_PEAK", "-1.5"))
LOCAL_MOTIVATIONAL_MUSIC = os.getenv(
    "LOCAL_MOTIVATIONAL_MUSIC",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
LOCAL_MOTIVATIONAL_MUSIC_TRACK = os.getenv(
    "LOCAL_MOTIVATIONAL_MUSIC_TRACK",
    "",
).strip()
LOCAL_MOTIVATIONAL_MUSIC_PROFILE = os.getenv(
    "LOCAL_MOTIVATIONAL_MUSIC_PROFILE",
    "auto",
).strip().lower()
LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS = max(
    -40.0,
    min(-24.0, float(os.getenv("LOCAL_MOTIVATIONAL_MUSIC_LOUDNESS", "-31"))),
)
LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS = max(
    0.0,
    float(os.getenv("LOCAL_MOTIVATIONAL_MUSIC_START_SECONDS", "8")),
)
LOCAL_CAPTION_LEAD_MS = max(0, min(120, int(os.getenv("LOCAL_CAPTION_LEAD_MS", "60"))))
LOCAL_REAL_ESRGAN = os.getenv("LOCAL_REAL_ESRGAN", "true").strip().lower() in {
    "1", "true", "yes", "on",
}
LOCAL_REAL_ESRGAN_PATH = os.getenv("LOCAL_REAL_ESRGAN_PATH", "").strip()
LOCAL_REAL_ESRGAN_MODEL = os.getenv("LOCAL_REAL_ESRGAN_MODEL", "").strip()
LOCAL_REAL_ESRGAN_REFERENCE_BLEND = max(
    0.0,
    min(0.5, float(os.getenv("LOCAL_REAL_ESRGAN_REFERENCE_BLEND", "0.25"))),
)
LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES = os.getenv(
    "LOCAL_REAL_ESRGAN_BYPASS_HIGH_RES",
    "true",
).strip().lower() in {"1", "true", "yes", "on"}
LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE = max(
    0.5,
    min(
        1.0,
        float(os.getenv("LOCAL_REAL_ESRGAN_MIN_PANEL_COVERAGE", "0.90")),
    ),
)

# VAD (Voice Activity Detection) settings for faster-whisper
# Default threshold is 0.5; lower = more sensitive, higher = less sensitive
# Default min_speech_duration_ms is 250ms; increase to avoid tiny false positives
# Default min_silence_duration_ms is 2000ms; increase to avoid splitting mid-sentence
# DISABLED by default because VAD is too aggressive on mixed speech/music content
LOCAL_WHISPER_VAD_FILTER = os.getenv("LOCAL_WHISPER_VAD_FILTER", "false").strip().lower() == "true"
_vad_params_env = os.getenv("LOCAL_WHISPER_VAD_PARAMETERS", "")
if _vad_params_env:
    import json
    LOCAL_WHISPER_VAD_PARAMETERS = json.loads(_vad_params_env)
else:
    # Match faster-whisper defaults when VAD is enabled
    LOCAL_WHISPER_VAD_PARAMETERS = {
        "threshold": 0.5,
        "min_speech_duration_ms": 250,
        "max_speech_duration_s": float("inf"),
        "min_silence_duration_ms": 2000,
        "speech_pad_ms": 400,
    }


def require_api_key() -> str:
    if not MUAPI_API_KEY:
        raise RuntimeError(
            "MUAPI_API_KEY is not set. Add it to your .env file or export it as an env var."
        )
    return MUAPI_API_KEY


def require_openai_key() -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Local mode needs an OpenAI key for highlight ranking. "
            "Add it to your .env or export it, or switch back to --mode api."
        )
    return OPENAI_API_KEY


def require_gemini_key() -> str:
    if not GEMINI_API_KEY:
        raise RuntimeError(
            "GEMINI_API_KEY is not set. Local mode needs a Gemini key when LLM_PROVIDER=gemini. "
            "Add it to your .env or export it, or switch LLM_PROVIDER back to openai."
        )
    return GEMINI_API_KEY
