#!/usr/bin/env python3
"""Operator CLI for the reviewed Budget Friendly production and growth loop."""
from __future__ import annotations

import argparse
import json
import os
import tempfile
import unicodedata
from pathlib import Path

from shorts_generator.artifact_contracts import (
    ArtifactBindingError,
    CANDIDATE_DECISION_PROFILE_RULES,
    CANDIDATE_PROFILE_FIELDS,
    build_candidate_decision,
    build_publish_manifest,
    build_replay_transcript_manifest,
    build_rights_manifest,
    candidate_hash,
    content_hash,
    file_sha256,
    verify_replay_transcript_manifest,
    verify_seal,
)
from shorts_generator.config import (
    LOCAL_AUTORESEARCH_EVIDENCE_DIR,
    LOCAL_PERFORMANCE_REPORT_DIR,
    LOCAL_RENDER_WORKERS,
)
from shorts_generator.experiment import build_experiment_manifest
from shorts_generator.growth_analytics import (
    GrowthAnalyticsStore,
    build_analytics_snapshot,
    evaluate_cohorts,
    import_studio_csv,
)
from shorts_generator.originality import evaluate_originality
from shorts_generator.performance import PerformanceTelemetry
from shorts_generator.local.downloader import _extract_youtube_video_id
from shorts_generator.local.youtube_captions import (
    _cache_matches as _youtube_caption_cache_matches,
)
from shorts_generator.production_workflow import (
    render_approved_candidate,
    render_approved_candidates,
)
from shorts_generator.profiles import (
    profile_manifest_metadata,
    resolve_profile_bundle,
)
from shorts_generator.replay_capture import (
    archive_approved_candidate,
    build_replay_capture_dataset,
    write_immutable_json,
)
from shorts_generator.publisher import (
    PublishReceiptStore,
    publish_idempotency_key,
    publish_reviewed_short,
    publish_upload_marker,
    release_uploaded_short,
)


def read_json(path: str) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object in {path}")
    return value


def write_json(path: str, value: dict) -> str:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=True)
            handle.write("\n")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return str(target.resolve())


def finish_performance_report(telemetry: PerformanceTelemetry) -> dict:
    report_path = (
        Path(LOCAL_PERFORMANCE_REPORT_DIR)
        / f"{telemetry.run_id}.json"
    )
    try:
        written = telemetry.write_report(report_path)
        written_path = str(written)
        write_error = None
    except (OSError, TypeError, ValueError, RuntimeError) as error:
        telemetry.finish()
        written_path = None
        write_error = str(error)
    report = telemetry.snapshot()
    payload = {
        "runId": telemetry.run_id,
        "reportPath": written_path,
        "durationSeconds": report["durationSeconds"],
        "stageTotals": report["stageTotals"],
        "cacheCounters": report["cacheCounters"],
    }
    if write_error:
        payload["reportWriteError"] = write_error
    return payload


def candidate_from_file(
    path: str,
    rank: int | None,
    source_path: str,
) -> tuple[dict, dict, str]:
    ranking = verify_seal(read_json(path), "RankingManifest")
    if rank is None:
        raise ValueError("--rank is required when approving from ranking.json")
    source_hash = file_sha256(source_path)
    if ranking.get("sourceHash") != source_hash:
        raise ArtifactBindingError("ranking manifest is not bound to the supplied source")
    profile_contracts = tuple(
        (
            profile_tuple,
            profile_manifest_metadata(
                resolve_profile_bundle(format_profile=profile_tuple[3])
            ),
        )
        for profile_tuple in CANDIDATE_DECISION_PROFILE_RULES
    )
    matching_contracts = [
        item for item in profile_contracts if ranking.get("profiles") == item[1]
    ]
    if len(matching_contracts) != 1:
        raise ArtifactBindingError(
            "ranking manifest does not freeze an approved review profile"
        )
    expected_profile_tuple = matching_contracts[0][0]
    candidates = ranking.get("candidates")
    if not isinstance(candidates, list):
        raise ArtifactBindingError("ranking manifest candidates are invalid")
    matches = []
    for candidate in candidates:
        if not isinstance(candidate, dict):
            raise ArtifactBindingError("ranking manifest candidate is invalid")
        raw_rank = candidate.get("selection_rank", candidate.get("output_rank", -1))
        try:
            candidate_rank = int(raw_rank)
        except (TypeError, ValueError):
            continue
        if candidate_rank == rank:
            matches.append(candidate)
    if len(matches) != 1:
        raise ValueError(f"Candidate rank {rank} did not resolve exactly once")
    candidate = matches[0]
    if candidate.get("rejected") is not False or candidate.get("rejection_reasons"):
        raise ArtifactBindingError("only an eligible non-rejected ranking candidate can be approved")
    expected_candidate_profiles = dict(
        zip(CANDIDATE_PROFILE_FIELDS, expected_profile_tuple)
    )
    for field, expected in expected_candidate_profiles.items():
        if str(candidate.get(field) or "").strip().lower() != expected:
            raise ArtifactBindingError(f"ranking candidate {field} is incompatible")
    declared_candidate_hash = str(candidate.get("candidate_hash") or "").strip().lower()
    if declared_candidate_hash != candidate_hash(candidate, source_hash):
        raise ArtifactBindingError("ranking candidate hash is stale")
    return ranking, candidate, source_hash


def _normalize_backfill_text(value: object) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    return "".join(character for character in normalized if character.isalnum())


def _verify_backfill_transcript_provenance(
    transcript: dict,
    *,
    source_input: str,
    source_hash: str,
) -> None:
    cache = transcript.get("_cache")
    if not isinstance(cache, dict):
        raise ArtifactBindingError("raw transcript lacks verifiable cache provenance")
    cached_source_hash = str(cache.get("source_sha256") or "").strip().lower()
    if cached_source_hash:
        if cache.get("schema_version") != 3 or cached_source_hash != source_hash:
            raise ArtifactBindingError("transcript cache references another source")
        return
    video_id = _extract_youtube_video_id(source_input)
    if (
        not video_id
        or not str(cache.get("provider") or "").strip()
        or not str(cache.get("track_language") or "").strip()
        or not _youtube_caption_cache_matches(
            transcript,
            video_id,
            str(cache.get("requested_language") or "auto"),
            allow_legacy_parser=True,
        )
    ):
        raise ArtifactBindingError("raw transcript cache provenance is incompatible")


def _verify_backfill_candidate_text(
    ranking: dict,
    transcript: dict,
) -> None:
    timed_words = []
    for segment in transcript.get("segments") or []:
        for word in segment.get("words") or []:
            token = str(word.get("word") or word.get("text") or "").strip()
            if any(character.isspace() for character in token):
                raise ArtifactBindingError(
                    "replay backfill word tokens must not contain whitespace"
                )
            timed_words.append(word)
    for index, candidate in enumerate(ranking.get("candidates") or []):
        speech_start = float(
            candidate.get("speech_start_time", candidate.get("start_time"))
        )
        speech_end = float(
            candidate.get("speech_end_time", candidate.get("end_time"))
        )
        interval_text = " ".join(
            str(word.get("word") or word.get("text") or "")
            for word in timed_words
            if float(word.get("end") or 0.0) >= speech_start - 0.05
            and float(word.get("start") or 0.0) <= speech_end + 0.05
        )
        expected = _normalize_backfill_text(candidate.get("candidate_text"))
        observed = _normalize_backfill_text(interval_text)
        if not expected or expected not in observed:
            raise ArtifactBindingError(
                f"ranking candidate[{index}] text is not supported by its timed interval"
            )


def command_bind_replay_transcript(args) -> dict:
    """Create a new replay-capable ranking without inventing a human label."""
    output = Path(args.output).expanduser().resolve()
    evidence_root = Path(args.evidence_dir).expanduser().resolve()
    try:
        output.relative_to(evidence_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            "--output must be outside the append-only Autoresearch evidence root"
        )

    ranking = verify_seal(read_json(args.ranking), "RankingManifest")
    if ranking.get("schemaVersion") != 1:
        raise ArtifactBindingError("unsupported RankingManifest schema")
    if ranking.get("replayTranscriptManifest") is not None:
        raise ArtifactBindingError("ranking already has a replay transcript manifest")
    source_path = Path(args.source).expanduser().resolve()
    source_hash = file_sha256(str(source_path))
    if ranking.get("sourceHash") != source_hash:
        raise ArtifactBindingError("ranking manifest is not bound to the supplied source")
    source = ranking.get("source")
    if not isinstance(source, dict) or not str(source.get("input") or "").strip():
        raise ArtifactBindingError("ranking manifest source is invalid")

    transcript_document = read_json(args.transcript)
    if transcript_document.get("artifactType") == "BudgetFriendlyReplayTranscriptManifestV2":
        transcript_manifest = verify_replay_transcript_manifest(
            transcript_document,
            source_hash=source_hash,
            require_timed_words=True,
        )
    else:
        _verify_backfill_transcript_provenance(
            transcript_document,
            source_input=str(source["input"]),
            source_hash=source_hash,
        )
        transcript_manifest = build_replay_transcript_manifest(
            transcript_document,
            source_hash,
        )
    verified_transcript = verify_replay_transcript_manifest(
        transcript_manifest,
        source_hash=source_hash,
        require_timed_words=True,
    )["transcript"]
    _verify_backfill_candidate_text(ranking, verified_transcript)

    ranking_body = {
        key: value for key, value in ranking.items() if key != "contentHash"
    }
    ranking_body["source"] = {
        **source,
        "local_path": str(source_path),
    }
    ranking_body["replayTranscriptManifest"] = transcript_manifest
    ranking_body["replayBackfillProvenance"] = {
        "method": "bind_exact_transcript_v1",
        "legacyRankingManifestHash": ranking["contentHash"],
        "humanLabelSemantics": "unknown_not_human_label",
    }
    replay_ranking = {
        **ranking_body,
        "contentHash": content_hash(ranking_body),
    }
    capture_dataset = build_replay_capture_dataset(replay_ranking)
    created = write_immutable_json(output, replay_ranking)
    return {
        "rankingPath": str(output),
        "created": created,
        "legacyRankingManifestHash": ranking["contentHash"],
        "rankingManifestHash": replay_ranking["contentHash"],
        "replayTranscriptManifestHash": transcript_manifest["contentHash"],
        "captureDatasetHash": capture_dataset["contentHash"],
        "candidateCount": len(capture_dataset["candidates"]),
        "engineSelectedCandidateCount": len(
            capture_dataset["engineSelectedCandidateHashes"]
        ),
        "engineSelectionSemantics": capture_dataset["engineSelectionSemantics"],
        "humanPositiveCount": 0,
        "approvalRequired": True,
    }


def command_approve(args) -> dict:
    evidence_root = Path(args.evidence_dir).expanduser().resolve()
    decision_output = Path(args.output).expanduser().resolve()
    try:
        decision_output.relative_to(evidence_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            "--output must be outside the append-only Autoresearch evidence root"
        )
    ranking, candidate, source_hash = candidate_from_file(
        args.candidate_json,
        args.rank,
        args.source,
    )
    decision = build_candidate_decision(
        candidate,
        source_hash,
        reviewer=args.reviewer,
        decided_at=args.decided_at,
        ranking_manifest_hash=ranking["contentHash"],
        notes=args.notes,
    )
    archive_approved_candidate(
        ranking,
        decision,
        approved_rank=args.rank,
        evidence_dir=evidence_root,
    )
    write_json(args.output, decision)
    return decision


def command_experiment(args) -> dict:
    decision = read_json(args.candidate_decision)
    candidate = decision["candidate"]
    duration = float(candidate["end_time"]) - float(candidate["start_time"])
    manifest = build_experiment_manifest(
        experiment_id=args.experiment_id,
        cohort_id=args.cohort,
        treatment_id=args.treatment,
        candidate_hash=decision["candidateHash"],
        hypothesis=args.hypothesis,
        primary_variable=args.primary_variable,
        pillar=args.pillar,
        duration_seconds=duration,
        declared_at=args.declared_at,
        decision_due_at=args.decision_due_at,
        speaker_id=args.speaker_id,
        source_popularity_bucket=args.source_popularity_bucket,
    )
    write_json(args.output, manifest)
    return manifest


def command_render(args) -> dict:
    telemetry = PerformanceTelemetry(
        metadata={"workflow": "render-approved", "requestedCount": 1}
    )
    try:
        with telemetry.stage("production.pipeline", requestedCount=1):
            result = render_approved_candidate(
                args.source,
                read_json(args.transcript),
                read_json(args.candidate_decision),
                read_json(args.experiment),
                args.output_dir,
                telemetry=telemetry,
            )
    except BaseException:
        finish_performance_report(telemetry)
        raise
    result["performance"] = finish_performance_report(telemetry)
    output = args.output or str(Path(args.output_dir) / "production-bundle.json")
    write_json(output, result)
    return {"bundlePath": str(Path(output).resolve()), **result}


def command_render_batch(args) -> dict:
    """Render multiple reviewed candidates in one bounded production batch."""
    decisions = [read_json(path) for path in args.candidate_decision]
    experiments = [read_json(path) for path in args.experiment]
    telemetry = PerformanceTelemetry(
        metadata={
            "workflow": "render-approved-batch",
            "requestedCount": len(decisions),
            "maxWorkers": args.max_workers,
        }
    )
    try:
        with telemetry.stage(
            "production.pipeline",
            requestedCount=len(decisions),
        ):
            result = render_approved_candidates(
                args.source,
                read_json(args.transcript),
                decisions,
                experiments,
                args.output_dir,
                max_workers=args.max_workers,
                telemetry=telemetry,
            )
    except BaseException:
        finish_performance_report(telemetry)
        raise
    result["performance"] = finish_performance_report(telemetry)
    for outcome in result["results"]:
        if outcome["status"] != "succeeded":
            continue
        bundle_path = Path(args.output_dir) / (
            f"production-bundle-{int(outcome['index']) + 1:02d}.json"
        )
        write_json(str(bundle_path), outcome["result"])
        outcome["bundlePath"] = str(bundle_path.resolve())

    output = args.output or str(Path(args.output_dir) / "production-batch.json")
    write_json(output, result)
    return {"batchPath": str(Path(output).resolve()), **result}


def command_originality(args) -> dict:
    decision = verify_seal(
        read_json(args.candidate_decision),
        "CandidateDecision",
    )
    if candidate_hash(decision["candidate"], decision["sourceHash"]) != decision["candidateHash"]:
        raise ArtifactBindingError("candidate decision hash is stale")
    recent = read_json(args.recent_publications).get("publications", [])
    report = evaluate_originality(
        decision["candidate"],
        decision["candidateHash"],
        decision["sourceHash"],
        recent,
        candidate_decision_hash=decision["contentHash"],
    )
    write_json(args.output, report)
    return report


def command_rights(args) -> dict:
    decision = read_json(args.candidate_decision)
    report = build_rights_manifest(
        decision["sourceHash"],
        status=args.status,
        owner=args.owner,
        evidence_reference=args.evidence_reference,
        allowed_platforms=args.platform,
        music_license_reference=args.music_license,
        font_license_references=args.font_license,
        attribution_text=args.attribution_text,
    )
    write_json(args.output, report)
    return report


def command_publish_plan(args) -> dict:
    bundle = read_json(args.production_bundle)
    metadata = read_json(args.metadata)
    manifest = build_publish_manifest(
        bundle["renderManifest"],
        bundle["creativeQaReport"],
        read_json(args.rights),
        bundle["experimentManifest"],
        bundle["candidateDecision"],
        metadata,
        originality_report=read_json(args.originality),
        audio_qa_report=bundle["audioQaReport"],
        privacy_status=args.privacy,
        related_video_id=args.related_video_id,
        related_video_waiver_reason=args.related_video_waiver,
    )
    write_json(args.output, manifest)
    return manifest


def command_publish(args) -> dict:
    from shorts_generator.youtube_uploader import (
        YouTubeMetadata,
        find_video_by_upload_marker,
        get_authenticated_service,
        upload_video,
        verify_authenticated_channel,
    )

    manifest = verify_seal(read_json(args.publish_manifest), "PublishManifest")
    render = verify_seal(read_json(args.render_manifest), "RenderManifest")
    if manifest.get("renderManifestHash") != render.get("contentHash"):
        raise ValueError("publish manifest references another render")
    if manifest.get("renderOutputHash") != render.get("outputHash"):
        raise ValueError("publish manifest output hash is stale")
    if file_sha256(render["outputPath"]) != render["outputHash"]:
        raise ValueError("render file changed after publish approval")
    if manifest.get("privacyStatus") == "public" and not args.confirm_public:
        raise ValueError("public release requires --confirm-public")
    idempotency_key = publish_idempotency_key(manifest, args.expected_channel_id)
    upload_marker = publish_upload_marker(idempotency_key)
    youtube = get_authenticated_service(args.client_secrets, args.token_file)
    channel = verify_authenticated_channel(
        youtube,
        expected_channel_id=args.expected_channel_id,
    )

    def upload(path, metadata, privacy, contains_synthetic_media):
        return upload_video(
            youtube,
            path,
            YouTubeMetadata(
                title=str(metadata["title"]),
                description=str(metadata["description"]),
                tags=tuple(metadata.get("tags") or ("shorts",)),
                category_id=str(metadata.get("categoryId") or "22"),
            ),
            privacy_status=privacy,
            contains_synthetic_media=contains_synthetic_media,
            upload_marker=upload_marker,
        )

    def reconcile(pending):
        return find_video_by_upload_marker(
            youtube,
            channel["id"],
            pending["uploadMarker"],
        )

    receipt = publish_reviewed_short(
        manifest,
        render,
        PublishReceiptStore(args.receipt_store),
        expected_channel_id=args.expected_channel_id,
        authenticated_channel=channel,
        upload=upload,
        public_release_approved=args.confirm_public,
        reconcile=reconcile,
        upload_marker=upload_marker,
    )
    return receipt


def command_release(args) -> dict:
    if not args.confirm_public:
        raise ValueError("public release requires --confirm-public")
    from shorts_generator.youtube_uploader import (
        get_authenticated_service,
        get_video_status,
        update_video_privacy,
        verify_authenticated_channel,
    )

    youtube = get_authenticated_service(args.client_secrets, args.token_file)
    channel = verify_authenticated_channel(
        youtube,
        expected_channel_id=args.expected_channel_id,
    )

    def inspect(video_id):
        return get_video_status(youtube, video_id)

    def update(video_id, privacy_status):
        return update_video_privacy(youtube, video_id, privacy_status)

    return release_uploaded_short(
        PublishReceiptStore(args.receipt_store),
        youtube_video_id=args.youtube_video_id,
        expected_channel_id=args.expected_channel_id,
        authenticated_channel=channel,
        update_privacy=update,
        inspect_video=inspect,
        public_release_approved=True,
    )


def command_snapshot(args) -> dict:
    metrics = read_json(args.metrics)
    experiment = read_json(args.experiment)
    snapshot = build_analytics_snapshot(
        video_id=args.video_id,
        published_at=args.published_at,
        observed_at=args.observed_at,
        metrics=metrics,
        source=args.source,
        experiment_id=experiment["experimentId"],
        cohort_id=experiment["cohortId"],
        treatment_id=experiment["treatmentId"],
        pillar=experiment["pillar"],
        duration_seconds=args.duration_seconds,
    )
    GrowthAnalyticsStore(args.store).upsert(snapshot)
    return snapshot


def command_evaluate(args) -> dict:
    report = evaluate_cohorts(
        GrowthAnalyticsStore(args.store).list(args.gate_hours),
        gate_hours=args.gate_hours,
        minimum_per_cohort=args.minimum_per_cohort,
    )
    write_json(args.output, report)
    return report


def command_import_csv(args) -> dict:
    value = {"schemaVersion": 1, "rows": import_studio_csv(args.csv)}
    if args.output:
        write_json(args.output, value)
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    bind_replay = sub.add_parser("bind-replay-transcript")
    bind_replay.add_argument("--ranking", required=True)
    bind_replay.add_argument("--source", required=True)
    bind_replay.add_argument("--transcript", required=True)
    bind_replay.add_argument(
        "--evidence-dir",
        default=LOCAL_AUTORESEARCH_EVIDENCE_DIR,
        help="Append-only evidence root, which may not contain this review artifact.",
    )
    bind_replay.add_argument("--output", required=True)
    bind_replay.set_defaults(handler=command_bind_replay_transcript)

    approve = sub.add_parser("approve-candidate")
    approve.add_argument("--candidate-json", required=True)
    approve.add_argument("--rank", type=int)
    approve.add_argument("--source", required=True)
    approve.add_argument("--reviewer", required=True)
    approve.add_argument("--decided-at", required=True)
    approve.add_argument("--notes", default="")
    approve.add_argument(
        "--evidence-dir",
        default=LOCAL_AUTORESEARCH_EVIDENCE_DIR,
        help=(
            "Durable append-only Autoresearch approval evidence root "
            "(separate from output and caches)."
        ),
    )
    approve.add_argument("--output", required=True)
    approve.set_defaults(handler=command_approve)

    experiment = sub.add_parser("declare-experiment")
    experiment.add_argument("--candidate-decision", required=True)
    experiment.add_argument("--experiment-id", required=True)
    experiment.add_argument("--cohort", choices=("contradiction", "concrete_rule", "identity_stakes", "legacy_control"), required=True)
    experiment.add_argument("--treatment", required=True)
    experiment.add_argument("--hypothesis", required=True)
    experiment.add_argument("--primary-variable", default="hook_family")
    experiment.add_argument("--pillar", required=True)
    experiment.add_argument("--declared-at", required=True)
    experiment.add_argument("--decision-due-at", required=True)
    experiment.add_argument("--speaker-id")
    experiment.add_argument("--source-popularity-bucket")
    experiment.add_argument("--output", required=True)
    experiment.set_defaults(handler=command_experiment)

    render = sub.add_parser("render-approved")
    render.add_argument("--source", required=True)
    render.add_argument("--transcript", required=True)
    render.add_argument("--candidate-decision", required=True)
    render.add_argument("--experiment", required=True)
    render.add_argument("--output-dir", required=True)
    render.add_argument("--output")
    render.set_defaults(handler=command_render)

    render_batch = sub.add_parser("render-approved-batch")
    render_batch.add_argument("--source", required=True)
    render_batch.add_argument("--transcript", required=True)
    render_batch.add_argument(
        "--candidate-decision",
        action="append",
        required=True,
        help="Repeat once per approved Short, in desired output order.",
    )
    render_batch.add_argument(
        "--experiment",
        action="append",
        required=True,
        help="Repeat in the same order as --candidate-decision.",
    )
    render_batch.add_argument("--output-dir", required=True)
    render_batch.add_argument(
        "--max-workers",
        type=int,
        default=LOCAL_RENDER_WORKERS,
    )
    render_batch.add_argument("--output")
    render_batch.set_defaults(handler=command_render_batch)

    originality = sub.add_parser("originality")
    originality.add_argument("--candidate-decision", required=True)
    originality.add_argument("--recent-publications", required=True)
    originality.add_argument("--output", required=True)
    originality.set_defaults(handler=command_originality)

    rights = sub.add_parser("rights")
    rights.add_argument("--candidate-decision", required=True)
    rights.add_argument("--status", choices=("owned", "licensed", "permission_granted"), required=True)
    rights.add_argument("--owner", required=True)
    rights.add_argument("--evidence-reference", required=True)
    rights.add_argument("--platform", action="append", default=["youtube"])
    rights.add_argument("--music-license", required=True)
    rights.add_argument("--font-license", action="append", required=True)
    rights.add_argument("--attribution-text", required=True)
    rights.add_argument("--output", required=True)
    rights.set_defaults(handler=command_rights)

    plan = sub.add_parser("publish-plan")
    plan.add_argument("--production-bundle", required=True)
    plan.add_argument("--rights", required=True)
    plan.add_argument("--originality", required=True)
    plan.add_argument("--metadata", required=True)
    plan.add_argument("--privacy", choices=("private", "unlisted", "public"), default="private")
    plan.add_argument("--related-video-id")
    plan.add_argument("--related-video-waiver")
    plan.add_argument("--output", required=True)
    plan.set_defaults(handler=command_publish_plan)

    publish = sub.add_parser("publish")
    publish.add_argument("--publish-manifest", required=True)
    publish.add_argument("--render-manifest", required=True)
    publish.add_argument("--receipt-store", required=True)
    publish.add_argument("--expected-channel-id", required=True)
    publish.add_argument("--client-secrets")
    publish.add_argument("--token-file")
    publish.add_argument("--confirm-public", action="store_true")
    publish.set_defaults(handler=command_publish)

    release = sub.add_parser("release")
    release.add_argument("--youtube-video-id", required=True)
    release.add_argument("--receipt-store", required=True)
    release.add_argument("--expected-channel-id", required=True)
    release.add_argument("--client-secrets")
    release.add_argument("--token-file")
    release.add_argument("--confirm-public", action="store_true")
    release.set_defaults(handler=command_release)

    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--video-id", required=True)
    snapshot.add_argument("--published-at", required=True)
    snapshot.add_argument("--observed-at", required=True)
    snapshot.add_argument("--metrics", required=True)
    snapshot.add_argument("--source", choices=("youtube_analytics_api", "studio_csv", "manual"), required=True)
    snapshot.add_argument("--experiment", required=True)
    snapshot.add_argument("--duration-seconds", type=float, required=True)
    snapshot.add_argument("--store", required=True)
    snapshot.set_defaults(handler=command_snapshot)

    evaluate = sub.add_parser("evaluate")
    evaluate.add_argument("--store", required=True)
    evaluate.add_argument("--gate-hours", type=int, choices=(24, 72, 168, 672), default=168)
    evaluate.add_argument("--minimum-per-cohort", type=int, default=3)
    evaluate.add_argument("--output", required=True)
    evaluate.set_defaults(handler=command_evaluate)

    csv_parser = sub.add_parser("import-studio-csv")
    csv_parser.add_argument("--csv", required=True)
    csv_parser.add_argument("--output")
    csv_parser.set_defaults(handler=command_import_csv)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.handler(args)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, indent=2))
        return 1
    print(json.dumps({"ok": True, "result": result}, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
