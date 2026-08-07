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
from .hook_gate_v3 import (
    BF_FEED_STOP_POLICY_VERSION,
    HOOK_GATE_V3_DECISION_VERSION,
    HOOK_GATE_V3_PROMPT_VERSION,
)
from .hook_gate_v4 import (
    BF_FEED_STOP_V2_POLICY_VERSION,
    HOOK_GATE_V4_DECISION_VERSION,
    HOOK_GATE_V4_PROMPT_VERSION,
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
from .winner_packaging import (
    COMPACT_CAPTION_PROFILE,
    DENSE_DIALOGUE_AUDIO_PROFILE,
    FULL_BLEED_LAYOUT_PROFILE,
    LIVE_TAIL_PROFILE,
    WINNER_PACKAGING_DECISION_VERSION,
    WINNER_PACKAGING_PROFILE,
)


MOTIVATIONAL_PODCAST = "motivational_podcast"
BUDGET_FRIENDLY_CAPTION_STYLE = "budget_friendly_v2"
MOTIVATIONAL_TENSION_MICRO_V1 = "motivational_tension_micro_v1"
MOTIVATIONAL_TENSION_MICRO_V2 = "motivational_tension_micro_v2"
BF_FEED_STOP_V1 = BF_FEED_STOP_POLICY_VERSION
BF_FEED_STOP_V2 = BF_FEED_STOP_V2_POLICY_VERSION
BF_EDITORIAL_INSET_V1 = "bf_editorial_inset_v1"
BF_EDITORIAL_INSET_V2 = "bf_editorial_inset_v2"
BF_EDITORIAL_INSET_V3 = "bf_editorial_inset_v3"
BF_EDITORIAL_INSET_V4 = "bf_editorial_inset_v4"
BF_EDITORIAL_INSET_STYLE = BF_EDITORIAL_INSET_V1
BF_VIRAL_MICRO_V1 = "bf_viral_micro_v1"
BF_GROWTH_V2 = "bf_growth_v2"
BF_FEED_STOP_FORMAT_V1 = "bf_feed_stop_format_v1"
BF_FEED_STOP_FORMAT_V2 = "bf_feed_stop_format_v2"
BF_FEED_STOP_FORMAT_V3 = "bf_feed_stop_format_v3"
BF_FEED_STOP_FORMAT_V4 = "bf_feed_stop_format_v4"
BF_REFERENCE_TAIL_V2 = "bf_reference_tail_v2"
BF_SMOOTH_TAIL_V3 = "bf_smooth_tail_v3"
BF_SMOOTH_TAIL_V4 = "bf_smooth_tail_v4"
BF_SMOOTH_TAIL_V5 = "bf_smooth_tail_v5"
BF_NATURAL_TAIL_V6 = "bf_natural_tail_v6"
BF_WINNER_PACKAGING_V1 = WINNER_PACKAGING_PROFILE
BF_WINNER_LAYOUT_V1 = "bf_winner_layout_v1"
SPEECH_CLEANLINESS_DECISION_VERSION = "bf-speech-cleanliness-v1.0.0"
SPEECH_CLEANLINESS_FILLER_REJECT_COUNT = 2
SPEECH_CLEANLINESS_UNCOVERED_REVIEW_COUNT = 3
SPEECH_CLEANLINESS_INTERNAL_GAP_MIN_SECONDS = 0.24
SPEECH_CLEANLINESS_WORD_EDGE_GUARD_SECONDS = 0.04
SPEECH_CLEANLINESS_VAD_EVENT_MIN_SECONDS = 0.08
# Keep this literal mirror at the profile boundary: importing spoken_clarity
# here would cycle through artifact_contracts -> profiles during module init.
# Versioned-profile tests assert that the mirror remains exactly equal to the
# decision module's exported contract.
SPOKEN_CLARITY_DECISION_VERSION = "bf-spoken-clarity-v1.2.0"
SPOKEN_CLARITY_POLICY = {
    "openingWindowSeconds": 2.0,
    "openingSignalMaxWords": 8,
    "openingAnchorMaxWords": 12,
    "searchingPauseMinSeconds": 0.8,
    "asrLowConfidenceWordThreshold": 0.65,
    "asrReviewMeanThreshold": 0.78,
    "asrReviewLowRatioThreshold": 0.25,
    "asrRejectMeanThreshold": 0.65,
    "asrRejectLowRatioThreshold": 0.40,
    "asrTokenMatchAlgorithm": "token_levenshtein_max_length_v1",
    "asrTokenMatchReviewThreshold": 0.72,
    "hookClaimAlgorithm": "conservative_two_part_early_claim_v1",
    "asrTokenMatchRejectThreshold": None,
    "lowAsrTokenMatchDisposition": "review",
    "singleDisfluencyDisposition": "review",
    "repeatedDisfluencyDisposition": "reject",
    "singleSearchingPauseDisposition": "review",
    "repeatedSearchingPauseDisposition": "reject",
}
SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY = {
    "analyzerVersion": "bf-spoken-clarity-analyzer-v1.2.0",
    "openingClarityTranscriber": "faster-whisper-base-opening-clarity-v1",
    "model": "base",
    "localFilesOnly": True,
    "audioDecoder": "ffmpeg-f32le-v1",
}
# DeliveryQuality imports artifact_contracts, so keep the immutable profile
# mirror here to avoid the same profiles -> artifact_contracts import cycle as
# SpokenClarity. Versioned-profile tests compare this mirror with the decision
# module's exported policy.
DELIVERY_QUALITY_DECISION_VERSION = "bf-delivery-quality-v1.0.0"
DELIVERY_QUALITY_POLICY = {
    "decisionVersion": DELIVERY_QUALITY_DECISION_VERSION,
    "spokenClarityDecisionVersion": SPOKEN_CLARITY_DECISION_VERSION,
    "pauseMinimumSeconds": 0.25,
    "longPauseMinimumSeconds": 0.80,
    "idealWordsPerMinute": [120.0, 195.0],
    "moderateWordsPerMinute": [90.0, 235.0],
    "severeWordsPerMinute": [60.0, 285.0],
    "moderateInternalPauseRatio": 0.28,
    "severeInternalPauseRatio": 0.45,
    "moderateRmsDynamicRangeDb": 2.0,
    "severeRmsDynamicRangeDb": 1.0,
    "moderateActiveFrameRatio": 0.25,
    "severeActiveFrameRatio": 0.12,
    "moderateOverallRmsDbfs": -44.0,
    "severeOverallRmsDbfs": -52.0,
    "borderlineStrengthMaximum": 65.0,
    "veryLowStrengthMaximum": 50.0,
    "veryLowMinimumCorroboratingCategories": 2,
    "calmDeliverySingleLowDynamicsDisposition": "pass",
    "affectInferenceAllowed": False,
}
DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY = {
    "analyzerVersion": "bf-delivery-quality-analyzer-v1.0.0",
    "decisionVersion": DELIVERY_QUALITY_DECISION_VERSION,
    "acousticProvider": "ffmpeg-f32le-mono16k-rms-dynamics-v1",
    "audioDecoder": "ffmpeg-f32le-v1",
    "sampleRate": 16000,
    "rmsWindowMilliseconds": 50.0,
    "audioPolicy": "read_only_source_contiguous_selection",
    "affectInferenceUsed": False,
}

# Descriptive aliases make call sites readable while keeping one canonical ID.
MOTIVATIONAL_TENSION_MICRO = MOTIVATIONAL_TENSION_MICRO_V1
BF_VIRAL_MICRO_FORMAT = BF_VIRAL_MICRO_V1

MOTIVATIONAL_MUSIC_REFLECTIVE = "reflective"
MOTIVATIONAL_MUSIC_DRIVING = "driving"
MOTIVATIONAL_MUSIC_WARM = "warm"
DYNAMIC_MUSIC_VERSION = "bf_dynamic_music_v1.0.0"
VIRAL_MUSIC_CATALOG_VERSION = "bf_viral_music_catalog_v1.0.0"
VIRAL_MUSIC_CATALOG_CONTENT_HASH = (
    "1da9ba63494e686aa3f55d3e0edd1175e233a480fd57171f6b770ef280cbf05c"
)
SEMANTIC_MUSIC_ROUTER_VERSION = "bf_semantic_music_router_v1.0.0"
MUSIC_ROTATION_VERSION = "bf_music_rotation_v1.0.0"

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
    # Opt-in HookGate V3 policy. Rendering remains independently frozen to
    # bf_editorial_inset_v2 by the caller/profile bundle.
    BF_FEED_STOP_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        # Operational routing only. This field is intentionally excluded from
        # the immutable profile contract so the sealed V1 metadata is stable.
        "local_only": True,
        "preferred_min_seconds": 12.0,
        "preferred_max_seconds": 17.0,
        "strong_min_seconds": 12.0,
        "strong_max_seconds": 21.0,
        "hard_min_seconds": 8.0,
        "hard_max_seconds": 24.0,
        "explicit_review_min_seconds": 21.0,
        "source_cut_limit": 2,
        "semantic_completion_source_cut_allowance": 1,
        "artificial_cut_limit": 0,
        "hook_gate_prompt_version": HOOK_GATE_V3_PROMPT_VERSION,
        "hook_gate_decision_version": HOOK_GATE_V3_DECISION_VERSION,
        "hook_gate_minimum_score": 80.0,
        "hook_context_dependence_max": 15.0,
        "hook_abstraction_max": 35.0,
        "hook_signal_max_latency_seconds": 2.0,
        "hook_payoff_max_latency_seconds": 6.0,
        "hook_opening_start_tolerance_seconds": 0.10,
        "semantic_closure_decision_version": (
            SEMANTIC_CLOSURE_DECISION_VERSION
        ),
        # Source-audio evidence is required before feed-stop candidates may
        # reach visual analysis or approval.  These thresholds describe the
        # immutable v1 detector contract; an uncertain provider result never
        # defaults to pass.
        "speech_cleanliness_decision_version": (
            SPEECH_CLEANLINESS_DECISION_VERSION
        ),
        "speech_cleanliness_filler_reject_count": (
            SPEECH_CLEANLINESS_FILLER_REJECT_COUNT
        ),
        "speech_cleanliness_uncovered_review_count": (
            SPEECH_CLEANLINESS_UNCOVERED_REVIEW_COUNT
        ),
        "speech_cleanliness_internal_gap_min_seconds": (
            SPEECH_CLEANLINESS_INTERNAL_GAP_MIN_SECONDS
        ),
        "speech_cleanliness_word_edge_guard_seconds": (
            SPEECH_CLEANLINESS_WORD_EDGE_GUARD_SECONDS
        ),
        "speech_cleanliness_vad_event_min_seconds": (
            SPEECH_CLEANLINESS_VAD_EVENT_MIN_SECONDS
        ),
        "natural_tail_policy_version": NATURAL_TAIL_POLICY_VERSION,
        "closure_hard_min_seconds": 8.0,
        "closure_preferred_min_seconds": 12.0,
        "closure_preferred_max_seconds": 17.0,
        "closure_soft_max_seconds": 21.0,
        "closure_hard_max_seconds": 24.0,
        "closure_strong_evidence_min_score": (
            CLOSURE_STRONG_EVIDENCE_MIN_SCORE
        ),
        "closure_word_end_tolerance_seconds": (
            CLOSURE_WORD_END_TOLERANCE_SECONDS
        ),
        "natural_tail_min_seconds": 0.35,
        "natural_tail_max_seconds": 0.55,
        "next_speech_safety_seconds": NEXT_SPEECH_SAFETY_SECONDS,
        "post_source_fade_seconds": POST_SOURCE_FADE_SECONDS,
        "production_approval": False,
    },
}

# HookGate V4 is a forward-only selection contract.  It deliberately inherits
# the proven duration, semantic-closure, tail and source-audio boundaries from
# V1, while replacing only the hook decision with whole-sentence/whole-point
# semantic evidence.  Keeping a distinct ID preserves every sealed V1 replay.
SELECTION_PROFILES[BF_FEED_STOP_V2] = {
    **deepcopy(SELECTION_PROFILES[BF_FEED_STOP_V1]),
    "hook_gate_prompt_version": HOOK_GATE_V4_PROMPT_VERSION,
    "hook_gate_decision_version": HOOK_GATE_V4_DECISION_VERSION,
    "hook_gate_minimum_score": 78.0,
    "minimum_score": 78.0,
    "first_word_max_latency_ms": 100.0,
    "hook_opening_start_tolerance_seconds": 0.10,
    "opening_unit_preferred_max_seconds": 3.50,
    "opening_unit_hard_max_seconds": 5.00,
    "topic_comprehension_max_seconds": 3.50,
    "opening_sentence_clarity_min": 70.0,
    "topic_explicitness_min": 65.0,
    "standalone_comprehension_min": 70.0,
    "tension_or_relevance_min": 65.0,
    "opening_point_coherence_min": 72.0,
    "payoff_resolution_min": 70.0,
    "single_idea_focus_min": 75.0,
    "lexical_delivery_strength_min": 55.0,
    "lexical_delivery_review_min": 65.0,
    "semantic_confidence_min": 75.0,
    "generic_motivation_max": 35.0,
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
    # Opt-in packaging treatment. It shares the sealed semantic selection
    # contract with growth-v2 but owns every visual/audio component ID so
    # legacy render caches and defaults remain untouched.
    BF_WINNER_PACKAGING_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "local_only": True,
        "layout_hint": FULL_BLEED_LAYOUT_PROFILE,
        "caption_style": COMPACT_CAPTION_PROFILE,
        "style_version": BF_WINNER_PACKAGING_V1,
        "packaging_decision_version": WINNER_PACKAGING_DECISION_VERSION,
        "layout_version": FULL_BLEED_LAYOUT_PROFILE,
        "grade_version": "source_authentic_grade_v1",
        "type_plan_version": COMPACT_CAPTION_PROFILE,
        "brand_tail_version": LIVE_TAIL_PROFILE,
        "music_version": DENSE_DIALOGUE_AUDIO_PROFILE,
        "canvas_width": 1080,
        "canvas_height": 1920,
        "canvas_fps": 30,
        "source_cut_limit": 2,
        "artificial_cut_limit": 0,
        "youtube_brand_tail_default_seconds": 0.0,
        "youtube_brand_tail_min_seconds": 0.0,
        "youtube_brand_tail_max_seconds": 0.0,
        "post_speech_reaction_min_seconds": 0.80,
        "post_speech_reaction_max_seconds": 1.10,
        "post_source_settle_max_seconds": 0.0,
        "tail_crossfade_max_seconds": 0.16,
        "tail_audio_fade_max_seconds": 0.04,
        "render_duration_max_seconds": 31.5,
        "opening_source_authentic": True,
        "first_speech_max_seconds": 0.10,
        "full_bleed_opening_min_seconds": 1.50,
        "face_height_min_ratio": 0.35,
        "face_height_max_ratio": 0.60,
        "production_approval": False,
    },
    # First rollout isolates layout only. Captions, ending, grade, and audio
    # remain the growth-v2 control components.
    BF_WINNER_LAYOUT_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "local_only": True,
        "layout_hint": FULL_BLEED_LAYOUT_PROFILE,
        "caption_style": BF_EDITORIAL_INSET_V2,
        "style_version": BF_WINNER_LAYOUT_V1,
        "packaging_decision_version": WINNER_PACKAGING_DECISION_VERSION,
        "layout_version": FULL_BLEED_LAYOUT_PROFILE,
        "grade_version": "high_contrast_grayscale_v1",
        "type_plan_version": "kinetic_editorial_v1",
        "brand_tail_version": BF_NATURAL_TAIL_V6,
        "music_version": "licensed_low_bed_v1",
        "canvas_width": 1080,
        "canvas_height": 1920,
        "canvas_fps": 30,
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
        "production_approval": False,
    },
}

# The V3 renderer changes only the music-treatment contract.  Layout, grade,
# captions and the natural-tail behavior remain byte-for-byte inherited from
# the proven editorial V2 renderer.
RENDER_PROFILES[BF_EDITORIAL_INSET_V3] = {
    **deepcopy(RENDER_PROFILES[BF_EDITORIAL_INSET_V2]),
    "caption_style": BF_EDITORIAL_INSET_V2,
    "style_version": BF_EDITORIAL_INSET_V3,
    "music_version": DYNAMIC_MUSIC_VERSION,
}

# V4 changes only how the licensed music asset and its start offset are
# selected.  The proven visual, caption, grade, natural-tail and deterministic
# dynamic-envelope contracts remain inherited from V3.
RENDER_PROFILES[BF_EDITORIAL_INSET_V4] = {
    **deepcopy(RENDER_PROFILES[BF_EDITORIAL_INSET_V3]),
    "style_version": BF_EDITORIAL_INSET_V4,
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
    BF_FEED_STOP_FORMAT_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": BF_FEED_STOP_V1,
        "render_profile": BF_EDITORIAL_INSET_V2,
        "local_only": True,
        "production_approval": False,
        "rendering_frozen": True,
    },
    BF_FEED_STOP_FORMAT_V2: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": BF_FEED_STOP_V1,
        "render_profile": BF_EDITORIAL_INSET_V2,
        "local_only": True,
        "production_approval": False,
        "rendering_frozen": True,
        # SpokenClarity is a format-layer migration. Keeping it here leaves
        # BF_FEED_STOP_V1 and BF_FEED_STOP_FORMAT_V1 byte-for-byte verifiable.
        "spoken_clarity_decision_version": SPOKEN_CLARITY_DECISION_VERSION,
        "spoken_clarity_policy": deepcopy(SPOKEN_CLARITY_POLICY),
        "spoken_clarity_provider_identity": deepcopy(
            SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY
        ),
    },
    BF_FEED_STOP_FORMAT_V3: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": BF_FEED_STOP_V2,
        "render_profile": BF_EDITORIAL_INSET_V3,
        "local_only": True,
        "production_approval": False,
        "rendering_frozen": True,
        # V4 owns semantic meaning.  The existing sealed SpokenClarity report
        # remains authoritative only for audibility, ASR agreement, stutters,
        # false starts and searching pauses.
        "spoken_clarity_decision_version": SPOKEN_CLARITY_DECISION_VERSION,
        "spoken_clarity_policy": deepcopy(SPOKEN_CLARITY_POLICY),
        "spoken_clarity_provider_identity": deepcopy(
            SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY
        ),
        "spoken_clarity_semantic_authority": "hook_gate_v4",
        "delivery_quality_decision_version": (
            DELIVERY_QUALITY_DECISION_VERSION
        ),
        "delivery_quality_policy": deepcopy(DELIVERY_QUALITY_POLICY),
        "delivery_quality_provider_identity": deepcopy(
            DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY
        ),
        "dynamic_music_version": DYNAMIC_MUSIC_VERSION,
    },
    BF_FEED_STOP_FORMAT_V4: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": BF_FEED_STOP_V2,
        "render_profile": BF_EDITORIAL_INSET_V4,
        "local_only": True,
        "production_approval": False,
        "rendering_frozen": True,
        "spoken_clarity_decision_version": SPOKEN_CLARITY_DECISION_VERSION,
        "spoken_clarity_policy": deepcopy(SPOKEN_CLARITY_POLICY),
        "spoken_clarity_provider_identity": deepcopy(
            SPOKEN_CLARITY_TRUSTED_PROVIDER_IDENTITY
        ),
        "spoken_clarity_semantic_authority": "hook_gate_v4",
        "delivery_quality_decision_version": DELIVERY_QUALITY_DECISION_VERSION,
        "delivery_quality_policy": deepcopy(DELIVERY_QUALITY_POLICY),
        "delivery_quality_provider_identity": deepcopy(
            DELIVERY_QUALITY_TRUSTED_PROVIDER_IDENTITY
        ),
        "dynamic_music_version": DYNAMIC_MUSIC_VERSION,
        "music_catalog_version": VIRAL_MUSIC_CATALOG_VERSION,
        "music_catalog_content_hash": VIRAL_MUSIC_CATALOG_CONTENT_HASH,
        "music_router_version": SEMANTIC_MUSIC_ROUTER_VERSION,
        "music_rotation_version": MUSIC_ROTATION_VERSION,
        "music_rotation_window_size": 5,
        "music_rotation_lookback": 4,
    },
    BF_WINNER_PACKAGING_V1: {
        "content_profile": MOTIVATIONAL_PODCAST,
        "selection_profile": MOTIVATIONAL_TENSION_MICRO_V2,
        "render_profile": BF_WINNER_PACKAGING_V1,
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
            resolved["selection_profile"]
            and SELECTION_PROFILES[resolved["selection_profile"]].get(
                "local_only"
            )
        )
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
    format_id = resolved.get("format_profile")
    versions: Dict[str, object] = {}
    if render_id in RENDER_PROFILES:
        render_contract = RENDER_PROFILES[render_id]
        versions.update(
            {
                key: render_contract[key]
                for key in (
                    "style_version",
                    "packaging_decision_version",
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
        if selection_contract.get("speech_cleanliness_decision_version"):
            versions["speech_cleanliness_decision_version"] = selection_contract[
                "speech_cleanliness_decision_version"
            ]
        if selection_contract.get("natural_tail_policy_version"):
            versions["natural_tail_policy_version"] = selection_contract[
                "natural_tail_policy_version"
            ]
    format_contract = FORMAT_PROFILES.get(format_id, {})
    if format_id:
        versions["format_version"] = format_id
    if format_contract.get("spoken_clarity_decision_version"):
        versions["spoken_clarity_decision_version"] = format_contract[
            "spoken_clarity_decision_version"
        ]
    if format_contract.get("dynamic_music_version"):
        versions["dynamic_music_version"] = format_contract[
            "dynamic_music_version"
        ]
    for version_key in (
        "music_catalog_version",
        "music_catalog_content_hash",
        "music_router_version",
        "music_rotation_version",
    ):
        if format_contract.get(version_key):
            versions[version_key] = format_contract[version_key]
    if format_contract.get("delivery_quality_decision_version"):
        versions["delivery_quality_decision_version"] = format_contract[
            "delivery_quality_decision_version"
        ]
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
        optional_hook_contract = {
            "minimum_score": selection_contract.get(
                "hook_gate_minimum_score"
            ),
            "maximum_context_dependence": selection_contract.get(
                "hook_context_dependence_max"
            ),
            "maximum_abstraction_score": selection_contract.get(
                "hook_abstraction_max"
            ),
        }
        immutable_contract["hook_gate"].update(
            {
                key: value
                for key, value in optional_hook_contract.items()
                if value is not None
            }
        )
        semantic_hook_contract = {
            "first_word_max_latency_ms": selection_contract.get(
                "first_word_max_latency_ms"
            ),
            "opening_unit_preferred_max_seconds": selection_contract.get(
                "opening_unit_preferred_max_seconds"
            ),
            "opening_unit_hard_max_seconds": selection_contract.get(
                "opening_unit_hard_max_seconds"
            ),
            "topic_comprehension_max_seconds": selection_contract.get(
                "topic_comprehension_max_seconds"
            ),
            "opening_sentence_clarity_min": selection_contract.get(
                "opening_sentence_clarity_min"
            ),
            "topic_explicitness_min": selection_contract.get(
                "topic_explicitness_min"
            ),
            "standalone_comprehension_min": selection_contract.get(
                "standalone_comprehension_min"
            ),
            "tension_or_relevance_min": selection_contract.get(
                "tension_or_relevance_min"
            ),
            "opening_point_coherence_min": selection_contract.get(
                "opening_point_coherence_min"
            ),
            "payoff_resolution_min": selection_contract.get(
                "payoff_resolution_min"
            ),
            "single_idea_focus_min": selection_contract.get(
                "single_idea_focus_min"
            ),
            "lexical_delivery_strength_min": selection_contract.get(
                "lexical_delivery_strength_min"
            ),
            "lexical_delivery_review_min": selection_contract.get(
                "lexical_delivery_review_min"
            ),
            "semantic_confidence_min": selection_contract.get(
                "semantic_confidence_min"
            ),
            "generic_motivation_max": selection_contract.get(
                "generic_motivation_max"
            ),
        }
        immutable_contract["hook_gate"].update(
            {
                key: value
                for key, value in semantic_hook_contract.items()
                if value is not None
            }
        )
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
    if selection_contract.get("speech_cleanliness_decision_version"):
        immutable_contract["speech_cleanliness"] = {
            "decision_version": selection_contract[
                "speech_cleanliness_decision_version"
            ],
            "filler_reject_count": selection_contract[
                "speech_cleanliness_filler_reject_count"
            ],
            "uncovered_review_count": selection_contract[
                "speech_cleanliness_uncovered_review_count"
            ],
            "internal_gap_min_seconds": selection_contract[
                "speech_cleanliness_internal_gap_min_seconds"
            ],
            "word_edge_guard_seconds": selection_contract[
                "speech_cleanliness_word_edge_guard_seconds"
            ],
            "vad_event_min_seconds": selection_contract[
                "speech_cleanliness_vad_event_min_seconds"
            ],
            "fail_closed": True,
            "production_approval": bool(
                selection_contract.get("production_approval", False)
            ),
        }
    if format_contract.get("spoken_clarity_decision_version"):
        immutable_contract["spoken_clarity"] = {
            "decision_version": format_contract[
                "spoken_clarity_decision_version"
            ],
            "policy": deepcopy(format_contract["spoken_clarity_policy"]),
            "provider_identity": deepcopy(
                format_contract["spoken_clarity_provider_identity"]
            ),
            "fail_closed": True,
            "production_approval": bool(
                format_contract.get("production_approval", False)
            ),
        }
        if format_contract.get("spoken_clarity_semantic_authority"):
            immutable_contract["spoken_clarity"]["semantic_authority"] = (
                format_contract["spoken_clarity_semantic_authority"]
            )
    if format_contract.get("delivery_quality_decision_version"):
        immutable_contract["delivery_quality"] = {
            "decision_version": format_contract[
                "delivery_quality_decision_version"
            ],
            "policy": deepcopy(format_contract["delivery_quality_policy"]),
            "provider_identity": deepcopy(
                format_contract["delivery_quality_provider_identity"]
            ),
            "source_audio_modified": False,
            "affect_inference_allowed": False,
            "fail_closed": True,
            "production_approval": bool(
                format_contract.get("production_approval", False)
            ),
        }
    if format_contract.get("dynamic_music_version"):
        immutable_contract["dynamic_music"] = {
            "decision_version": format_contract["dynamic_music_version"],
            "semantic_events": [
                "hook_end",
                "payoff_start",
                "payoff_end",
                "speech_end",
            ],
            "randomized_effects": False,
            "speech_sidechain_required": True,
            "production_approval": bool(
                format_contract.get("production_approval", False)
            ),
        }
    if format_contract.get("music_router_version"):
        immutable_contract["music_selection"] = {
            "catalog_version": format_contract["music_catalog_version"],
            "catalog_content_hash": format_contract[
                "music_catalog_content_hash"
            ],
            "router_version": format_contract["music_router_version"],
            "rotation_version": format_contract["music_rotation_version"],
            "rotation_window_size": format_contract[
                "music_rotation_window_size"
            ],
            "rotation_lookback": format_contract["music_rotation_lookback"],
            "semantic_scope": "complete_selected_point_and_payoff",
            "first_word_heuristic_allowed": False,
            "hidden_mutable_history_allowed": False,
            "catalog_asset_hash_required": True,
            "production_approval": bool(
                format_contract.get("production_approval", False)
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
        if render_id in {
            BF_EDITORIAL_INSET_V2,
            BF_EDITORIAL_INSET_V3,
            BF_EDITORIAL_INSET_V4,
            BF_WINNER_LAYOUT_V1,
            BF_WINNER_PACKAGING_V1,
        }:
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
            "hook_semantic_topic",
            "opening_claim_summary",
            "whole_point_summary",
            "opening_unit_exact_quote",
            "payoff_exact_quote",
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
    if render_id in {
        BF_EDITORIAL_INSET_V1,
        BF_EDITORIAL_INSET_V2,
        BF_EDITORIAL_INSET_V3,
        BF_EDITORIAL_INSET_V4,
        BF_WINNER_LAYOUT_V1,
        BF_WINNER_PACKAGING_V1,
    }:
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
