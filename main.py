"""CLI entry point.

Usage:
    python main.py "https://www.youtube.com/watch?v=..." \
        --num-clips 3 --aspect-ratio 9:16
"""
import argparse
import json
import os
import sys

# Windows uses 'charmap' by default, which can't encode Unicode characters
# like →. Reconfigure stdout/stderr to UTF-8 so output works on all platforms.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from shorts_generator import generate_shorts
from shorts_generator.control_plane import (
    bind_control_plane_result,
    load_control_plane_request,
)
from shorts_generator.profiles import (
    BF_EDITORIAL_INSET_V1,
    FORMAT_PROFILES,
    RENDER_PROFILES,
    SELECTION_PROFILES,
)


def _parse_num_clips(value: str):
    if value.strip().lower() == "auto":
        return None
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("use a positive integer or 'auto'") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("use a positive integer or 'auto'")
    return parsed


def main() -> int:
    parser = argparse.ArgumentParser(description="AI YouTube Shorts Generator")
    parser.add_argument("url", help="YouTube URL, file:// URL, or local file path")
    parser.add_argument(
        "--mode",
        choices=["api", "local"],
        default="api",
        help="api (default, MuAPI) or local (remote URL, file://, or local path + faster-whisper + LLM provider + ffmpeg).",
    )
    parser.add_argument(
        "--num-clips",
        type=_parse_num_clips,
        default=None,
        metavar="N|auto",
        help="How many ranked shorts to render, or auto by source duration (default: auto)",
    )
    parser.add_argument("--aspect-ratio", default="9:16", help="Output aspect ratio (default: 9:16)")
    parser.add_argument("--format", default="720", help="Source download resolution: 360 / 480 / 720 / 1080 (default: 720)")
    parser.add_argument("--language", default=None, help="Force Whisper language code, e.g. 'en' (default: auto-detect)")
    parser.add_argument(
        "--profile",
        "--content-profile",
        dest="content_profile",
        choices=["auto", "motivational_podcast"],
        default="auto",
        help="Force a content profile or use automatic detection (default: auto)",
    )
    parser.add_argument(
        "--selection-profile",
        choices=["auto", *sorted(SELECTION_PROFILES)],
        default="auto",
        help="Versioned highlight-selection policy (default: auto/legacy)",
    )
    parser.add_argument(
        "--render-profile",
        choices=["auto", *sorted(RENDER_PROFILES)],
        default="auto",
        help="Versioned renderer contract; editorial inset profiles require --mode local",
    )
    parser.add_argument(
        "--format-profile",
        choices=["auto", *sorted(FORMAT_PROFILES)],
        default="auto",
        help="Combined content, selection, and render preset (default: auto/legacy)",
    )
    parser.add_argument("--output-json", default=None, help="Write the full result JSON to this path")
    parser.add_argument(
        "--select-only",
        action="store_true",
        help="Rank and persist candidates without rendering clips",
    )
    parser.add_argument(
        "--recent-publications",
        default=None,
        help=(
            "JSON ledger containing public and scheduled uploads. V4 uses "
            "its musicTrackId values to avoid recent track repetition."
        ),
    )
    parser.add_argument(
        "--upload-youtube",
        action="store_true",
        help="Upload successful renders through the official YouTube Data API",
    )
    parser.add_argument(
        "--youtube-privacy",
        choices=["private", "unlisted", "public"],
        default="private",
        help="Visibility for uploaded videos (default: private)",
    )
    parser.add_argument(
        "--youtube-metadata-file",
        default=None,
        help="Curated TITLE/DESCRIPTION file; valid when one Short is rendered",
    )
    parser.add_argument(
        "--youtube-expected-handle",
        default=os.getenv("YOUTUBE_EXPECTED_CHANNEL_HANDLE", ""),
        help="Fail closed if OAuth selects another channel",
    )
    parser.add_argument("--youtube-expected-channel-id", default=os.getenv("YOUTUBE_EXPECTED_CHANNEL_ID", ""))
    parser.add_argument("--youtube-client-secrets", default=None)
    parser.add_argument("--youtube-token-file", default=None)
    parser.add_argument("--youtube-notify-subscribers", action="store_true")
    args = parser.parse_args()

    if args.select_only and args.upload_youtube:
        print(
            "\nFAILED: --select-only cannot be combined with --upload-youtube",
            file=sys.stderr,
        )
        return 1

    try:
        recent_music_publications = None
        if args.recent_publications:
            with open(args.recent_publications, "r", encoding="utf-8") as handle:
                recent_ledger = json.load(handle)
            if not isinstance(recent_ledger, dict) or not isinstance(
                recent_ledger.get("publications"), list
            ):
                raise ValueError(
                    "--recent-publications must contain a publications list"
                )
            recent_music_publications = recent_ledger["publications"]
        control_plane_request = load_control_plane_request(os.environ)
        result = generate_shorts(
            youtube_url=args.url,
            num_clips=args.num_clips,
            aspect_ratio=args.aspect_ratio,
            download_format=args.format,
            language=args.language,
            mode=args.mode,
            content_profile=(
                None if args.content_profile == "auto" else args.content_profile
            ),
            selection_profile=(
                None if args.selection_profile == "auto" else args.selection_profile
            ),
            render_profile=None if args.render_profile == "auto" else args.render_profile,
            format_profile=None if args.format_profile == "auto" else args.format_profile,
            approved_candidate_hash=(
                control_plane_request["bindings"]["candidate_hash"]
                if control_plane_request
                else None
            ),
            approved_transcript=(
                control_plane_request["transcriptManifest"]["transcript"]
                if control_plane_request
                else None
            ),
            recent_music_publications=recent_music_publications,
            select_only=args.select_only,
        )
        result = bind_control_plane_result(
            result,
            os.environ,
            request=control_plane_request,
        )
    except Exception as e:
        print(f"\nFAILED: {e}", file=sys.stderr)
        return 1

    if args.upload_youtube:
        if result.get("profiles", {}).get("render_profile") == BF_EDITORIAL_INSET_V1:
            print(
                "\nFAILED TO UPLOAD: bf_editorial_inset_v1 requires the reviewed "
                "hash-bound publisher workflow (candidate decision, rights, experiment, "
                "render QA, and publish receipt). The legacy direct uploader is disabled "
                "for this production profile.",
                file=sys.stderr,
            )
            return 1
        if not args.youtube_expected_handle and not args.youtube_expected_channel_id:
            print(
                "\nFAILED: configure --youtube-expected-handle or "
                "--youtube-expected-channel-id before uploading",
                file=sys.stderr,
            )
            return 1
        try:
            from shorts_generator.youtube_uploader import upload_rendered_shorts

            youtube_result = upload_rendered_shorts(
                result["shorts"],
                source_url=args.url,
                metadata_file=args.youtube_metadata_file,
                privacy_status=args.youtube_privacy,
                expected_handle=args.youtube_expected_handle,
                expected_channel_id=args.youtube_expected_channel_id,
                client_secrets_file=args.youtube_client_secrets,
                token_file=args.youtube_token_file,
                notify_subscribers=args.youtube_notify_subscribers,
            )
            result["youtube"] = youtube_result
        except Exception as e:
            print(f"\nFAILED TO UPLOAD: {e}", file=sys.stderr)
            return 1

    print("\n" + "=" * 72)
    print(f"Mode:          {result.get('mode', args.mode)}")
    profiles = result.get("profiles", {})
    if any(
        profiles.get(key)
        for key in ("format_profile", "selection_profile", "render_profile")
    ):
        print(
            "Profiles:      "
            f"format={profiles.get('format_profile') or 'custom'} "
            f"selection={profiles.get('selection_profile') or 'legacy'} "
            f"render={profiles.get('render_profile') or 'legacy'}"
        )
    print(f"Source video:  {result['source_video_url']}")
    selected = result.get("selected_candidates", result["shorts"])
    print(f"Highlights:    {len(result['highlights'])} candidates → selected {len(selected)}")
    ranking = result.get("ranking", {})
    print(
        f"Batch target:  {ranking.get('target_clips', len(result['shorts']))} "
        f"({ranking.get('requested_clips', args.num_clips)})"
    )
    if ranking.get("selection_only"):
        print("Render:        skipped (--select-only)")
    print("=" * 72)
    summary_items = selected if ranking.get("selection_only") else result["shorts"]
    for i, s in enumerate(summary_items, 1):
        print(
            f"\n#{s.get('output_rank', i)}  score={s.get('final_score', s.get('score'))}  "
            f"{s.get('start_time'):.1f}s → {s.get('end_time'):.1f}s"
        )
        print(f"     title:  {s.get('title')}")
        print(f"     hook:   {s.get('hook_sentence')}")
        if ranking.get("selection_only"):
            print("     clip:   NOT RENDERED (selection-only)")
        elif s.get("clip_url"):
            print(f"     clip:   {s['clip_url']}")
        else:
            print(f"     clip:   FAILED ({s.get('error')})")
        if s.get("youtube_upload"):
            print(f"     youtube: {s['youtube_upload']['url']}")

    if args.output_json:
        with open(args.output_json, "w") as f:
            json.dump(result, f, indent=2)
        print(f"\nFull JSON written to {args.output_json}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
