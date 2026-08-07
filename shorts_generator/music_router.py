"""Pure, deterministic semantic music selection with explicit rotation history.

The router performs no network access, keeps no mutable history, and never
infers a track from a fixed opening-word window.  It verifies the exact sealed
catalog and local asset identities, scores the complete selected point, then
applies the versioned anti-repeat policy supplied by the caller.
"""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from pathlib import Path, PurePosixPath
from typing import Dict, Iterable, List, Mapping, Optional, Sequence, Tuple


MUSIC_CATALOG_VERSION = "bf_viral_music_catalog_v1.0.0"
MUSIC_CATALOG_CONTENT_HASH = (
    "1da9ba63494e686aa3f55d3e0edd1175e233a480fd57171f6b770ef280cbf05c"
)
MUSIC_ROUTER_DECISION_VERSION = "bf_semantic_music_router_v1.0.0"
MUSIC_ROTATION_POLICY_VERSION = "bf_music_rotation_v1.0.0"
MUSIC_ROTATION_WINDOW_SIZE = 5
MUSIC_ROTATION_LOOKBACK = 4
MUSIC_ROUTING_SCHEMA_VERSION = 1
MUSIC_CATALOG_SCHEMA_VERSION = 1

DEFAULT_MUSIC_CATALOG_PATH = (
    Path(__file__).resolve().parents[1] / "assets" / "music" / "catalog.v1.json"
)

_SHA256_RE = re.compile(r"[0-9a-f]{64}")
_SLUG_RE = re.compile(r"[a-z0-9]+(?:[_-][a-z0-9]+)*")
_TRACK_ID_RE = re.compile(r"[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*")
_TOKEN_RE = re.compile(r"[a-z0-9]+(?:'[a-z0-9]+)?", re.IGNORECASE)
_HTTPS_RE = re.compile(r"https://[^\s]+")
_RETRIEVED_AT_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")
_TREATMENT_PROFILES = frozenset({"reflective", "driving", "warm"})

_CATALOG_KEYS = frozenset(
    {
        "schemaVersion",
        "artifactType",
        "catalogVersion",
        "contentHash",
        "licenseUrl",
        "retrievedAt",
        "sourceReplacement",
        "tracks",
    }
)
_SOURCE_REPLACEMENT_KEYS = frozenset(
    {"explicit", "requestedTrack", "replacementTrackId", "note"}
)
_REQUESTED_TRACK_KEYS = frozenset(
    {"title", "sourcePageUrl", "pixabayContentId"}
)
_TRACK_KEYS = frozenset(
    {
        "trackId",
        "relativePath",
        "title",
        "creator",
        "sourcePageUrl",
        "contentUrl",
        "licenseUrl",
        "sha256",
        "byteLength",
        "durationSeconds",
        "codec",
        "sampleRate",
        "channels",
        "aiGenerated",
        "contentIdRegistered",
        "semanticFamilies",
        "treatmentProfile",
        "recommendedOffsetSeconds",
        "catalogOrder",
    }
)
_DECISION_KEYS = frozenset(
    {
        "schemaVersion",
        "artifactType",
        "routerVersion",
        "catalogVersion",
        "catalogContentHash",
        "rotationVersion",
        "rotationPolicy",
        "semanticInputHash",
        "trackId",
        "semanticFamily",
        "treatmentProfile",
        "startSeconds",
        "recentWindowHash",
        "recentTrackIds",
        "reservedTrackIds",
        "scores",
        "reasons",
        "catalogTrack",
        "contentHash",
    }
)

# Semantic evidence is taken from the complete candidate, with the point and
# payoff deliberately weighted above the opening.  Aliases are grouped so the
# same evidence cannot be counted twice merely because integration emitted
# both snake_case and camelCase forms.
_SEMANTIC_FIELD_GROUPS: Tuple[Tuple[str, Tuple[str, ...], float], ...] = (
    ("topic", ("hook_semantic_topic", "hookSemanticTopic", "topic"), 5.0),
    (
        "opening_claim",
        ("opening_claim_summary", "openingClaimSummary"),
        3.0,
    ),
    ("whole_point", ("whole_point_summary", "wholePointSummary"), 8.0),
    (
        "payoff",
        ("payoff_exact_quote", "payoffExactQuote", "strong_point_phrase"),
        7.0,
    ),
    (
        "takeaway",
        ("final_takeaway_sentence", "finalTakeawaySentence", "listener_payoff"),
        6.0,
    ),
    ("thesis", ("thesis",), 6.0),
    ("context", ("context_summary", "contextSummary"), 4.0),
    (
        "opening",
        (
            "opening_unit_exact_quote",
            "openingUnitExactQuote",
            "topic_comprehension_exact_quote",
            "topicComprehensionExactQuote",
        ),
        2.0,
    ),
    (
        "full_text",
        ("full_text", "transcript_text", "speech_text", "selected_text", "text"),
        5.0,
    ),
    ("title", ("title",), 1.5),
    (
        "hook_family",
        ("hook_mechanism", "hookMechanism", "hook_family", "hookFamily"),
        1.5,
    ),
)

# The catalog owns which families each track serves.  This versioned router
# owns how ordinary language maps to those families.  Matching scans every
# token in every complete field; it never special-cases the first N words.
_FAMILY_SIGNALS: Mapping[str, Tuple[str, ...]] = {
    "hard_truth": (
        "hard truth", "truth", "reality", "accept", "uncomfortable", "harsh",
        "stop pretending", "you cannot", "you don't owe", "you do not owe",
    ),
    "boundaries": (
        "boundary", "boundaries", "say no", "walk away", "access", "limit",
        "protect yourself", "not obligated", "don't owe", "do not owe",
        "argument", "opinion", "approval",
    ),
    "rejection": (
        "reject", "rejected", "rejection", "unwanted", "not chosen", "leave",
        "left you", "walk away", "approval",
    ),
    "people_pleasing": (
        "people pleasing", "people pleaser", "please everyone", "approval",
        "validation", "liked by everyone", "make everyone happy",
    ),
    "emotional_pain": (
        "pain", "hurt", "heartbreak", "broken", "grief", "suffering", "ache",
    ),
    "relationships": (
        "relationship", "relationships", "partner", "couple", "love", "dating",
        "marriage", "connection", "together",
    ),
    "self_worth": (
        "self worth", "worth", "value yourself", "enough", "deserve", "respect",
        "validation", "approval",
    ),
    "moving_on": (
        "move on", "moving on", "let go", "leave", "walk away", "release",
        "over them", "past relationship",
    ),
    "identity": (
        "identity", "who you are", "be yourself", "become", "yourself", "character",
    ),
    "confidence": (
        "confidence", "confident", "believe in yourself", "self belief", "doubt",
        "courage", "approval", "criticism",
    ),
    "criticism": (
        "criticism", "criticize", "criticized", "judge", "judgment", "opinion",
        "what people think", "haters",
    ),
    "discipline": (
        "discipline", "consistent", "consistency", "practice", "effort", "work",
        "routine", "sacrifice", "focus",
    ),
    "adversity": (
        "adversity", "struggle", "hard times", "obstacle", "failure", "challenge",
        "resilience", "survive", "difficult",
    ),
    "introspection": (
        "introspection", "reflect", "look within", "ask yourself", "inside yourself",
        "think about", "understand yourself",
    ),
    "soft_reflection": (
        "reflect", "remember", "quiet", "gentle", "peace", "sometimes", "realize",
        "lesson", "looking back",
    ),
    "self_awareness": (
        "self awareness", "aware", "notice your", "recognize your", "understand yourself",
        "your pattern", "your behavior",
    ),
    "interpersonal_tension": (
        "argument", "conflict", "tension", "fight", "gossip", "criticism", "opinion",
        "against you", "confrontation",
    ),
    "manipulation": (
        "manipulation", "manipulate", "manipulated", "gaslight", "gaslighting",
        "control you", "controlling", "use you", "power over",
    ),
    "betrayal": (
        "betrayal", "betray", "betrayed", "cheat", "cheated", "disloyal", "trust",
        "lied to you", "backstab",
    ),
    "intimacy": (
        "intimacy", "intimate", "vulnerable", "closeness", "connection", "trust",
        "open up", "emotional bond",
    ),
    "dark_confession": (
        "confession", "confess", "secret", "hidden", "dark", "never told", "admit",
        "truth about me",
    ),
}


class MusicRouterError(ValueError):
    """Raised when catalog, history, or routing evidence is invalid."""


def _canonical_json(value: object) -> str:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as error:
        raise MusicRouterError("music routing data must be strict JSON") from error


def _content_hash(value: Mapping[str, object]) -> str:
    body = {key: item for key, item in value.items() if key != "contentHash"}
    return hashlib.sha256(_canonical_json(body).encode("utf-8")).hexdigest()


def _strict_object(pairs: Iterable[Tuple[str, object]]) -> Dict:
    result: Dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise MusicRouterError(f"duplicate JSON key {key!r}")
        result[key] = value
    return result


def _reject_json_constant(value: str) -> None:
    raise MusicRouterError(f"non-finite JSON number {value!r} is not allowed")


def _require_exact_keys(value: Mapping[str, object], expected: frozenset, label: str) -> None:
    actual = set(value)
    if actual != set(expected):
        missing = sorted(set(expected) - actual)
        extra = sorted(actual - set(expected))
        raise MusicRouterError(
            f"{label} keys do not match the versioned schema; "
            f"missing={missing}, extra={extra}"
        )


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise MusicRouterError(f"{label} must be a non-empty string")
    return value.strip()


def _https(value: object, label: str) -> str:
    text = _string(value, label)
    if not _HTTPS_RE.fullmatch(text):
        raise MusicRouterError(f"{label} must be an https URL")
    return text


def _finite(value: object, label: str) -> float:
    if isinstance(value, bool):
        raise MusicRouterError(f"{label} must be finite")
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise MusicRouterError(f"{label} must be finite") from error
    if not math.isfinite(number):
        raise MusicRouterError(f"{label} must be finite")
    return number


def _positive_int(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise MusicRouterError(f"{label} must be a positive integer")
    return value


def _sha256(value: object, label: str) -> str:
    text = _string(value, label)
    if not _SHA256_RE.fullmatch(text):
        raise MusicRouterError(f"{label} must be a lowercase sha256")
    return text


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _repository_root(catalog_path: Path, repository_root: Optional[Path]) -> Path:
    if repository_root is not None:
        return Path(repository_root).resolve()
    resolved = Path(catalog_path).resolve()
    try:
        if resolved.parent.name != "music" or resolved.parent.parent.name != "assets":
            raise MusicRouterError(
                "catalog_path must be inside <repository>/assets/music"
            )
        return resolved.parents[2]
    except IndexError as error:
        raise MusicRouterError("catalog_path cannot resolve a repository root") from error


def resolve_music_asset_path(
    track: Mapping[str, object],
    *,
    catalog_path: Path | str = DEFAULT_MUSIC_CATALOG_PATH,
    repository_root: Optional[Path | str] = None,
) -> Path:
    """Resolve a catalog track without permitting absolute/traversal paths."""

    relative = _string(track.get("relativePath"), "track.relativePath")
    if "\\" in relative:
        raise MusicRouterError("track.relativePath must use POSIX separators")
    pure = PurePosixPath(relative)
    if pure.is_absolute() or ".." in pure.parts or pure.parts[:2] != ("assets", "music"):
        raise MusicRouterError("track.relativePath must stay inside assets/music")
    root = _repository_root(
        Path(catalog_path),
        Path(repository_root) if repository_root is not None else None,
    )
    path = (root / Path(*pure.parts)).resolve()
    music_root = (root / "assets" / "music").resolve()
    try:
        path.relative_to(music_root)
    except ValueError as error:
        raise MusicRouterError("track asset resolves outside assets/music") from error
    return path


def _verify_track(
    raw: object,
    *,
    index: int,
    catalog_path: Path,
    repository_root: Optional[Path],
    verify_assets: bool,
) -> Dict:
    if not isinstance(raw, Mapping):
        raise MusicRouterError(f"catalog track {index} must be an object")
    _require_exact_keys(raw, _TRACK_KEYS, f"catalog track {index}")
    track = copy.deepcopy(dict(raw))
    track_id = _string(track["trackId"], f"catalog track {index}.trackId")
    if not _TRACK_ID_RE.fullmatch(track_id):
        raise MusicRouterError(f"catalog track {index}.trackId is invalid")
    relative_path = _string(
        track["relativePath"], f"catalog track {index}.relativePath"
    )
    if not relative_path.lower().endswith(".mp3"):
        raise MusicRouterError(f"catalog track {index}.relativePath must be MP3")
    _string(track["title"], f"catalog track {index}.title")
    _string(track["creator"], f"catalog track {index}.creator")
    for field in ("sourcePageUrl", "contentUrl", "licenseUrl"):
        _https(track[field], f"catalog track {index}.{field}")
    declared_sha = _sha256(track["sha256"], f"catalog track {index}.sha256")
    declared_bytes = _positive_int(
        track["byteLength"], f"catalog track {index}.byteLength"
    )
    duration = _finite(track["durationSeconds"], f"catalog track {index}.durationSeconds")
    if duration <= 0.0:
        raise MusicRouterError(f"catalog track {index}.durationSeconds must be positive")
    if track["codec"] != "mp3":
        raise MusicRouterError(f"catalog track {index}.codec must be 'mp3'")
    _positive_int(track["sampleRate"], f"catalog track {index}.sampleRate")
    channels = _positive_int(track["channels"], f"catalog track {index}.channels")
    if channels > 8:
        raise MusicRouterError(f"catalog track {index}.channels is implausible")
    if not isinstance(track["aiGenerated"], bool):
        raise MusicRouterError(f"catalog track {index}.aiGenerated must be boolean")
    if track["contentIdRegistered"] not in {"unknown", "yes", "no"}:
        raise MusicRouterError(
            f"catalog track {index}.contentIdRegistered is invalid"
        )
    families = track["semanticFamilies"]
    if not isinstance(families, list) or not families:
        raise MusicRouterError(f"catalog track {index}.semanticFamilies must be non-empty")
    if len(families) != len(set(families)):
        raise MusicRouterError(f"catalog track {index}.semanticFamilies has duplicates")
    for family in families:
        if not isinstance(family, str) or not _SLUG_RE.fullmatch(family):
            raise MusicRouterError(
                f"catalog track {index}.semanticFamilies contains an invalid family"
            )
        if family not in _FAMILY_SIGNALS:
            raise MusicRouterError(
                f"catalog track {index}.semanticFamilies contains an unsupported family"
            )
    if track["treatmentProfile"] not in _TREATMENT_PROFILES:
        raise MusicRouterError(f"catalog track {index}.treatmentProfile is invalid")
    offset = _finite(
        track["recommendedOffsetSeconds"],
        f"catalog track {index}.recommendedOffsetSeconds",
    )
    if offset < 0.0 or offset >= duration:
        raise MusicRouterError(
            f"catalog track {index}.recommendedOffsetSeconds must be inside the asset"
        )
    _positive_int(track["catalogOrder"], f"catalog track {index}.catalogOrder")

    path = resolve_music_asset_path(
        track,
        catalog_path=catalog_path,
        repository_root=repository_root,
    )
    if verify_assets:
        if not path.is_file():
            raise MusicRouterError(f"catalog asset is missing: {relative_path}")
        actual_bytes = path.stat().st_size
        if actual_bytes != declared_bytes:
            raise MusicRouterError(
                f"catalog asset byteLength mismatch for {track_id}: "
                f"declared {declared_bytes}, actual {actual_bytes}"
            )
        actual_sha = _file_sha256(path)
        if actual_sha != declared_sha:
            raise MusicRouterError(
                f"catalog asset sha256 mismatch for {track_id}"
            )
    return track


def verify_music_catalog(
    catalog: Mapping[str, object],
    *,
    catalog_path: Path | str = DEFAULT_MUSIC_CATALOG_PATH,
    repository_root: Optional[Path | str] = None,
    verify_assets: bool = True,
) -> Dict:
    """Verify the canonical catalog seal, schema, uniqueness, and asset IDs."""

    if not isinstance(catalog, Mapping):
        raise MusicRouterError("music catalog must be an object")
    _require_exact_keys(catalog, _CATALOG_KEYS, "music catalog")
    declared_hash = _sha256(catalog.get("contentHash"), "music catalog contentHash")
    actual_hash = _content_hash(catalog)
    if declared_hash != actual_hash:
        raise MusicRouterError("music catalog contentHash does not match its body")
    if catalog.get("schemaVersion") != MUSIC_CATALOG_SCHEMA_VERSION:
        raise MusicRouterError("unsupported music catalog schemaVersion")
    if catalog.get("artifactType") != "ViralMusicCatalog":
        raise MusicRouterError("music catalog artifactType is invalid")
    if catalog.get("catalogVersion") != MUSIC_CATALOG_VERSION:
        raise MusicRouterError("unsupported music catalog version")
    _https(catalog.get("licenseUrl"), "music catalog licenseUrl")
    retrieved = _string(catalog.get("retrievedAt"), "music catalog retrievedAt")
    if not _RETRIEVED_AT_RE.fullmatch(retrieved):
        raise MusicRouterError("music catalog retrievedAt must be canonical UTC")

    replacement = catalog.get("sourceReplacement")
    if not isinstance(replacement, Mapping):
        raise MusicRouterError("music catalog sourceReplacement must be an object")
    _require_exact_keys(
        replacement,
        _SOURCE_REPLACEMENT_KEYS,
        "music catalog sourceReplacement",
    )
    if not isinstance(replacement.get("explicit"), bool):
        raise MusicRouterError("sourceReplacement.explicit must be boolean")
    requested = replacement.get("requestedTrack")
    if not isinstance(requested, Mapping):
        raise MusicRouterError("sourceReplacement.requestedTrack must be an object")
    _require_exact_keys(requested, _REQUESTED_TRACK_KEYS, "requested replacement track")
    _string(requested.get("title"), "requested replacement track.title")
    _https(requested.get("sourcePageUrl"), "requested replacement track.sourcePageUrl")
    _positive_int(
        requested.get("pixabayContentId"),
        "requested replacement track.pixabayContentId",
    )
    replacement_track_id = _string(
        replacement.get("replacementTrackId"),
        "sourceReplacement.replacementTrackId",
    )
    _string(replacement.get("note"), "sourceReplacement.note")

    raw_tracks = catalog.get("tracks")
    if not isinstance(raw_tracks, list) or not raw_tracks:
        raise MusicRouterError("music catalog tracks must be a non-empty list")
    catalog_file = Path(catalog_path)
    root = Path(repository_root) if repository_root is not None else None
    tracks = [
        _verify_track(
            raw,
            index=index,
            catalog_path=catalog_file,
            repository_root=root,
            verify_assets=verify_assets,
        )
        for index, raw in enumerate(raw_tracks)
    ]
    for field in ("trackId", "relativePath", "sha256", "catalogOrder"):
        values = [track[field] for track in tracks]
        if len(values) != len(set(values)):
            raise MusicRouterError(f"music catalog contains duplicate {field}")
    expected_orders = list(range(1, len(tracks) + 1))
    if sorted(track["catalogOrder"] for track in tracks) != expected_orders:
        raise MusicRouterError("music catalog catalogOrder must be contiguous from 1")
    if replacement_track_id not in {track["trackId"] for track in tracks}:
        raise MusicRouterError("sourceReplacement references an unknown track")

    verified = copy.deepcopy(dict(catalog))
    verified["tracks"] = sorted(tracks, key=lambda track: track["catalogOrder"])
    return verified


def load_music_catalog(
    catalog_path: Path | str = DEFAULT_MUSIC_CATALOG_PATH,
    *,
    repository_root: Optional[Path | str] = None,
    verify_assets: bool = True,
) -> Dict:
    """Load strict JSON and verify the exact catalog and local asset bytes."""

    path = Path(catalog_path)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise MusicRouterError(f"cannot read music catalog: {path}") from error
    try:
        parsed = json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
        )
    except MusicRouterError:
        raise
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise MusicRouterError("music catalog is not strict JSON") from error
    return verify_music_catalog(
        parsed,
        catalog_path=path,
        repository_root=repository_root,
        verify_assets=verify_assets,
    )


def resolve_catalog_track(catalog: Mapping[str, object], track_id: str) -> Dict:
    """Return an isolated exact track record by ID."""

    target = _string(track_id, "track_id")
    tracks = catalog.get("tracks")
    if not isinstance(tracks, list):
        raise MusicRouterError("verified music catalog has no tracks")
    matches = [track for track in tracks if track.get("trackId") == target]
    if len(matches) != 1:
        raise MusicRouterError(f"music catalog has no unique track {target!r}")
    return copy.deepcopy(dict(matches[0]))


def _tokens(value: object) -> Tuple[str, ...]:
    return tuple(
        _TOKEN_RE.findall(
            str(value or "")
            .lower()
            .replace("_", " ")
            .replace("-", " ")
            .replace("’", "'")
            .replace("‘", "'")
            .replace("`", "'")
        )
    )


def _phrase_present(tokens: Sequence[str], phrase: str) -> bool:
    wanted = _tokens(phrase)
    if not wanted or len(wanted) > len(tokens):
        return False
    width = len(wanted)
    return any(tuple(tokens[index : index + width]) == wanted for index in range(len(tokens) - width + 1))


def _first_text(candidate: Mapping[str, object], aliases: Sequence[str]) -> str:
    for name in aliases:
        value = candidate.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _semantic_evidence(candidate: Mapping[str, object]) -> List[Tuple[str, str, float]]:
    evidence: List[Tuple[str, str, float]] = []
    for label, aliases, weight in _SEMANTIC_FIELD_GROUPS:
        text = _first_text(candidate, aliases)
        if text:
            evidence.append((label, text, weight))

    report = candidate.get("hookGateReport")
    meaning = report.get("semanticMeaning") if isinstance(report, Mapping) else None
    if isinstance(meaning, Mapping):
        nested = (
            ("report_topic", "topic", 5.0),
            ("report_opening_claim", "openingClaimSummary", 3.0),
            ("report_whole_point", "wholePointSummary", 8.0),
        )
        existing_texts = {text for _, text, _ in evidence}
        for label, key, weight in nested:
            value = meaning.get(key)
            if isinstance(value, str) and value.strip() and value.strip() not in existing_texts:
                evidence.append((label, value.strip(), weight))
                existing_texts.add(value.strip())
    return evidence


def _semantic_input_hash(candidate: Mapping[str, object]) -> str:
    snapshot = {
        "routerVersion": MUSIC_ROUTER_DECISION_VERSION,
        "semanticScope": "complete_selected_point_and_payoff",
        "evidence": [
            {"field": label, "text": text, "weight": weight}
            for label, text, weight in _semantic_evidence(candidate)
        ],
    }
    return hashlib.sha256(_canonical_json(snapshot).encode("utf-8")).hexdigest()


def _family_semantic_scores(
    candidate: Mapping[str, object],
    families: Sequence[str],
) -> Tuple[Dict[str, float], Dict[str, List[str]], List[str]]:
    evidence = _semantic_evidence(candidate)
    scores: Dict[str, float] = {}
    matches: Dict[str, List[str]] = {}
    for family in sorted(set(families)):
        signals = tuple(_FAMILY_SIGNALS.get(family, ())) + (family,)
        family_score = 0.0
        family_matches: List[str] = []
        for field_label, text, field_weight in evidence:
            tokens = _tokens(text)
            matched = []
            for signal in signals:
                if _phrase_present(tokens, signal):
                    matched.append(signal)
            unique = list(dict.fromkeys(matched))
            if not unique:
                continue
            # Multiple coherent signals strengthen a field, but verbosity is
            # capped so one long transcript cannot overwhelm point/payoff.
            strength = min(2.0, 1.0 + 0.25 * (len(unique) - 1))
            family_score += field_weight * strength
            family_matches.extend(f"{field_label}:{signal}" for signal in unique)
        scores[family] = round(family_score, 3)
        matches[family] = family_matches
    return scores, matches, [label for label, _, _ in evidence]


def _history_ids(values: Sequence[str], label: str) -> List[str]:
    if isinstance(values, (str, bytes)) or not isinstance(values, Sequence):
        raise MusicRouterError(f"{label} must be a sequence of track IDs")
    result: List[str] = []
    for index, value in enumerate(values):
        if not isinstance(value, str) or not _TRACK_ID_RE.fullmatch(value.strip()):
            raise MusicRouterError(f"{label}[{index}] is not a valid track ID")
        result.append(value.strip())
    return result


def _recent_window(
    recent_track_ids: Sequence[str],
    reserved_track_ids: Sequence[str],
) -> Tuple[List[str], List[str], str]:
    recent = _history_ids(recent_track_ids, "recent_track_ids")
    reserved = _history_ids(reserved_track_ids, "reserved_track_ids")
    combined = (recent + reserved)[-MUSIC_ROTATION_WINDOW_SIZE:]
    reserved_in_window = reserved[-min(len(reserved), MUSIC_ROTATION_WINDOW_SIZE) :]
    body = {
        "rotationVersion": MUSIC_ROTATION_POLICY_VERSION,
        "windowSize": MUSIC_ROTATION_WINDOW_SIZE,
        "lookback": MUSIC_ROTATION_LOOKBACK,
        "recentTrackIds": combined,
        "reservedTrackIds": reserved_in_window,
    }
    window_hash = hashlib.sha256(_canonical_json(body).encode("utf-8")).hexdigest()
    return combined, reserved_in_window, window_hash


def _last_use_distance(track_id: str, window: Sequence[str]) -> int:
    for distance, recent_id in enumerate(reversed(window), start=1):
        if recent_id == track_id:
            return distance
    return len(window) + 1


def route_music_for_candidate(
    candidate: Mapping[str, object],
    recent_track_ids: Sequence[str] = (),
    reserved_track_ids: Sequence[str] = (),
    *,
    catalog_path: Path | str = DEFAULT_MUSIC_CATALOG_PATH,
    catalog: Optional[Mapping[str, object]] = None,
    repository_root: Optional[Path | str] = None,
    verify_assets: bool = True,
) -> Dict:
    """Choose a track from full semantics plus explicit oldest-to-newest history.

    ``reserved_track_ids`` are appended as the newest in-window uses.  This
    lets a caller route several not-yet-published renders without introducing
    hidden global state in the router.
    """

    if not isinstance(candidate, Mapping):
        raise MusicRouterError("candidate must be an object")
    path = Path(catalog_path)
    verified_catalog = (
        verify_music_catalog(
            catalog,
            catalog_path=path,
            repository_root=repository_root,
            verify_assets=verify_assets,
        )
        if catalog is not None
        else load_music_catalog(
            path,
            repository_root=repository_root,
            verify_assets=verify_assets,
        )
    )
    tracks = list(verified_catalog["tracks"])
    all_families = [
        family for track in tracks for family in track["semanticFamilies"]
    ]
    family_scores, family_matches, evidence_fields = _family_semantic_scores(
        candidate,
        all_families,
    )
    recent_window, reserved_window, recent_window_hash = _recent_window(
        recent_track_ids,
        reserved_track_ids,
    )
    known_ids = {track["trackId"] for track in tracks}
    unknown_recent = list(
        dict.fromkeys(track_id for track_id in recent_window if track_id not in known_ids)
    )
    exclusion_window = recent_window[-MUSIC_ROTATION_LOOKBACK:]
    excluded = {track_id for track_id in exclusion_window if track_id in known_ids}

    score_rows: List[Dict] = []
    for track in tracks:
        ranked_families = sorted(
            enumerate(track["semanticFamilies"]),
            key=lambda pair: (-family_scores.get(pair[1], 0.0), pair[0], pair[1]),
        )
        best_family = ranked_families[0][1]
        family_values = [family_scores.get(family, 0.0) for family in track["semanticFamilies"]]
        best_score = max(family_values, default=0.0)
        secondary = sum(value for value in family_values if value != best_score)
        semantic_score = round(best_score + 0.20 * secondary, 3)
        score_rows.append(
            {
                "trackId": track["trackId"],
                "semanticScore": semantic_score,
                "bestFamily": best_family,
                "bestFamilyScore": round(family_scores.get(best_family, 0.0), 3),
                "matchedSignals": list(family_matches.get(best_family, ())),
                "excludedByRotation": track["trackId"] in excluded,
                "lastUseDistance": _last_use_distance(track["trackId"], recent_window),
                "catalogOrder": track["catalogOrder"],
            }
        )

    eligible_rows = [row for row in score_rows if not row["excludedByRotation"]]
    fallback_reasons: List[str] = []
    if len(recent_window) < MUSIC_ROTATION_LOOKBACK:
        fallback_reasons.append(
            f"rotation_history_short:{len(recent_window)}/{MUSIC_ROTATION_LOOKBACK}"
        )
    if unknown_recent:
        fallback_reasons.append("unknown_recent_track_ids_ignored:" + ",".join(unknown_recent))
    if not eligible_rows:
        eligible_rows = list(score_rows)
        fallback_reasons.append("rotation_exhausted_least_recent_fallback")
    if not evidence_fields or max(family_scores.values(), default=0.0) <= 0.0:
        fallback_reasons.append("semantic_evidence_insufficient_catalog_order_fallback")

    ordered = sorted(
        eligible_rows,
        key=lambda row: (
            -float(row["semanticScore"]),
            -int(row["lastUseDistance"]),
            int(row["catalogOrder"]),
            str(row["trackId"]),
        ),
    )
    winner_row = ordered[0]
    winner = resolve_catalog_track(verified_catalog, winner_row["trackId"])
    reasons = [
        "semantic_scope:complete_selected_point_and_payoff",
        f"selected_family:{winner_row['bestFamily']}",
        f"semantic_score:{winner_row['semanticScore']:.3f}",
        "evidence_fields:" + (",".join(evidence_fields) if evidence_fields else "none"),
        f"rotation_excluded_known_tracks:{','.join(sorted(excluded)) or 'none'}",
        *fallback_reasons,
    ]
    payload = {
        "schemaVersion": MUSIC_ROUTING_SCHEMA_VERSION,
        "artifactType": "SemanticMusicRoutingDecision",
        "routerVersion": MUSIC_ROUTER_DECISION_VERSION,
        "catalogVersion": MUSIC_CATALOG_VERSION,
        "catalogContentHash": verified_catalog["contentHash"],
        "rotationVersion": MUSIC_ROTATION_POLICY_VERSION,
        "rotationPolicy": {
            "windowSize": MUSIC_ROTATION_WINDOW_SIZE,
            "lookback": MUSIC_ROTATION_LOOKBACK,
            "historyOrder": "oldest_to_newest",
            "reservedIdsAreNewest": True,
        },
        "semanticInputHash": _semantic_input_hash(candidate),
        "trackId": winner["trackId"],
        "semanticFamily": winner_row["bestFamily"],
        "treatmentProfile": winner["treatmentProfile"],
        "startSeconds": round(float(winner["recommendedOffsetSeconds"]), 3),
        "recentWindowHash": recent_window_hash,
        "recentTrackIds": recent_window,
        "reservedTrackIds": reserved_window,
        "scores": score_rows,
        "reasons": reasons,
        "catalogTrack": winner,
    }
    return {**payload, "contentHash": _content_hash(payload)}


def verify_music_routing_decision(
    decision: Mapping[str, object],
    *,
    candidate: Optional[Mapping[str, object]] = None,
    catalog_path: Path | str = DEFAULT_MUSIC_CATALOG_PATH,
    catalog: Optional[Mapping[str, object]] = None,
    repository_root: Optional[Path | str] = None,
    verify_assets: bool = True,
) -> Dict:
    """Verify a sealed decision against the exact catalog track metadata."""

    if not isinstance(decision, Mapping):
        raise MusicRouterError("music routing decision must be an object")
    _require_exact_keys(decision, _DECISION_KEYS, "music routing decision")
    declared_hash = _sha256(decision.get("contentHash"), "music routing contentHash")
    if declared_hash != _content_hash(decision):
        raise MusicRouterError("music routing contentHash does not match its body")
    if decision.get("schemaVersion") != MUSIC_ROUTING_SCHEMA_VERSION:
        raise MusicRouterError("unsupported music routing schemaVersion")
    if decision.get("artifactType") != "SemanticMusicRoutingDecision":
        raise MusicRouterError("music routing artifactType is invalid")
    if decision.get("routerVersion") != MUSIC_ROUTER_DECISION_VERSION:
        raise MusicRouterError("unsupported music router version")
    if decision.get("catalogVersion") != MUSIC_CATALOG_VERSION:
        raise MusicRouterError("unsupported music catalog version in decision")
    if decision.get("rotationVersion") != MUSIC_ROTATION_POLICY_VERSION:
        raise MusicRouterError("unsupported music rotation version")
    if decision.get("rotationPolicy") != {
        "windowSize": MUSIC_ROTATION_WINDOW_SIZE,
        "lookback": MUSIC_ROTATION_LOOKBACK,
        "historyOrder": "oldest_to_newest",
        "reservedIdsAreNewest": True,
    }:
        raise MusicRouterError("music routing rotationPolicy is invalid")
    semantic_input_hash = _sha256(
        decision.get("semanticInputHash"),
        "music routing semanticInputHash",
    )
    if candidate is not None:
        if not isinstance(candidate, Mapping):
            raise MusicRouterError("candidate must be an object")
        if semantic_input_hash != _semantic_input_hash(candidate):
            raise MusicRouterError("music routing decision references other semantics")

    path = Path(catalog_path)
    verified_catalog = (
        verify_music_catalog(
            catalog,
            catalog_path=path,
            repository_root=repository_root,
            verify_assets=verify_assets,
        )
        if catalog is not None
        else load_music_catalog(
            path,
            repository_root=repository_root,
            verify_assets=verify_assets,
        )
    )
    if decision.get("catalogContentHash") != verified_catalog["contentHash"]:
        raise MusicRouterError("music routing decision references another catalog")
    track = resolve_catalog_track(verified_catalog, str(decision.get("trackId") or ""))
    if decision.get("catalogTrack") != track:
        raise MusicRouterError("music routing catalogTrack metadata does not match catalog")
    if decision.get("semanticFamily") not in track["semanticFamilies"]:
        raise MusicRouterError("music routing semanticFamily is not supported by track")
    if decision.get("treatmentProfile") != track["treatmentProfile"]:
        raise MusicRouterError("music routing treatmentProfile does not match catalog")
    if _finite(decision.get("startSeconds"), "music routing startSeconds") != float(
        track["recommendedOffsetSeconds"]
    ):
        raise MusicRouterError("music routing startSeconds does not match catalog")
    recent = _history_ids(decision.get("recentTrackIds"), "recentTrackIds")
    reserved = _history_ids(decision.get("reservedTrackIds"), "reservedTrackIds")
    # Recreate the hash from the exact stored bounded window, not from any
    # external mutable publication state.
    body = {
        "rotationVersion": MUSIC_ROTATION_POLICY_VERSION,
        "windowSize": MUSIC_ROTATION_WINDOW_SIZE,
        "lookback": MUSIC_ROTATION_LOOKBACK,
        "recentTrackIds": recent,
        "reservedTrackIds": reserved,
    }
    expected_window_hash = hashlib.sha256(
        _canonical_json(body).encode("utf-8")
    ).hexdigest()
    if decision.get("recentWindowHash") != expected_window_hash:
        raise MusicRouterError("music routing recentWindowHash is invalid")
    if not isinstance(decision.get("scores"), list) or not decision["scores"]:
        raise MusicRouterError("music routing scores are missing")
    if not isinstance(decision.get("reasons"), list) or not decision["reasons"]:
        raise MusicRouterError("music routing reasons are missing")
    return copy.deepcopy(dict(decision))


__all__ = [
    "DEFAULT_MUSIC_CATALOG_PATH",
    "MUSIC_CATALOG_VERSION",
    "MUSIC_CATALOG_CONTENT_HASH",
    "MUSIC_ROTATION_LOOKBACK",
    "MUSIC_ROTATION_POLICY_VERSION",
    "MUSIC_ROTATION_WINDOW_SIZE",
    "MUSIC_ROUTER_DECISION_VERSION",
    "MUSIC_ROUTING_SCHEMA_VERSION",
    "MusicRouterError",
    "load_music_catalog",
    "resolve_catalog_track",
    "resolve_music_asset_path",
    "route_music_for_candidate",
    "verify_music_catalog",
    "verify_music_routing_decision",
]
