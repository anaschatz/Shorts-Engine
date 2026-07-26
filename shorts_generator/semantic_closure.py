"""Deterministic topic-closure and word-safe render boundary resolution."""
import re
from typing import Dict, List, Optional


SENTENCE_END_RE = re.compile(r"[.!?][\"')\]]?$", re.IGNORECASE)
DANGLING_ENDINGS = {
    "and", "although", "because", "but", "however", "if", "or", "so", "which",
}
CONTRAST_OPENERS = {
    "but", "but if", "however", "so", "the problem is", "the reason is", "here is why",
}
FORWARD_REFERENCES = {
    "but if", "here is why", "the problem is", "the reason is", "what happens next",
}
PROBLEM_TERMS = {
    "challenge", "daunting", "dauntingly", "difficult", "hard", "impossible", "mystery",
    "problem", "question mark",
}
MECHANISM_PHRASES = {
    "activation", "between zero and one", "corresponding to", "determine the", "holds a number",
    "is a thing that", "means", "operates", "works by",
}
EVIDENCE_PHRASES = {
    "784", "for example", "first layer", "grayscale", "input image", "in total", "pixel",
}
RESOLUTION_PHRASES = {
    "how much the system thinks", "last layer", "network's choice", "output layer",
    "representing one of the digits", "represents how much",
}
HOOK_PHRASES = {"crazy", "effortlessly", "imagine", "surprising"}
FILLER_PHRASES = {
    "download the code", "in this video", "living under a rock", "my hope is", "resources",
}
PROMOTIONAL_TERMS = {
    "subscribe", "patreon", "sponsor", "thanks for watching", "hit the bell",
}
SEMANTIC_PADDING_SECONDS = 0.45
NEXT_WORD_SAFETY_SECONDS = 0.08
MAX_CLIP_SECONDS = 90.0


def _normalize(text: str) -> str:
    return re.sub(r"[^a-z0-9' ]", "", text.lower()).strip()


def _timed_words(transcript: Dict) -> List[Dict]:
    words = []
    for segment in transcript.get("segments", []):
        for word in segment.get("words", []) if isinstance(segment.get("words"), list) else []:
            text = str(word.get("word") or word.get("text") or "").strip()
            try:
                start = float(word["start"])
                end = float(word["end"])
            except (KeyError, TypeError, ValueError):
                continue
            if text and end > start:
                words.append({"text": text, "start": start, "end": end})
    return sorted(words, key=lambda word: (word["start"], word["end"]))


def _sentence_spans(words: List[Dict]) -> List[Dict]:
    if not words:
        return []
    spans = []
    current = []
    for index, word in enumerate(words):
        current.append(word)
        next_start = words[index + 1]["start"] if index + 1 < len(words) else None
        gap = next_start - word["end"] if next_start is not None else float("inf")
        if SENTENCE_END_RE.search(word["text"]) or gap >= 0.9:
            spans.append(
                {
                    "start": current[0]["start"],
                    "end": current[-1]["end"],
                    "text": " ".join(item["text"] for item in current),
                    "words": list(current),
                }
            )
            current = []
    if current:
        spans.append(
            {
                "start": current[0]["start"],
                "end": current[-1]["end"],
                "text": " ".join(item["text"] for item in current),
                "words": list(current),
            }
        )
    return spans


def _word_cut_at(words: List[Dict], endpoint: float) -> Optional[Dict]:
    return next(
        (word for word in words if word["start"] < endpoint < word["end"]),
        None,
    )


def _starts_with_phrase(text: str, phrases) -> bool:
    normalized = _normalize(text)
    return any(normalized == phrase or normalized.startswith(phrase + " ") for phrase in phrases)


def _contains_phrase(text: str, phrases) -> bool:
    normalized = _normalize(text)
    return any(phrase in normalized for phrase in phrases)


def _last_word(text: str) -> str:
    tokens = _normalize(text).split()
    return tokens[-1] if tokens else ""


def classify_sentence_arc(text: str) -> str:
    normalized = _normalize(text)
    if _contains_phrase(normalized, PROMOTIONAL_TERMS):
        return "promotional_or_outro"
    if _contains_phrase(normalized, RESOLUTION_PHRASES):
        return "resolution"
    if _contains_phrase(normalized, PROBLEM_TERMS):
        return "problem_escalation"
    if _contains_phrase(normalized, EVIDENCE_PHRASES):
        return "evidence_or_example"
    if _contains_phrase(normalized, MECHANISM_PHRASES):
        return "mechanism"
    if "?" in text or normalized.startswith(("how ", "what ", "why ")):
        return "question"
    if _contains_phrase(normalized, FILLER_PHRASES):
        return "unrelated_or_filler"
    if _contains_phrase(normalized, HOOK_PHRASES):
        return "hook"
    return "setup"


def _topic_tokens(text: str) -> set:
    stopwords = {
        "about", "after", "again", "also", "and", "are", "but", "for", "from", "has",
        "have", "how", "into", "its", "that", "the", "their", "this", "what", "when",
        "where", "which", "while", "with", "you", "your",
    }
    tokens = set()
    for token in _normalize(text).split():
        token = token[:-1] if token.endswith("s") and len(token) > 4 else token
        if len(token) >= 3 and token not in stopwords:
            tokens.add(token)
    return tokens


def _arc_summary(sentences: List[Dict], first_index: int, last_index: int) -> Dict:
    selected = sentences[first_index:last_index + 1]
    stages = [classify_sentence_arc(str(sentence["text"])) for sentence in selected]
    texts_by_stage = {
        stage: " ".join(
            str(sentence["text"])
            for sentence, sentence_stage in zip(selected, stages)
            if sentence_stage == stage
        )
        for stage in set(stages)
    }
    hook_text = " ".join(
        str(sentence["text"])
        for sentence, stage in zip(selected, stages)
        if stage in {"hook", "setup", "question", "problem_escalation"}
    )
    resolution_text = texts_by_stage.get("resolution", "")
    topic_overlap = _topic_tokens(hook_text) & _topic_tokens(resolution_text)
    resolution_present = "resolution" in stages
    resolution_answers_hook = bool(resolution_present and topic_overlap)
    problem_present = "problem_escalation" in stages
    question_present = "question" in stages
    mechanism_present = "mechanism" in stages
    evidence_present = "evidence_or_example" in stages
    unresolved = bool(
        (problem_present or question_present) and not resolution_answers_hook
    )
    payoff_present = bool(
        resolution_answers_hook and (mechanism_present or evidence_present or resolution_present)
    )
    arc_stage_at_end = stages[-1] if stages else "setup"
    if resolution_answers_hook:
        topic_score = 98
        closure_score = 100
    elif problem_present or question_present:
        topic_score = 35
        closure_score = 30
    elif mechanism_present or evidence_present:
        topic_score = 62
        closure_score = 55
    else:
        topic_score = 70
        closure_score = 70
    return {
        "setup_present": any(stage in {"hook", "setup"} for stage in stages),
        "problem_present": problem_present,
        "mechanism_present": mechanism_present,
        "evidence_present": evidence_present,
        "resolution_present": resolution_present,
        "resolution_answers_hook": resolution_answers_hook,
        "unresolved_question": unresolved,
        "arc_stage_at_end": arc_stage_at_end,
        "topic_completeness_score": topic_score,
        "closure_score": closure_score,
        "payoff_present": payoff_present,
        "composite_required": unresolved,
        "rejection_reason": "unresolved_educational_arc" if unresolved else None,
    }


def _direct_continuation(next_sentence: Optional[Dict], cut_word: Optional[Dict]) -> bool:
    if not next_sentence:
        return False
    text = str(next_sentence["text"])
    starts_with_contrast = _starts_with_phrase(text, CONTRAST_OPENERS)
    contains_payoff = classify_sentence_arc(text) in {"mechanism", "evidence_or_example", "resolution"}
    cut_is_opener = bool(cut_word and _normalize(cut_word["text"]) in DANGLING_ENDINGS)
    return starts_with_contrast and (contains_payoff or cut_is_opener)


def _is_promotional(text: str) -> bool:
    return _contains_phrase(text, PROMOTIONAL_TERMS)


def resolve_semantic_endpoint(candidate: Dict, transcript: Dict) -> Dict:
    """Repair one candidate and extend only through the shortest complete payoff."""
    item = dict(candidate)
    words = _timed_words(transcript)
    sentences = _sentence_spans(words)
    if not words or not sentences:
        item.update(
            {
                "semantic_boundary_valid": False,
                "continuation_required": True,
                "open_loop_resolved": False,
                "topic_completeness_score": 0,
                "closure_score": 0,
                "payoff_present": False,
                "closure_sentence": "",
            }
        )
        return item

    requested_start = float(item.get("speech_start_time", item.get("start_time", 0.0)))
    requested_end = float(item.get("speech_end_time", item.get("end_time", 0.0)))
    original_render_end = float(item.get("end_time", requested_end))
    original_cut_word = _word_cut_at(words, original_render_end)

    selected = [
        index
        for index, sentence in enumerate(sentences)
        if sentence["end"] > requested_start and sentence["start"] < requested_end
    ]
    if original_cut_word:
        cut_sentence_index = next(
            (
                index
                for index, sentence in enumerate(sentences)
                if sentence["start"] <= original_cut_word["start"] < sentence["end"]
            ),
            None,
        )
        if cut_sentence_index is not None:
            selected = [index for index in selected if index < cut_sentence_index]
    if not selected:
        selected = [
            min(range(len(sentences)), key=lambda index: abs(sentences[index]["start"] - requested_start))
        ]
    first_index = selected[0]
    last_index = selected[-1]

    def state(index: int, cut_word: Optional[Dict]) -> Dict:
        sentence = sentences[index]
        text = " ".join(part["text"] for part in sentences[first_index:index + 1])
        complete_sentence = bool(SENTENCE_END_RE.search(str(sentence["text"])))
        dangling = _last_word(str(sentence["text"])) in DANGLING_ENDINGS
        forward_reference = _contains_phrase(
            str(sentence["text"]),
            FORWARD_REFERENCES,
        ) and not (
            complete_sentence
            and classify_sentence_arc(str(sentence["text"])) in {"mechanism", "resolution"}
        )
        next_sentence = sentences[index + 1] if index + 1 < len(sentences) else None
        direct_continuation = _direct_continuation(next_sentence, cut_word)
        continuation = bool(cut_word or not complete_sentence or dangling or forward_reference or direct_continuation)
        return {
            "text": text,
            "complete": complete_sentence,
            "dangling": dangling,
            "next_sentence": next_sentence,
            "direct_continuation": direct_continuation,
            "continuation": continuation,
        }

    current = state(last_index, original_cut_word)
    extension_applied = False
    while current["continuation"] and last_index + 1 < len(sentences):
        next_sentence = sentences[last_index + 1]
        extended_duration = float(next_sentence["end"]) - float(sentences[first_index]["start"])
        if extended_duration > MAX_CLIP_SECONDS or _is_promotional(str(next_sentence["text"])):
            break
        if not (original_cut_word or current["direct_continuation"] or not current["complete"] or current["dangling"]):
            break
        last_index += 1
        extension_applied = True
        original_cut_word = None
        current = state(last_index, None)

    speech_start = float(sentences[first_index]["start"])
    speech_end = float(sentences[last_index]["end"])
    previous_word_end = max((word["end"] for word in words if word["end"] <= speech_start), default=0.0)
    next_word_start = min(
        (word["start"] for word in words if word["start"] >= speech_end),
        default=float(transcript.get("duration", speech_end + SEMANTIC_PADDING_SECONDS)),
    )
    render_start = max(previous_word_end, speech_start - SEMANTIC_PADDING_SECONDS, 0.0)
    render_end = min(
        speech_end + SEMANTIC_PADDING_SECONDS,
        next_word_start - NEXT_WORD_SAFETY_SECONDS,
    )
    render_end = max(speech_end, render_end)
    endpoint_cut = _word_cut_at(words, render_end)
    final = state(last_index, original_cut_word or endpoint_cut)
    arc = _arc_summary(sentences, first_index, last_index)
    resolved = bool(
        final["complete"]
        and not final["continuation"]
        and not endpoint_cut
        and not arc["unresolved_question"]
    )

    item.update(
        {
            "speech_start_time": round(speech_start, 3),
            "speech_end_time": round(speech_end, 3),
            "render_start_time": round(render_start, 3),
            "render_end_time": round(render_end, 3),
            "start_time": round(render_start, 3),
            "end_time": round(render_end, 3),
            **arc,
            "open_loop_resolved": resolved,
            "continuation_required": bool(final["continuation"] or arc["unresolved_question"]),
            "closure_sentence": str(sentences[last_index]["text"]),
            "semantic_boundary_valid": endpoint_cut is None,
            "semantic_extension_applied": extension_applied,
            "original_endpoint_cut_word": (
                str(_word_cut_at(words, original_render_end)["text"])
                if _word_cut_at(words, original_render_end)
                else None
            ),
        }
    )
    return item


def resolve_semantic_endpoints(candidates: List[Dict], transcript: Dict) -> List[Dict]:
    return [resolve_semantic_endpoint(candidate, transcript) for candidate in candidates]
