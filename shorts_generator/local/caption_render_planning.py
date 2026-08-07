"""Pure per-frame selection and normalization for local caption rendering."""

from typing import Any, Dict, Mapping, NamedTuple, Optional, Sequence, Tuple


CaptionCue = Mapping[str, Any]


class ActiveCaptionSelection(NamedTuple):
    """The active cue references and next legacy scan index for one frame."""

    cues: Tuple[CaptionCue, ...]
    next_index: int


class CaptionRenderPlan(NamedTuple):
    words: Tuple[str, ...]
    active_index: int
    emphasis_index: int
    visible_word_count: int
    phrase_id: Optional[int]
    sentence_id: Optional[int]
    sentence_phrase_index: int
    sentence_phrase_count: int
    caption_track_progress: Optional[float]
    typography: Dict[str, Any]
    kinetic_state: Optional[Mapping[str, float]]


def select_active_caption_cues(
    caption_cues: Sequence[CaptionCue],
    elapsed: float,
    *,
    persistent_editorial: bool,
    start_index: int,
) -> ActiveCaptionSelection:
    """Select cues with the exact persistent and legacy frame semantics."""
    if persistent_editorial:
        active = sorted(
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
        if len(active) > 1:
            cues_by_track = {}
            for cue in active:
                track_key = (
                    int(cue.get("sentence_id", -1)),
                    int(cue.get("caption_track_slot", 1)),
                )
                previous = cues_by_track.get(track_key)
                if previous is None or float(cue["start"]) >= float(
                    previous["start"]
                ):
                    cues_by_track[track_key] = cue
            active = sorted(
                cues_by_track.values(),
                key=lambda cue: (
                    int(cue.get("sentence_phrase_index", 0)),
                    int(cue.get("phrase_id", 0)),
                ),
            )
            if len(active) > 2:
                active = sorted(
                    sorted(active, key=lambda cue: float(cue["start"]))[-2:],
                    key=lambda cue: (
                        int(cue.get("sentence_phrase_index", 0)),
                        int(cue.get("phrase_id", 0)),
                    ),
                )
        return ActiveCaptionSelection(tuple(active), start_index)

    next_index = start_index
    while (
        next_index < len(caption_cues)
        and elapsed >= float(caption_cues[next_index]["end"])
    ):
        next_index += 1
    active = (
        (caption_cues[next_index],)
        if (
            next_index < len(caption_cues)
            and float(caption_cues[next_index]["start"]) <= elapsed
        )
        else ()
    )
    return ActiveCaptionSelection(active, next_index)


def editorial_kinetic_state(
    cue: CaptionCue,
    elapsed: float,
    *,
    entry_seconds: float,
    exit_seconds: float,
) -> Dict[str, float]:
    """Calculate the existing restrained phrase entry and exit treatment."""
    phrase_start = float(cue.get("phrase_start", cue.get("start", 0.0)))
    entry_progress = max(
        0.0,
        min(
            1.0,
            (float(elapsed) - phrase_start) / max(0.001, entry_seconds),
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
                / max(0.001, exit_seconds),
            ),
        )
    exit_eased = exit_progress * exit_progress * (3.0 - 2.0 * exit_progress)
    return {
        "progress": entry_progress,
        "exit_progress": exit_progress,
        "opacity": (0.35 + 0.65 * eased) * exit_eased,
        "scale": 0.98 + 0.02 * eased,
        "mask_reveal": 1.0,
    }


def build_caption_render_plan(
    cue: Any,
    *,
    editorial_style: bool,
    kinetic_state: Optional[Mapping[str, float]],
) -> CaptionRenderPlan:
    """Normalize a cue without measuring text or touching frame pixels."""
    if isinstance(cue, dict):
        words = [str(word).strip() for word in cue.get("words", [])]
        active_index = int(cue.get("active_index", 0))
        emphasis_index = int(cue.get("emphasis_index", active_index))
        visible_word_count = max(
            0,
            min(len(words), int(cue.get("visible_word_count", len(words)))),
        )
        phrase_id_value = cue.get("phrase_id")
        phrase_id = int(phrase_id_value) if phrase_id_value is not None else None
        sentence_id_value = cue.get("sentence_id")
        sentence_id = (
            int(sentence_id_value) if sentence_id_value is not None else None
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
            "secondary_style": str(
                cue.get("typography_secondary_style") or "base"
            ),
        }
        if kinetic_state:
            typography["base_scale"] *= float(kinetic_state["scale"])
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
    if not editorial_style:
        words = [word.upper() for word in words]
    return CaptionRenderPlan(
        words=tuple(word for word in words if word),
        active_index=active_index,
        emphasis_index=emphasis_index,
        visible_word_count=visible_word_count,
        phrase_id=phrase_id,
        sentence_id=sentence_id,
        sentence_phrase_index=sentence_phrase_index,
        sentence_phrase_count=sentence_phrase_count,
        caption_track_progress=caption_track_progress,
        typography=typography,
        kinetic_state=kinetic_state,
    )
