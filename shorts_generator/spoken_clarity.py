"""Sealed, fail-closed evidence for spoken hook, point, and delivery clarity.

The gate in this module is deliberately pure: it consumes exact timed words and
optional opening-ASR confidence evidence, derives deterministic observations,
and binds the result to source bytes, transcript timing, and one exact half-open
speech interval.  It never edits audio, removes disfluencies, or infers a
speaker's emotion or personality.  A non-passing result means "select another
source-contiguous clip".
"""

from __future__ import annotations

import json
import math
import re
from typing import Dict, Iterable, Mapping, Optional, Sequence, Tuple

from .artifact_contracts import ArtifactBindingError, content_hash, verify_seal


SPOKEN_CLARITY_REPORT_TYPE = "SpokenClarityReport"
SPOKEN_CLARITY_REPORT_SCHEMA_VERSION = 1
SPOKEN_CLARITY_DECISION_VERSION = "bf-spoken-clarity-v1.2.0"

OPENING_WINDOW_SECONDS = 2.0
OPENING_SIGNAL_MAX_WORDS = 8
OPENING_ANCHOR_MAX_WORDS = 12
SEARCHING_PAUSE_MIN_SECONDS = 0.8
ASR_LOW_CONFIDENCE_WORD_THRESHOLD = 0.65
ASR_REVIEW_MEAN_THRESHOLD = 0.78
ASR_REVIEW_LOW_RATIO_THRESHOLD = 0.25
ASR_REJECT_MEAN_THRESHOLD = 0.65
ASR_REJECT_LOW_RATIO_THRESHOLD = 0.40
ASR_TOKEN_MATCH_ALGORITHM = "token_levenshtein_max_length_v1"
ASR_TOKEN_MATCH_REVIEW_THRESHOLD = 0.72
HOOK_CLAIM_ALGORITHM = "conservative_two_part_early_claim_v1"

SPOKEN_CLARITY_POLICY = {
    "openingWindowSeconds": OPENING_WINDOW_SECONDS,
    "openingSignalMaxWords": OPENING_SIGNAL_MAX_WORDS,
    "openingAnchorMaxWords": OPENING_ANCHOR_MAX_WORDS,
    "searchingPauseMinSeconds": SEARCHING_PAUSE_MIN_SECONDS,
    "asrLowConfidenceWordThreshold": ASR_LOW_CONFIDENCE_WORD_THRESHOLD,
    "asrReviewMeanThreshold": ASR_REVIEW_MEAN_THRESHOLD,
    "asrReviewLowRatioThreshold": ASR_REVIEW_LOW_RATIO_THRESHOLD,
    "asrRejectMeanThreshold": ASR_REJECT_MEAN_THRESHOLD,
    "asrRejectLowRatioThreshold": ASR_REJECT_LOW_RATIO_THRESHOLD,
    "asrTokenMatchAlgorithm": ASR_TOKEN_MATCH_ALGORITHM,
    "asrTokenMatchReviewThreshold": ASR_TOKEN_MATCH_REVIEW_THRESHOLD,
    "hookClaimAlgorithm": HOOK_CLAIM_ALGORITHM,
    # A lexical disagreement can come from the reference transcript or the
    # opening-ASR provider, so V1.1 deliberately fails closed to REVIEW rather
    # than claiming that a very low ratio proves bad delivery.
    "asrTokenMatchRejectThreshold": None,
    "lowAsrTokenMatchDisposition": "review",
    "singleDisfluencyDisposition": "review",
    "repeatedDisfluencyDisposition": "reject",
    "singleSearchingPauseDisposition": "review",
    "repeatedSearchingPauseDisposition": "reject",
}

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)
_STATUS_VALUES = frozenset({"pass", "review", "reject"})

# These are observable lexical signals, not a claim to understand arbitrary
# language.  A candidate without one of these conservative early anchors cannot
# pass this first version of the feed-stop clarity gate.
_ACTION_WORDS = frozenset(
    {
        "ask",
        "avoid",
        "choose",
        "decide",
        "leave",
        "let",
        "listen",
        "notice",
        "protect",
        "remember",
        "say",
        "set",
        "start",
        "stop",
        "tell",
        "trust",
        "walk",
    }
)
_TENSION_WORDS = frozenset(
    {
        "afraid",
        "anxious",
        "anxiety",
        "betray",
        "conflict",
        "criticism",
        "criticize",
        "danger",
        "fear",
        "guilt",
        "hate",
        "hurt",
        "illness",
        "nervous",
        "pain",
        "poison",
        "rejection",
        "resentment",
        "risk",
        "wrong",
    }
)
_CONSEQUENCE_WORDS = frozenset(
    {
        "break",
        "cost",
        "die",
        "fail",
        "heal",
        "hurt",
        "lose",
        "lost",
        "poison",
        "regret",
        "win",
    }
)
_CONCRETE_WORDS = frozenset(
    {
        "body",
        "boundaries",
        "boundary",
        "criticism",
        "door",
        "face",
        "flower",
        "friend",
        "garden",
        "guilt",
        "illness",
        "money",
        "people",
        "person",
        "phone",
        "rejection",
        "relationship",
        "resentment",
        "room",
        "sentence",
        "table",
        "water",
        "word",
        "work",
    }
)
_GENERIC_CONCRETE_WORDS = frozenset({"people", "person", "work"})
_STRONG_CONTRAST_WORDS = frozenset(
    {"but", "instead", "opposite", "rather", "versus", "while", "yet"}
)

_ANCHOR_STOPWORDS = frozenset(
    {
        "a",
        "about",
        "after",
        "all",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "because",
        "been",
        "being",
        "but",
        "by",
        "can",
        "could",
        "did",
        "do",
        "does",
        "for",
        "from",
        "had",
        "has",
        "have",
        "he",
        "her",
        "here",
        "him",
        "his",
        "i",
        "if",
        "in",
        "is",
        "it",
        "its",
        "me",
        "my",
        "not",
        "of",
        "on",
        "or",
        "our",
        "she",
        "so",
        "some",
        "that",
        "the",
        "their",
        "them",
        "then",
        "there",
        "these",
        "they",
        "this",
        "those",
        "to",
        "up",
        "us",
        "was",
        "we",
        "were",
        "what",
        "when",
        "which",
        "who",
        "will",
        "with",
        "would",
        "you",
        "your",
    }
)
_GENERIC_ANCHOR_WORDS = frozenset(
    {
        "clear",
        "clearer",
        "feel",
        "feeling",
        "going",
        "happen",
        "know",
        "much",
        "okay",
        "really",
        "thing",
        "things",
        "way",
    }
)
_CONTINUATION_LEFT_WORDS = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "because",
        "but",
        "can",
        "could",
        "do",
        "does",
        "don't",
        "for",
        "from",
        "had",
        "has",
        "have",
        "if",
        "in",
        "is",
        "of",
        "or",
        "should",
        "that",
        "the",
        "to",
        "was",
        "were",
        "when",
        "which",
        "while",
        "will",
        "with",
        "would",
    }
)
_SENTENCE_OPENERS = frozenset({"anyway", "but", "now", "okay", "so", "then", "well"})


def _sha256(value: object, field: str) -> str:
    normalized = str(value or "").strip().lower().removeprefix("sha256:")
    if not _SHA256_RE.fullmatch(normalized):
        raise ArtifactBindingError(f"{field} must be a sha256 hash")
    return normalized


def _finite_number(value: object, field: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be finite") from error
    if not math.isfinite(number):
        raise ArtifactBindingError(f"{field} must be finite")
    return number


def _strict_json(value: object, field: str) -> object:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=True,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise ArtifactBindingError(f"{field} must be strict JSON") from error
    return json.loads(encoded)


def _provider_status(value: object) -> str:
    normalized = str(value or "").strip().lower().replace(" ", "_")
    if not normalized or not re.fullmatch(r"[a-z0-9_.:-]{1,96}", normalized):
        raise ArtifactBindingError("provider_status is invalid")
    return normalized


def _tokens(value: object) -> list[str]:
    return _TOKEN_RE.findall(
        str(value or "")
        .lower()
        .replace("’", "'")
        .replace("‘", "'")
        .replace("`", "'")
    )


def _normalise_reference_words(
    values: Iterable[object],
    *,
    speech_start: float,
    speech_end: float,
) -> list[Dict]:
    if isinstance(values, (str, bytes, Mapping)) or values is None:
        raise ArtifactBindingError("reference_words must be a list")
    output: list[Dict] = []
    try:
        iterator = iter(values)
    except TypeError as error:
        raise ArtifactBindingError("reference_words must be a list") from error
    for index, raw in enumerate(iterator):
        if not isinstance(raw, Mapping):
            raise ArtifactBindingError("reference word entries must be objects")
        text = str(raw.get("text") or raw.get("word") or "").strip()
        start = _finite_number(
            raw.get("startSeconds", raw.get("start")),
            f"reference_words[{index}].start",
        )
        end = _finite_number(
            raw.get("endSeconds", raw.get("end")),
            f"reference_words[{index}].end",
        )
        if (
            not text
            or not _tokens(text)
            or end <= start
            or start < speech_start - 1e-9
            or start >= speech_end
            or end > speech_end + 1e-9
        ):
            raise ArtifactBindingError("reference word is outside the speech interval")
        item: Dict[str, object] = {
            "text": text,
            "startSeconds": start,
            "endSeconds": end,
        }
        if raw.get("segmentIndex") is not None:
            segment_index = raw.get("segmentIndex")
            if isinstance(segment_index, bool):
                raise ArtifactBindingError("reference word segmentIndex is invalid")
            try:
                segment_index = int(segment_index)
            except (TypeError, ValueError) as error:
                raise ArtifactBindingError(
                    "reference word segmentIndex is invalid"
                ) from error
            if segment_index < 0:
                raise ArtifactBindingError("reference word segmentIndex is invalid")
            item["segmentIndex"] = segment_index
        if raw.get("sentenceBoundaryAfter") is not None:
            if type(raw.get("sentenceBoundaryAfter")) is not bool:
                raise ArtifactBindingError(
                    "reference word sentenceBoundaryAfter must be boolean"
                )
            item["sentenceBoundaryAfter"] = raw["sentenceBoundaryAfter"]
        output.append(item)
    output.sort(
        key=lambda word: (
            float(word["startSeconds"]),
            float(word["endSeconds"]),
            str(word["text"]),
        )
    )
    return output


def _normalise_asr_words(
    values: Optional[Iterable[object]],
    *,
    speech_start: float,
    speech_end: float,
) -> list[Dict]:
    if values is None:
        return []
    if isinstance(values, (str, bytes, Mapping)):
        raise ArtifactBindingError("opening_asr_words must be a list")
    output: list[Dict] = []
    opening_end = min(speech_end, speech_start + OPENING_WINDOW_SECONDS)
    try:
        iterator = iter(values)
    except TypeError as error:
        raise ArtifactBindingError("opening_asr_words must be a list") from error
    for index, raw in enumerate(iterator):
        if not isinstance(raw, Mapping):
            raise ArtifactBindingError("opening ASR entries must be objects")
        text = str(raw.get("text") or raw.get("word") or "").strip()
        confidence = _finite_number(
            raw.get("confidence", raw.get("probability")),
            f"opening_asr_words[{index}].confidence",
        )
        if not text or not _tokens(text) or not 0.0 <= confidence <= 1.0:
            raise ArtifactBindingError("opening ASR word is invalid")
        item: Dict[str, object] = {"text": text, "confidence": confidence}
        start_value = raw.get("startSeconds", raw.get("start"))
        end_value = raw.get("endSeconds", raw.get("end"))
        if (start_value is None) != (end_value is None):
            raise ArtifactBindingError("opening ASR timing requires start and end")
        if start_value is not None:
            start = _finite_number(
                start_value,
                f"opening_asr_words[{index}].start",
            )
            end = _finite_number(
                end_value,
                f"opening_asr_words[{index}].end",
            )
            if (
                end <= start
                or start < speech_start - 1e-9
                or start >= opening_end
                or end > opening_end + 1e-9
            ):
                raise ArtifactBindingError(
                    "opening ASR timing is outside the opening window"
                )
            item.update({"startSeconds": start, "endSeconds": end})
        output.append(item)
    return output


def _flatten_words(words: Sequence[Mapping[str, object]]) -> list[Dict]:
    flattened: list[Dict] = []
    for word_index, word in enumerate(words):
        for token in _tokens(word.get("text")):
            flattened.append(
                {
                    "token": token,
                    "text": str(word["text"]),
                    "startSeconds": float(word["startSeconds"]),
                    "endSeconds": float(word["endSeconds"]),
                    "wordIndex": word_index,
                }
            )
    return flattened


def _opening_tokens(tokens: Sequence[Dict], maximum_words: int) -> list[Dict]:
    if not tokens:
        return []
    origin = float(tokens[0]["startSeconds"])
    return [
        dict(token)
        for token in tokens
        if float(token["startSeconds"]) - origin <= OPENING_WINDOW_SECONDS + 1e-9
    ][:maximum_words]


def _first_tokens(tokens: Sequence[Dict], maximum_words: int) -> list[Dict]:
    """Return the lexical hook window; ASR keeps its separate two-second window."""

    return [dict(token) for token in tokens[:maximum_words]]


def _reference_tokens_in_opening_window(
    words: Sequence[Mapping[str, object]],
    *,
    speech_start: float,
    speech_end: float,
) -> list[str]:
    """Return tokens whose onset is in the exact half-open opening window."""

    opening_end = min(speech_end, speech_start + OPENING_WINDOW_SECONDS)
    output: list[str] = []
    for word in words:
        start = float(word["startSeconds"])
        if speech_start <= start < opening_end:
            output.extend(_tokens(word.get("text")))
    return output


def _token_edit_distance(left: Sequence[str], right: Sequence[str]) -> int:
    """Compute deterministic Levenshtein distance over normalized tokens."""

    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for left_index, left_token in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_token in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1]
                    + (left_token != right_token),
                )
            )
        previous = current
    return previous[-1]


def _stem(token: str) -> str:
    value = token.removesuffix("'s")
    if len(value) > 6 and value.endswith("ing"):
        value = value[:-3]
    elif len(value) > 5 and value.endswith("ied"):
        value = value[:-3] + "y"
    elif len(value) > 5 and value.endswith("ed"):
        value = value[:-2]
    elif (
        len(value) > 4
        and value.endswith("s")
        and not value.endswith(("ss", "us", "is"))
    ):
        value = value[:-1]
    return value


def _claim_part(
    item: Mapping[str, object],
    *,
    role: str,
    families: Sequence[str],
) -> Dict:
    """Return one canonical, source-timed part of an early spoken claim."""

    return {
        "role": role,
        "families": sorted(set(families)),
        "token": str(item["token"]),
        "wordIndex": int(item["wordIndex"]),
        "startSeconds": float(item["startSeconds"]),
        "endSeconds": float(item["endSeconds"]),
    }


def _hook_claim(opening: Sequence[Dict]) -> Optional[Dict]:
    """Detect a conservative two-part claim in the first eight words.

    A single topical or action-like token is intentionally insufficient.  The
    accepted structures bind two distinct timed words: a strong topic plus a
    lexical predicate/contrast, two separate tension-or-consequence anchors,
    or an opening imperative plus a non-generic concrete object.  This keeps
    auxiliaries and generic vocabulary (``don't``, ``do``, ``work``,
    ``people``) from manufacturing a hook on their own.
    """

    if not opening:
        return None

    enriched = []
    for position, item in enumerate(opening):
        token = str(item["token"])
        base = _stem(token)
        tension = token in _TENSION_WORDS or base in _TENSION_WORDS
        consequence = token in _CONSEQUENCE_WORDS or base in _CONSEQUENCE_WORDS
        concrete = (
            (token in _CONCRETE_WORDS or base in _CONCRETE_WORDS)
            and token not in _GENERIC_CONCRETE_WORDS
            and base not in _GENERIC_CONCRETE_WORDS
        )
        action = token in _ACTION_WORDS or base in _ACTION_WORDS
        contrast = token in _STRONG_CONTRAST_WORDS
        enriched.append(
            {
                "item": item,
                "position": position,
                "tension": tension,
                "consequence": consequence,
                "concrete": concrete,
                "action": action,
                "contrast": contrast,
            }
        )

    topics = [
        entry
        for entry in enriched
        if entry["tension"] or entry["consequence"] or entry["concrete"]
    ]
    predicates = [
        entry for entry in enriched if entry["action"] or entry["contrast"]
    ]
    for predicate in predicates:
        topic = next(
            (
                candidate
                for candidate in topics
                if candidate["position"] != predicate["position"]
            ),
            None,
        )
        if topic is None:
            continue
        predicate_families = []
        if predicate["action"]:
            predicate_families.append("lexical_action")
        if predicate["contrast"]:
            predicate_families.append("contrast")
        topic_families = []
        if topic["tension"]:
            topic_families.append("tension")
        if topic["consequence"]:
            topic_families.append("consequence")
        if topic["concrete"]:
            topic_families.append("concrete_subject")
        return {
            "present": True,
            "algorithm": HOOK_CLAIM_ALGORITHM,
            "pattern": "topic_plus_predicate_or_contrast",
            # Keep the V1 evidence summary useful to existing diagnostics while
            # requiring the canonical two-part ``parts`` proof below.
            "family": (
                "actionable_claim" if predicate["action"] else "contrast"
            ),
            "token": str(predicate["item"]["token"]),
            "wordIndex": int(predicate["item"]["wordIndex"]),
            "startSeconds": float(predicate["item"]["startSeconds"]),
            "endSeconds": float(predicate["item"]["endSeconds"]),
            "parts": [
                _claim_part(
                    topic["item"],
                    role="topic",
                    families=topic_families,
                ),
                _claim_part(
                    predicate["item"],
                    role="predicate",
                    families=predicate_families,
                ),
            ],
        }

    tension_or_consequence = [
        entry
        for entry in enriched
        if entry["tension"] or entry["consequence"]
    ]
    anchor_pair = None
    for first_index, first in enumerate(tension_or_consequence):
        first_base = _stem(str(first["item"]["token"]))
        second = next(
            (
                candidate
                for candidate in tension_or_consequence[first_index + 1 :]
                if _stem(str(candidate["item"]["token"])) != first_base
            ),
            None,
        )
        if second is not None:
            anchor_pair = (first, second)
            break
    if anchor_pair is not None:
        first, second = anchor_pair

        def anchor_families(entry: Mapping[str, object]) -> list[str]:
            families = []
            if entry["tension"]:
                families.append("tension")
            if entry["consequence"]:
                families.append("consequence")
            return families

        return {
            "present": True,
            "algorithm": HOOK_CLAIM_ALGORITHM,
            "pattern": "two_tension_or_consequence_anchors",
            "family": "tension_pair",
            "token": str(first["item"]["token"]),
            "wordIndex": int(first["item"]["wordIndex"]),
            "startSeconds": float(first["item"]["startSeconds"]),
            "endSeconds": float(first["item"]["endSeconds"]),
            "parts": [
                _claim_part(
                    first["item"],
                    role="anchor",
                    families=anchor_families(first),
                ),
                _claim_part(
                    second["item"],
                    role="anchor",
                    families=anchor_families(second),
                ),
            ],
        }

    # The general topic+predicate path already recognizes most imperatives.
    # This explicit shape makes the contract auditable and requires the action
    # to open the utterance (optionally after "don't") and its concrete object
    # to follow it.  Generic objects never qualify.
    first_position = 1 if str(opening[0]["token"]) == "don't" else 0
    if first_position < len(enriched):
        imperative = enriched[first_position]
        concrete_object = next(
            (
                entry
                for entry in enriched[first_position + 1 :]
                if entry["concrete"]
            ),
            None,
        )
        if imperative["action"] and concrete_object is not None:
            return {
                "present": True,
                "algorithm": HOOK_CLAIM_ALGORITHM,
                "pattern": "imperative_plus_concrete_object",
                "family": "actionable_claim",
                "token": str(imperative["item"]["token"]),
                "wordIndex": int(imperative["item"]["wordIndex"]),
                "startSeconds": float(imperative["item"]["startSeconds"]),
                "endSeconds": float(imperative["item"]["endSeconds"]),
                "parts": [
                    _claim_part(
                        imperative["item"],
                        role="imperative",
                        families=["lexical_action"],
                    ),
                    _claim_part(
                        concrete_object["item"],
                        role="object",
                        families=["concrete_object"],
                    ),
                ],
            }
    return None


def _anchor_stems(tokens: Sequence[Dict]) -> set[str]:
    return {
        _stem(str(item["token"]))
        for item in tokens
        if str(item["token"]) not in _ANCHOR_STOPWORDS
        and str(item["token"]) not in _GENERIC_ANCHOR_WORDS
        and len(_stem(str(item["token"]))) >= 3
    }


def _phrase_span(tokens: Sequence[Dict], phrase: object) -> Optional[Tuple[int, int]]:
    phrase_tokens = _tokens(phrase)
    if not phrase_tokens or len(phrase_tokens) > len(tokens):
        return None
    matches = []
    for index in range(len(tokens) - len(phrase_tokens) + 1):
        if [
            str(item["token"])
            for item in tokens[index : index + len(phrase_tokens)]
        ] == phrase_tokens:
            matches.append((index, index + len(phrase_tokens) - 1))
    return matches[-1] if matches else None


def _adjacent_duplicates(tokens: Sequence[Dict]) -> list[Dict]:
    events = []
    for index in range(len(tokens) - 1):
        left = tokens[index]
        right = tokens[index + 1]
        if left["token"] != right["token"]:
            continue
        events.append(
            {
                "text": f"{left['text']} {right['text']}",
                "token": str(left["token"]),
                "startSeconds": float(left["startSeconds"]),
                "endSeconds": float(right["endSeconds"]),
                "startTokenIndex": index,
                "endTokenIndex": index + 1,
            }
        )
    return events


def _repeated_phrase_restarts(tokens: Sequence[Dict]) -> list[Dict]:
    values = [str(item["token"]) for item in tokens]
    events = []
    occupied: set[int] = set()
    index = 0
    while index < len(values):
        match = None
        for width in range(4, 1, -1):
            if index + 2 * width > len(values):
                continue
            if values[index : index + width] == values[index + width : index + 2 * width]:
                match = width
                break
        if match is None:
            index += 1
            continue
        indexes = set(range(index, index + 2 * match))
        if not indexes & occupied:
            first = tokens[index]
            last = tokens[index + 2 * match - 1]
            phrase = " ".join(values[index : index + match])
            events.append(
                {
                    "phrase": phrase,
                    "widthTokens": match,
                    "startSeconds": float(first["startSeconds"]),
                    "endSeconds": float(last["endSeconds"]),
                    "startTokenIndex": index,
                    "endTokenIndex": index + 2 * match - 1,
                }
            )
            occupied.update(indexes)
        index += 2 * match
    return events


def _searching_pauses(words: Sequence[Mapping[str, object]]) -> list[Dict]:
    events = []
    for left, right in zip(words, words[1:]):
        gap = float(right["startSeconds"]) - float(left["endSeconds"])
        if gap + 1e-9 < SEARCHING_PAUSE_MIN_SECONDS:
            continue
        left_text = str(left["text"]).strip()
        left_tokens = _tokens(left_text)
        right_tokens = _tokens(right.get("text"))
        if not left_tokens or not right_tokens:
            continue
        boundary = bool(left.get("sentenceBoundaryAfter")) or bool(
            re.search(r"[.!?][\"')\]]*$", left_text)
        )
        if boundary:
            continue
        same_segment = (
            left.get("segmentIndex") is not None
            and left.get("segmentIndex") == right.get("segmentIndex")
        )
        incomplete_left = left_tokens[-1] in _CONTINUATION_LEFT_WORDS
        if not same_segment and not incomplete_left:
            continue
        if right_tokens[0] in _SENTENCE_OPENERS and not incomplete_left:
            continue
        events.append(
            {
                "afterText": left_text,
                "beforeText": str(right["text"]),
                "startSeconds": float(left["endSeconds"]),
                "endSeconds": float(right["startSeconds"]),
                "durationSeconds": round(gap, 6),
            }
        )
    return events


def _asr_measurements(
    words: Sequence[Mapping[str, object]],
    reference_tokens: Sequence[str],
) -> Dict:
    confidences = [float(word["confidence"]) for word in words]
    asr_tokens = [
        token
        for word in words
        for token in _tokens(word.get("text"))
    ]
    alignment_available = bool(reference_tokens) and bool(asr_tokens)
    edit_distance = (
        _token_edit_distance(reference_tokens, asr_tokens)
        if alignment_available
        else None
    )
    token_match_ratio = (
        round(
            max(
                0.0,
                1.0
                - float(edit_distance)
                / max(len(reference_tokens), len(asr_tokens)),
            ),
            6,
        )
        if edit_distance is not None
        else None
    )
    low_count = sum(
        value < ASR_LOW_CONFIDENCE_WORD_THRESHOLD for value in confidences
    )
    return {
        "available": bool(confidences),
        "wordCount": len(confidences),
        "meanWordConfidence": (
            round(sum(confidences) / len(confidences), 6)
            if confidences
            else None
        ),
        "lowConfidenceWordCount": low_count,
        "lowConfidenceWordRatio": (
            round(low_count / len(confidences), 6) if confidences else None
        ),
        "tokenMatchAlgorithm": ASR_TOKEN_MATCH_ALGORITHM,
        "tokenAlignmentAvailable": alignment_available,
        "referenceTokenCount": len(reference_tokens),
        "asrTokenCount": len(asr_tokens),
        "tokenEditDistance": edit_distance,
        "tokenMatchRatio": token_match_ratio,
    }


def _unique(values: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _decision(
    *,
    provider_status: str,
    reference_word_count: int,
    hook_signal: Optional[Mapping[str, object]],
    point_quote: str,
    point_aligned: bool,
    anchor_count: int,
    adjacent_duplicate_count: int,
    repeated_phrase_count: int,
    searching_pause_count: int,
    asr: Mapping[str, object],
) -> tuple[str, list[str], list[str]]:
    rejects: list[str] = []
    reviews: list[str] = []
    if reference_word_count == 0:
        rejects.append("spoken_clarity_reference_words_missing")
    if hook_signal is None:
        rejects.append("spoken_clarity_hook_subject_or_claim_missing")
    if not point_quote:
        rejects.append("spoken_clarity_point_quote_missing")
    elif not point_aligned:
        rejects.append("spoken_clarity_point_quote_unaligned")
    elif anchor_count == 0:
        rejects.append("spoken_clarity_opening_point_anchor_missing")

    disfluency_count = adjacent_duplicate_count + repeated_phrase_count
    if disfluency_count >= 2:
        rejects.append("spoken_clarity_repeated_disfluencies")
    elif disfluency_count == 1:
        reviews.append("spoken_clarity_single_disfluency")
    if searching_pause_count >= 2:
        rejects.append("spoken_clarity_repeated_searching_pauses")
    elif searching_pause_count == 1:
        reviews.append("spoken_clarity_single_searching_pause")

    if provider_status != "ok":
        reviews.append("spoken_clarity_provider_not_ok")
    elif not asr.get("available"):
        reviews.append("spoken_clarity_opening_asr_evidence_missing")
    else:
        mean = float(asr["meanWordConfidence"])
        ratio = float(asr["lowConfidenceWordRatio"])
        if mean < ASR_REJECT_MEAN_THRESHOLD or ratio > ASR_REJECT_LOW_RATIO_THRESHOLD:
            rejects.append("spoken_clarity_opening_asr_severely_unclear")
        elif mean < ASR_REVIEW_MEAN_THRESHOLD or ratio > ASR_REVIEW_LOW_RATIO_THRESHOLD:
            reviews.append("spoken_clarity_opening_asr_uncertain")
        token_match_ratio = asr.get("tokenMatchRatio")
        if token_match_ratio is None:
            reviews.append("spoken_clarity_opening_asr_alignment_unavailable")
        elif float(token_match_ratio) < ASR_TOKEN_MATCH_REVIEW_THRESHOLD:
            reviews.append("spoken_clarity_opening_asr_token_mismatch")

    rejects = _unique(rejects)
    reviews = _unique(reviews)
    if rejects:
        return "reject", rejects, reviews
    if reviews:
        return "review", [], reviews
    return "pass", [], []


def evaluate_spoken_clarity_evidence(
    *,
    source_hash: str,
    transcript_timing_hash: str,
    speech_start: float,
    speech_end: float,
    reference_words: Iterable[object],
    point_exact_quote: str,
    opening_asr_words: Optional[Iterable[object]],
    provider_status: str = "ok",
    provider_identity: Optional[object] = None,
) -> Dict:
    """Build one sealed spoken-clarity decision from measured evidence."""

    normalized_source_hash = _sha256(source_hash, "source_hash")
    normalized_transcript_hash = _sha256(
        transcript_timing_hash,
        "transcript_timing_hash",
    )
    start = _finite_number(speech_start, "speech_start")
    end = _finite_number(speech_end, "speech_end")
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("speech interval is invalid")
    status_value = _provider_status(provider_status)
    identity = _strict_json(provider_identity, "provider_identity")
    words = _normalise_reference_words(
        reference_words,
        speech_start=start,
        speech_end=end,
    )
    asr_words = _normalise_asr_words(
        opening_asr_words,
        speech_start=start,
        speech_end=end,
    )
    point_quote = str(point_exact_quote or "").strip()
    tokens = _flatten_words(words)
    opening_signal_tokens = _first_tokens(tokens, OPENING_SIGNAL_MAX_WORDS)
    opening_anchor_tokens = _opening_tokens(tokens, OPENING_ANCHOR_MAX_WORDS)
    signal = _hook_claim(opening_signal_tokens)
    point_span = _phrase_span(tokens, point_quote)
    point_tokens = (
        tokens[point_span[0] : point_span[1] + 1]
        if point_span is not None
        else []
    )
    opening_stems = _anchor_stems(opening_anchor_tokens)
    point_stems = _anchor_stems(point_tokens)
    anchors = sorted(opening_stems & point_stems)
    duplicates = _adjacent_duplicates(tokens)
    phrase_restarts = _repeated_phrase_restarts(tokens)
    pauses = _searching_pauses(words)
    opening_reference_tokens = _reference_tokens_in_opening_window(
        words,
        speech_start=start,
        speech_end=end,
    )
    asr = _asr_measurements(asr_words, opening_reference_tokens)
    decision, rejection_reasons, review_reasons = _decision(
        provider_status=status_value,
        reference_word_count=len(words),
        hook_signal=signal,
        point_quote=point_quote,
        point_aligned=point_span is not None,
        anchor_count=len(anchors),
        adjacent_duplicate_count=len(duplicates),
        repeated_phrase_count=len(phrase_restarts),
        searching_pause_count=len(pauses),
        asr=asr,
    )

    payload = {
        "schemaVersion": SPOKEN_CLARITY_REPORT_SCHEMA_VERSION,
        "artifactType": SPOKEN_CLARITY_REPORT_TYPE,
        "decisionVersion": SPOKEN_CLARITY_DECISION_VERSION,
        "sourceHash": normalized_source_hash,
        "transcriptTimingHash": normalized_transcript_hash,
        "speechInterval": {
            "startSeconds": start,
            "endSeconds": end,
            "semantics": "half-open",
        },
        "providerStatus": status_value,
        "providerIdentity": identity,
        "policy": dict(SPOKEN_CLARITY_POLICY),
        "inputs": {
            "referenceWords": words,
            "pointExactQuote": point_quote,
            "openingAsrWords": asr_words,
        },
        "evidence": {
            "openingWords": [
                {
                    "text": item["text"],
                    "token": item["token"],
                    "startSeconds": item["startSeconds"],
                    "endSeconds": item["endSeconds"],
                }
                for item in opening_signal_tokens
            ],
            "hookSubjectOrClaim": signal or {"present": False},
            "pointExactQuoteAligned": point_span is not None,
            "pointTokenSpan": (
                {"startTokenIndex": point_span[0], "endTokenIndex": point_span[1]}
                if point_span is not None
                else None
            ),
            "openingPointAnchorTokens": anchors,
            "adjacentDuplicates": duplicates,
            "repeatedPhraseRestarts": phrase_restarts,
            "searchingInternalPauses": pauses,
            "openingAsr": asr,
        },
        "counts": {
            "referenceWords": len(words),
            "openingWords": len(opening_signal_tokens),
            "openingPointAnchors": len(anchors),
            "adjacentDuplicates": len(duplicates),
            "repeatedPhraseRestarts": len(phrase_restarts),
            "searchingInternalPauses": len(pauses),
            "disfluencies": len(duplicates) + len(phrase_restarts),
        },
        "status": decision,
        "eligible": decision == "pass",
        "rejectionReasons": rejection_reasons,
        "reviewReasons": review_reasons,
        "deterministicReasons": rejection_reasons + review_reasons,
        "audioHandling": {
            "sourceAudioModified": False,
            "disfluenciesRemoved": False,
            "affectInferenceUsed": False,
            "policy": "select_another_source_contiguous_clip",
        },
    }
    return {**payload, "contentHash": content_hash(payload)}


def verify_spoken_clarity_report(
    report: Dict,
    source_hash: Optional[str] = None,
    transcript_timing_hash: Optional[str] = None,
    speech_interval: Optional[Sequence[float]] = None,
    require_pass: bool = False,
) -> Dict:
    """Verify seal, provenance, canonical evidence, and deterministic decision."""

    verified = verify_seal(report, SPOKEN_CLARITY_REPORT_TYPE)
    if (
        verified.get("schemaVersion") != SPOKEN_CLARITY_REPORT_SCHEMA_VERSION
        or verified.get("decisionVersion") != SPOKEN_CLARITY_DECISION_VERSION
    ):
        raise ArtifactBindingError("unsupported spoken-clarity report version")
    actual_source_hash = _sha256(verified.get("sourceHash"), "report.sourceHash")
    actual_transcript_hash = _sha256(
        verified.get("transcriptTimingHash"),
        "report.transcriptTimingHash",
    )
    if source_hash is not None and actual_source_hash != _sha256(
        source_hash,
        "source_hash",
    ):
        raise ArtifactBindingError("spoken-clarity report references another source")
    if transcript_timing_hash is not None and actual_transcript_hash != _sha256(
        transcript_timing_hash,
        "transcript_timing_hash",
    ):
        raise ArtifactBindingError("spoken-clarity report references another transcript")
    interval = verified.get("speechInterval")
    if not isinstance(interval, dict) or interval.get("semantics") != "half-open":
        raise ArtifactBindingError("spoken-clarity interval contract is invalid")
    start = _finite_number(interval.get("startSeconds"), "report.speechInterval.start")
    end = _finite_number(interval.get("endSeconds"), "report.speechInterval.end")
    if start < 0.0 or end <= start:
        raise ArtifactBindingError("spoken-clarity interval is invalid")
    if speech_interval is not None:
        if len(speech_interval) != 2:
            raise ArtifactBindingError("speech_interval must contain start and end")
        expected_interval = (
            _finite_number(speech_interval[0], "speech_interval.start"),
            _finite_number(speech_interval[1], "speech_interval.end"),
        )
        if (start, end) != expected_interval:
            raise ArtifactBindingError("spoken-clarity report interval is stale")
    inputs = verified.get("inputs")
    if not isinstance(inputs, dict) or set(inputs) != {
        "referenceWords",
        "pointExactQuote",
        "openingAsrWords",
    }:
        raise ArtifactBindingError("spoken-clarity inputs are invalid")
    expected = evaluate_spoken_clarity_evidence(
        source_hash=actual_source_hash,
        transcript_timing_hash=actual_transcript_hash,
        speech_start=start,
        speech_end=end,
        reference_words=inputs["referenceWords"],
        point_exact_quote=inputs["pointExactQuote"],
        opening_asr_words=inputs["openingAsrWords"],
        provider_status=verified.get("providerStatus"),
        provider_identity=verified.get("providerIdentity"),
    )
    if expected != verified:
        raise ArtifactBindingError("spoken-clarity report is not canonical")
    if verified.get("status") not in _STATUS_VALUES:
        raise ArtifactBindingError("spoken-clarity status is invalid")
    if require_pass and verified.get("status") != "pass":
        raise ArtifactBindingError("spoken-clarity report is not eligible")
    return verified


__all__ = [
    "ASR_LOW_CONFIDENCE_WORD_THRESHOLD",
    "ASR_REJECT_LOW_RATIO_THRESHOLD",
    "ASR_REJECT_MEAN_THRESHOLD",
    "ASR_REVIEW_LOW_RATIO_THRESHOLD",
    "ASR_REVIEW_MEAN_THRESHOLD",
    "ASR_TOKEN_MATCH_ALGORITHM",
    "ASR_TOKEN_MATCH_REVIEW_THRESHOLD",
    "HOOK_CLAIM_ALGORITHM",
    "OPENING_ANCHOR_MAX_WORDS",
    "OPENING_SIGNAL_MAX_WORDS",
    "OPENING_WINDOW_SECONDS",
    "SEARCHING_PAUSE_MIN_SECONDS",
    "SPOKEN_CLARITY_DECISION_VERSION",
    "SPOKEN_CLARITY_POLICY",
    "SPOKEN_CLARITY_REPORT_SCHEMA_VERSION",
    "SPOKEN_CLARITY_REPORT_TYPE",
    "evaluate_spoken_clarity_evidence",
    "verify_spoken_clarity_report",
]
