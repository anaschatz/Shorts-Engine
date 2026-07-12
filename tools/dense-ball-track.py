#!/usr/bin/env python3
"""Bounded per-frame sports-ball tracking for selected goal windows."""

import argparse
import json
import math
import os
import sys

import cv2
import numpy as np
from ultralytics import YOLO


MAX_SEGMENTS = 12
MAX_OUTPUT_SAMPLES = 4096
SPORTS_BALL_CLASS = 32
PERSON_CLASS = 0


def clamp(value, minimum, maximum):
    return min(maximum, max(minimum, value))


def parse_args():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--segments", required=True)
    parser.add_argument("--imgsz", type=int, default=960)
    parser.add_argument("--confidence", type=float, default=0.05)
    parser.add_argument("--device", choices=["cpu", "mps"], default="cpu")
    return parser.parse_args()


def safe_segments(raw, duration):
    try:
        values = json.loads(raw)
    except Exception as error:
        raise ValueError("invalid_segments") from error
    if not isinstance(values, list) or not values or len(values) > MAX_SEGMENTS:
        raise ValueError("invalid_segments")
    safe = []
    for index, value in enumerate(values):
        if not isinstance(value, dict):
            raise ValueError("invalid_segment")
        start = float(value.get("sourceStart", -1))
        finish = float(value.get("visibleFinishTime", value.get("finishTime", -1)))
        if not math.isfinite(start) or not math.isfinite(finish) or start < 0 or finish <= start:
            raise ValueError("invalid_segment")
        if duration > 0 and finish > duration + 0.25:
            raise ValueError("invalid_segment")
        safe.append({
            "goalNumber": int(value.get("goalNumber") or index + 1),
            "sourceStart": round(start, 3),
            "finishTime": round(finish, 3),
        })
    return safe


def model_classes(model):
    names = {
        int(class_id): str(name).strip().lower()
        for class_id, name in dict(model.names).items()
    }
    ball_classes = [
        class_id
        for class_id, name in names.items()
        if name in {"ball", "sports ball", "football", "soccer ball"}
    ]
    person_classes = {
        class_id
        for class_id, name in names.items()
        if name in {"person", "player", "goalkeeper", "referee"}
    }
    if len(ball_classes) != 1 or not person_classes:
        raise ValueError("unsupported_model_classes")
    return ball_classes[0], person_classes


def scene_cut(previous_gray, frame):
    gray = cv2.cvtColor(cv2.resize(frame, (160, 90)), cv2.COLOR_BGR2GRAY)
    if previous_gray is None:
        return gray, False
    difference = float(np.mean(cv2.absdiff(previous_gray, gray)))
    return gray, difference >= 38.0


def box_values(box):
    values = [float(value) for value in box.xyxy[0]]
    return values, float(box.conf[0]), int(box.cls[0])


def patch_scores(frame, xyxy):
    height, width = frame.shape[:2]
    left, top, right, bottom = xyxy
    padding = max(3, int(max(right - left, bottom - top) * 0.35))
    x1 = int(clamp(left - padding, 0, width - 1))
    y1 = int(clamp(top - padding, 0, height - 1))
    x2 = int(clamp(right + padding, x1 + 1, width))
    y2 = int(clamp(bottom + padding, y1 + 1, height))
    patch = frame[y1:y2, x1:x2]
    if patch.size == 0:
        return 0.0, 0.0
    hsv = cv2.cvtColor(patch, cv2.COLOR_BGR2HSV)
    saturation = float(np.mean(hsv[:, :, 1])) / 255.0
    value = float(np.mean(hsv[:, :, 2])) / 255.0
    white_score = clamp((1.0 - saturation) * 0.65 + value * 0.35, 0.0, 1.0)

    ring_padding = max(8, padding * 3)
    rx1 = int(clamp(left - ring_padding, 0, width - 1))
    ry1 = int(clamp(top - ring_padding, 0, height - 1))
    rx2 = int(clamp(right + ring_padding, rx1 + 1, width))
    ry2 = int(clamp(bottom + ring_padding, ry1 + 1, height))
    ring = cv2.cvtColor(frame[ry1:ry2, rx1:rx2], cv2.COLOR_BGR2HSV)
    green = cv2.inRange(ring, np.array([30, 25, 25]), np.array([100, 255, 255]))
    pitch_score = float(np.count_nonzero(green)) / max(1, green.size)
    return white_score, pitch_score


def nearest_foot_score(center, people, diagonal):
    if not people:
        return 0.0
    nearest = min(
        math.hypot(center[0] - (person[0] + person[2]) / 2.0, center[1] - person[3])
        for person in people
    )
    return clamp(1.0 - nearest / max(1.0, diagonal * 0.12), 0.0, 1.0)


def candidate_rows(frame, result, previous, velocity, ball_class, person_classes):
    height, width = frame.shape[:2]
    diagonal = math.hypot(width, height)
    people = []
    balls = []
    if result.boxes is not None:
        for box in result.boxes:
            xyxy, confidence, class_id = box_values(box)
            if class_id in person_classes:
                people.append(xyxy)
            elif class_id == ball_class:
                balls.append((xyxy, confidence))
    predicted = None if previous is None else (
        previous[0] + velocity[0],
        previous[1] + velocity[1],
    )
    rows = []
    for xyxy, confidence in balls:
        left, top, right, bottom = xyxy
        center = ((left + right) / 2.0, (top + bottom) / 2.0)
        if center[1] < height * 0.14 or center[1] > height * 0.94:
            continue
        if center[0] < width * 0.01 or center[0] > width * 0.99:
            continue
        white_score, pitch_score = patch_scores(frame, xyxy)
        foot_score = nearest_foot_score(center, people, diagonal)
        trajectory_score = 0.45
        distance = None
        if predicted is not None:
            distance = math.hypot(center[0] - predicted[0], center[1] - predicted[1])
            trajectory_score = math.exp(-distance / max(1.0, diagonal * 0.055))
            if distance > diagonal * 0.16:
                continue
        score = (
            confidence * 0.24 +
            white_score * 0.20 +
            pitch_score * 0.14 +
            foot_score * 0.18 +
            trajectory_score * 0.24
        )
        rows.append({
            "xyxy": xyxy,
            "center": center,
            "confidence": confidence,
            "score": score,
            "distance": distance,
        })
    rows.sort(key=lambda item: item["score"], reverse=True)
    return rows


def expanded_tracker_box(xyxy, width, height):
    left, top, right, bottom = xyxy
    center_x = (left + right) / 2.0
    center_y = (top + bottom) / 2.0
    size = clamp(max(right - left, bottom - top) * 2.4, 28.0, 72.0)
    x = clamp(center_x - size / 2.0, 0, width - size)
    y = clamp(center_y - size / 2.0, 0, height - size)
    return (float(x), float(y), float(size), float(size))


def tracking_sample(timestamp, xyxy, confidence, source, frame_index):
    left, top, right, bottom = xyxy
    width = max(2.0, right - left)
    height = max(2.0, bottom - top)
    center_x = left + width / 2.0
    center_y = top + height / 2.0
    return {
        "time": round(timestamp, 3),
        "frameIndex": frame_index,
        "ballBox": {
            "x": round(max(0.0, left), 2),
            "y": round(max(0.0, top), 2),
            "width": round(width, 2),
            "height": round(height, 2),
        },
        "ballConfidence": round(clamp(confidence, 0.0, 1.0), 3),
        "actionCenter": {"x": round(center_x, 2), "y": round(center_y, 2)},
        "source": source,
        "phase": "ball_follow",
        "reasonCodes": ["tracking_ball_visible"],
    }


def interpolated_sample(left, right, frame_index, fps):
    span = right["frameIndex"] - left["frameIndex"]
    progress = (frame_index - left["frameIndex"]) / max(1, span)
    left_box = left["ballBox"]
    right_box = right["ballBox"]
    xyxy = []
    for left_value, right_value in (
        (left_box["x"], right_box["x"]),
        (left_box["y"], right_box["y"]),
        (left_box["x"] + left_box["width"], right_box["x"] + right_box["width"]),
        (left_box["y"] + left_box["height"], right_box["y"] + right_box["height"]),
    ):
        xyxy.append(left_value + (right_value - left_value) * progress)
    return tracking_sample(
        frame_index / fps,
        xyxy,
        min(left["ballConfidence"], right["ballConfidence"], 0.45),
        "ball_interpolation",
        frame_index,
    )


def fill_bounded_internal_gaps(samples, start_frame, end_frame, fps, frame_diagonal):
    sample_by_frame = {sample["frameIndex"]: sample for sample in samples}
    added = []
    frame_index = start_frame
    while frame_index <= end_frame:
        if frame_index in sample_by_frame:
            frame_index += 1
            continue
        gap_start = frame_index
        while frame_index <= end_frame and frame_index not in sample_by_frame:
            frame_index += 1
        gap_end = frame_index - 1
        gap_length = gap_end - gap_start + 1
        left = sample_by_frame.get(gap_start - 1)
        right = sample_by_frame.get(gap_end + 1)
        if gap_length > 2 or not left or not right:
            continue
        displacement = math.hypot(
            right["actionCenter"]["x"] - left["actionCenter"]["x"],
            right["actionCenter"]["y"] - left["actionCenter"]["y"],
        )
        if displacement > frame_diagonal * 0.18:
            continue
        for missing_frame in range(gap_start, gap_end + 1):
            sample = interpolated_sample(left, right, missing_frame, fps)
            sample_by_frame[missing_frame] = sample
            added.append(sample)
    return sorted([*samples, *added], key=lambda sample: sample["frameIndex"]), len(added)


def track_segment(
    cap,
    model,
    segment,
    fps,
    args,
    ball_class,
    person_classes,
):
    start = segment["sourceStart"]
    finish = segment["finishTime"]
    start_frame = max(0, int(round(start * fps)))
    end_frame = max(start_frame, int(math.floor(finish * fps)))
    expected_frames = end_frame - start_frame + 1
    cap.set(cv2.CAP_PROP_POS_FRAMES, start_frame)
    previous = None
    velocity = (0.0, 0.0)
    tracker = None
    tracker_gap = 0
    samples = []
    missing = []
    detector_frames = 0
    tracker_frames = 0
    frame_index = start_frame
    previous_gray = None
    while frame_index <= end_frame and len(samples) + len(missing) < expected_frames:
        ok, frame = cap.read()
        if not ok:
            missing.extend(range(frame_index, end_frame + 1))
            break
        previous_gray, cut_detected = scene_cut(previous_gray, frame)
        if cut_detected:
            previous = None
            velocity = (0.0, 0.0)
            tracker = None
            tracker_gap = 0
        result = model.predict(
            frame,
            classes=sorted({ball_class, *person_classes}),
            conf=args.confidence,
            imgsz=args.imgsz,
            device=args.device,
            verbose=False,
        )[0]
        candidates = candidate_rows(frame, result, previous, velocity, ball_class, person_classes)
        selected = candidates[0] if candidates and candidates[0]["score"] >= 0.38 else None
        source = "ball_detection"
        if selected is not None:
            xyxy = selected["xyxy"]
            center = selected["center"]
            confidence = clamp(selected["score"], 0.45, 0.95)
            tracker = cv2.TrackerCSRT_create()
            tracker_box = tuple(
                int(round(value))
                for value in expanded_tracker_box(xyxy, frame.shape[1], frame.shape[0])
            )
            tracker.init(frame, tracker_box)
            tracker_gap = 0
            detector_frames += 1
        elif tracker is not None and tracker_gap < 6:
            tracked, box = tracker.update(frame)
            tracker_gap += 1
            if tracked:
                x, y, box_width, box_height = box
                center = (x + box_width / 2.0, y + box_height / 2.0)
                if 0 <= center[0] < frame.shape[1] and frame.shape[0] * 0.14 <= center[1] <= frame.shape[0] * 0.94:
                    xyxy = [x, y, x + box_width, y + box_height]
                    confidence = 0.46
                    source = "ball_interpolation"
                    tracker_frames += 1
                else:
                    selected = None
                    tracker = None
            else:
                selected = None
                tracker = None
        if selected is None and source != "ball_interpolation":
            missing.append(frame_index)
            frame_index += 1
            continue
        if previous is not None:
            observed_velocity = (center[0] - previous[0], center[1] - previous[1])
            velocity = (
                velocity[0] * 0.65 + observed_velocity[0] * 0.35,
                velocity[1] * 0.65 + observed_velocity[1] * 0.35,
            )
        previous = center
        samples.append(tracking_sample(frame_index / fps, xyxy, confidence, source, frame_index))
        frame_index += 1
        if len(samples) >= MAX_OUTPUT_SAMPLES:
            break
    terminal_missing_count = 0
    sample_frames = {sample["frameIndex"] for sample in samples}
    for candidate_frame in range(end_frame, start_frame - 1, -1):
        if candidate_frame in sample_frames:
            break
        terminal_missing_count += 1
    target_switch_recommended = bool(
        terminal_missing_count >= max(8, int(round(fps * 0.3))) and
        terminal_missing_count <= int(round(fps * 5.0)) and
        len(samples) >= expected_frames * 0.7
    )
    effective_end_frame = end_frame - terminal_missing_count if target_switch_recommended else end_frame
    frame_diagonal = math.hypot(
        float(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
        float(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
    )
    samples, interpolated_frames = fill_bounded_internal_gaps(
        samples,
        start_frame,
        effective_end_frame,
        fps,
        frame_diagonal,
    )
    effective_sample_frames = {
        sample["frameIndex"]
        for sample in samples
        if start_frame <= sample["frameIndex"] <= effective_end_frame
    }
    effective_missing = [
        index
        for index in range(start_frame, effective_end_frame + 1)
        if index not in effective_sample_frames
    ]
    effective_expected_frames = effective_end_frame - start_frame + 1
    inspected_frames = effective_expected_frames
    contained_frames = len(effective_sample_frames)
    coverage = contained_frames / max(1, effective_expected_frames)
    max_missing_run = 0
    current_run = 0
    missing_set = set(effective_missing)
    for index in range(start_frame, effective_end_frame + 1):
        if index in missing_set:
            current_run += 1
            max_missing_run = max(max_missing_run, current_run)
        else:
            current_run = 0
    return samples, {
        "goalNumber": segment["goalNumber"],
        "sourceStart": start,
        "finishTime": round(effective_end_frame / fps, 3),
        "requestedFinishTime": finish,
        "recommendedVisibleFinishTime": round(effective_end_frame / fps, 3),
        "targetSwitchRecommended": target_switch_recommended,
        "terminalBallLossFrameCount": terminal_missing_count,
        "originalExpectedFrameCount": expected_frames,
        "expectedFrameCount": effective_expected_frames,
        "inspectedFrameCount": inspected_frames,
        "containedFrameCount": contained_frames,
        "containmentCoverage": round(coverage, 4),
        "missingFrameCount": len(effective_missing),
        "missingFrameIndexes": effective_missing[:32],
        "maxMissingFrameRun": max_missing_run,
        "detectorFrameCount": detector_frames,
        "trackerFrameCount": tracker_frames + interpolated_frames,
        "passed": not effective_missing and contained_frames == effective_expected_frames,
    }


def main():
    stage = "validate_runtime"
    args = parse_args()
    if (
        not os.path.isfile(args.input) or
        not os.path.isfile(args.model)
    ):
        raise ValueError("runtime_input_missing")
    stage = "open_video"
    cap = cv2.VideoCapture(args.input)
    if not cap.isOpened():
        raise ValueError("video_unreadable")
    stage = "validate_video_metadata"
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0)
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if not math.isfinite(fps) or fps <= 0 or fps > 120:
        raise ValueError("invalid_frame_rate")
    duration = frame_count / fps if frame_count > 0 else 0
    stage = "validate_segments"
    segments = safe_segments(args.segments, duration)
    stage = "load_model"
    model = YOLO(args.model)
    ball_class, person_classes = model_classes(model)
    samples = []
    goals = []
    for segment in segments:
        try:
            goal_samples, summary = track_segment(
                cap,
                model,
                segment,
                fps,
                args,
                ball_class,
                person_classes,
            )
        except Exception as error:
            cap.release()
            raise RuntimeError(f"track_goal_{segment['goalNumber']}") from error
        samples.extend(goal_samples)
        goals.append(summary)
        if len(samples) >= MAX_OUTPUT_SAMPLES:
            break
    cap.release()
    passed = len(goals) == len(segments) and all(goal["passed"] for goal in goals)
    output = {
        "ok": True,
        "providerMode": "ultralytics-dense-ball-tracking",
        "sourceFrameRate": round(fps, 3),
        "inspectedFrameCount": sum(goal["inspectedFrameCount"] for goal in goals),
        "containedFrameCount": sum(goal["containedFrameCount"] for goal in goals),
        "perFrameBallContainmentPassed": passed,
        "goals": goals,
        "samples": samples[:MAX_OUTPUT_SAMPLES],
    }
    print(json.dumps(output, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        detail_code = str(error)
        if not detail_code.startswith("track_goal_") and detail_code not in {
            "runtime_input_missing",
            "video_unreadable",
            "invalid_frame_rate",
            "invalid_segments",
            "invalid_segment",
            "unsupported_model_classes",
        }:
            detail_code = "runtime_failure"
        print(json.dumps({
            "ok": False,
            "code": "DENSE_BALL_TRACKING_FAILED",
            "detailCode": detail_code,
        }))
        sys.exit(1)
