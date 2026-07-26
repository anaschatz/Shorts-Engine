"""Idempotent, hash-bound publisher boundary for reviewed Shorts."""
from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Optional

import fcntl

from .artifact_contracts import (
    ArtifactBindingError,
    content_hash,
    file_sha256,
    verify_seal,
)


class PublishConflict(ArtifactBindingError):
    """Raised when an idempotency key or output was already used differently."""


class PublishReceiptStore:
    _PUBLISH_TRANSITION_FIELDS = (
        "idempotencyKey",
        "requestHash",
        "publishManifestHash",
        "renderManifestHash",
        "renderOutputHash",
        "candidateHash",
        "rightsManifestHash",
        "experimentManifestHash",
        "channelId",
        "privacyStatus",
        "uploadMarker",
    )
    _RELEASE_TRANSITION_FIELDS = (
        "releaseKey",
        "publishReceiptHash",
        "publishIdempotencyKey",
        "youtubeVideoId",
        "channelId",
        "fromPrivacyStatus",
        "toPrivacyStatus",
    )

    def __init__(self, path: str):
        self.path = Path(path)
        self.lock_path = self.path.with_name(f".{self.path.name}.lock")

    def _read(self) -> Dict:
        if not self.path.is_file():
            return {"schemaVersion": 1, "receipts": {}, "releases": {}}
        value = json.loads(self.path.read_text(encoding="utf-8"))
        if value.get("schemaVersion") != 1 or not isinstance(value.get("receipts"), dict):
            raise ArtifactBindingError("publish receipt store is invalid")
        releases = value.get("releases", {})
        if not isinstance(releases, dict):
            raise ArtifactBindingError("publish release store is invalid")
        return {**value, "releases": releases}

    @contextmanager
    def _exclusive_lock(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _write(self, payload: Dict) -> None:
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{self.path.name}.",
            dir=str(self.path.parent),
        )
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True, ensure_ascii=True)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self.path)
            directory_fd = os.open(str(self.path.parent), os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if os.path.exists(temporary_name):
                os.unlink(temporary_name)

    @staticmethod
    def _verify_record(record: Dict, artifact_type: str) -> Dict:
        return verify_seal(record, artifact_type)

    def find(self, idempotency_key: str) -> Optional[Dict]:
        receipt = self._read()["receipts"].get(idempotency_key)
        return self._verify_record(receipt, "PublishReceipt") if receipt else None

    def find_by_output_hash(self, output_hash: str) -> Optional[Dict]:
        receipt = next(
            (
                value
                for value in self._read()["receipts"].values()
                if value.get("renderOutputHash") == output_hash
            ),
            None,
        )
        return self._verify_record(receipt, "PublishReceipt") if receipt else None

    def find_by_video_id(self, youtube_video_id: str) -> Optional[Dict]:
        receipt = next(
            (
                value
                for value in self._read()["receipts"].values()
                if value.get("youtubeVideoId") == youtube_video_id
                and value.get("responseState") == "uploaded"
            ),
            None,
        )
        return self._verify_record(receipt, "PublishReceipt") if receipt else None

    def find_release(self, release_key: str) -> Optional[Dict]:
        release = self._read()["releases"].get(release_key)
        return self._verify_record(release, "VideoReleaseReceipt") if release else None

    @staticmethod
    def _transition_matches(existing: Dict, replacement: Dict, fields) -> bool:
        return all(existing.get(field) == replacement.get(field) for field in fields)

    def _save_record(
        self,
        collection: str,
        key_field: str,
        artifact_type: str,
        record: Dict,
    ) -> Dict:
        verified = self._verify_record(record, artifact_type)
        key = str(verified.get(key_field) or "").strip()
        if not key:
            raise ArtifactBindingError(f"{key_field} is required")
        with self._exclusive_lock():
            payload = self._read()
            existing = payload[collection].get(key)
            if existing:
                existing = self._verify_record(existing, artifact_type)
                if existing["contentHash"] == verified["contentHash"]:
                    return existing
                if collection == "receipts":
                    valid_transition = (
                        existing.get("responseState") == "pending"
                        and verified.get("responseState") == "uploaded"
                        and self._transition_matches(
                            existing,
                            verified,
                            self._PUBLISH_TRANSITION_FIELDS,
                        )
                    )
                else:
                    valid_transition = (
                        existing.get("responseState") == "pending"
                        and verified.get("responseState") == "released"
                        and self._transition_matches(
                            existing,
                            verified,
                            self._RELEASE_TRANSITION_FIELDS,
                        )
                    )
                if not valid_transition:
                    raise PublishConflict(
                        f"{key_field} is already bound to another state"
                    )
            elif collection == "receipts":
                duplicate = next(
                    (
                        value
                        for other_key, value in payload["receipts"].items()
                        if other_key != key
                        and value.get("renderOutputHash") == verified.get("renderOutputHash")
                    ),
                    None,
                )
                if duplicate:
                    self._verify_record(duplicate, "PublishReceipt")
                    raise PublishConflict("render output was already published")
            payload[collection][key] = verified
            self._write(payload)
            return verified

    def _begin_record(
        self,
        collection: str,
        key_field: str,
        artifact_type: str,
        record: Dict,
        immutable_fields,
    ) -> bool:
        verified = self._verify_record(record, artifact_type)
        if verified.get("responseState") != "pending":
            raise ArtifactBindingError("only a pending state can begin an external action")
        key = str(verified.get(key_field) or "").strip()
        if not key:
            raise ArtifactBindingError(f"{key_field} is required")
        with self._exclusive_lock():
            payload = self._read()
            existing = payload[collection].get(key)
            if existing:
                existing = self._verify_record(existing, artifact_type)
                if not self._transition_matches(existing, verified, immutable_fields):
                    raise PublishConflict(
                        f"{key_field} is already bound to another state"
                    )
                return False
            if collection == "receipts":
                duplicate = next(
                    (
                        value
                        for value in payload["receipts"].values()
                        if value.get("renderOutputHash") == verified.get("renderOutputHash")
                    ),
                    None,
                )
                if duplicate:
                    self._verify_record(duplicate, "PublishReceipt")
                    raise PublishConflict("render output was already published")
            payload[collection][key] = verified
            self._write(payload)
            return True

    def save(self, receipt: Dict) -> Dict:
        state = receipt.get("responseState")
        if state not in {"pending", "uploaded"}:
            raise ArtifactBindingError("publish receipt responseState is invalid")
        return self._save_record(
            "receipts",
            "idempotencyKey",
            "PublishReceipt",
            receipt,
        )

    def save_release(self, release: Dict) -> Dict:
        state = release.get("responseState")
        if state not in {"pending", "released"}:
            raise ArtifactBindingError("release receipt responseState is invalid")
        return self._save_record(
            "releases",
            "releaseKey",
            "VideoReleaseReceipt",
            release,
        )

    def begin_publish(self, pending_receipt: Dict) -> bool:
        return self._begin_record(
            "receipts",
            "idempotencyKey",
            "PublishReceipt",
            pending_receipt,
            self._PUBLISH_TRANSITION_FIELDS,
        )

    def begin_release(self, pending_release: Dict) -> bool:
        return self._begin_record(
            "releases",
            "releaseKey",
            "VideoReleaseReceipt",
            pending_release,
            self._RELEASE_TRANSITION_FIELDS,
        )


def publish_idempotency_key(
    publish_manifest: Dict,
    expected_channel_id: str = "",
) -> str:
    manifest = verify_seal(publish_manifest, "PublishManifest")
    return content_hash(
        {
            "renderOutputHash": manifest["renderOutputHash"],
            "channelId": str(expected_channel_id or "").strip(),
            "privacyStatus": manifest["privacyStatus"],
            "metadata": manifest["metadata"],
        }
    )


def publish_upload_marker(idempotency_key: str) -> str:
    key = str(idempotency_key or "").strip().lower()
    if len(key) != 64 or any(char not in "0123456789abcdef" for char in key):
        raise ArtifactBindingError("publish idempotency key must be sha256")
    return f"bf_publish_{key}"


def _timestamp(now: Callable[[], datetime]) -> str:
    value = now()
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _seal(payload: Dict) -> Dict:
    return {**payload, "contentHash": content_hash(payload)}


def _complete_upload(
    pending: Dict,
    response: Dict,
    receipt_store: PublishReceiptStore,
    now: Callable[[], datetime],
    *,
    replayed: bool,
    reconciled: bool,
) -> Dict:
    if not isinstance(response, dict):
        raise ArtifactBindingError("YouTube returned an invalid upload response")
    video_id = str(response.get("video_id") or response.get("id") or "").strip()
    if not video_id:
        raise ArtifactBindingError("YouTube returned no video ID")
    response_channel = str(response.get("channel_id") or "").strip()
    if (reconciled and response_channel != pending["channelId"]) or (
        response_channel and response_channel != pending["channelId"]
    ):
        raise PublishConflict("reconciled upload belongs to another channel")
    response_privacy = str(response.get("privacy_status") or "").strip().lower()
    if (reconciled and response_privacy != pending["privacyStatus"]) or (
        response_privacy and response_privacy != pending["privacyStatus"]
    ):
        raise PublishConflict("reconciled upload privacy does not match the request")
    response_marker = str(response.get("upload_marker") or "").strip()
    if (reconciled and response_marker != pending["uploadMarker"]) or (
        response_marker and response_marker != pending["uploadMarker"]
    ):
        raise PublishConflict("reconciled upload marker does not match the request")
    payload = {
        key: value
        for key, value in pending.items()
        if key not in {"contentHash", "responseState"}
    }
    payload.update(
        {
            "youtubeVideoId": video_id,
            "youtubeUrl": str(response.get("url") or "").strip()
            or f"https://www.youtube.com/watch?v={video_id}",
            "publishedAt": str(response.get("published_at") or "").strip()
            or _timestamp(now),
            "responseState": "uploaded",
        }
    )
    receipt = receipt_store.save(_seal(payload))
    return {**receipt, "replayed": replayed, "reconciled": reconciled}


def _resume_publish(
    previous: Dict,
    receipt_store: PublishReceiptStore,
    reconcile: Optional[Callable[[Dict], Optional[Dict]]],
    now: Callable[[], datetime],
) -> Dict:
    state = previous.get("responseState")
    if state == "uploaded":
        return {**previous, "replayed": True, "reconciled": False}
    if state != "pending":
        raise PublishConflict("publish receipt has an unknown response state")
    if reconcile is None:
        raise PublishConflict(
            "upload is pending reconciliation; refusing a second upload"
        )
    response = reconcile(previous)
    if not response:
        raise PublishConflict(
            "pending upload was not found during reconciliation; refusing a second upload"
        )
    return _complete_upload(
        previous,
        response,
        receipt_store,
        now,
        replayed=True,
        reconciled=True,
    )


def publish_reviewed_short(
    publish_manifest: Dict,
    render_manifest: Dict,
    receipt_store: PublishReceiptStore,
    expected_channel_id: str,
    authenticated_channel: Dict,
    upload: Callable[[str, Dict, str, bool], Dict],
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    public_release_approved: bool = False,
    reconcile: Optional[Callable[[Dict], Optional[Dict]]] = None,
    upload_marker: str = "",
) -> Dict:
    """Durably record intent, then upload once or fail closed on reconciliation."""
    manifest = verify_seal(publish_manifest, "PublishManifest")
    render = verify_seal(render_manifest, "RenderManifest")
    channel_id = str(authenticated_channel.get("id") or "")
    if not expected_channel_id or channel_id != expected_channel_id:
        raise ArtifactBindingError("authenticated YouTube channel does not match expected channel")
    if manifest["renderManifestHash"] != render["contentHash"]:
        raise ArtifactBindingError("publish manifest references another render")
    if manifest["renderOutputHash"] != render["outputHash"]:
        raise ArtifactBindingError("publish manifest output hash is stale")
    if file_sha256(render["outputPath"]) != render["outputHash"]:
        raise ArtifactBindingError("render file changed after approval")
    if manifest["privacyStatus"] == "public" and not public_release_approved:
        raise ArtifactBindingError("public release requires explicit approval")
    key = publish_idempotency_key(manifest, expected_channel_id)
    marker = str(upload_marker or publish_upload_marker(key)).strip()
    previous = receipt_store.find(key)
    if previous:
        return _resume_publish(previous, receipt_store, reconcile, now)
    duplicate = receipt_store.find_by_output_hash(render["outputHash"])
    if duplicate:
        raise PublishConflict("render output was already published with another request")

    pending_payload = {
        "schemaVersion": 1,
        "artifactType": "PublishReceipt",
        "idempotencyKey": key,
        "requestHash": manifest["contentHash"],
        "publishManifestHash": manifest["contentHash"],
        "renderManifestHash": render["contentHash"],
        "renderOutputHash": render["outputHash"],
        "candidateHash": manifest["candidateHash"],
        "rightsManifestHash": manifest["rightsManifestHash"],
        "experimentManifestHash": manifest["experimentManifestHash"],
        "channelId": channel_id,
        "privacyStatus": manifest["privacyStatus"],
        "uploadMarker": marker,
        "relatedVideoId": manifest.get("relatedVideoId"),
        "relatedVideoWaiverReason": manifest.get("relatedVideoWaiverReason"),
        "relatedVideoState": (
            "studio_action_required"
            if manifest.get("relatedVideoId")
            else "waived"
        ),
        "postUploadActions": (
            ["set_related_video_in_youtube_studio"]
            if manifest.get("relatedVideoId")
            else []
        ),
        "pendingAt": _timestamp(now),
        "responseState": "pending",
    }
    pending = _seal(pending_payload)
    if not receipt_store.begin_publish(pending):
        concurrent = receipt_store.find(key)
        if not concurrent:
            raise PublishConflict("publish state changed during durable begin")
        return _resume_publish(concurrent, receipt_store, reconcile, now)

    response = upload(
        render["outputPath"],
        manifest["metadata"],
        manifest["privacyStatus"],
        manifest["containsSyntheticMedia"],
    )
    return _complete_upload(
        pending,
        response,
        receipt_store,
        now,
        replayed=False,
        reconciled=False,
    )


def release_idempotency_key(publish_receipt: Dict) -> str:
    receipt = verify_seal(publish_receipt, "PublishReceipt")
    if receipt.get("responseState") != "uploaded":
        raise ArtifactBindingError("only an uploaded receipt can be released")
    return content_hash(
        {
            "publishReceiptHash": receipt["contentHash"],
            "youtubeVideoId": receipt["youtubeVideoId"],
            "channelId": receipt["channelId"],
            "fromPrivacyStatus": "private",
            "toPrivacyStatus": "public",
        }
    )


def _complete_release(
    pending: Dict,
    response: Dict,
    receipt_store: PublishReceiptStore,
    now: Callable[[], datetime],
    *,
    replayed: bool,
    reconciled: bool,
) -> Dict:
    if not isinstance(response, dict):
        raise ArtifactBindingError("YouTube returned an invalid privacy update response")
    video_id = str(response.get("video_id") or response.get("id") or "").strip()
    if video_id != pending["youtubeVideoId"]:
        raise PublishConflict("privacy update returned another YouTube video")
    response_channel = str(response.get("channel_id") or "").strip()
    if response_channel and response_channel != pending["channelId"]:
        raise PublishConflict("privacy update returned another YouTube channel")
    privacy = str(response.get("privacy_status") or "").strip().lower()
    if privacy != "public":
        raise ArtifactBindingError("YouTube did not confirm public privacy status")
    payload = {
        key: value
        for key, value in pending.items()
        if key not in {"contentHash", "responseState"}
    }
    payload.update(
        {
            "releasedAt": str(response.get("updated_at") or "").strip()
            or _timestamp(now),
            "responseState": "released",
        }
    )
    release = receipt_store.save_release(_seal(payload))
    return {**release, "replayed": replayed, "reconciled": reconciled}


def release_uploaded_short(
    receipt_store: PublishReceiptStore,
    youtube_video_id: str,
    expected_channel_id: str,
    authenticated_channel: Dict,
    update_privacy: Callable[[str, str], Dict],
    inspect_video: Optional[Callable[[str], Optional[Dict]]] = None,
    now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
    public_release_approved: bool = False,
) -> Dict:
    """Update one stored private video to public without creating another upload."""
    if not public_release_approved:
        raise ArtifactBindingError("public release requires explicit approval")
    channel_id = str(authenticated_channel.get("id") or "")
    if not expected_channel_id or channel_id != expected_channel_id:
        raise ArtifactBindingError("authenticated YouTube channel does not match expected channel")
    receipt = receipt_store.find_by_video_id(str(youtube_video_id or "").strip())
    if not receipt:
        raise ArtifactBindingError("YouTube video is not bound to an uploaded receipt")
    if receipt["channelId"] != channel_id:
        raise ArtifactBindingError("publish receipt belongs to another YouTube channel")
    if receipt.get("privacyStatus") != "private":
        raise ArtifactBindingError("release flow only permits private to public updates")
    release_key = release_idempotency_key(receipt)
    previous = receipt_store.find_release(release_key)
    if previous and previous.get("responseState") == "released":
        return {**previous, "replayed": True, "reconciled": False}

    resuming = previous is not None
    pending = previous
    if pending is None:
        pending_payload = {
            "schemaVersion": 1,
            "artifactType": "VideoReleaseReceipt",
            "releaseKey": release_key,
            "publishReceiptHash": receipt["contentHash"],
            "publishIdempotencyKey": receipt["idempotencyKey"],
            "youtubeVideoId": receipt["youtubeVideoId"],
            "channelId": channel_id,
            "fromPrivacyStatus": "private",
            "toPrivacyStatus": "public",
            "pendingAt": _timestamp(now),
            "responseState": "pending",
        }
        proposed = _seal(pending_payload)
        if receipt_store.begin_release(proposed):
            pending = proposed
        else:
            pending = receipt_store.find_release(release_key)
            resuming = True
            if pending and pending.get("responseState") == "released":
                return {**pending, "replayed": True, "reconciled": False}
    if not pending or pending.get("responseState") != "pending":
        raise PublishConflict("release state changed during durable begin")

    if resuming:
        if inspect_video is None:
            raise PublishConflict(
                "pending release requires remote reconciliation before another update"
            )
        observed = inspect_video(receipt["youtubeVideoId"])
        if not observed:
            raise PublishConflict("pending release could not be reconciled")
        observed_video_id = str(observed.get("video_id") or observed.get("id") or "").strip()
        observed_channel = str(observed.get("channel_id") or "").strip()
        if observed_video_id != receipt["youtubeVideoId"]:
            raise PublishConflict("pending release reconciliation returned another video")
        if observed_channel and observed_channel != channel_id:
            raise PublishConflict("pending release reconciliation returned another channel")
        observed_privacy = str(observed.get("privacy_status") or "").strip().lower()
        if observed_privacy == "public":
            return _complete_release(
                pending,
                observed,
                receipt_store,
                now,
                replayed=True,
                reconciled=True,
            )
        if observed_privacy != "private":
            raise PublishConflict("pending release has an unexpected remote privacy state")

    response = update_privacy(receipt["youtubeVideoId"], "public")
    return _complete_release(
        pending,
        response,
        receipt_store,
        now,
        replayed=resuming,
        reconciled=False,
    )


__all__ = [
    "PublishConflict",
    "PublishReceiptStore",
    "publish_idempotency_key",
    "publish_upload_marker",
    "publish_reviewed_short",
    "release_idempotency_key",
    "release_uploaded_short",
]
