"""Versioned content, selection, render, and combined-format policies.

The original motivational renderer is intentionally kept as
``budget_friendly_v2``.  New production behavior must be selected explicitly
through a render profile or a combined format profile so experiments cannot
silently change when a default evolves.
"""
import hashlib
import json
import re
from copy import deepcopy
from typing import Dict, Optional

from .hook_gate import (
    HOOK_GATE_DECISION_VERSION,
    HOOK_GATE_PROMPT_VERSION,
    HOOK_OPENING_START_TOLERANCE_SECONDS,
    HOOK_SIGNAL_LATENCY_TOLERANCE_SECONDS,
    HOOK_PAYOFF_MAX_LATENCY_SECONDS,
    HOOK_SIGNAL_MAX_LATENCY_SECONDS,
)
from .motivational_closure import (
    CLOSURE_HARD_MAX_SECONDS,
    CLOSURE_HARD_MIN_SECONDS,
    CLOSURE_PREFERRED_MAX_SECONDS,
    CLOSURE_PREFERRED_MIN_SECONDS,
    CLOSURE_SOFT_MAX_SECONDS,
    CLOSURE_STRONG_EVIDENCE_MIN_SCORE,
    CLOSURE_WORD_END_TOLERANCE_SECONDS,
    NATURAL_TAIL_MAX_SECONDS,
    NATURAL_TAIL_POLICY_VERSION,
    NEXT_SPEECH_SAFETY_SECONDS,
    POST_SOURCE_FADE_SECONDS,
    SEMANTIC_CLOSURE_DECISION_VERSION,
)


MOTIVATIONAL_PODCAST = "motivational_podcast"
BUDGET_FRIENDLY_CAPTION_STYLE = "budget_friendly_v2"
MOTIVATIONAL_TENSION_MICRO_V1 = "motivational_tension_micro_v1"
MOTIVATIONAL_TENSION_MICRO_V2 = "motivational_tension_micro_v2"
BF_EDITORIAL_INSET_V1 = "bf_editorial_inset_v1"
BF_EDITORIAL_INSET_V2 = "bf_editorial_inset_v2"
BF_EDITORIAL_INSET_STYLE = BF_EDITORIAL_INSET_V1
BF_VIRAL_MICRO_V1 = "bf_viral_micro_v1"
BF_GROWTH_V2 = "bf_growth_v2"
BF_REFERENCE_TAIL_V2 = "bf_reference_tail_v2"
BF_SMOOTH_TAIL_V3 = "bf_smooth_tail_v3"
BF_SMOOTH_TAIL_V4 = "bf_smooth_tail_v4"
BF_SMOOTH_TAIL_V5 = "bf_smooth_tail_v5"
BF_NATURAL_TAIL_V6 = "bf_natural_tail_v6"

# Descriptive aliases make call sites readable while keeping one canonical ID.
MOTIVATIONAL_TENSION_MICRO = MOTIVATIONAL_TENSION_MICRO_V1
BF_VIRAL_MICRO_FORMAT = BF_VIRAL_MICRO_V1

MOTIVATIONAL_MUSIC_REFLECTIVE = "reflective"
MOTIVATIONAL_MUSIC_DRIVING = "driving"
MOTIVATIONAL_MUSIC_WARM = "warm"

_MOTIVATIONAL_MUSIC_TERMS = {
    MOTIVATIONAL_MUSIC_REFLECTIVE: {
        "alone", "death", "fear", "future", "identity", "life", "meaning",
        "movie", "past", "present", "regret", "remember", "truth", "watching",
        "younger",
    },
    MOTIVATIONAL_MUSIC_DRIVING: {
        "ambition", "challenge", "confidence", "discipline", "focus", "goal",
        "greatness", "improve", "obsession", "push", "sacrifice", "success",
        "train", "win", "work",
    },
    MOTIVATIONAL_MUSIC_WARM: {
        "believe", "choose", "enough", "family", "freedom", "gratitude", "hope",
        "kindness", "love", "peace", "purpose", "relationship", "together",
    },
}


CONTENT_PROFILES: Dict[str, Dict] = {
    MOTIVATIONAL_PODCAST: {
        "preferred_min_seconds": 22.0,
        "preferred_max_seconds": 35.0,
        "strong_min_seconds": 18.0,
        "strong_max_seconds": 45.0,
        "hard_min_seconds": 14.0,
        "hard_max_seconds": 55.0,
        "layout_hint": "motivational_editorial",
        "caption_style": BUDGET_FRIENDLY_CAPTION_STYLE,
        "enhancement_model": "realesrgan-x4plus",
        "enhancement_scale": 4,
        "enhancement_reference_blend": 0.10,
        "background_music": True,
    },
}


SELECTION_PROFILES: Dict[str, Dict] = {
    MOTIVATIONAL_TENSION_MICRO_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "preferred_min_seconds": 10.0,
        "preferred_max_seconds": 18.0,
        "strong_min_seconds": 9.0,
        "strong_max_seconds": 20.0,
        "hard_min_seconds": 8.0,
        "hard_max_seconds": 22.0,
        "source_cut_limit": 2,
        "semantic_completion_source_cut_allowance": 1,
        "artificial_cut_limit": 0,
    },
    # Opt-in growth profile. Hook and semantic closure are deterministic;
    # production approval remains false until replay/acceptance gates pass.
    MOTIVATIONAL_TENSION_MICRO_V2: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "preferred_min_seconds": CLOSURE_PREFERRED_MIN_SECONDS,
        "preferred_max_seconds": CLOSURE_PREFERRED_MAX_SECONDS,
        "strong_min_seconds": CLOSURE_PREFERRED_MIN_SECONDS,
        "strong_max_seconds": CLOSURE_SOFT_MAX_SECONDS,
        "hard_min_seconds": CLOSURE_HARD_MIN_SECONDS,
        "hard_max_seconds": CLOSURE_HARD_MAX_SECONDS,
        "source_cut_limit": 2,
        "semantic_completion_source_cut_allowance": 1,
        "artificial_cut_limit": 0,
        "hook_gate_prompt_version": HOOK_GATE_PROMPT_VERSION,
        "hook_gate_decision_version": HOOK_GATE_DECISION_VERSION,
        "hook_signal_max_latency_seconds": HOOK_SIGNAL_MAX_LATENCY_SECONDS,
        "hook_signal_latency_tolerance_seconds": (
            HOOK_SIGNAL_LATENCY_TOLERANCE_SECONDS
        ),
        "hook_payoff_max_latency_seconds": HOOK_PAYOFF_MAX_LATENCY_SECONDS,
        "hook_opening_start_tolerance_seconds": (
            HOOK_OPENING_START_TOLERANCE_SECONDS
        ),
        "semantic_closure_decision_version": (
            SEMANTIC_CLOSURE_DECISION_VERSION
        ),
        "natural_tail_policy_version": NATURAL_TAIL_POLICY_VERSION,
        "closure_hard_min_seconds": CLOSURE_HARD_MIN_SECONDS,
        "closure_preferred_min_seconds": CLOSURE_PREFERRED_MIN_SECONDS,
        "closure_preferred_max_seconds": CLOSURE_PREFERRED_MAX_SECONDS,
        "closure_soft_max_seconds": CLOSURE_SOFT_MAX_SECONDS,
        "closure_hard_max_seconds": CLOSURE_HARD_MAX_SECONDS,
        "closure_strong_evidence_min_score": (
            CLOSURE_STRONG_EVIDENCE_MIN_SCORE
        ),
        "closure_word_end_tolerance_seconds": (
            CLOSURE_WORD_END_TOLERANCE_SECONDS
        ),
        "natural_tail_max_seconds": NATURAL_TAIL_MAX_SECONDS,
        "next_speech_safety_seconds": NEXT_SPEECH_SAFETY_SECONDS,
        "post_source_fade_seconds": POST_SOURCE_FADE_SECONDS,
        "production_approval": False,
    },
}


RENDER_PROFILES: Dict[str, Dict] = {
    # The legacy entry is metadata only; its renderer settings remain the
    # existing CONTENT_PROFILES values above.
    BUDGET_FRIENDLY_CAPTION_STYLE: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "local_only": False,
        "layout_hint": "motivational_editorial",
        "caption_style": BUDGET_FRIENDLY_CAPTION_STYLE,
        "style_version": BUDGET_FRIENDLY_CAPTION_STYLE,
    },
    BF_EDITORIAL_INSET_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "local_only": True,
        "layout_hint": "editorial_inset",
        "caption_style": BF_EDITORIAL_INSET_STYLE,
        "style_version": BF_EDITORIAL_INSET_V1,
        "layout_version": "editorial_inset_v1",
        "grade_version": "high_contrast_grayscale_v1",
        "type_plan_version": "kinetic_editorial_v1",
        # v5 never fades over the final word or the authentic post-speech
        # reaction.  It keeps every verified-clean source frame full strength,
        # then performs the short picture fade before the BF. card.  The new
        # policy ID prevents older v4 renders (whose fade could overlap the
        # final phoneme) from satisfying a production cache lookup.
        "brand_tail_version": BF_SMOOTH_TAIL_V5,
        "music_version": "licensed_low_bed_v1",
        "canvas_width": 1080,
        "canvas_height": 1920,
        "canvas_fps": 30,
        "inset_max_width_ratio": 0.9444,
        "inset_max_height_ratio": 0.36,
        "inset_vertical_anchor": 0.50,
        "inset_corner_radius_ratio": 0.18,
        "source_cut_limit": 2,
        "artificial_cut_limit": 0,
        "youtube_brand_tail_default_seconds": 0.85,
        "youtube_brand_tail_min_seconds": 0.80,
        "youtube_brand_tail_max_seconds": 0.90,
        "post_speech_reaction_max_seconds": 0.75,
        "post_source_settle_max_seconds": 0.08,
        "tail_crossfade_max_seconds": 0.13,
        "tail_audio_fade_max_seconds": 0.04,
        "render_duration_max_seconds": 24.5,
    },
    BF_EDITORIAL_INSET_V2: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "local_only": True,
        "layout_hint": "editorial_inset",
        "caption_style": BF_EDITORIAL_INSET_V2,
        "style_version": BF_EDITORIAL_INSET_V2,
        "layout_version": "editorial_inset_v1",
        "grade_version": "high_contrast_grayscale_v1",
        "type_plan_version": "kinetic_editorial_v1",
        # V6 consumes the sealed semantic endpoint and uses only authentic
        # source frames before a 130ms post-source fade. Synthetic settle
        # frames are forbidden.
        "brand_tail_version": BF_NATURAL_TAIL_V6,
        "music_version": "licensed_low_bed_v1",
        "canvas_width": 1080,
        "canvas_height": 1920,
        "canvas_fps": 30,
        "inset_max_width_ratio": 0.9444,
        "inset_max_height_ratio": 0.36,
        "inset_vertical_anchor": 0.50,
        "inset_corner_radius_ratio": 0.18,
        "source_cut_limit": 2,
        "artificial_cut_limit": 0,
        "youtube_brand_tail_default_seconds": 0.85,
        "youtube_brand_tail_min_seconds": 0.80,
        "youtube_brand_tail_max_seconds": 0.90,
        "post_speech_reaction_max_seconds": NATURAL_TAIL_MAX_SECONDS,
        "post_source_settle_max_seconds": 0.0,
        "tail_crossfade_max_seconds": POST_SOURCE_FADE_SECONDS,
        "tail_audio_fade_max_seconds": 0.04,
        "render_duration_max_seconds": 31.5,
    },
}


FORMAT_PROFILES: Dict[str, Dict] = {
    BF_VIRAL_MICRO_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": MOTIVATIONAL_TENSION_MICRO_V1,
        "render_profile": BF_EDITORIAL_INSET_V1,
        "local_only": True,
    },
    BF_GROWTH_V2: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": MOTIVATIONAL_TENSION_MICRO_V2,
        "render_profile": BF_EDITORIAL_INSET_V2,
        "local_only": True,
        "production_approval": False,
    },
}


def _profile_id(value: Optional[str]) -> Optional[str]:
    normalized = str(value or "").strip().lower()
    return None if normalized in {"", "auto", "none"} else normalized


def _require_known(profile_id: Optional[str], registry: Dict[str, Dict], label: str) -> None:
    if profile_id is not None and profile_id not in registry:
        choices = ", ".join(sorted(registry))
        raise ValueError(f"Unknown {label}: {profile_id!r}. Available: {choices}")


def resolve_profile_bundle(
    content_profile: Optional[str] = None,
    selection_profile: Optional[str] = None,
    render_profile: Optional[str] = None,
    format_profile: Optional[str] = None,
) -> Dict:
    """Resolve and validate an immutable set of versioned pipeline profiles.

    A combined format expands to its content, selection, and render profiles.
    Explicit component values may repeat the preset values but cannot override
    them, preventing a manifest from claiming one format while rendering
    another.
    """
    resolved = {
        "format_profile": _profile_id(format_profile),
        "content_profile": _profile_id(content_profile),
        "selection_profile": _profile_id(selection_profile),
        "render_profile": _profile_id(render_profile),
    }
    _require_known(resolved["format_profile"], FORMAT_PROFILES, "format_profile")
    _require_known(resolved["content_profile"], CONTENT_PROFILES, "content_profile")
    _require_known(resolved["selection_profile"], SELECTION_PROFILES, "selection_profile")
    _require_known(resolved["render_profile"], RENDER_PROFILES, "render_profile")

    format_id = resolved["format_profile"]
    if format_id:
        preset = FORMAT_PROFILES[format_id]
        for key in ("content_profile", "selection_profile", "render_profile"):
            explicit = resolved[key]
            expected = preset[key]
            if explicit is not None and explicit != expected:
                raise ValueError(
                    f"{format_id!r} requires {key}={expected!r}; got {explicit!r}"
                )
            resolved[key] = expected

    expected_content = None
    for key, registry in (
        ("selection_profile", SELECTION_PROFILES),
        ("render_profile", RENDER_PROFILES),
    ):
        profile_id = resolved[key]
        if not profile_id:
            continue
        profile_content = registry[profile_id].get("content_profile")
        if expected_content is not None and profile_content != expected_content:
            raise ValueError("Selection and render profiles target different content profiles")
        expected_content = profile_content
    if expected_content:
        if resolved["content_profile"] not in {None, expected_content}:
            raise ValueError(
                f"Selected profiles require content_profile={expected_content!r}; "
                f"got {resolved['content_profile']!r}"
            )
        resolved["content_profile"] = expected_content

    resolved["local_only"] = bool(
        (format_id and FORMAT_PROFILES[format_id].get("local_only"))
        or (
            resolved["render_profile"]
            and RENDER_PROFILES[resolved["render_profile"]].get("local_only")
        )
    )
    return resolved


def profile_manifest_metadata(resolved_profiles: Optional[Dict]) -> Dict:
    """Return stable, JSON-safe profile metadata for ranking/render manifests."""
    resolved = dict(resolved_profiles or {})
    render_id = resolved.get("render_profile")
    selection_id = resolved.get("selection_profile")
    versions: Dict[str, object] = {}
    if render_id in RENDER_PROFILES:
        render_contract = RENDER_PROFILES[render_id]
        versions.update(
            {
                key: render_contract[key]
                for key in (
                    "style_version",
                    "layout_version",
                    "grade_version",
                    "type_plan_version",
                    "brand_tail_version",
                    "music_version",
                )
                if key in render_contract
            }
        )
    if selection_id in SELECTION_PROFILES:
        versions["selection_version"] = selection_id
        selection_contract = SELECTION_PROFILES[selection_id]
        if selection_contract.get("hook_gate_prompt_version"):
            versions["hook_gate_prompt_version"] = selection_contract[
                "hook_gate_prompt_version"
            ]
        if selection_contract.get("hook_gate_decision_version"):
            versions["hook_gate_decision_version"] = selection_contract[
                "hook_gate_decision_version"
            ]
        if selection_contract.get("semantic_closure_decision_version"):
            versions["semantic_closure_decision_version"] = selection_contract[
                "semantic_closure_decision_version"
            ]
        if selection_contract.get("natural_tail_policy_version"):
            versions["natural_tail_policy_version"] = selection_contract[
                "natural_tail_policy_version"
            ]
    if resolved.get("format_profile"):
        versions["format_version"] = resolved["format_profile"]
    render_contract = RENDER_PROFILES.get(render_id, {})
    immutable_contract = {
        "format_profile": resolved.get("format_profile"),
        "selection_profile": selection_id,
        "render_profile": render_id,
        "layout_profile": render_contract.get("layout_version"),
        "grade_profile": render_contract.get("grade_version"),
        "caption_profile": render_contract.get("type_plan_version"),
        "brand_tail_profile": render_contract.get("brand_tail_version"),
        "artificial_cut_limit": render_contract.get("artificial_cut_limit"),
        "semantic_completion_source_cut_allowance": (
            SELECTION_PROFILES.get(selection_id, {}).get(
                "semantic_completion_source_cut_allowance"
            )
        ),
    }
    selection_contract = SELECTION_PROFILES.get(selection_id, {})
    if selection_contract.get("hook_gate_prompt_version"):
        immutable_contract["hook_gate"] = {
            "prompt_version": selection_contract["hook_gate_prompt_version"],
            "decision_version": selection_contract.get(
                "hook_gate_decision_version"
            ),
            "signal_max_latency_seconds": selection_contract.get(
                "hook_signal_max_latency_seconds"
            ),
            "payoff_max_latency_seconds": selection_contract.get(
                "hook_payoff_max_latency_seconds"
            ),
            "opening_start_tolerance_seconds": selection_contract.get(
                "hook_opening_start_tolerance_seconds"
            ),
            "production_approval": bool(
                selection_contract.get("production_approval", False)
            ),
        }
    if selection_contract.get("semantic_closure_decision_version"):
        immutable_contract["semantic_closure"] = {
            "decision_version": selection_contract[
                "semantic_closure_decision_version"
            ],
            "natural_tail_policy_version": selection_contract[
                "natural_tail_policy_version"
            ],
            "hard_min_seconds": selection_contract[
                "closure_hard_min_seconds"
            ],
            "preferred_min_seconds": selection_contract[
                "closure_preferred_min_seconds"
            ],
            "preferred_max_seconds": selection_contract[
                "closure_preferred_max_seconds"
            ],
            "soft_max_seconds": selection_contract[
                "closure_soft_max_seconds"
            ],
            "hard_max_seconds": selection_contract[
                "closure_hard_max_seconds"
            ],
            "strong_evidence_min_score": selection_contract[
                "closure_strong_evidence_min_score"
            ],
            "word_end_tolerance_seconds": selection_contract[
                "closure_word_end_tolerance_seconds"
            ],
            "natural_tail_max_seconds": selection_contract[
                "natural_tail_max_seconds"
            ],
            "next_speech_safety_seconds": selection_contract[
                "next_speech_safety_seconds"
            ],
            "post_source_fade_seconds": selection_contract[
                "post_source_fade_seconds"
            ],
            "production_approval": bool(
                selection_contract.get("production_approval", False)
            ),
        }
    if render_contract.get("brand_tail_version"):
        immutable_contract["tail_policy"] = {
            "brand_hold_default_seconds": render_contract.get(
                "youtube_brand_tail_default_seconds"
            ),
            "brand_hold_min_seconds": render_contract.get(
                "youtube_brand_tail_min_seconds"
            ),
            "brand_hold_max_seconds": render_contract.get(
                "youtube_brand_tail_max_seconds"
            ),
            "natural_reaction_max_seconds": render_contract.get(
                "post_speech_reaction_max_seconds"
            ),
            "safe_frame_settle_max_seconds": render_contract.get(
                "post_source_settle_max_seconds"
            ),
            "crossfade_max_seconds": render_contract.get(
                "tail_crossfade_max_seconds"
            ),
            "audio_fade_max_seconds": render_contract.get(
                "tail_audio_fade_max_seconds"
            ),
            "output_max_seconds": render_contract.get(
                "render_duration_max_seconds"
            ),
            "freeze_allowed": False,
        }
        if render_id == BF_EDITORIAL_INSET_V2:
            immutable_contract["tail_policy"].update(
                {
                    "semantic_closure_seal_required": True,
                    "authentic_source_tail_only": True,
                    "fade_starts_after_source_end": True,
                }
            )
    if render_contract.get("canvas_width") and render_contract.get("canvas_height"):
        immutable_contract["canvas"] = {
            "width": render_contract["canvas_width"],
            "height": render_contract["canvas_height"],
            "fps": render_contract.get("canvas_fps"),
        }
    contract_bytes = json.dumps(
        immutable_contract,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return {
        "format_profile": resolved.get("format_profile"),
        "content_profile": resolved.get("content_profile"),
        "selection_profile": selection_id,
        "render_profile": render_id,
        "local_only": bool(resolved.get("local_only", False)),
        "versions": versions,
        "contract": immutable_contract,
        "contract_sha256": hashlib.sha256(contract_bytes).hexdigest(),
    }


def selection_settings(selection_profile: Optional[str]) -> Dict:
    """Return a defensive copy of a versioned selection policy."""
    profile_id = _profile_id(selection_profile)
    _require_known(profile_id, SELECTION_PROFILES, "selection_profile")
    return deepcopy(SELECTION_PROFILES.get(profile_id, {}))


def is_motivational_profile(content_type: str) -> bool:
    return str(content_type or "").strip().lower() == MOTIVATIONAL_PODCAST


def motivational_music_profile_for_candidate(candidate: Dict) -> str:
    """Choose a restrained music bed from candidate semantics, without another LLM call."""
    text = " ".join(
        str(candidate.get(key) or "")
        for key in (
            "title",
            "topic",
            "hook_sentence",
            "final_takeaway_sentence",
            "thesis",
            "context_summary",
        )
    ).lower()
    tokens = set(re.findall(r"[a-z]+(?:'[a-z]+)?", text))
    scores = {
        profile: len(tokens & terms)
        for profile, terms in _MOTIVATIONAL_MUSIC_TERMS.items()
    }
    driving = scores[MOTIVATIONAL_MUSIC_DRIVING]
    reflective = scores[MOTIVATIONAL_MUSIC_REFLECTIVE]
    warm = scores[MOTIVATIONAL_MUSIC_WARM]
    if driving >= 2 and driving > max(reflective, warm):
        return MOTIVATIONAL_MUSIC_DRIVING
    if warm >= 2 and warm > max(reflective, driving):
        return MOTIVATIONAL_MUSIC_WARM
    return MOTIVATIONAL_MUSIC_REFLECTIVE


def render_settings_for_content(
    content_type: str,
    render_profile: Optional[str] = None,
    selection_profile: Optional[str] = None,
    format_profile: Optional[str] = None,
) -> Dict:
    """Return renderer metadata without mutating the selected candidate."""
    profile = CONTENT_PROFILES.get(str(content_type or "").strip().lower())
    if not profile:
        return {}
    render_id = _profile_id(render_profile) or BUDGET_FRIENDLY_CAPTION_STYLE
    _require_known(render_id, RENDER_PROFILES, "render_profile")
    render_contract = RENDER_PROFILES[render_id]
    if render_contract.get("content_profile") != MOTIVATIONAL_PODCAST:
        return {}
    settings = {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": _profile_id(selection_profile),
        "render_profile": render_id,
        "format_profile": _profile_id(format_profile),
        "layout_hint": render_contract.get("layout_hint", profile["layout_hint"]),
        "caption_style": render_contract.get("caption_style", profile["caption_style"]),
        "enhancement_model": profile["enhancement_model"],
        "enhancement_scale": profile["enhancement_scale"],
        "enhancement_reference_blend": profile["enhancement_reference_blend"],
        "background_music": profile["background_music"],
    }
    if render_id in {BF_EDITORIAL_INSET_V1, BF_EDITORIAL_INSET_V2}:
        settings.update(
            {
                "grade_profile": render_contract["grade_version"],
                "typography_profile": render_contract["type_plan_version"],
                "brand_tail_profile": render_contract["brand_tail_version"],
                "music_mix_profile": render_contract["music_version"],
                "artificial_cut_limit": render_contract["artificial_cut_limit"],
                "source_cut_limit": render_contract["source_cut_limit"],
            }
        )
    return settings
