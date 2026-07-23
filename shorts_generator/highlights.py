"""Find the most viral-worthy highlights in a transcript.

Logic ported from ViralVadoo's transcript_analysis/highlight_generator.py:
  - content-type / density detection
  - chunking for long videos with overlap
  - virality-criteria prompt
  - score-based dedupe with overlap suppression

The LLM call is pluggable via the `llm_fn` argument so the same prompts can
drive either MuAPI (default, --mode api) or a direct local LLM client
(--mode local).
"""
import hashlib
import json
import os
import re
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import profiles as _profiles
from .hook_gate import (
    HOOK_GATE_PROMPT_VERSION,
    HOOK_GATE_V2_PROMPT,
    HOOK_GATE_V2_RESPONSE_CONTRACT,
    evaluate_hook_gate_v2,
    normalize_hook_gate_v2_fields,
)
from .motivational_closure import (
    SEMANTIC_CLOSURE_DECISION_VERSION,
    evaluate_motivational_closure_v1,
)
from .profiles import MOTIVATIONAL_PODCAST


LLMFn = Callable[[str], str]
MOTIVATIONAL_TENSION_MICRO_V1 = getattr(
    _profiles,
    "MOTIVATIONAL_TENSION_MICRO_V1",
    "motivational_tension_micro_v1",
)
MOTIVATIONAL_TENSION_MICRO_V2 = getattr(
    _profiles,
    "MOTIVATIONAL_TENSION_MICRO_V2",
    "motivational_tension_micro_v2",
)
MICRO_SELECTION_PROFILES = frozenset(
    {MOTIVATIONAL_TENSION_MICRO_V1, MOTIVATIONAL_TENSION_MICRO_V2}
)


CONTENT_TYPE_PROMPT = """Analyze this video transcript sample and classify the content type.
Choose one: motivational_podcast, podcast, interview, tutorial, lecture, commentary, debate, vlog, gaming, sports, other.
Use motivational_podcast only for a podcast/interview dominated by standalone ideas about discipline, work, money, responsibility, risk, identity, failure, or practical self-improvement. Do not use it for a podcast merely because one sentence sounds inspirational.
Also estimate content density: low (mostly filler/chit-chat), medium, or high (dense info/stories).
Respond with JSON only: {"content_type": "...", "density": "..."}"""


VIRALITY_CRITERIA = """
Virality signals to prioritize (ranked by impact):
1. HOOK MOMENTS — statements that create immediate curiosity ("The secret is...", "Nobody talks about...", "I was completely wrong about...")
2. EMOTIONAL PEAKS — genuine surprise, laughter, anger, vulnerability, excitement; raw unscripted reactions
3. OPINION BOMBS — strong, polarizing or counter-intuitive statements that trigger agree/disagree
4. REVELATION MOMENTS — surprising facts, stats, or confessions that reframe how the viewer thinks
5. CONFLICT/TENSION — disagreement, pushback, or a problem being confronted head-on
6. QUOTABLE ONE-LINERS — a sentence that works as a standalone quote card
7. STORY PEAKS — the climax or twist of an anecdote; the payoff moment
8. PRACTICAL VALUE — a concrete tip, hack, or insight the viewer can immediately apply
"""

CONTENT_TYPE_GUIDANCE = {
    MOTIVATIONAL_PODCAST: """Motivational podcast rules:
- Build one complete conceptual micro-story: HOOK -> DEVELOPMENT -> TAKEAWAY.
- The hook must be a headline-quality claim, contradiction, identity tension, practical promise, or high-stakes statement whose payoff is understandable within 1.5-2.5 seconds.
- Return hook_payoff_phrase as the exact 3-12 spoken words containing the earliest complete tension, command, contradiction, identity threat, or practical promise.
- Never open on so, but, and, coming back to, as I said, a host question, or a speaker/book attribution. These are context, not hooks.
- Reject callbacks such as "the fuel thing", "this", or "that" when their antecedent is outside the interval.
- Development must add one reason, contrast, example, mechanism, consequence, or compact framework. Repeating the hook is not development.
- Return earliest_complete_takeaway_sentence as the exact first sentence that resolves the idea with a reframe, command, answer, formula, or memorable source-supported claim.
- A grammatical sentence ending is not necessarily a semantic ending. If the next sentence immediately answers the closing question, completes its consequence, repairs/rephrases the same line, or refers back to its subject to finish the payoff, include that required continuation. If the complete point cannot fit the hard duration, reject or re-cut it from a later self-contained hook; never stop early merely to fit.
- Stop before repetition, a tangent, disclaimer, or second topic. Set second_topic_begins_after_takeaway conservatively.
- Set contains_attribution_lead_in and contains_context_callback conservatively. Candidates with either problem are not eligible.
- Prefer one contiguous source interval. Never invent, paraphrase, or reorder spoken content.
- Reject host questions, greetings, agreement filler, sponsor reads, CTAs, inside jokes, and references that require earlier context.
- Preferred duration is 22-35 seconds. Allow 18-45 seconds for an unusually strong complete idea; never exceed 55 seconds. A 14-18 second clip must be an exceptional complete standalone aphorism.
- Static podcast footage is acceptable. Judge meaning before visual activity.
- Identify the exact hook_sentence, hook_payoff_phrase, final_takeaway_sentence, and earliest_complete_takeaway_sentence.
- Set has_hook, has_development, has_takeaway, and has_complete_ending conservatively. A missing arc beat must score below 60.
- Provide three truthful title_options that match the spoken thesis without clickbait.""",
    "gaming": """Gaming-specific rules:
- Prefer a complete micro-story: immediate threat or challenge, escalation, decisive move, and visible outcome or authentic reaction.
- Treat challenge -> escalation -> result as the required gaming narrative unit. Do not return a clip that contains only one or two of these beats.
- The opening context must answer four questions when the source provides them: what mode/activity is being played, why it matters (reward or challenge), which rule/limitation applies, and what the immediate objective is.
- Establish this premise before the action. A limitation such as "pistol only" or an objective such as "survive 10 waves" is not sufficient by itself when the viewer still cannot identify the mode or the reason for attempting it.
- A reaction alone is not context. Prefer short source-supported premise beats over invented narration or a vague title overlay.
- context_summary must be a source-supported, non-spoiler label of at most 6 words, such as "LEVEL 1 - PISTOL ONLY" or "WAVE 9 - LAST PLAYER".
- Set has_clear_setup only when a new viewer can identify the activity, rules, and objective without outside knowledge. Set has_escalation only when the pressure, difficulty, progress, or consequences materially increase after the challenge is established. Set has_visible_cause and has_complete_outcome only when those beats are actually present inside the returned interval.
- micro_story_score measures the complete challenge -> escalation -> result arc. Score below 60 when any beat is weak, repetitive, inferred, or missing.
- narrative_coherence_score measures whether a new viewer can follow setup -> escalation -> outcome without guessing what happened between frames.
- Preferred duration is 25-60 seconds; never exceed 75 seconds.
- Reject menus, loading screens, lobbies, inventories, settings, routine driving, uneventful looting, and upgrade screens unless a decision made there has an immediate payoff in the same clip.
- Never select a loud reaction without including the visible cause, and never select setup without the clutch, failure, escape, win, or other outcome.
- Treat chase reversals, near failures, unexpected NPC behavior, mission chaos, combat clutches, stunts, and funny cause-and-effect chains as strong candidates.
- visual_action_score must describe the actual gameplay, not only an animated facecam or excited narration.""",
    "sports": """Sports-specific rules:
- Prefer one complete play from setup through outcome, not isolated celebration or commentary without the play.
- Reject static studio, betting, sponsor, lineup, and scoreboard-only sections when live action is available.""",
}


MOTIVATIONAL_TENSION_MICRO_GUIDANCE = """Motivational tension micro selection rules:
- Select one source-contiguous, self-contained micro-arc: TENSION -> CONTRAST/REFRAME -> LISTENER PAYOFF.
- The spoken interval must be 8-22 seconds. Prefer 10-18 seconds, with extra weight for an exceptionally tight 9-13 second idea; do not stretch a weak thought to fill time.
- Prefer a precise human tension, identity conflict, contradiction, reversal, boundary, uncomfortable distinction, or counter-intuitive truth over generic inspiration.
- A strong candidate makes the contrast legible without prior context, such as NICE vs GOOD, COMFORT vs GROWTH, APPROVAL vs INTEGRITY, or what people expect vs what is actually true.
- Generic motivation such as "believe in yourself", "never give up", "work hard", or "keep going" is ineligible unless the same interval contains a specific conflict, reversal, mechanism, or surprising payoff.
- Reject pronoun-dependent callbacks, host setup, attribution, throat-clearing, open loops, fragments, repeated versions of the same point, and any clip whose meaning depends on earlier dialogue.
- The final line must resolve the opening tension. Do not end on setup, a question, a connector, or a promised explanation.
- Do not confuse a full stop with semantic closure. Include an immediately following answer, consequence, self-correction/rephrase, or referential sentence when it is needed to finish the same point. If that continuation breaks the 22-second limit, skip or re-cut the candidate instead of truncating its meaning.
- Prefer an authentic reaction tail when the source contains one immediately after the payoff: a silent look, nod, smile, laugh, breath, or listener reaction that can close the edit. Never invent a reaction or extend into a new topic.
- reaction_tail_start_time must be the source timestamp where that authentic reaction begins, or null when there is no supported reaction.
- Score semantic_tension_score, contrast_score, conflict_score, reversal_score, listener_payoff_score, self_contained_micro_arc_score, generic_motivation_score, context_dependence_score, and reaction_tail_compatibility_score from 0-100 conservatively.
- Set the boolean semantic and reaction fields conservatively. Explain the specific tension in tension_kind, the two sides in contrast_pair, the resolved value in listener_payoff, and reaction evidence in reaction_tail_reason.
- Never invent, paraphrase, reorder, or stitch spoken content."""

MOTIVATIONAL_TENSION_MICRO_V2_CLOSURE_GUIDANCE = """
Growth V2 semantic-closure rules:
- Prefer 15-21 seconds of complete speech.
- A complete point may run 22-25 seconds with a soft duration penalty.
- A 25-30 second point is eligible only when the hook, payoff, self-contained arc, and closure are all exceptionally strong.
- Never return more than 30 seconds of speech.
- Semantic completion overrides the preferred duration: include an immediately required answer, consequence, self-correction, or referential completion when it still fits the 30-second hard limit.
- End at the exact final word of the earliest complete point. Do not add a second topic, optional repetition, or unrelated discussion.
- Python, not the model, plans the authentic source breath/reaction and the post-source fade."""

MOTIVATIONAL_TENSION_MICRO_V2_GUIDANCE = (
    MOTIVATIONAL_TENSION_MICRO_GUIDANCE.replace(
        "- The spoken interval must be 8-22 seconds. Prefer 10-18 seconds, with extra weight for an exceptionally tight 9-13 second idea; do not stretch a weak thought to fill time.",
        "- The spoken interval must be 8-30 seconds. Prefer a complete 15-21 second point; do not stretch a weak thought to fill time.",
    ).replace(
        "If that continuation breaks the 22-second limit, skip or re-cut the candidate instead of truncating its meaning.",
        "If that continuation breaks the 30-second hard limit, skip or re-cut the candidate instead of truncating its meaning.",
    )
)

SELECTION_PROFILE_GUIDANCE = {
    MOTIVATIONAL_TENSION_MICRO_V1: MOTIVATIONAL_TENSION_MICRO_GUIDANCE,
    MOTIVATIONAL_TENSION_MICRO_V2: (
        HOOK_GATE_V2_PROMPT
        + "\n\n"
        + MOTIVATIONAL_TENSION_MICRO_V2_GUIDANCE
        + "\n"
        + MOTIVATIONAL_TENSION_MICRO_V2_CLOSURE_GUIDANCE
    ),
}


REFINEMENT_INSTRUCTIONS = """Boundary-refinement task:
- The candidates below were promising but failed deterministic publication gates.
- Work ONLY inside the supplied source windows and return new source-contiguous alternatives; never invent, paraphrase, reorder, or stitch speech.
- Return absolute source timestamps, not timestamps relative to a window.
- HARD TIMESTAMP INVARIANT: calculate speech_end_time - speech_start_time before returning every candidate. It must be 8.0-20.0 seconds inclusive. Never return a longer interval; the 2-second reserve is required for exact word alignment.
- Each spoken interval must contain a complete TENSION -> CONTRAST/REFRAME -> LISTENER PAYOFF arc. Prefer 9-18 seconds.
- Begin on the earliest self-contained hook, with its payoff understandable within 5 seconds. Remove host setup, attribution, filler, pronoun-dependent callbacks, and references to earlier discussion.
- End at the exact earliest semantically complete takeaway. A complete sentence is not sufficient when the speaker immediately answers it, completes its consequence, self-corrects/rephrases it, or refers back to its subject to finish the same payoff. Do not include optional repetition, a connector, a second topic, or unrelated trailing discussion.
- If the original hook and takeaway are more than 20 seconds apart, choose a later self-contained hook or an earlier complete resolving line. If that is impossible, skip that window and use another supplied window.
- Cover as many different supplied windows as possible; do not spend the response repeating alternate cuts of one point.
- hook_sentence, hook_payoff_phrase, and earliest_complete_takeaway_sentence must be exact consecutive words present in the chosen window so Python can align their word timestamps.
- second_topic_begins_after_takeaway means the SELECTED SPEECH INTERVAL itself contains a second topic after its takeaway. Set it false when a later topic begins only after speech_end_time and is outside the returned clip.
- contains_attribution_lead_in means the SELECTED SPEECH INTERVAL itself begins with attribution or setup. Set it false when that lead-in exists in the surrounding window but is outside speech_start_time.
- Set all semantic, context, boundary, and duration fields conservatively. Do not repeat an already-valid interval merely to fill the requested count.
"""

REFINEMENT_INSTRUCTIONS_V2 = (
    REFINEMENT_INSTRUCTIONS.replace(
        "It must be 8.0-20.0 seconds inclusive. Never return a longer interval; the 2-second reserve is required for exact word alignment.",
        "It must be 8.0-30.0 seconds inclusive. Prefer 15-21 seconds; 22-25 seconds receives a soft penalty and 25-30 seconds requires exceptional evidence.",
    )
    .replace(
        "Each spoken interval must contain a complete TENSION -> CONTRAST/REFRAME -> LISTENER PAYOFF arc. Prefer 9-18 seconds.",
        "Each spoken interval must contain a complete TENSION -> CONTRAST/REFRAME -> LISTENER PAYOFF arc. Prefer 15-21 seconds.",
    )
    .replace(
        "If the original hook and takeaway are more than 20 seconds apart, choose a later self-contained hook or an earlier complete resolving line.",
        "If the original hook and complete takeaway are more than 30 seconds apart, choose a later self-contained hook or an earlier complete resolving line.",
    )
)


HIGHLIGHT_SYSTEM_PROMPT = """You are an elite short-form video editor who has studied thousands of viral clips on TikTok, Instagram Reels, and YouTube Shorts. You know exactly what makes viewers stop scrolling, watch to the end, and share.

{virality_criteria}

Content type: {content_type} | Density: {density}

{content_guidance}

{selection_guidance}

Your task: identify the most viral-worthy highlights from the transcript.

Rules:
- Every highlight must open with a strong HOOK — a line that grabs attention within the first 3 seconds
- Default duration sweet spot: 45-90 seconds. Follow a stricter content-specific duration rule when one is provided; never exceed 90 seconds
- Never cut mid-sentence, mid-thought, or mid-word. The first and last spoken lines must both be complete
- Return speech_start_time at the beginning of the first complete spoken sentence and speech_end_time at the end of the final complete spoken sentence
- Python applies silence-safe edit padding after selection. Return exact speech boundaries and never place them inside a spoken word
- Never select subscribe requests, notification reminders, Patreon messages, sponsorships, thanks-for-watching messages, next-video announcements, channel promotion, or other calls to action
- Mentioning the YouTube algorithm is not valuable when the actual purpose is asking viewers to subscribe or promote the channel
- Set is_promotional or is_outro to true whenever promotion or wrap-up is the clip's primary purpose; these clips are ineligible regardless of how catchy their wording sounds
- Prefer a complete idea with a meaningful payoff, emotional tension, practical insight, demonstration, story climax, or surprising explanation
- Set requires_previous_context to true unless a new viewer can understand the clip without seeing anything before it
- Do not return context-dependent candidates: first expand them to include the necessary setup sentence; if they still require earlier context, discard them
- Use is_standalone_one_liner only for an exceptional, fully complete sub-20-second insight; short definitions or fragments are not automatically one-liners
- Clips must not overlap significantly with each other
- Score 0-100 on viral potential (not general quality)
- {num_clips_instruction}
- For each highlight, identify the single best "hook_sentence" — the opening line that would make someone stop scrolling
- Explain in one sentence why this clip is viral ("virality_reason")

Respond ONLY with valid JSON (no markdown, no explanation):
{{"highlights":[{{"title":"string","speech_start_time":float,"speech_end_time":float,"start_time":float,"end_time":float,"score":int,"hook_sentence":"string","hook_payoff_phrase":"string","final_takeaway_sentence":"string","earliest_complete_takeaway_sentence":"string","second_topic_begins_after_takeaway":bool,"contains_attribution_lead_in":bool,"contains_context_callback":bool,"thesis":"string","topic":"string","hook_type":"string","development_type":"string","virality_reason":"string","context_summary":"string","title_options":["string","string","string"],"has_hook":bool,"has_development":bool,"has_takeaway":bool,"has_complete_ending":bool,"has_clear_setup":bool,"has_escalation":bool,"has_visible_cause":bool,"has_complete_outcome":bool,"narrative_coherence_score":int,"micro_story_score":int,"has_semantic_tension":bool,"has_contrast":bool,"has_conflict":bool,"has_reversal":bool,"semantic_tension_score":int,"contrast_score":int,"conflict_score":int,"reversal_score":int,"listener_payoff_score":int,"self_contained_micro_arc_score":int,"generic_motivation_score":int,"context_dependence_score":int,"reaction_tail_compatible":bool,"reaction_tail_compatibility_score":int,"reaction_tail_start_time":float|null,"tension_kind":"string","contrast_pair":"string","listener_payoff":"string","reaction_tail_reason":"string","is_promotional":bool,"is_outro":bool,"requires_previous_context":bool,"is_standalone_one_liner":bool,"contains_profanity":bool,"hook_score":int,"standalone_score":int,"development_score":int,"takeaway_score":int,"emotional_conviction_score":int,"quotability_score":int,"closure_score":int,"title_fit_score":int,"payoff_score":int,"educational_value_score":int,"visual_action_score":int}}]}}"""


CHUNK_SIZE_SECONDS = 1200       # 20-min chunks for long videos
LONG_VIDEO_THRESHOLD = 1800     # chunk videos longer than 30 min
CHUNK_OVERLAP_SECONDS = 60
LLM_CHUNK_WORKERS_ENV = "LOCAL_LLM_CHUNK_WORKERS"
DEFAULT_LLM_CHUNK_WORKERS = 2
MAX_LLM_CHUNK_WORKERS = 4
GPT_CALL_TIMEOUT_SECONDS = 300  # cap LLM polls at 5 min — a wedged call should fail fast
MAX_HIGHLIGHT_API_ATTEMPTS = 3
HIGHLIGHT_PADDING_SECONDS = 1.75
SILENCE_BOUNDARY_SECONDS = 0.75
SENTENCE_END_RE = re.compile(r"[.!?][\"')\]]?\s*$")
DISCOVERY_CACHE_SCHEMA_VERSION = 1
DISCOVERY_ALGORITHM_VERSION = "timed-long-context-v6"
DISCOVERY_CACHE_DIRECTORY = "discovery-v6"
GLOBAL_CANDIDATE_CACHE_SCHEMA_VERSION = 1
# Keep this stable when only the deterministic decision policy changes.  The
# expensive raw whole-transcript response remains valid input to newer gates.
GLOBAL_CANDIDATE_REQUEST_VERSION = "timed-long-context-v1"
REFINEMENT_CACHE_SCHEMA_VERSION = 1
REFINEMENT_ALGORITHM_VERSION = "motivational-near-miss-v3"
REFINEMENT_CACHE_DIRECTORY = "refinement-v2"
REFINEMENT_MAX_WINDOWS = 6
REFINEMENT_MIN_NEAR_MISS_SCORE = 65.0
REFINEMENT_MAX_NEAR_MISS_DURATION_SECONDS = 40.0
REFINEMENT_WINDOW_LEAD_SECONDS = 8.0
REFINEMENT_WINDOW_TRAIL_SECONDS = 10.0
REFINEMENT_MAX_TRANSCRIPT_CHARACTERS = 36_000
LONG_CONTEXT_DISCOVERY_ENV = "LOCAL_LONG_CONTEXT_DISCOVERY"
LONG_CONTEXT_MAX_CHARACTERS_ENV = "LOCAL_LONG_CONTEXT_MAX_CHARACTERS"
DEFAULT_LONG_CONTEXT_MAX_CHARACTERS = 280_000
MIN_LONG_CONTEXT_HEADROOM_MULTIPLIER = 2


class IncompleteHighlightBatchError(RuntimeError):
    """Raised before visual analysis/render when discovery cannot fill a batch."""


def _micro_batch_is_complete(decision: Dict, target: int) -> bool:
    required = max(1, int(target))
    return min(
        _coerce_int(decision.get("eligible_count")),
        _coerce_int(decision.get("selected_count")),
    ) >= required


def call_muapi_llm(prompt: str) -> str:
    """Default LLM backend: MuAPI gpt-5-mini."""
    from . import muapi

    result = muapi.run(
        "gpt-5-mini",
        {"prompt": prompt},
        label="gpt-5-mini",
        timeout=GPT_CALL_TIMEOUT_SECONDS,
    )

    outputs = result.get("outputs")
    if isinstance(outputs, list) and outputs and isinstance(outputs[0], str) and outputs[0].strip():
        return outputs[0]

    for key in ("output", "text", "response", "result", "content"):
        v = result.get(key)
        if isinstance(v, str) and v.strip():
            return v
        if isinstance(v, dict):
            inner = v.get("text") or v.get("content")
            if isinstance(inner, str) and inner.strip():
                return inner
        if isinstance(v, list) and v and isinstance(v[0], str):
            return v[0]

    raise RuntimeError(f"Could not extract gpt-5-mini text from response: {result}")


def _parse_json_loose(raw: str) -> Dict:
    """gpt-5-4 sometimes wraps JSON in markdown fences — strip and parse."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start != -1 and end != -1:
            return json.loads(text[start:end + 1])
        raise


def _coerce_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _coerce_int(value: object, default: int = 0) -> int:
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _coerce_bool(value: object, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes"}:
            return True
        if normalized in {"false", "0", "no"}:
            return False
    if isinstance(value, (int, float)):
        return bool(value)
    return default


def _normalized_selection_profile(selection_profile: Optional[str]) -> str:
    return str(selection_profile or "").strip().lower()


def _is_micro_selection_profile(selection_profile: Optional[str]) -> bool:
    return _normalized_selection_profile(selection_profile) in MICRO_SELECTION_PROFILES


def _stamp_selection_profile(
    highlights: List[Dict],
    selection_profile: Optional[str],
) -> List[Dict]:
    normalized = _normalized_selection_profile(selection_profile)
    if not normalized:
        return highlights
    for item in highlights:
        item["selection_profile"] = normalized
        item["selection_policy_version"] = normalized
    return highlights


def _sanitize_highlights(
    raw_highlights: object,
    duration: float,
    selection_profile: Optional[str] = None,
) -> List[Dict]:
    """Normalize model output and enforce safe edit padding around speech."""
    if not isinstance(raw_highlights, list):
        return []

    max_end = duration if duration > 0 else float("inf")
    cleaned: List[Dict] = []
    for item in raw_highlights:
        if not isinstance(item, dict):
            continue

        speech_start = _coerce_float(
            item.get("speech_start_time"),
            default=_coerce_float(item.get("start_time"), default=-1.0),
        )
        speech_end = _coerce_float(
            item.get("speech_end_time"),
            default=_coerce_float(item.get("end_time"), default=-1.0),
        )
        if speech_start < 0 or speech_end <= speech_start:
            continue

        # Python aligns complete sentences and adds safe padding after parsing.
        start = speech_start
        end = speech_end

        if max_end != float("inf"):
            start = min(start, max_end)
            end = min(end, max_end)
            if end <= start:
                continue

        hook_gate_fields = (
            normalize_hook_gate_v2_fields(item)
            if _normalized_selection_profile(selection_profile)
            == MOTIVATIONAL_TENSION_MICRO_V2
            else {}
        )

        cleaned.append(
            {
                "title": str(item.get("title") or "Untitled Highlight").strip(),
                "speech_start_time": speech_start,
                "speech_end_time": speech_end,
                "start_time": start,
                "end_time": end,
                "score": max(0, min(100, _coerce_int(item.get("score"), default=0))),
                "hook_sentence": str(item.get("hook_sentence") or "").strip(),
                "hook_payoff_phrase": str(item.get("hook_payoff_phrase") or "").strip(),
                **hook_gate_fields,
                "final_takeaway_sentence": str(
                    item.get("final_takeaway_sentence") or ""
                ).strip(),
                "earliest_complete_takeaway_sentence": str(
                    item.get("earliest_complete_takeaway_sentence") or ""
                ).strip(),
                "second_topic_begins_after_takeaway": _coerce_bool(
                    item.get("second_topic_begins_after_takeaway")
                ),
                "contains_attribution_lead_in": _coerce_bool(
                    item.get("contains_attribution_lead_in")
                ),
                "contains_context_callback": _coerce_bool(
                    item.get("contains_context_callback")
                ),
                "motivational_schema_version": max(
                    1,
                    _coerce_int(item.get("motivational_schema_version"), default=2),
                ),
                "thesis": str(item.get("thesis") or "").strip(),
                "topic": str(item.get("topic") or "").strip(),
                "hook_type": str(item.get("hook_type") or "").strip(),
                "development_type": str(item.get("development_type") or "").strip(),
                "virality_reason": str(item.get("virality_reason") or "").strip(),
                "context_summary": str(item.get("context_summary") or "").strip(),
                "title_options": [
                    str(title).strip()
                    for title in item.get("title_options", [])
                    if str(title).strip()
                ][:3] if isinstance(item.get("title_options"), list) else [],
                "has_hook": _coerce_bool(item.get("has_hook")),
                "has_development": _coerce_bool(item.get("has_development")),
                "has_takeaway": _coerce_bool(item.get("has_takeaway")),
                "has_complete_ending": _coerce_bool(item.get("has_complete_ending")),
                "has_clear_setup": _coerce_bool(item.get("has_clear_setup")),
                "has_escalation": _coerce_bool(item.get("has_escalation")),
                "has_visible_cause": _coerce_bool(item.get("has_visible_cause")),
                "has_complete_outcome": _coerce_bool(item.get("has_complete_outcome")),
                "narrative_coherence_score": max(
                    0,
                    min(100, _coerce_int(item.get("narrative_coherence_score"))),
                ),
                "micro_story_score": max(
                    0,
                    min(100, _coerce_int(item.get("micro_story_score"))),
                ),
                "has_semantic_tension": (
                    _coerce_bool(item.get("has_semantic_tension"))
                    if item.get("has_semantic_tension") is not None
                    else None
                ),
                "has_contrast": (
                    _coerce_bool(item.get("has_contrast"))
                    if item.get("has_contrast") is not None
                    else None
                ),
                "has_conflict": (
                    _coerce_bool(item.get("has_conflict"))
                    if item.get("has_conflict") is not None
                    else None
                ),
                "has_reversal": (
                    _coerce_bool(item.get("has_reversal"))
                    if item.get("has_reversal") is not None
                    else None
                ),
                **{
                    key: (
                        max(0, min(100, _coerce_int(item.get(key))))
                        if item.get(key) is not None
                        else None
                    )
                    for key in (
                        "semantic_tension_score",
                        "contrast_score",
                        "conflict_score",
                        "reversal_score",
                        "listener_payoff_score",
                        "self_contained_micro_arc_score",
                        "generic_motivation_score",
                        "context_dependence_score",
                        "reaction_tail_compatibility_score",
                    )
                },
                "reaction_tail_compatible": (
                    _coerce_bool(item.get("reaction_tail_compatible"))
                    if item.get("reaction_tail_compatible") is not None
                    else None
                ),
                "reaction_tail_start_time": (
                    _coerce_float(item.get("reaction_tail_start_time"))
                    if item.get("reaction_tail_start_time") is not None
                    else None
                ),
                "tension_kind": str(item.get("tension_kind") or "").strip(),
                "contrast_pair": str(item.get("contrast_pair") or "").strip(),
                "listener_payoff": str(item.get("listener_payoff") or "").strip(),
                "reaction_tail_reason": str(
                    item.get("reaction_tail_reason") or ""
                ).strip(),
                "is_promotional": _coerce_bool(item.get("is_promotional")),
                "is_outro": _coerce_bool(item.get("is_outro")),
                "requires_previous_context": _coerce_bool(item.get("requires_previous_context")),
                "is_standalone_one_liner": _coerce_bool(item.get("is_standalone_one_liner")),
                "contains_profanity": _coerce_bool(item.get("contains_profanity")),
                "hook_score": max(0, min(100, _coerce_int(item.get("hook_score")))),
                "standalone_score": max(0, min(100, _coerce_int(item.get("standalone_score")))),
                "development_score": max(0, min(100, _coerce_int(item.get("development_score")))),
                "takeaway_score": max(0, min(100, _coerce_int(item.get("takeaway_score")))),
                "emotional_conviction_score": max(
                    0,
                    min(100, _coerce_int(item.get("emotional_conviction_score"))),
                ),
                "quotability_score": max(0, min(100, _coerce_int(item.get("quotability_score")))),
                "closure_score": max(0, min(100, _coerce_int(item.get("closure_score")))),
                "title_fit_score": max(0, min(100, _coerce_int(item.get("title_fit_score")))),
                "payoff_score": max(0, min(100, _coerce_int(item.get("payoff_score")))),
                "educational_value_score": max(
                    0,
                    min(100, _coerce_int(item.get("educational_value_score"))),
                ),
                "visual_action_score": max(
                    0,
                    min(100, _coerce_int(item.get("visual_action_score"))),
                ),
            }
        )

    return cleaned


def detect_content_type(transcript: Dict, llm_fn: LLMFn = call_muapi_llm) -> Dict[str, str]:
    segments = transcript.get("segments", [])
    sample = " ".join(s["text"] for s in segments[:25])[:3000]
    prompt = f"{CONTENT_TYPE_PROMPT}\n\nTranscript sample:\n{sample}"
    try:
        raw = llm_fn(prompt)
        return _parse_json_loose(raw)
    except Exception:
        return {"content_type": "other", "density": "medium"}


def build_transcript_text(transcript: Dict) -> str:
    segments = transcript.get("segments", [])
    offset = _coerce_float(transcript.get("_offset"), default=0.0)
    return "\n".join(
        f"[{max(0.0, _coerce_float(s.get('start')) - offset):.1f}s] "
        f"{str(s.get('text') or '').strip()}"
        for s in segments
    )


def chunk_transcript(transcript: Dict) -> List[Dict]:
    segments = transcript.get("segments", [])
    duration = transcript.get("duration", segments[-1]["end"] if segments else 0)
    chunks = []
    start = 0
    while start < duration:
        # The previous 20-minute window already covers a final remainder no
        # longer than the configured overlap.  Emitting another tiny chunk
        # would duplicate the same words and can force a pointless LLM retry
        # when there is not enough material for a valid highlight.
        if chunks and duration - start <= CHUNK_OVERLAP_SECONDS:
            break
        end = min(start + CHUNK_SIZE_SECONDS, duration)
        chunk_segs = [
            s for s in segments
            if s["start"] >= start and s["end"] <= end + CHUNK_OVERLAP_SECONDS
        ]
        if chunk_segs:
            chunk = dict(transcript)
            chunk["segments"] = chunk_segs
            chunk["duration"] = end - start
            chunk["_offset"] = start
            chunks.append(chunk)
        start += CHUNK_SIZE_SECONDS - CHUNK_OVERLAP_SECONDS
    return chunks


def _configured_llm_chunk_workers(chunk_count: int) -> int:
    """Return a conservative, bounded worker count for independent LLM chunks."""
    if chunk_count <= 1:
        return 1
    raw_value = os.getenv(
        LLM_CHUNK_WORKERS_ENV,
        str(DEFAULT_LLM_CHUNK_WORKERS),
    )
    try:
        configured = int(raw_value)
    except (TypeError, ValueError):
        configured = DEFAULT_LLM_CHUNK_WORKERS
    return min(chunk_count, MAX_LLM_CHUNK_WORKERS, max(1, configured))


def _build_highlight_prompt(
    transcript_text: str,
    content_info: Dict,
    duration: float,
    num_clips: int,
    is_chunk: bool,
    selection_profile: Optional[str],
) -> tuple[str, str]:
    """Build the exact prompt and normalized policy used by cache identities."""
    normalized_selection_profile = _normalized_selection_profile(selection_profile)
    micro_selection = _is_micro_selection_profile(normalized_selection_profile)
    if micro_selection:
        target = max(num_clips * 5, 10)
        natural_max = max(6 if not is_chunk else 4, int(duration / 12))
        candidate_cap = 12
    else:
        target = max(num_clips * 3, 6)
        natural_max = max(2 if is_chunk else 3, int(duration / 90))
        candidate_cap = 8 if not is_chunk and duration >= LONG_VIDEO_THRESHOLD else (
            4 if content_info.get("content_type") == MOTIVATIONAL_PODCAST else 8
        )
    min_clips = min(target, natural_max, candidate_cap)
    system = HIGHLIGHT_SYSTEM_PROMPT.format(
        virality_criteria=VIRALITY_CRITERIA,
        content_type=content_info.get("content_type", "other"),
        density=content_info.get("density", "medium"),
        content_guidance=CONTENT_TYPE_GUIDANCE.get(
            str(content_info.get("content_type", "other")).lower(),
            "No additional content-specific rules.",
        ),
        selection_guidance=SELECTION_PROFILE_GUIDANCE.get(
            normalized_selection_profile,
            "No additional selection-profile rules.",
        ),
        num_clips_instruction=(
            f"Generate up to {min_clips} distinct qualified highlights. "
            "Do not add weak filler merely to reach this count"
        ),
    )
    if normalized_selection_profile == MOTIVATIONAL_TENSION_MICRO_V2:
        # Keep the V1 base JSON example byte-stable, then make the V2 extension
        # the final authoritative response instruction for unstructured LLMs.
        system = f"{system}\n\n{HOOK_GATE_V2_RESPONSE_CONTRACT}"
    return f"{system}\n\nTranscript:\n{transcript_text}", normalized_selection_profile


def _candidate_cache_path(
    cache_dir: Optional[str],
    cache_namespace: str,
    base_prompt: str,
    normalized_selection_profile: str,
) -> Optional[Path]:
    if not cache_dir:
        return None
    digest = hashlib.sha256(
        (
            f"motivational-schema-v3\0{normalized_selection_profile}\0"
            f"{cache_namespace}\0{base_prompt}"
        ).encode("utf-8")
    ).hexdigest()
    return Path(cache_dir) / f"{digest}.json"


def _load_candidate_cache(
    cache_path: Optional[Path],
    duration: float,
    normalized_selection_profile: str,
) -> Optional[Dict]:
    if cache_path is None or not cache_path.is_file():
        return None
    try:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        highlights = _stamp_selection_profile(
            _sanitize_highlights(
                cached.get("highlights"),
                duration=duration,
                selection_profile=normalized_selection_profile,
            ),
            normalized_selection_profile,
        )
    except (OSError, ValueError, TypeError):
        return None
    return {"highlights": highlights} if highlights else None


def _cached_highlight_request(
    transcript_text: str,
    content_info: Dict,
    duration: float,
    num_clips: int,
    is_chunk: bool,
    cache_dir: Optional[str],
    cache_namespace: str,
    selection_profile: Optional[str],
) -> Optional[tuple[Dict, Path]]:
    """Read a candidate request without causing an LLM call or telemetry event."""
    prompt, normalized_selection_profile = _build_highlight_prompt(
        transcript_text,
        content_info,
        duration,
        num_clips,
        is_chunk,
        selection_profile,
    )
    path = _candidate_cache_path(
        cache_dir,
        cache_namespace,
        prompt,
        normalized_selection_profile,
    )
    cached = _load_candidate_cache(path, duration, normalized_selection_profile)
    return (cached, path) if cached is not None and path is not None else None


def _atomic_write_json(path: Path, payload: Dict) -> None:
    """Atomically replace a JSON cache entry so concurrent runs never see half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def _valid_sha256(value: object) -> Optional[str]:
    normalized = str(value or "").strip().lower()
    return normalized if re.fullmatch(r"[0-9a-f]{64}", normalized) else None


def _transcript_discovery_identity(transcript: Dict) -> str:
    """Return a stable content/timing identity, cheap for trusted timed captions."""
    segments = transcript.get("segments", [])
    duration = round(_coerce_float(transcript.get("duration")), 3)
    first_start = (
        round(_coerce_float(segments[0].get("start")), 3)
        if segments
        else 0.0
    )
    last_end = (
        round(_coerce_float(segments[-1].get("end")), 3)
        if segments
        else 0.0
    )
    provenance = transcript.get("_provenance")
    if isinstance(provenance, dict):
        source_sha = _valid_sha256(provenance.get("sourceSha256"))
        if source_sha:
            payload = {
                "kind": "provenance",
                "schema": str(provenance.get("schema") or ""),
                "sourceSha256": source_sha,
                "videoId": str(provenance.get("videoId") or ""),
                "language": str(provenance.get("language") or ""),
                "duration": duration,
                "segmentCount": len(segments),
                "firstStart": first_start,
                "lastEnd": last_end,
            }
            return hashlib.sha256(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
                    "utf-8"
                )
            ).hexdigest()

    cache_metadata = transcript.get("_cache")
    if isinstance(cache_metadata, dict):
        source_sha = _valid_sha256(
            cache_metadata.get("source_sha256")
            or cache_metadata.get("sourceSha256")
        )
        if source_sha:
            payload = {
                "kind": "transcriber-cache",
                "schema": str(cache_metadata.get("schema") or ""),
                "sourceSha256": source_sha,
                "model": str(cache_metadata.get("model") or ""),
                "language": str(cache_metadata.get("language") or ""),
                "duration": duration,
                "segmentCount": len(segments),
                "firstStart": first_start,
                "lastEnd": last_end,
            }
            return hashlib.sha256(
                json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
                    "utf-8"
                )
            ).hexdigest()

    # Untrusted/ad-hoc transcript dictionaries still get a correct cache key.
    # Stream the fields into the digest to avoid constructing another large JSON tree.
    digest = hashlib.sha256()
    digest.update(f"duration\0{duration:.3f}\0segments\0{len(segments)}\0".encode())
    for segment in segments:
        digest.update(
            (
                f"s\0{_coerce_float(segment.get('start')):.3f}\0"
                f"{_coerce_float(segment.get('end')):.3f}\0"
                f"{str(segment.get('text') or '').strip()}\0"
            ).encode("utf-8")
        )
        words = segment.get("words")
        if not isinstance(words, list):
            continue
        for word in words:
            digest.update(
                (
                    f"w\0{_coerce_float(word.get('start')):.3f}\0"
                    f"{_coerce_float(word.get('end')):.3f}\0"
                    f"{str(word.get('word') or word.get('text') or '').strip()}\0"
                ).encode("utf-8")
            )
    return digest.hexdigest()


def _discovery_prompt_contract(
    selection_profile: Optional[str] = None,
) -> str:
    normalized_selection_profile = _normalized_selection_profile(
        selection_profile
    )
    # Preserve the exact legacy contract for v1 and non-versioned callers.
    # New prompt families are isolated to their own cache lineage.
    if normalized_selection_profile == MOTIVATIONAL_TENSION_MICRO_V2:
        selection_guidance = {
            MOTIVATIONAL_TENSION_MICRO_V2: SELECTION_PROFILE_GUIDANCE[
                MOTIVATIONAL_TENSION_MICRO_V2
            ]
        }
    else:
        selection_guidance = {
            MOTIVATIONAL_TENSION_MICRO_V1: SELECTION_PROFILE_GUIDANCE[
                MOTIVATIONAL_TENSION_MICRO_V1
            ]
        }
    payload = {
        "contentTypePrompt": CONTENT_TYPE_PROMPT,
        "highlightSystemPrompt": HIGHLIGHT_SYSTEM_PROMPT,
        "viralityCriteria": VIRALITY_CRITERIA,
        "contentGuidance": CONTENT_TYPE_GUIDANCE,
        "selectionGuidance": selection_guidance,
        "refinementInstructions": (
            REFINEMENT_INSTRUCTIONS_V2
            if normalized_selection_profile == MOTIVATIONAL_TENSION_MICRO_V2
            else REFINEMENT_INSTRUCTIONS
        ),
        "refinementAlgorithmVersion": REFINEMENT_ALGORITHM_VERSION,
        "chunkSizeSeconds": CHUNK_SIZE_SECONDS,
        "chunkOverlapSeconds": CHUNK_OVERLAP_SECONDS,
        "paddingSeconds": HIGHLIGHT_PADDING_SECONDS,
        "silenceBoundarySeconds": SILENCE_BOUNDARY_SECONDS,
    }
    if normalized_selection_profile == MOTIVATIONAL_TENSION_MICRO_V2:
        payload["hookGatePromptVersion"] = HOOK_GATE_PROMPT_VERSION
        payload["semanticClosureDecisionVersion"] = (
            SEMANTIC_CLOSURE_DECISION_VERSION
        )
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def _discovery_cache_path(
    cache_dir: Optional[str],
    transcript: Dict,
    num_clips: int,
    profile_override: Optional[str],
    selection_profile: Optional[str],
    cache_namespace: str,
) -> tuple[Optional[Path], str]:
    transcript_identity = _transcript_discovery_identity(transcript)
    if not cache_dir:
        return None, transcript_identity
    contract = {
        "schemaVersion": DISCOVERY_CACHE_SCHEMA_VERSION,
        "algorithmVersion": DISCOVERY_ALGORITHM_VERSION,
        "promptContract": _discovery_prompt_contract(selection_profile),
        "transcriptIdentity": transcript_identity,
        "numClips": max(1, int(num_clips)),
        "profileOverride": str(profile_override or "").strip().lower(),
        "selectionProfile": _normalized_selection_profile(selection_profile),
        "cacheNamespace": str(cache_namespace or ""),
    }
    if (
        _normalized_selection_profile(selection_profile)
        == MOTIVATIONAL_TENSION_MICRO_V2
    ):
        selection_contract = _profiles.SELECTION_PROFILES[
            MOTIVATIONAL_TENSION_MICRO_V2
        ]
        contract["decisionPolicyVersion"] = {
            "hookGate": str(
                selection_contract.get("hook_gate_decision_version") or ""
            ),
            "semanticClosure": str(
                selection_contract.get("semantic_closure_decision_version")
                or ""
            ),
            "naturalTail": str(
                selection_contract.get("natural_tail_policy_version") or ""
            ),
        }
    digest = hashlib.sha256(
        json.dumps(contract, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return Path(cache_dir) / DISCOVERY_CACHE_DIRECTORY / f"{digest}.json", transcript_identity


def _load_discovery_cache(
    path: Optional[Path],
    transcript_identity: str,
) -> Optional[Dict]:
    if path is None or not path.is_file():
        return None
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(envelope, dict):
        return None
    if envelope.get("schemaVersion") != DISCOVERY_CACHE_SCHEMA_VERSION:
        return None
    if envelope.get("algorithmVersion") != DISCOVERY_ALGORITHM_VERSION:
        return None
    if envelope.get("transcriptIdentity") != transcript_identity:
        return None
    result = envelope.get("result")
    if not isinstance(result, dict) or not isinstance(result.get("content_info"), dict):
        return None
    highlights = result.get("highlights")
    if not isinstance(highlights, list) or not highlights:
        return None
    if any(not isinstance(highlight, dict) for highlight in highlights):
        return None
    # Return a detached value so callers cannot mutate the in-memory envelope.
    return json.loads(json.dumps(result))


def _write_discovery_cache(
    path: Optional[Path],
    transcript_identity: str,
    result: Dict,
    origin_strategy: str,
    global_disposition: str,
) -> None:
    if path is None or not result.get("highlights"):
        return
    _atomic_write_json(
        path,
        {
            "schemaVersion": DISCOVERY_CACHE_SCHEMA_VERSION,
            "algorithmVersion": DISCOVERY_ALGORITHM_VERSION,
            "transcriptIdentity": transcript_identity,
            "originStrategy": origin_strategy,
            "globalDisposition": global_disposition,
            "result": result,
        },
    )


def _record_discovery_strategy(telemetry: Optional[Any], strategy: str) -> None:
    if telemetry is None:
        return
    stage = getattr(telemetry, "stage", None)
    if callable(stage):
        with stage("highlight_discovery_strategy", strategy=strategy):
            pass


def _long_context_enabled() -> bool:
    return str(os.getenv(LONG_CONTEXT_DISCOVERY_ENV, "1")).strip().lower() not in {
        "0",
        "false",
        "no",
        "off",
    }


def _has_exact_timing(transcript: Dict) -> bool:
    provenance = transcript.get("_provenance")
    if isinstance(provenance, dict) and str(provenance.get("schema") or "") == (
        "youtube-json3-word-offsets-v1"
    ):
        return bool(_valid_sha256(provenance.get("sourceSha256")))
    segments = transcript.get("segments", [])
    if not segments:
        return False
    timed_segments = 0
    for segment in segments:
        words = segment.get("words")
        if not isinstance(words, list) or not words:
            continue
        if any(
            _coerce_float(word.get("end"), default=-1.0)
            > _coerce_float(word.get("start"), default=-1.0)
            >= 0.0
            for word in words
        ):
            timed_segments += 1
    return timed_segments / len(segments) >= 0.8


def _can_use_long_context_discovery(
    transcript: Dict,
    transcript_text: str,
    cache_dir: Optional[str],
) -> bool:
    if not cache_dir or not _long_context_enabled() or not _has_exact_timing(transcript):
        return False
    try:
        maximum_characters = int(
            os.getenv(
                LONG_CONTEXT_MAX_CHARACTERS_ENV,
                str(DEFAULT_LONG_CONTEXT_MAX_CHARACTERS),
            )
        )
    except (TypeError, ValueError):
        maximum_characters = DEFAULT_LONG_CONTEXT_MAX_CHARACTERS
    return 0 < len(transcript_text) <= max(1, maximum_characters)


def _global_candidate_is_qualified(
    highlight: Dict,
    selection_profile: Optional[str],
) -> bool:
    if any(
        _coerce_bool(highlight.get(key))
        for key in ("is_promotional", "is_outro", "requires_previous_context")
    ):
        return False
    speech_start = _coerce_float(
        highlight.get("speech_start_time", highlight.get("start_time")),
        default=-1.0,
    )
    speech_end = _coerce_float(
        highlight.get("speech_end_time", highlight.get("end_time")),
        default=-1.0,
    )
    speech_duration = speech_end - speech_start
    if speech_start < 0.0 or speech_duration < 5.0 or speech_duration > 90.0:
        return False
    hook_ok = _coerce_bool(highlight.get("has_hook")) or _coerce_int(
        highlight.get("hook_score")
    ) >= 75
    ending_ok = _coerce_bool(highlight.get("has_complete_ending")) or _coerce_int(
        highlight.get("closure_score")
    ) >= 75
    takeaway_ok = (
        _coerce_bool(highlight.get("has_takeaway"))
        or _coerce_int(highlight.get("takeaway_score")) >= 70
        or _coerce_int(highlight.get("payoff_score")) >= 75
    )
    if not (hook_ok and ending_ok and takeaway_ok):
        return False

    if not _is_micro_selection_profile(selection_profile):
        return True
    if not 8.0 <= speech_duration <= 22.0:
        return False
    semantic_ok = (
        _coerce_bool(highlight.get("has_semantic_tension"))
        or _coerce_bool(highlight.get("has_contrast"))
        or _coerce_bool(highlight.get("has_conflict"))
        or _coerce_bool(highlight.get("has_reversal"))
        or max(
            _coerce_int(highlight.get("semantic_tension_score")),
            _coerce_int(highlight.get("contrast_score")),
            _coerce_int(highlight.get("conflict_score")),
            _coerce_int(highlight.get("reversal_score")),
        )
        >= 70
    )
    return (
        semantic_ok
        and _coerce_int(highlight.get("self_contained_micro_arc_score")) >= 70
        and _coerce_int(highlight.get("generic_motivation_score")) <= 55
        and _coerce_int(highlight.get("context_dependence_score")) <= 35
    )


def _global_pass_has_quality_headroom(
    highlights: List[Dict],
    duration: float,
    num_clips: int,
    selection_profile: Optional[str],
) -> bool:
    qualified = [
        highlight
        for highlight in highlights
        if _global_candidate_is_qualified(highlight, selection_profile)
    ]
    required = min(max(num_clips * MIN_LONG_CONTEXT_HEADROOM_MULTIPLIER, 6), 8)
    if len(qualified) < required:
        return False
    required_regions = min(3, max(1, int(num_clips)))
    regions = {
        min(2, max(0, int(3 * _coerce_float(item.get("start_time")) / max(duration, 1.0))))
        for item in qualified
    }
    return len(regions) >= required_regions


def _rank_micro_candidates_for_decision(
    highlights: List[Dict],
    transcript: Dict,
    num_clips: Optional[int] = None,
    selection_profile: Optional[str] = MOTIVATIONAL_TENSION_MICRO_V1,
) -> Dict:
    """Run the publication ranker and dedupe with eligible candidates first."""
    from .ranker import rank_highlights, select_diverse_highlights

    identity_key = "_discovery_decision_candidate_index"
    tagged = [
        {**highlight, identity_key: index}
        for index, highlight in enumerate(highlights)
    ]
    ranked = rank_highlights(
        tagged,
        transcript,
        content_type=MOTIVATIONAL_PODCAST,
        selection_profile=selection_profile,
    )
    kept_ranked = []
    for candidate in ranked:
        start = _coerce_float(candidate.get("start_time"))
        end = _coerce_float(candidate.get("end_time"))
        duration = max(0.001, end - start)
        duplicate = False
        for kept in kept_ranked:
            kept_start = _coerce_float(kept.get("start_time"))
            kept_end = _coerce_float(kept.get("end_time"))
            overlap = max(0.0, min(end, kept_end) - max(start, kept_start))
            shorter = min(duration, max(0.001, kept_end - kept_start))
            if overlap > 0.5 * shorter:
                duplicate = True
                break
        if not duplicate:
            kept_ranked.append(candidate)

    ordered_highlights = []
    for candidate in kept_ranked:
        source_index = _coerce_int(candidate.get(identity_key), default=-1)
        if 0 <= source_index < len(highlights):
            ordered_highlights.append(dict(highlights[source_index]))
    diverse_limit = max(1, int(num_clips or len(kept_ranked) or 1))
    diverse_selected = select_diverse_highlights(
        [dict(candidate) for candidate in kept_ranked],
        limit=diverse_limit,
    )
    return {
        "ranked": kept_ranked,
        "eligible_count": sum(
            not bool(candidate.get("rejected")) for candidate in kept_ranked
        ),
        "selected_count": len(diverse_selected),
        "ordered_highlights": ordered_highlights,
    }


def _repairable_micro_near_misses(
    ranked_decision: Dict,
    num_clips: int,
) -> List[Dict]:
    repairable_reasons = {
        "connector_or_attribution_opening",
        "context_callback",
        "high_filler_ratio",
        "hook_payoff_too_late",
        "incomplete_ending_connector",
        "micro_context_dependent",
        "micro_duration_over_22s",
        "micro_duration_under_8s",
        "opening_filler",
        "requires_previous_context",
        "second_topic_after_takeaway",
        "unaligned_hook_payoff",
        "unaligned_takeaway",
        "duration_over_limit",
        "closure_exact_quote_unaligned",
        "closure_required_continuation_missing",
        "closure_speech_end_mismatch",
        "closure_takeaway_boundary_unaligned",
        "closure_duration_over_hard_max",
        "semantic_closure_decision_missing",
    }
    viable_count = min(
        _coerce_int(ranked_decision.get("eligible_count")),
        _coerce_int(ranked_decision.get("selected_count")),
    )
    missing_count = max(1, int(num_clips) - viable_count)
    limit = min(REFINEMENT_MAX_WINDOWS, max(3, missing_count * 2))
    selected = []
    for candidate in ranked_decision.get("ranked", []):
        if not candidate.get("rejected"):
            continue
        reasons = {
            str(reason)
            for reason in candidate.get("rejection_reasons", [])
            if str(reason)
        }
        if not reasons or not reasons.issubset(repairable_reasons):
            continue
        if (
            _coerce_float(candidate.get("final_score"))
            < REFINEMENT_MIN_NEAR_MISS_SCORE
        ):
            continue
        duration = _coerce_float(candidate.get("duration_seconds"))
        if "micro_duration_under_8s" in reasons and duration < 5.0:
            continue
        if (
            {"micro_duration_over_22s", "duration_over_limit"} & reasons
            and duration > REFINEMENT_MAX_NEAR_MISS_DURATION_SECONDS
        ):
            continue
        selected.append(candidate)
        if len(selected) >= limit:
            break
    return selected


def _build_refinement_window_text(
    transcript: Dict,
    near_misses: List[Dict],
) -> str:
    duration = _coerce_float(transcript.get("duration"))
    windows = []
    for candidate in near_misses:
        speech_start = _coerce_float(
            candidate.get("speech_start_time", candidate.get("start_time"))
        )
        speech_end = _coerce_float(
            candidate.get("speech_end_time", candidate.get("end_time"))
        )
        if speech_end <= speech_start:
            continue
        windows.append(
            {
                "start": max(0.0, speech_start - REFINEMENT_WINDOW_LEAD_SECONDS),
                "end": min(
                    duration or speech_end + REFINEMENT_WINDOW_TRAIL_SECONDS,
                    speech_end + REFINEMENT_WINDOW_TRAIL_SECONDS,
                ),
                "near_misses": [
                    {
                        "title": str(candidate.get("title") or ""),
                        "speech_start_time": round(speech_start, 3),
                        "speech_end_time": round(speech_end, 3),
                        "rejection_reasons": list(
                            candidate.get("rejection_reasons", [])
                        ),
                        "hook_sentence": str(candidate.get("hook_sentence") or ""),
                        "earliest_complete_takeaway_sentence": str(
                            candidate.get("earliest_complete_takeaway_sentence")
                            or candidate.get("final_takeaway_sentence")
                            or ""
                        ),
                    }
                ],
            }
        )
    if not windows:
        return ""

    merged = []
    for window in sorted(windows, key=lambda item: (item["start"], item["end"])):
        if merged and window["start"] <= merged[-1]["end"]:
            merged[-1]["end"] = max(merged[-1]["end"], window["end"])
            merged[-1]["near_misses"].extend(window["near_misses"])
        else:
            merged.append(window)

    blocks = []
    used_characters = 0
    segments = transcript.get("segments", [])
    for index, window in enumerate(merged, start=1):
        header = (
            f"WINDOW {index} [{window['start']:.1f}s-{window['end']:.1f}s]\n"
            "Near-miss diagnostics: "
            + json.dumps(
                window["near_misses"],
                ensure_ascii=True,
                separators=(",", ":"),
            )
            + "\nSource:\n"
        )
        available = (
            REFINEMENT_MAX_TRANSCRIPT_CHARACTERS
            - used_characters
            - len(header)
        )
        if available <= 0:
            break
        lines = []
        line_characters = 0
        for segment in segments:
            segment_start = _coerce_float(segment.get("start"))
            segment_end = _coerce_float(segment.get("end"))
            if segment_end <= window["start"] or segment_start >= window["end"]:
                continue
            text = str(segment.get("text") or "").strip()
            if not text:
                continue
            line = f"[{segment_start:.1f}s] {text}\n"
            if line_characters + len(line) > available:
                break
            lines.append(line)
            line_characters += len(line)
        if not lines:
            continue
        block = header + "".join(lines)
        blocks.append(block.rstrip())
        used_characters += len(block)
    return "\n\n".join(blocks)


def _build_refinement_prompt(
    transcript: Dict,
    content_info: Dict,
    num_clips: int,
    selection_profile: Optional[str],
    ranked_decision: Dict,
) -> Optional[str]:
    near_misses = _repairable_micro_near_misses(ranked_decision, num_clips)
    window_text = _build_refinement_window_text(transcript, near_misses)
    if not window_text:
        return None
    eligible_count = _coerce_int(ranked_decision.get("eligible_count"))
    selected_count = _coerce_int(ranked_decision.get("selected_count"))
    missing_count = max(1, int(num_clips) - min(eligible_count, selected_count))
    empty_prompt, _ = _build_highlight_prompt(
        "",
        content_info,
        _coerce_float(transcript.get("duration")),
        missing_count,
        False,
        selection_profile,
    )
    system_prompt = empty_prompt.rsplit("\n\nTranscript:\n", 1)[0]
    refinement_instructions = (
        REFINEMENT_INSTRUCTIONS_V2
        if _normalized_selection_profile(selection_profile)
        == MOTIVATIONAL_TENSION_MICRO_V2
        else REFINEMENT_INSTRUCTIONS
    )
    return (
        f"{system_prompt}\n\n{refinement_instructions}\n"
        f"There are {eligible_count} deterministically eligible candidates, "
        f"{selected_count} survive batch-diversity rules, and "
        f"at least {missing_count} additional eligible candidates are required.\n\n"
        f"{window_text}"
    )


def _refinement_cache_path(
    cache_dir: Optional[str],
    cache_namespace: str,
    prompt: str,
) -> Optional[Path]:
    if not cache_dir:
        return None
    digest = hashlib.sha256(
        (
            f"schema-{REFINEMENT_CACHE_SCHEMA_VERSION}\0"
            f"{REFINEMENT_ALGORITHM_VERSION}\0{cache_namespace}\0{prompt}"
        ).encode("utf-8")
    ).hexdigest()
    return Path(cache_dir) / REFINEMENT_CACHE_DIRECTORY / f"{digest}.json"


def _load_refinement_cache(
    path: Optional[Path],
    duration: float,
    selection_profile: Optional[str],
) -> Optional[Dict]:
    if path is None or not path.is_file():
        return None
    try:
        envelope = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(envelope, dict):
        return None
    if envelope.get("schemaVersion") != REFINEMENT_CACHE_SCHEMA_VERSION:
        return None
    if envelope.get("algorithmVersion") != REFINEMENT_ALGORITHM_VERSION:
        return None
    raw_highlights = envelope.get("highlights")
    if not isinstance(raw_highlights, list):
        return None
    return {
        "highlights": _stamp_selection_profile(
            _sanitize_highlights(
                raw_highlights,
                duration,
                selection_profile=selection_profile,
            ),
            selection_profile,
        )
    }


def _call_refinement_api(
    prompt: str,
    duration: float,
    llm_fn: LLMFn,
    cache_dir: Optional[str],
    cache_namespace: str,
    selection_profile: Optional[str],
    telemetry: Optional[Any],
) -> Dict:
    """Issue at most one refinement model call; successful responses are cached."""
    cache_path = _refinement_cache_path(cache_dir, cache_namespace, prompt)
    cached = _load_refinement_cache(cache_path, duration, selection_profile)
    if cached is not None:
        if telemetry is not None:
            telemetry.cache_hit("highlight_refinement")
        print(f"[highlights] refinement cache hit: {cache_path.name}", flush=True)
        return cached
    if cache_path is not None and telemetry is not None:
        telemetry.cache_miss("highlight_refinement")

    raw = llm_fn(prompt)
    try:
        parsed = _parse_json_loose(raw)
        raw_highlights = parsed.get("highlights")
        if not isinstance(raw_highlights, list):
            raise ValueError("missing highlights array")
        highlights = _stamp_selection_profile(
            _sanitize_highlights(
                raw_highlights,
                duration,
                selection_profile=selection_profile,
            ),
            selection_profile,
        )
    except Exception as error:
        raise RuntimeError(f"invalid refinement response: {error}") from error
    if cache_path is not None:
        _atomic_write_json(
            cache_path,
            {
                "schemaVersion": REFINEMENT_CACHE_SCHEMA_VERSION,
                "algorithmVersion": REFINEMENT_ALGORITHM_VERSION,
                "highlights": highlights,
            },
        )
    return {"highlights": highlights}


def _record_refinement_outcome(
    telemetry: Optional[Any],
    outcome: str,
    eligible_before: int,
    eligible_after: int,
) -> None:
    if telemetry is None:
        return
    stage = getattr(telemetry, "stage", None)
    if callable(stage):
        with stage(
            "highlight_discovery_refinement",
            strategy="refinement",
            outcome=outcome,
            eligibleBefore=eligible_before,
            eligibleAfter=eligible_after,
        ):
            pass


def _global_cache_namespace(cache_namespace: str) -> str:
    """Keep raw global candidates reusable across decision-policy upgrades."""
    return (
        f"{cache_namespace}\0global-discovery\0"
        f"schema-{GLOBAL_CANDIDATE_CACHE_SCHEMA_VERSION}\0"
        f"{GLOBAL_CANDIDATE_REQUEST_VERSION}"
    )


def call_highlight_api(
    transcript_text: str,
    content_info: Dict,
    duration: float,
    num_clips: int,
    is_chunk: bool = False,
    llm_fn: LLMFn = call_muapi_llm,
    cache_dir: Optional[str] = None,
    cache_namespace: str = "",
    selection_profile: Optional[str] = None,
    telemetry: Optional[Any] = None,
) -> Dict:
    base_prompt, normalized_selection_profile = _build_highlight_prompt(
        transcript_text,
        content_info,
        duration,
        num_clips,
        is_chunk,
        selection_profile,
    )
    cache_path = _candidate_cache_path(
        cache_dir,
        cache_namespace,
        base_prompt,
        normalized_selection_profile,
    )
    cached = _load_candidate_cache(
        cache_path,
        duration,
        normalized_selection_profile,
    )
    if cached is not None:
        if telemetry is not None:
            telemetry.cache_hit("llm_candidates")
        print(f"[highlights] candidate cache hit: {cache_path.name}", flush=True)
        return cached
    if cache_path is not None and telemetry is not None:
        telemetry.cache_miss("llm_candidates")
    prompt = base_prompt
    hook_gate_retry_fields = (
        " opening_exact_quote, hook_signal_phrase, hook_family,"
        " new_viewer_understands_opening, opens_with_context_connector,"
        " contains_external_antecedent, contains_host_setup,"
        " first_second_value_score, specificity_score, relatability_score,"
        " stop_scroll_score, hook_gate_recommendation, hook_gate_reasons,"
        if normalized_selection_profile == MOTIVATIONAL_TENSION_MICRO_V2
        else ""
    )
    last_error = "unknown"

    for attempt in range(1, MAX_HIGHLIGHT_API_ATTEMPTS + 1):
        raw = llm_fn(prompt)
        try:
            parsed = _parse_json_loose(raw)
            highlights = _stamp_selection_profile(
                _sanitize_highlights(
                    parsed.get("highlights"),
                    duration=duration,
                    selection_profile=normalized_selection_profile,
                ),
                normalized_selection_profile,
            )
            if highlights:
                if cache_path is not None:
                    _atomic_write_json(cache_path, {"highlights": highlights})
                return {"highlights": highlights}
            last_error = "no valid highlights in response"
        except Exception as e:
            last_error = str(e)

        if attempt < MAX_HIGHLIGHT_API_ATTEMPTS:
            print(
                f"[highlights] invalid model output on attempt {attempt}/{MAX_HIGHLIGHT_API_ATTEMPTS}; retrying",
                flush=True,
            )
            prompt = (
                base_prompt
                + "\n\nIMPORTANT: Return ONLY valid JSON with a top-level 'highlights' array."
                + " Each item must include: title, speech_start_time, speech_end_time,"
                + " start_time, end_time, score, hook_sentence, final_takeaway_sentence,"
                + " hook_payoff_phrase, earliest_complete_takeaway_sentence,"
                + hook_gate_retry_fields
                + " second_topic_begins_after_takeaway, contains_attribution_lead_in,"
                + " contains_context_callback,"
                + " thesis, topic, hook_type, development_type, virality_reason, title_options,"
                + " has_hook, has_development, has_takeaway, has_complete_ending,"
                + " context_summary, has_clear_setup, has_escalation, has_visible_cause,"
                + " has_complete_outcome, narrative_coherence_score, micro_story_score,"
                + " has_semantic_tension, has_contrast, has_conflict, has_reversal,"
                + " semantic_tension_score, contrast_score, conflict_score, reversal_score,"
                + " listener_payoff_score, self_contained_micro_arc_score,"
                + " generic_motivation_score, context_dependence_score,"
                + " reaction_tail_compatible, reaction_tail_compatibility_score,"
                + " reaction_tail_start_time, tension_kind, contrast_pair, listener_payoff,"
                + " reaction_tail_reason,"
                + " is_promotional, is_outro, requires_previous_context,"
                + " is_standalone_one_liner, contains_profanity, hook_score, standalone_score,"
                + " development_score, takeaway_score, emotional_conviction_score,"
                + " quotability_score, closure_score, title_fit_score, payoff_score,"
                + " educational_value_score, visual_action_score."
                + " No markdown fences, no commentary."
            )

    raise RuntimeError(
        f"Highlight generator produced invalid output after {MAX_HIGHLIGHT_API_ATTEMPTS} attempts: {last_error}"
    )


def dedupe_highlights(highlights: List[Dict]) -> List[Dict]:
    """Drop a highlight if it overlaps >50% with a higher-scoring one already kept."""
    highlights = sorted(
        highlights,
        key=lambda x: float(x.get("final_score", x.get("score", 0))),
        reverse=True,
    )
    kept: List[Dict] = []
    for h in highlights:
        h_start = float(h["start_time"])
        h_end = float(h["end_time"])
        h_dur = h_end - h_start
        overlapping = False
        for k in kept:
            latest_start = max(h_start, float(k["start_time"]))
            earliest_end = min(h_end, float(k["end_time"]))
            overlap = earliest_end - latest_start
            if overlap > 0 and overlap > 0.5 * h_dur:
                overlapping = True
                break
        if not overlapping:
            kept.append(h)
    return kept


def _sentence_spans(transcript: Dict) -> List[Dict]:
    """Build complete sentence spans from word timestamps or SRT segments."""
    segments = transcript.get("segments", [])
    if not segments:
        return []

    timed_words = []
    for segment in segments:
        for word in segment.get("words", []) if isinstance(segment.get("words"), list) else []:
            text = str(word.get("word") or word.get("text") or "").strip()
            start = _coerce_float(word.get("start"), default=-1.0)
            end = _coerce_float(word.get("end"), default=-1.0)
            if text and start >= 0 and end > start:
                timed_words.append({"start": start, "end": end, "text": text})

    units = timed_words or [
        {
            "start": _coerce_float(segment.get("start"), default=-1.0),
            "end": _coerce_float(segment.get("end"), default=-1.0),
            "text": str(segment.get("text") or "").strip(),
        }
        for segment in segments
    ]
    units = [unit for unit in units if unit["text"] and unit["start"] >= 0 and unit["end"] > unit["start"]]
    if not units:
        return []

    spans = []
    current_start = units[0]["start"]
    current_end = units[0]["end"]
    current_text = [units[0]["text"]]
    for index, unit in enumerate(units):
        if index > 0:
            current_end = unit["end"]
            current_text.append(unit["text"])
        next_start = units[index + 1]["start"] if index + 1 < len(units) else None
        gap = (next_start - current_end) if next_start is not None else float("inf")
        if SENTENCE_END_RE.search(unit["text"]) or gap >= SILENCE_BOUNDARY_SECONDS:
            spans.append(
                {
                    "start": float(current_start),
                    "end": float(current_end),
                    "text": " ".join(current_text),
                }
            )
            if next_start is not None:
                current_start = units[index + 1]["start"]
                current_end = units[index + 1]["end"]
                current_text = []
    return spans


def _snap_highlights_to_transcript(highlights: List[Dict], transcript: Dict) -> List[Dict]:
    """Align semantic cuts to full sentences and add only silence-safe padding."""
    spans = _sentence_spans(transcript)
    if not spans:
        return highlights

    duration = _coerce_float(transcript.get("duration"), default=0.0)
    snapped = []
    for highlight in highlights:
        item = dict(highlight)
        speech_start = float(item.get("speech_start_time", item["start_time"]))
        speech_end = float(item.get("speech_end_time", item["end_time"]))
        selected_indexes = [
            index
            for index, span in enumerate(spans)
            if span["end"] > speech_start and span["start"] < speech_end
        ]
        if not selected_indexes:
            selected_indexes = [
                min(
                    range(len(spans)),
                    key=lambda index: abs(spans[index]["start"] - speech_start),
                )
            ]

        first_index = selected_indexes[0]
        last_index = selected_indexes[-1]
        sentence_start = float(spans[first_index]["start"])
        sentence_end = float(spans[last_index]["end"])
        previous_end = float(spans[first_index - 1]["end"]) if first_index > 0 else 0.0
        next_start = (
            float(spans[last_index + 1]["start"])
            if last_index + 1 < len(spans)
            else duration or sentence_end + HIGHLIGHT_PADDING_SECONDS
        )
        start = max(previous_end, sentence_start - HIGHLIGHT_PADDING_SECONDS, 0.0)
        end = min(next_start, sentence_end + HIGHLIGHT_PADDING_SECONDS)
        if duration > 0:
            end = min(duration, end)

        item["speech_start_time"] = sentence_start
        item["speech_end_time"] = sentence_end
        item["start_time"] = start
        item["end_time"] = end
        item["boundary_quality_score"] = 100
        if item["end_time"] > item["start_time"]:
            snapped.append(item)
    return snapped


def _normalized_phrase_tokens(text: str) -> List[str]:
    return re.findall(r"[a-z0-9']+", str(text or "").lower())


def _timed_transcript_words(transcript: Dict) -> List[Dict]:
    words = []
    for segment in transcript.get("segments", []):
        for word in segment.get("words", []) if isinstance(segment.get("words"), list) else []:
            text = str(word.get("word") or word.get("text") or "").strip()
            start = _coerce_float(word.get("start"), default=-1.0)
            end = _coerce_float(word.get("end"), default=-1.0)
            tokens = _normalized_phrase_tokens(text)
            if tokens and start >= 0.0 and end > start:
                words.append(
                    {"start": start, "end": end, "text": text, "token": tokens[0]}
                )
    return sorted(words, key=lambda word: (word["start"], word["end"]))


def _raw_timed_transcript_words(transcript: Dict) -> List[Dict]:
    """Preserve source word text for the strict V2 matcher.

    The legacy boundary matcher intentionally collapses punctuation-bearing
    tokens. HookGateV2 needs the original word text so contractions and
    hyphenated words can be normalized without changing V1 behavior.
    """
    words = []
    for segment in transcript.get("segments", []):
        segment_words = (
            segment.get("words")
            if isinstance(segment.get("words"), list)
            else []
        )
        for word in segment_words:
            if isinstance(word, dict):
                words.append(dict(word))
    return words


def _find_phrase_word_span(
    words: List[Dict],
    phrase: str,
    search_start: float,
    search_end: float,
    prefer_suffix: bool = False,
    exact: bool = False,
) -> Optional[tuple]:
    phrase_tokens = _normalized_phrase_tokens(phrase)
    if not phrase_tokens:
        return None
    indexed = [
        (index, word)
        for index, word in enumerate(words)
        if word["end"] >= search_start - 3.0 and word["start"] <= search_end + 3.0
    ]
    if not indexed:
        return None
    local_tokens = [word["token"] for _, word in indexed]
    lengths = [len(phrase_tokens)]
    if not exact:
        fallback_length = min(7, len(phrase_tokens))
        if fallback_length not in lengths:
            lengths.append(fallback_length)
    for length in lengths:
        needle = phrase_tokens[-length:] if prefer_suffix else phrase_tokens[:length]
        matches = []
        for local_index in range(0, len(local_tokens) - length + 1):
            if local_tokens[local_index:local_index + length] == needle:
                first_index = indexed[local_index][0]
                last_index = indexed[local_index + length - 1][0]
                matches.append((first_index, last_index))
        if matches:
            return matches[-1] if prefer_suffix else matches[0]
    return None


_SEMANTIC_CONTINUATION_MAX_GAP_SECONDS = 0.85
_SEMANTIC_TOPIC_SHIFT_PREFIXES = (
    "anyway",
    "moving on",
    "now lets",
    "on another",
    "please do",
    "speaking of",
    "the next",
)
_SEMANTIC_REFERENCE_OPENERS = {
    "he", "hes", "her", "hers", "him", "his", "it", "its", "she", "shes",
    "their", "theirs", "them", "these", "they", "theyre", "this", "those",
}
_SEMANTIC_PLURAL_ANTECEDENTS = {
    "children", "colleague", "colleagues", "everyone", "family", "friends", "kids",
    "others", "people", "team", "teams", "workers",
}
_SEMANTIC_CONTENT_STOPWORDS = {
    "about", "after", "again", "also", "and", "are", "because", "been", "being",
    "but", "can", "could", "did", "does", "doing", "for", "from", "going", "had",
    "has", "have", "here", "into", "just", "make", "may", "not", "only", "our",
    "should", "than", "that", "the", "their", "them", "then", "there", "these",
    "they", "this", "those", "through", "too", "very", "was", "were", "what",
    "when", "where", "which", "while", "who", "will", "with", "would", "you",
    "your",
}


def _semantic_token(token: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(token or "").lower())


def _semantic_stem(token: str) -> str:
    value = _semantic_token(token)
    if value.endswith("ies") and len(value) > 4:
        return value[:-3] + "y"
    if value.endswith("ing") and len(value) > 5:
        value = value[:-3]
    elif value.endswith("ed") and len(value) > 4:
        value = value[:-2]
    elif value.endswith("er") and len(value) > 5:
        value = value[:-2]
    elif value.endswith("s") and len(value) > 4:
        value = value[:-1]
    return value


def _semantic_content_stems(text: str) -> set:
    return {
        stem
        for stem in (_semantic_stem(token) for token in _normalized_phrase_tokens(text))
        if len(stem) >= 3 and stem not in _SEMANTIC_CONTENT_STOPWORDS
    }


def _required_motivational_continuation(
    sentence: Dict,
    next_sentence: Optional[Dict],
) -> Optional[str]:
    """Return deterministic evidence that the next sentence finishes the same payoff.

    This deliberately requires a short source gap plus a structural link. Topic
    similarity alone is not enough: adjacent podcast sentences often discuss the
    same broad subject while forming independently usable points.
    """
    if not next_sentence:
        return None
    gap = float(next_sentence["start"]) - float(sentence["end"])
    if gap < -0.05 or gap > _SEMANTIC_CONTINUATION_MAX_GAP_SECONDS:
        return None

    current_text = str(sentence.get("text") or "").strip()
    next_text = str(next_sentence.get("text") or "").strip()
    current_tokens = [
        _semantic_token(token) for token in _normalized_phrase_tokens(current_text)
    ]
    next_tokens = [
        _semantic_token(token) for token in _normalized_phrase_tokens(next_text)
    ]
    current_tokens = [token for token in current_tokens if token]
    next_tokens = [token for token in next_tokens if token]
    if not current_tokens or not next_tokens:
        return None

    normalized_next = " ".join(next_tokens)
    if any(
        normalized_next == prefix or normalized_next.startswith(prefix + " ")
        for prefix in _SEMANTIC_TOPIC_SHIFT_PREFIXES
    ):
        return None

    first = next_tokens[0]
    if current_text.endswith("?") and first in {
        "because", "if", "no", "otherwise", "yes",
    }:
        return "question_answer"

    common_prefix = 0
    for current_token, next_token in zip(current_tokens, next_tokens):
        if current_token != next_token:
            break
        common_prefix += 1
    if common_prefix >= 3:
        return "immediate_rephrase"
    if normalized_next.startswith(("i mean ", "in other words ", "or rather ")):
        return "self_correction"
    if normalized_next.startswith(("because ", "otherwise ", "that means ", "which means ")):
        return "required_consequence"

    current_stems = _semantic_content_stems(current_text)
    next_stems = _semantic_content_stems(next_text)
    shared_stems = current_stems & next_stems
    early_references = set(next_tokens[:4]) & {"it", "its", "that", "these", "this", "those"}
    plural_reference = first in {"their", "theirs", "them", "they", "theyre"}
    has_plural_antecedent = bool(
        current_stems & _SEMANTIC_PLURAL_ANTECEDENTS
    )
    consequence_language = any(
        phrase in f" {normalized_next} "
        for phrase in (
            " going to ", " make ", " means ", " only ", " so that ", " that by ",
            " will ",
        )
    )
    if early_references and (shared_stems or consequence_language):
        return "referential_consequence"
    if plural_reference and has_plural_antecedent and (shared_stems or consequence_language):
        return "referential_consequence"
    if first in _SEMANTIC_REFERENCE_OPENERS and shared_stems and consequence_language:
        return "referential_consequence"
    return None


def _motivational_hard_max_seconds(highlight: Dict) -> float:
    selection_profile = str(
        highlight.get("selection_profile")
        or highlight.get("selection_policy_version")
        or ""
    ).strip().lower()
    selection_contract = _profiles.SELECTION_PROFILES.get(selection_profile, {})
    if selection_contract.get("hard_max_seconds") is not None:
        return _coerce_float(selection_contract["hard_max_seconds"], default=55.0)
    return _coerce_float(
        _profiles.CONTENT_PROFILES.get(MOTIVATIONAL_PODCAST, {}).get(
            "hard_max_seconds",
            55.0,
        ),
        default=55.0,
    )


def _hook_gate_v2_policy(highlight: Dict) -> Optional[Dict]:
    selection_profile = str(
        highlight.get("selection_profile")
        or highlight.get("selection_policy_version")
        or ""
    ).strip().lower()
    if selection_profile != MOTIVATIONAL_TENSION_MICRO_V2:
        return None
    return _profiles.SELECTION_PROFILES.get(selection_profile, {})


def _apply_growth_v2_decisions(
    highlight: Dict,
    transcript: Dict,
    hook_gate_words: List[Dict],
    policy: Dict,
) -> Dict:
    item = evaluate_hook_gate_v2(
        dict(highlight),
        timed_words=hook_gate_words,
        policy=policy,
    )
    return evaluate_motivational_closure_v1(
        item,
        transcript=transcript,
        policy=policy,
    )


def align_motivational_boundaries(
    highlights: List[Dict],
    transcript: Dict,
) -> List[Dict]:
    """Anchor motivational cuts to the exact reported hook and takeaway words."""
    words = _timed_transcript_words(transcript)
    hook_gate_words = _raw_timed_transcript_words(transcript)
    if not words:
        return [
            _apply_growth_v2_decisions(
                highlight,
                transcript=transcript,
                hook_gate_words=hook_gate_words,
                policy=policy,
            )
            if (policy := _hook_gate_v2_policy(highlight)) is not None
            else highlight
            for highlight in highlights
        ]
    duration = _coerce_float(transcript.get("duration"), default=0.0)
    sentence_spans = _sentence_spans(transcript)
    aligned = []
    for highlight in highlights:
        item = dict(highlight)
        growth_v2_policy = _hook_gate_v2_policy(item)
        old_start = _coerce_float(item.get("speech_start_time", item.get("start_time")))
        old_end = _coerce_float(item.get("speech_end_time", item.get("end_time")))
        hook_text = str(
            item.get("opening_exact_quote")
            if growth_v2_policy is not None
            and item.get("opening_exact_quote")
            else item.get("hook_sentence")
            or ""
        )
        payoff_text = str(item.get("hook_payoff_phrase") or hook_text)
        takeaway_text = str(
            item.get("earliest_complete_takeaway_sentence")
            or item.get("final_takeaway_sentence")
            or ""
        )
        exact_hook_span = (
            _find_phrase_word_span(
                words,
                hook_text,
                old_start,
                old_end,
                exact=True,
            )
            if hook_text
            else None
        )
        hook_span = exact_hook_span or _find_phrase_word_span(
            words,
            hook_text,
            old_start,
            old_end,
        )
        payoff_span = _find_phrase_word_span(
            words,
            payoff_text,
            old_start,
            old_end,
            exact=bool(item.get("hook_payoff_phrase")),
        )
        exact_takeaway_span = (
            _find_phrase_word_span(
                words,
                takeaway_text,
                old_start,
                old_end,
                prefer_suffix=True,
                exact=True,
            )
            if takeaway_text
            else None
        )
        takeaway_span = exact_takeaway_span or _find_phrase_word_span(
            words,
            takeaway_text,
            old_start,
            old_end,
            prefer_suffix=True,
        )
        if hook_span is not None:
            hook_index = hook_span[0]
            speech_start = float(words[hook_index]["start"])
        else:
            speech_start = old_start
        speech_end = (
            float(words[takeaway_span[1]]["end"])
            if takeaway_span is not None
            else old_end
        )
        if speech_end <= speech_start:
            if growth_v2_policy is not None:
                item = _apply_growth_v2_decisions(
                    item,
                    transcript=transcript,
                    hook_gate_words=hook_gate_words,
                    policy=growth_v2_policy,
                )
            aligned.append(item)
            continue

        aligned_takeaway_end = speech_end
        continuation_reasons = []
        continuation_required = False
        semantic_closure_sentence = takeaway_text
        if takeaway_span is not None and sentence_spans:
            sentence_index = next(
                (
                    index
                    for index, sentence in enumerate(sentence_spans)
                    if float(sentence["start"]) <= speech_end + 0.05
                    and float(sentence["end"]) >= speech_end - 0.05
                ),
                None,
            )
            hard_max_seconds = _motivational_hard_max_seconds(item)
            if sentence_index is not None:
                sentence = sentence_spans[sentence_index]
                if float(sentence["end"]) > speech_end + 0.05:
                    proposed_end = float(sentence["end"])
                    if proposed_end - speech_start <= hard_max_seconds + 0.001:
                        speech_end = proposed_end
                        continuation_reasons.append("same_sentence_completion")
                        semantic_closure_sentence = str(sentence["text"])
                    else:
                        continuation_required = True
                        continuation_reasons.append("same_sentence_completion")
                while not continuation_required and sentence_index + 1 < len(sentence_spans):
                    sentence = sentence_spans[sentence_index]
                    next_sentence = sentence_spans[sentence_index + 1]
                    reason = _required_motivational_continuation(sentence, next_sentence)
                    if reason is None:
                        break
                    proposed_end = float(next_sentence["end"])
                    if proposed_end - speech_start > hard_max_seconds + 0.001:
                        continuation_required = True
                        continuation_reasons.append(reason)
                        break
                    speech_end = proposed_end
                    sentence_index += 1
                    continuation_reasons.append(reason)
                    semantic_closure_sentence = str(next_sentence["text"])

        previous_ends = [word["end"] for word in words if word["end"] <= speech_start]
        next_starts = [word["start"] for word in words if word["start"] >= speech_end]
        previous_end = max(previous_ends, default=0.0)
        next_start = min(next_starts, default=duration or speech_end + HIGHLIGHT_PADDING_SECONDS)
        item["speech_start_time"] = speech_start
        item["speech_end_time"] = speech_end
        item["start_time"] = max(
            previous_end,
            speech_start - HIGHLIGHT_PADDING_SECONDS,
            0.0,
        )
        item["end_time"] = min(
            next_start,
            speech_end + HIGHLIGHT_PADDING_SECONDS,
            duration or float("inf"),
        )
        item["hook_boundary_aligned"] = hook_span is not None
        item["hook_payoff_aligned"] = payoff_span is not None
        item["takeaway_boundary_aligned"] = takeaway_span is not None
        item["semantic_continuation_detected"] = bool(continuation_reasons)
        item["semantic_continuation_required"] = continuation_required
        item["semantic_continuation_reasons"] = continuation_reasons
        item["semantic_extension_applied"] = speech_end > aligned_takeaway_end + 0.001
        item["semantic_extension_start_time"] = round(aligned_takeaway_end, 3)
        item["semantic_extension_end_time"] = round(speech_end, 3)
        item["semantic_closure_sentence"] = semantic_closure_sentence
        if continuation_required:
            item["has_complete_ending"] = False
        item["hook_payoff_latency_seconds"] = (
            round(float(words[payoff_span[1]]["end"]) - speech_start, 3)
            if payoff_span is not None
            else None
        )
        if (
            exact_hook_span is not None
            and speech_start > old_start + 0.001
            and _coerce_bool(item.get("contains_attribution_lead_in"))
        ):
            item["contains_attribution_lead_in"] = False
            item["attribution_lead_in_trimmed"] = True
        if (
            exact_takeaway_span is not None
            and _coerce_bool(item.get("second_topic_begins_after_takeaway"))
        ):
            next_word_index = exact_takeaway_span[1] + 1
            next_word_start = (
                float(words[next_word_index]["start"])
                if next_word_index < len(words)
                else float("inf")
            )
            # Treat speech intervals as half-open.  Once the exact takeaway is
            # the selected endpoint, a later topic beginning at/after that
            # endpoint is outside the clip and cannot justify a hard reject.
            if next_word_start >= speech_end - 0.001:
                item["second_topic_begins_after_takeaway"] = False
                if speech_end < old_end - 0.001:
                    item["second_topic_trimmed_after_takeaway"] = True
                else:
                    item["second_topic_flag_cleared_outside_interval"] = True
        if growth_v2_policy is not None:
            item = _apply_growth_v2_decisions(
                item,
                transcript=transcript,
                hook_gate_words=hook_gate_words,
                policy=growth_v2_policy,
            )
        aligned.append(item)
    return aligned


def get_highlights(
    transcript: Dict,
    num_clips: int = 3,
    llm_fn: Optional[LLMFn] = None,
    profile_override: Optional[str] = None,
    cache_dir: Optional[str] = None,
    cache_namespace: str = "",
    selection_profile: Optional[str] = None,
    telemetry: Optional[Any] = None,
    allow_incomplete_batch: bool = False,
) -> Dict:
    """Main entry point — returns {highlights: [...]} sorted by score.

    `llm_fn` swaps the underlying LLM. Defaults to MuAPI gpt-5-mini; local
    mode passes in a local LLM-backed callable. ``allow_incomplete_batch`` is
    reserved for non-production shadow evaluation: it returns every evaluated
    candidate instead of raising when fewer than ``num_clips`` survive.
    """
    llm_fn = llm_fn or call_muapi_llm
    duration = _coerce_float(transcript.get("duration"), default=0.0)
    normalized_selection_profile = _normalized_selection_profile(selection_profile)
    discovery_cache_path, transcript_identity = _discovery_cache_path(
        cache_dir,
        transcript,
        num_clips,
        profile_override,
        normalized_selection_profile,
        cache_namespace,
    )
    cached_discovery = _load_discovery_cache(
        discovery_cache_path,
        transcript_identity,
    )
    if (
        cached_discovery is not None
        and not allow_incomplete_batch
        and _is_micro_selection_profile(normalized_selection_profile)
    ):
        cached_decision = _rank_micro_candidates_for_decision(
            cached_discovery.get("highlights", []),
            transcript,
            num_clips,
            normalized_selection_profile,
        )
        if not _micro_batch_is_complete(cached_decision, num_clips):
            print(
                "[highlights] ignoring incomplete final discovery cache "
                f"({cached_decision.get('selected_count', 0)}/{num_clips})",
                flush=True,
            )
            cached_discovery = None
    if cached_discovery is not None:
        if telemetry is not None:
            telemetry.cache_hit("highlight_discovery")
        _record_discovery_strategy(telemetry, "final_cache")
        print(
            f"[highlights] final discovery cache hit: {discovery_cache_path.name}",
            flush=True,
        )
        return cached_discovery
    if discovery_cache_path is not None and telemetry is not None:
        telemetry.cache_miss("highlight_discovery")

    content_info = (
        {
            "content_type": str(profile_override).strip().lower(),
            "density": "high",
            "profile_forced": True,
        }
        if profile_override
        else detect_content_type(transcript, llm_fn=llm_fn)
    )
    if normalized_selection_profile:
        content_info["selection_profile"] = normalized_selection_profile
    print(f"[highlights] content={content_info.get('content_type')} density={content_info.get('density')} duration={duration:.0f}s", flush=True)

    def finalize(raw_highlights: List[Dict]) -> List[Dict]:
        prepared = _snap_highlights_to_transcript(
            dedupe_highlights(raw_highlights),
            transcript,
        )
        if content_info.get("content_type") == MOTIVATIONAL_PODCAST:
            prepared = align_motivational_boundaries(prepared, transcript)
        return dedupe_highlights(prepared)

    strategy = "global"
    global_disposition = "short-video"
    supplemental_global_highlights: List[Dict] = []
    highlights: List[Dict]

    if duration >= LONG_VIDEO_THRESHOLD:
        chunks = chunk_transcript(transcript)
        print(f"[highlights] long video — splitting into {len(chunks)} chunks", flush=True)
        chunk_jobs = []
        for i, chunk in enumerate(chunks):
            offset = chunk.get("_offset", 0)
            text = build_transcript_text(chunk)
            print(f"[highlights] chunk {i + 1}/{len(chunks)} (offset {offset:.0f}s)", flush=True)
            chunk_jobs.append((i, chunk, offset, text))

        # Existing chunk entries represent already-paid, known-good work.  If every
        # chunk is available, reuse them before considering a new full-video pass.
        cached_chunk_results = []
        for i, chunk, offset, text in chunk_jobs:
            cached = _cached_highlight_request(
                text,
                content_info,
                chunk["duration"],
                num_clips,
                True,
                cache_dir,
                cache_namespace,
                normalized_selection_profile,
            )
            if cached is None:
                cached_chunk_results = []
                break
            cached_result, cached_path = cached
            cached_chunk_results.append((i, offset, cached_result, cached_path))

        def analyze_chunk(job):
            i, chunk, offset, text = job
            result = call_highlight_api(
                text,
                content_info,
                chunk["duration"],
                num_clips=num_clips,
                is_chunk=True,
                llm_fn=llm_fn,
                cache_dir=cache_dir,
                cache_namespace=cache_namespace,
                selection_profile=normalized_selection_profile,
                telemetry=telemetry,
            )
            return i, offset, result

        use_chunks = False
        chunk_results = []
        if chunk_jobs and len(cached_chunk_results) == len(chunk_jobs):
            if telemetry is not None:
                telemetry.cache_hit("llm_candidates", count=len(cached_chunk_results))
            for _, _, _, cached_path in cached_chunk_results:
                print(
                    f"[highlights] candidate cache hit: {cached_path.name}",
                    flush=True,
                )
            chunk_results = [
                (index, offset, result)
                for index, offset, result, _ in cached_chunk_results
            ]
            cached_global = _cached_highlight_request(
                build_transcript_text(transcript),
                content_info,
                duration,
                num_clips,
                False,
                cache_dir,
                _global_cache_namespace(cache_namespace),
                normalized_selection_profile,
            )
            if cached_global is not None:
                cached_global_result, cached_global_path = cached_global
                supplemental_global_highlights = list(
                    cached_global_result.get("highlights", [])
                )
                if telemetry is not None:
                    telemetry.cache_hit("llm_candidates")
                print(
                    "[highlights] supplementing chunks from cached global "
                    f"candidates: {cached_global_path.name}",
                    flush=True,
                )
            use_chunks = True
            global_disposition = "skipped-complete-chunk-cache"
        elif chunk_jobs:
            full_transcript_text = build_transcript_text(transcript)
            if _can_use_long_context_discovery(
                transcript,
                full_transcript_text,
                cache_dir,
            ):
                print(
                    "[highlights] trying one full timed-transcript discovery pass",
                    flush=True,
                )
                try:
                    global_result = call_highlight_api(
                        full_transcript_text,
                        content_info,
                        duration,
                        num_clips=num_clips,
                        is_chunk=False,
                        llm_fn=llm_fn,
                        cache_dir=cache_dir,
                        cache_namespace=_global_cache_namespace(cache_namespace),
                        selection_profile=normalized_selection_profile,
                        telemetry=telemetry,
                    )
                    global_highlights = finalize(global_result.get("highlights", []))
                    supplemental_global_highlights = list(
                        global_result.get("highlights", [])
                    )
                except Exception as error:
                    global_highlights = []
                    global_disposition = f"error:{type(error).__name__}"
                    use_chunks = True
                    if telemetry is not None:
                        telemetry.cache_miss("highlight_global_quality")
                    print(
                        "[highlights] full-transcript pass failed; falling back to chunks "
                        f"({type(error).__name__})",
                        flush=True,
                    )
                else:
                    accepted_global = False
                    if (
                        _is_micro_selection_profile(
                            normalized_selection_profile
                        )
                    ):
                        initial_decision = _rank_micro_candidates_for_decision(
                            global_highlights,
                            transcript,
                            num_clips,
                            normalized_selection_profile,
                        )
                        eligible_before = _coerce_int(
                            initial_decision.get("eligible_count")
                        )
                        selected_before = _coerce_int(
                            initial_decision.get("selected_count")
                        )
                        if _micro_batch_is_complete(initial_decision, num_clips):
                            accepted_global = True
                            highlights = initial_decision["ordered_highlights"]
                            global_disposition = "accepted-deterministic"
                            if telemetry is not None:
                                telemetry.cache_hit("highlight_deterministic_quality")
                        else:
                            if telemetry is not None:
                                telemetry.cache_miss("highlight_deterministic_quality")
                            print(
                                "[highlights] deterministic micro gate kept "
                                f"{eligible_before}/{num_clips}; merging timed chunks "
                                "before refinement",
                                flush=True,
                            )
                            global_disposition = "insufficient-before-chunk-union"
                    else:
                        accepted_global = _global_pass_has_quality_headroom(
                            global_highlights,
                            duration,
                            num_clips,
                            normalized_selection_profile,
                        )
                        if accepted_global:
                            highlights = global_highlights
                            global_disposition = "accepted"
                        else:
                            global_disposition = "low-headroom-or-diversity"
                            print(
                                "[highlights] full-transcript candidates lacked "
                                "quality headroom/diversity; falling back to chunks",
                                flush=True,
                            )
                    strategy = "global" if accepted_global else "chunks"
                    if telemetry is not None:
                        if accepted_global:
                            telemetry.cache_hit("highlight_global_quality")
                        else:
                            telemetry.cache_miss("highlight_global_quality")
                    use_chunks = not accepted_global
            else:
                use_chunks = True
                global_disposition = "ineligible"
        else:
            use_chunks = True
            global_disposition = "no-timed-chunks"

        if use_chunks:
            if not chunk_results and chunk_jobs:
                worker_count = _configured_llm_chunk_workers(len(chunk_jobs))
                print(
                    f"[highlights] analyzing chunks with {worker_count} worker"
                    f"{'s' if worker_count != 1 else ''}",
                    flush=True,
                )
                if worker_count == 1:
                    chunk_results = [analyze_chunk(job) for job in chunk_jobs]
                else:
                    with ThreadPoolExecutor(max_workers=worker_count) as executor:
                        # executor.map preserves source order despite concurrent calls.
                        chunk_results = list(executor.map(analyze_chunk, chunk_jobs))

            # Prefer whole-transcript candidates on exact score ties; chunk
            # duplicates may carry weaker local-context boundary metadata.
            all_highlights: List[Dict] = [
                dict(highlight) for highlight in supplemental_global_highlights
            ]
            for _, offset, result in chunk_results:
                for highlight in result.get("highlights", []):
                    adjusted = dict(highlight)
                    for key in (
                        "start_time",
                        "end_time",
                        "speech_start_time",
                        "speech_end_time",
                        "reaction_tail_start_time",
                    ):
                        if adjusted.get(key) is not None:
                            adjusted[key] = float(adjusted[key]) + offset
                    all_highlights.append(adjusted)
            highlights = finalize(all_highlights)
            if _is_micro_selection_profile(normalized_selection_profile):
                chunk_decision = _rank_micro_candidates_for_decision(
                    highlights,
                    transcript,
                    num_clips,
                    normalized_selection_profile,
                )
                eligible_before = _coerce_int(
                    chunk_decision.get("eligible_count")
                )
                selected_before = _coerce_int(
                    chunk_decision.get("selected_count")
                )
                if (
                    eligible_before < int(num_clips)
                    or selected_before < int(num_clips)
                ):
                    print(
                        "[highlights] merged chunk gate kept "
                        f"{eligible_before}/{num_clips}; trying one compact "
                        "near-miss refinement",
                        flush=True,
                    )
                    refinement_prompt = _build_refinement_prompt(
                        transcript,
                        content_info,
                        num_clips,
                        normalized_selection_profile,
                        chunk_decision,
                    )
                    eligible_after = eligible_before
                    refinement_outcome = "no-repairable-windows"
                    if refinement_prompt:
                        try:
                            refinement_result = _call_refinement_api(
                                refinement_prompt,
                                duration,
                                llm_fn,
                                cache_dir,
                                cache_namespace,
                                normalized_selection_profile,
                                telemetry,
                            )
                            refined_highlights = finalize(
                                refinement_result.get("highlights", [])
                            )
                            refined_decision = _rank_micro_candidates_for_decision(
                                highlights + refined_highlights,
                                transcript,
                                num_clips,
                                normalized_selection_profile,
                            )
                            eligible_after = _coerce_int(
                                refined_decision.get("eligible_count")
                            )
                            selected_after = _coerce_int(
                                refined_decision.get("selected_count")
                            )
                        except Exception as error:
                            refinement_outcome = f"error:{type(error).__name__}"
                            print(
                                "[highlights] merged-chunk refinement failed "
                                f"({type(error).__name__})",
                                flush=True,
                            )
                        else:
                            # Preserve every re-cut for the downstream visual ranker;
                            # deterministic eligibility still decides what may render.
                            highlights = refined_decision["ordered_highlights"]
                            if _micro_batch_is_complete(
                                refined_decision,
                                num_clips,
                            ):
                                refinement_outcome = "chunk-accepted"
                                global_disposition += "+chunk-refinement-accepted"
                                if telemetry is not None:
                                    telemetry.cache_hit(
                                        "highlight_refinement_quality"
                                    )
                            else:
                                refinement_outcome = "chunk-insufficient"
                                global_disposition += "+chunk-refinement-insufficient"
                                if telemetry is not None:
                                    telemetry.cache_miss(
                                        "highlight_refinement_quality"
                                    )
                                print(
                                    "[highlights] merged-chunk refinement kept only "
                                    f"{eligible_after}/{num_clips}",
                                    flush=True,
                                )
                    _record_refinement_outcome(
                        telemetry,
                        refinement_outcome,
                        eligible_before,
                        eligible_after,
                    )
            strategy = "chunks"
    else:
        text = build_transcript_text(transcript)
        result = call_highlight_api(
            text,
            content_info,
            duration,
            num_clips=num_clips,
            llm_fn=llm_fn,
            cache_dir=cache_dir,
            cache_namespace=cache_namespace,
            selection_profile=normalized_selection_profile,
            telemetry=telemetry,
        )
        highlights = finalize(result.get("highlights", []))

    final_batch_decision = None
    if _is_micro_selection_profile(normalized_selection_profile):
        final_decision = _rank_micro_candidates_for_decision(
            highlights,
            transcript,
            num_clips,
            normalized_selection_profile,
        )
        final_batch_decision = {
            "target_count": int(num_clips),
            "eligible_count": _coerce_int(
                final_decision.get("eligible_count")
            ),
            "selected_count": _coerce_int(
                final_decision.get("selected_count")
            ),
            "complete": _micro_batch_is_complete(
                final_decision,
                num_clips,
            ),
        }
        highlights = final_decision["ordered_highlights"]
        if (
            not allow_incomplete_batch
            and not _micro_batch_is_complete(final_decision, num_clips)
        ):
            eligible_count = _coerce_int(final_decision.get("eligible_count"))
            selected_count = _coerce_int(final_decision.get("selected_count"))
            raise IncompleteHighlightBatchError(
                "candidate completion exhausted before visual analysis: "
                f"eligible={eligible_count}, diverse={selected_count}, "
                f"target={int(num_clips)}"
            )

    discovery_result = {
        "content_info": content_info,
        "highlights": highlights,
    }
    if final_batch_decision is not None:
        discovery_result["batch_decision"] = final_batch_decision
    _write_discovery_cache(
        discovery_cache_path,
        transcript_identity,
        discovery_result,
        strategy,
        global_disposition,
    )
    _record_discovery_strategy(telemetry, strategy)
    return discovery_result
