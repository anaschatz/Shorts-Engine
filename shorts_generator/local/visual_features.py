"""Low-cost visual features used before final highlight ranking."""
import hashlib
import importlib.metadata
import json
import math
import os
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple


SHOT_INDEX_SCHEMA_VERSION = 1
SHOT_DETECTOR_VERSION = "ffmpeg-scene-v2"
SHOT_SAMPLE_FPS = 5.0
SHOT_SCENE_THRESHOLD = 0.08
SHOT_MIN_SEPARATION_SECONDS = 0.45
VISUAL_METRICS_CACHE_SCHEMA_VERSION = 1
VISUAL_METRICS_ALGORITHM_VERSION = "candidate-frames-v1"
VISUAL_METRIC_FIELDS = frozenset(
    {
        "motion_score",
        "scene_change_count",
        "scene_change_score",
        "face_visibility_score",
        "subject_visibility_score",
        "static_frame_ratio",
        "visual_action_score",
    }
)
OPENCV_DISTRIBUTIONS = (
    "opencv-python",
    "opencv-python-headless",
    "opencv-contrib-python",
    "opencv-contrib-python-headless",
)


def visual_metrics_from_frames(frames: List, cv2, face_cascade=None) -> Dict[str, float]:
    if not frames:
        return {
            "motion_score": 0.0,
            "scene_change_count": 0,
            "scene_change_score": 0.0,
            "face_visibility_score": 0.0,
            "subject_visibility_score": 0.0,
            "static_frame_ratio": 1.0,
            "visual_action_score": 0.0,
        }

    grays = []
    edge_coverages = []
    face_hits = 0
    for frame in frames:
        height, width = frame.shape[:2]
        scale = min(1.0, 320.0 / max(width, 1))
        resized = cv2.resize(
            frame,
            (max(2, int(width * scale)), max(2, int(height * scale))),
            interpolation=cv2.INTER_AREA,
        )
        gray = cv2.cvtColor(resized, cv2.COLOR_BGR2GRAY)
        grays.append(cv2.GaussianBlur(gray, (5, 5), 0))
        edges = cv2.Canny(gray, 70, 160)
        margin_x = int(edges.shape[1] * 0.10)
        margin_y = int(edges.shape[0] * 0.10)
        center = edges[margin_y:edges.shape[0] - margin_y, margin_x:edges.shape[1] - margin_x]
        edge_coverages.append(float((center > 0).mean()) if center.size else 0.0)

        if face_cascade is not None:
            faces = face_cascade.detectMultiScale(
                cv2.equalizeHist(gray),
                scaleFactor=1.1,
                minNeighbors=6,
                minSize=(18, 18),
            )
            if len(faces) > 0:
                face_hits += 1

    differences = [
        float(cv2.absdiff(grays[index - 1], grays[index]).mean()) / 255.0
        for index in range(1, len(grays))
    ]
    motion_score = min(100.0, (sum(differences) / max(1, len(differences))) * 600.0)
    scene_change_count = sum(value >= 0.18 for value in differences)
    scene_change_score = min(
        100.0,
        scene_change_count / max(1, len(differences)) * 200.0,
    )
    static_frame_ratio = (
        sum(value < 0.015 for value in differences) / max(1, len(differences))
        if differences
        else 1.0
    )
    face_visibility_score = face_hits / len(frames) * 100.0
    subject_visibility_score = min(
        100.0,
        (sum(edge_coverages) / len(edge_coverages)) * 500.0,
    )
    visual_action_score = (
        0.65 * motion_score
        + 0.20 * scene_change_score
        + 0.15 * max(face_visibility_score, subject_visibility_score)
    )
    return {
        "motion_score": round(motion_score, 3),
        "scene_change_count": int(scene_change_count),
        "scene_change_score": round(scene_change_score, 3),
        "face_visibility_score": round(face_visibility_score, 3),
        "subject_visibility_score": round(subject_visibility_score, 3),
        "static_frame_ratio": round(static_frame_ratio, 4),
        "visual_action_score": round(min(100.0, visual_action_score), 3),
    }


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    )


def _content_hash(value: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _write_json_atomic(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    descriptor_open = True
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            descriptor_open = False
            handle.write(json.dumps(payload, indent=2, sort_keys=True))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        if descriptor_open:
            os.close(descriptor)
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def _visual_detector_identity(cv2) -> Dict[str, Any]:
    cascade_path = Path(cv2.data.haarcascades) / "haarcascade_frontalface_default.xml"
    if not cascade_path.is_file():
        raise RuntimeError(f"OpenCV face cascade is missing: {cascade_path}")
    return {
        "algorithm": VISUAL_METRICS_ALGORITHM_VERSION,
        "opencvVersion": str(getattr(cv2, "__version__", "unknown")),
        "faceCascadeSha256": _source_sha256(str(cascade_path)),
    }


def _load_cv2():
    try:
        import cv2  # type: ignore
    except ImportError as error:
        raise RuntimeError(
            "opencv-python is required for local visual candidate scoring."
        ) from error
    return cv2


@lru_cache(maxsize=1)
def _visual_detector_identity_without_cv2() -> Optional[Dict[str, Any]]:
    """Reconstruct the exact cache identity without loading OpenCV's binary."""
    installed = []
    for distribution_name in OPENCV_DISTRIBUTIONS:
        try:
            distribution = importlib.metadata.distribution(distribution_name)
        except importlib.metadata.PackageNotFoundError:
            continue
        installed.append(distribution)
    if len(installed) != 1:
        return None

    distribution = installed[0]
    match = re.match(r"^(\d+)\.(\d+)\.(\d+)", distribution.version)
    if match is None:
        return None
    cascade_path = Path(
        distribution.locate_file(
            "cv2/data/haarcascade_frontalface_default.xml"
        )
    )
    if not cascade_path.is_file():
        return None
    return {
        "algorithm": VISUAL_METRICS_ALGORITHM_VERSION,
        "opencvVersion": ".".join(match.groups()),
        "faceCascadeSha256": _source_sha256(str(cascade_path)),
    }


def _visual_metric_identity(
    source_hash: str,
    start: float,
    end: float,
    sample_count: int,
    detector: Mapping[str, Any],
) -> Dict[str, Any]:
    return {
        "sourceHash": source_hash,
        "startHex": float(start).hex(),
        "endHex": float(end).hex(),
        "sampleCount": sample_count,
        "detector": dict(detector),
    }


def _visual_metric_cache_key(identity: Mapping[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(identity).encode("utf-8")).hexdigest()


def _validated_visual_metrics(value: Any) -> Optional[Dict[str, float]]:
    if not isinstance(value, dict) or set(value) != VISUAL_METRIC_FIELDS:
        return None
    normalized: Dict[str, Any] = {}
    for field in VISUAL_METRIC_FIELDS:
        raw = value[field]
        if isinstance(raw, bool) or not isinstance(raw, (int, float)):
            return None
        if not math.isfinite(float(raw)):
            return None
        if field == "scene_change_count":
            if not isinstance(raw, int) or raw < 0:
                return None
            normalized[field] = raw
        else:
            normalized[field] = float(raw)
    return normalized


def _read_visual_metric_cache(
    path: Path,
    cache_key: str,
    identity: Mapping[str, Any],
) -> Optional[Dict[str, float]]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return None
        content_hash = payload.pop("contentHash", None)
        if (
            payload.get("schemaVersion") != VISUAL_METRICS_CACHE_SCHEMA_VERSION
            or payload.get("cacheKey") != cache_key
            or payload.get("identity") != identity
            or content_hash != _content_hash(payload)
        ):
            return None
        return _validated_visual_metrics(payload.get("metrics"))
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _write_visual_metric_cache(
    path: Path,
    cache_key: str,
    identity: Mapping[str, Any],
    metrics: Mapping[str, Any],
) -> None:
    body = {
        "schemaVersion": VISUAL_METRICS_CACHE_SCHEMA_VERSION,
        "cacheKey": cache_key,
        "identity": dict(identity),
        "metrics": dict(metrics),
    }
    _write_json_atomic(path, {**body, "contentHash": _content_hash(body)})


def _score_visual_chunk(
    source_path: str,
    jobs: List[Tuple[str, float, float]],
    sample_count: int,
    cv2,
) -> List[Tuple[str, Dict[str, float]]]:
    """Score one worker's intervals with one decoder and face detector."""

    cap = cv2.VideoCapture(source_path)
    if not cap.isOpened():
        raise RuntimeError(f"could not open {source_path} for visual scoring")
    face_cascade = cv2.CascadeClassifier(
        cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    )
    results = []
    try:
        for cache_key, start, end in jobs:
            frames = []
            for index in range(sample_count):
                timestamp = start + (end - start) * index / max(1, sample_count - 1)
                cap.set(cv2.CAP_PROP_POS_MSEC, timestamp * 1000.0)
                ok, frame = cap.read()
                if ok:
                    frames.append(frame)
            results.append(
                (
                    cache_key,
                    visual_metrics_from_frames(
                        frames,
                        cv2,
                        face_cascade=face_cascade,
                    ),
                )
            )
    finally:
        cap.release()
    return results


def _compute_uncached_visual_metrics(
    source_path: str,
    jobs: List[Tuple[str, float, float]],
    sample_count: int,
    cv2,
    max_workers: int,
) -> Dict[str, Dict[str, float]]:
    if not jobs:
        return {}
    worker_count = max(1, min(int(max_workers), len(jobs)))
    chunks = [jobs[index::worker_count] for index in range(worker_count)]
    if worker_count == 1:
        scored_chunks = [
            _score_visual_chunk(source_path, chunks[0], sample_count, cv2)
        ]
    else:
        with ThreadPoolExecutor(
            max_workers=worker_count,
            thread_name_prefix="candidate-visual",
        ) as executor:
            futures = [
                executor.submit(
                    _score_visual_chunk,
                    source_path,
                    chunk,
                    sample_count,
                    cv2,
                )
                for chunk in chunks
            ]
            # Resolve in deterministic chunk order. Any worker failure still
            # raises the original exception and fails the full analysis call.
            scored_chunks = [future.result() for future in futures]
    return {
        cache_key: metrics
        for chunk in scored_chunks
        for cache_key, metrics in chunk
    }


def analyze_candidate_visuals(
    source_path: str,
    highlights: List[Dict],
    sample_count: int = 12,
    *,
    max_workers: Optional[int] = None,
    cache_enabled: Optional[bool] = None,
    cache_dir: Optional[str] = None,
    telemetry=None,
) -> List[Dict]:
    """Measure candidate visuals concurrently with exact metric reuse."""
    from ..config import (
        LOCAL_CANDIDATE_VISUAL_CACHE_DIR,
        LOCAL_CANDIDATE_VISUAL_WORKERS,
        LOCAL_VISUAL_ANALYSIS_CACHE,
    )

    if isinstance(sample_count, bool) or not isinstance(sample_count, int):
        raise ValueError("sample_count must be an integer")
    normalized_sample_count = max(2, sample_count)
    workers = LOCAL_CANDIDATE_VISUAL_WORKERS if max_workers is None else int(max_workers)
    if workers < 1:
        raise ValueError("max_workers must be at least 1")
    use_cache = LOCAL_VISUAL_ANALYSIS_CACHE if cache_enabled is None else bool(cache_enabled)
    resolved_cache_dir = Path(cache_dir or LOCAL_CANDIDATE_VISUAL_CACHE_DIR)

    items = [dict(highlight) for highlight in highlights]
    if not items:
        return []
    intervals = [
        (float(item["start_time"]), float(item["end_time"]))
        for item in items
    ]
    cv2 = None
    source_hash = _source_sha256(source_path) if use_cache else None
    detector = _visual_detector_identity_without_cv2() if use_cache else None
    if not use_cache or detector is None:
        cv2 = _load_cv2()
        if use_cache:
            detector = _visual_detector_identity(cv2)

    def resolve_requests(resolved_detector):
        request_keys = []
        identities: Dict[str, Dict[str, Any]] = {}
        unique_jobs: Dict[str, Tuple[str, float, float]] = {}
        for start, end in intervals:
            if use_cache:
                identity = _visual_metric_identity(
                    str(source_hash),
                    start,
                    end,
                    normalized_sample_count,
                    resolved_detector or {},
                )
                cache_key = _visual_metric_cache_key(identity)
                identities[cache_key] = identity
            else:
                cache_key = hashlib.sha256(
                    f"{start.hex()}:{end.hex()}:{normalized_sample_count}".encode(
                        "ascii"
                    )
                ).hexdigest()
            request_keys.append(cache_key)
            unique_jobs.setdefault(cache_key, (cache_key, start, end))

        metrics_by_key: Dict[str, Dict[str, float]] = {}
        misses = []
        for cache_key, job in unique_jobs.items():
            cached = None
            if use_cache:
                path = resolved_cache_dir / cache_key[:2] / f"{cache_key}.json"
                cached = _read_visual_metric_cache(
                    path,
                    cache_key,
                    identities[cache_key],
                )
            if cached is None:
                misses.append(job)
            else:
                metrics_by_key[cache_key] = cached
        return request_keys, identities, metrics_by_key, misses

    request_keys, identities, metrics_by_key, misses = resolve_requests(detector)
    if misses and cv2 is None:
        cv2 = _load_cv2()
        authoritative_detector = _visual_detector_identity(cv2)
        if authoritative_detector != detector:
            detector = authoritative_detector
            request_keys, identities, metrics_by_key, misses = resolve_requests(
                detector
            )

    if telemetry is not None and use_cache:
        hit_requests = sum(cache_key in metrics_by_key for cache_key in request_keys)
        miss_requests = len(request_keys) - hit_requests
        if hit_requests:
            telemetry.cache_hit("candidate_visual_metrics", count=hit_requests)
        if miss_requests:
            telemetry.cache_miss("candidate_visual_metrics", count=miss_requests)

    computed = (
        _compute_uncached_visual_metrics(
            source_path,
            misses,
            normalized_sample_count,
            cv2,
            workers,
        )
        if misses
        else {}
    )
    metrics_by_key.update(computed)
    if use_cache:
        for cache_key, metrics in computed.items():
            path = resolved_cache_dir / cache_key[:2] / f"{cache_key}.json"
            _write_visual_metric_cache(
                path,
                cache_key,
                identities[cache_key],
                metrics,
            )

    scored = []
    for item, cache_key in zip(items, request_keys):
        metrics = dict(metrics_by_key[cache_key])
        item["visual_metrics"] = metrics
        item["measured_visual_action_score"] = metrics["visual_action_score"]
        scored.append(item)
    return scored


def _source_sha256(source_path: str) -> str:
    digest = hashlib.sha256()
    with open(source_path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _scene_cache_key(start: float, end: float) -> str:
    return f"{start:.3f}:{end:.3f}"


def _parse_scene_times(
    output: str,
    interval_start: float,
    interval_end: float,
) -> List[float]:
    duration = max(0.0, interval_end - interval_start)
    local_times = [float(value) for value in re.findall(r"pts_time:([0-9.]+)", output)]
    clustered = []
    for local_time in sorted(local_times):
        if local_time < 0.35 or local_time > duration - 0.25:
            continue
        absolute = interval_start + local_time
        if not clustered or absolute - clustered[-1] >= SHOT_MIN_SEPARATION_SECONDS:
            clustered.append(absolute)
    return [round(value, 3) for value in clustered]


def _detect_scene_times(
    source_path: str,
    start: float,
    end: float,
    sample_fps: float = SHOT_SAMPLE_FPS,
    threshold: float = SHOT_SCENE_THRESHOLD,
    runner=None,
) -> List[float]:
    run = runner or subprocess.run
    command = [
        "ffmpeg", "-hide_banner", "-loglevel", "info",
        "-ss", f"{start:.3f}",
        "-t", f"{max(0.001, end - start):.3f}",
        "-i", source_path,
        "-an",
        "-vf",
        (
            f"fps={sample_fps:.3f},scale=320:-2,"
            f"select='gt(scene,{threshold:.3f})',showinfo"
        ),
        "-f", "null", "-",
    ]
    result = run(command, capture_output=True, text=True)
    if result.returncode != 0:
        details = (result.stderr or result.stdout or "")[-1200:]
        raise RuntimeError(f"source shot detection failed: {details}")
    return _parse_scene_times(
        (result.stderr or "") + "\n" + (result.stdout or ""),
        start,
        end,
    )


def build_source_shot_index(
    source_path: str,
    intervals: List[Tuple[float, float]],
    cache_dir: str,
    sample_fps: float = SHOT_SAMPLE_FPS,
    threshold: float = SHOT_SCENE_THRESHOLD,
    runner=None,
    max_workers: Optional[int] = None,
    telemetry=None,
) -> Dict:
    """Build one incremental scene cache for the requested source intervals."""
    from ..config import LOCAL_SHOT_ANALYSIS_WORKERS

    workers = LOCAL_SHOT_ANALYSIS_WORKERS if max_workers is None else int(max_workers)
    if workers < 1:
        raise ValueError("max_workers must be at least 1")
    source_hash = _source_sha256(source_path)
    detector_settings = {
        "version": SHOT_DETECTOR_VERSION,
        "sample_fps": sample_fps,
        "scene_threshold": threshold,
    }
    digest = hashlib.sha256(
        json.dumps(
            {"source_hash": source_hash, **detector_settings},
            sort_keys=True,
        ).encode("utf-8")
    ).hexdigest()
    path = Path(cache_dir) / f"{digest}.json"
    payload = {
        "schema_version": SHOT_INDEX_SCHEMA_VERSION,
        "source_hash": source_hash,
        "detector": detector_settings,
        "intervals": {},
    }
    if path.is_file():
        try:
            cached = json.loads(path.read_text(encoding="utf-8"))
            if (
                cached.get("schema_version") == SHOT_INDEX_SCHEMA_VERSION
                and cached.get("source_hash") == source_hash
                and cached.get("detector") == detector_settings
            ):
                payload = cached
        except (OSError, ValueError, TypeError):
            pass

    normalized_intervals = []
    for start, end in intervals:
        start = max(0.0, float(start))
        end = max(start, float(end))
        key = _scene_cache_key(start, end)
        normalized_intervals.append((key, start, end))

    missing_by_key = {}
    for key, start, end in normalized_intervals:
        if key not in payload["intervals"]:
            missing_by_key.setdefault(key, (key, start, end))
    if telemetry is not None:
        hit_count = sum(key in payload["intervals"] for key, _, _ in normalized_intervals)
        miss_count = len(normalized_intervals) - hit_count
        if hit_count:
            telemetry.cache_hit("shot_analysis", count=hit_count)
        if miss_count:
            telemetry.cache_miss("shot_analysis", count=miss_count)

    missing = list(missing_by_key.values())

    def detect(job):
        key, start, end = job
        return (
            key,
            start,
            end,
            _detect_scene_times(
                source_path,
                start,
                end,
                sample_fps=sample_fps,
                threshold=threshold,
                runner=runner,
            ),
        )

    worker_count = max(1, min(workers, len(missing))) if missing else 1
    if worker_count == 1:
        detected = [detect(job) for job in missing]
    else:
        with ThreadPoolExecutor(
            max_workers=worker_count,
            thread_name_prefix="candidate-shots",
        ) as executor:
            # executor.map preserves input ordering while allowing FFmpeg jobs
            # to overlap. A detector error still raises and aborts the batch.
            detected = list(executor.map(detect, missing))

    for key, start, end, scene_change_times in detected:
        payload["intervals"][key] = {
            "start": round(start, 3),
            "end": round(end, 3),
            "scene_change_times": scene_change_times,
        }

    if detected or not path.is_file():
        _write_json_atomic(path, payload)
    payload["cache_path"] = str(path)
    return payload


def analyze_motivational_editability(
    source_path: str,
    highlights: List[Dict],
    cache_dir: str,
    runner=None,
    max_workers: Optional[int] = None,
    telemetry=None,
) -> List[Dict]:
    intervals = [
        (float(item["start_time"]), float(item["end_time"]))
        for item in highlights
    ]
    index = build_source_shot_index(
        source_path,
        intervals,
        cache_dir,
        runner=runner,
        max_workers=max_workers,
        telemetry=telemetry,
    )
    scored = []
    for highlight in highlights:
        item = dict(highlight)
        start = float(item["start_time"])
        end = float(item["end_time"])
        record = index["intervals"][_scene_cache_key(start, end)]
        changes = [float(value) for value in record["scene_change_times"]]
        boundaries = [start, *changes, end]
        shot_durations = [
            max(0.0, boundaries[position + 1] - boundaries[position])
            for position in range(len(boundaries) - 1)
        ]
        ordered = sorted(shot_durations)
        visual_metrics = item.get("visual_metrics") or {}
        editability = {
                "source_cut_count": len(changes),
                "source_cut_density_per_10s": round(
                    len(changes) / max(0.001, end - start) * 10.0,
                    3,
                ),
                "median_source_shot_seconds": round(
                    ordered[len(ordered) // 2] if ordered else end - start,
                    3,
                ),
                "shortest_source_shot_seconds": round(
                    min(shot_durations, default=end - start),
                    3,
                ),
                "source_scene_change_times": changes,
                "source_hash": index["source_hash"],
                "shot_index_cache_path": index["cache_path"],
            }
        if "face_visibility_score" in visual_metrics:
            editability["face_visible_shot_ratio"] = round(
                float(visual_metrics["face_visibility_score"]) / 100.0,
                4,
            )
        else:
            editability["candidate_visual_metrics_status"] = (
                "not_required_for_motivational_profile"
            )
        item.update(editability)
        scored.append(item)
    return scored


def analyze_rendered_cut_metrics(
    shorts: List[Dict],
    runner=None,
) -> List[Dict]:
    """Compare rendered scene changes with the source edit for motivational QA."""
    measured = []
    for short in shorts:
        item = dict(short)
        path = str(item.get("clip_url") or "")
        duration = float(
            item.get("duration_seconds")
            or float(item.get("end_time", 0.0)) - float(item.get("start_time", 0.0))
        )
        changes = _detect_scene_times(
            path,
            0.0,
            duration,
            runner=runner,
        )
        source_count = int(item.get("source_cut_count", 0))
        render_start = float(item.get("render_start_time", item.get("start_time", 0.0)))
        expected_source_times = [
            float(value) - render_start
            for value in (item.get("source_scene_change_times") or [])
            if 0.0 <= float(value) - render_start <= duration
        ]
        declared_events = [
            event
            for event in (item.get("declared_render_events") or [])
            if isinstance(event, dict) and event.get("type") == "brand_tail"
        ]
        declared_times = [float(event["start_seconds"]) for event in declared_events]

        unmatched = list(enumerate(changes))

        def consume_matches(expected_times, tolerance=0.75):
            nonlocal unmatched
            matched = []
            for expected in expected_times:
                candidates = [
                    (abs(observed - expected), position, observed)
                    for position, observed in unmatched
                    if abs(observed - expected) <= tolerance
                ]
                if not candidates:
                    continue
                _, matched_position, matched_time = min(candidates)
                matched.append(matched_time)
                unmatched = [
                    value for value in unmatched if value[0] != matched_position
                ]
            return matched

        if expected_source_times:
            matched_source_times = consume_matches(expected_source_times)
            unmatched_source_allowance = max(0, source_count - len(matched_source_times))
        else:
            matched_source_times = []
            unmatched_source_allowance = source_count
        matched_declared_times = consume_matches(declared_times, tolerance=0.55)
        remaining_after_source_allowance = max(
            0,
            len(unmatched) - unmatched_source_allowance,
        )
        artificial = remaining_after_source_allowance
        artificial_limit = int(item.get("artificial_cut_limit", 1))
        item.update(
            {
                "output_cut_count": len(changes),
                "output_scene_change_times": changes,
                "matched_source_cut_times": matched_source_times,
                "matched_declared_render_event_times": matched_declared_times,
                "declared_render_event_count": len(declared_events),
                "brand_tail_transition_detected": bool(matched_declared_times),
                "artificial_cut_count": artificial,
                "artificial_cut_guardrail_pass": artificial <= artificial_limit,
            }
        )
        measured.append(item)
    return measured
