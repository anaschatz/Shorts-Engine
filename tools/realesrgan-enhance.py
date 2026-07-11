#!/usr/bin/env python3
"""Bounded Real-ESRGAN frame-directory adapter for ShortsEngine."""

import argparse
import json
import os
import sys
from pathlib import Path


MAX_FRAMES = 5000
SUPPORTED_SUFFIXES = {".png", ".jpg", ".jpeg"}


def fail(code: str) -> None:
    print(json.dumps({"ok": False, "code": code}, separators=(",", ":")))
    raise SystemExit(1)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--input-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--scale", required=True, type=int)
    parser.add_argument("--tile", default=0, type=int)
    parser.add_argument("--device", default="auto", choices=("auto", "mps", "cpu"))
    return parser.parse_args()


def contained_files(directory: Path) -> list[Path]:
    if not directory.is_dir():
        fail("INPUT_DIRECTORY_INVALID")
    files = sorted(
        path for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() in SUPPORTED_SUFFIXES
    )
    if not files or len(files) > MAX_FRAMES:
        fail("FRAME_COUNT_INVALID")
    return files


def main() -> None:
    args = parse_args()
    if args.scale < 2 or args.scale > 6 or args.tile < 0 or args.tile > 2048:
        fail("ENHANCEMENT_ARGUMENT_INVALID")

    try:
        input_dir = Path(args.input_dir).resolve(strict=True)
        output_dir = Path(args.output_dir).resolve(strict=True)
        model_path = Path(args.model_path).resolve(strict=True)
    except (OSError, RuntimeError):
        fail("ENHANCEMENT_PATH_INVALID")
    if input_dir == output_dir or not model_path.is_file():
        fail("ENHANCEMENT_PATH_INVALID")

    frames = contained_files(input_dir)

    try:
        import cv2
        import torch
        import torchvision.transforms.functional as functional

        # BasicSR 1.4 imports the pre-0.17 torchvision compatibility module.
        sys.modules.setdefault("torchvision.transforms.functional_tensor", functional)
        from basicsr.archs.rrdbnet_arch import RRDBNet
        from realesrgan import RealESRGANer
    except Exception:
        fail("REALESRGAN_IMPORT_FAILED")

    if args.device == "mps" and not torch.backends.mps.is_available():
        fail("MPS_UNAVAILABLE")
    device_name = "mps" if args.device == "auto" and torch.backends.mps.is_available() else args.device
    if device_name == "auto":
        device_name = "cpu"
    device = torch.device(device_name)

    try:
        model = RRDBNet(
            num_in_ch=3,
            num_out_ch=3,
            num_feat=64,
            num_block=23,
            num_grow_ch=32,
            scale=4,
        )
        upsampler = RealESRGANer(
            scale=4,
            model_path=str(model_path),
            dni_weight=None,
            model=model,
            tile=args.tile,
            tile_pad=16,
            pre_pad=0,
            half=False,
            device=device,
        )
        for frame in frames:
            image = cv2.imread(str(frame), cv2.IMREAD_COLOR)
            if image is None:
                fail("FRAME_DECODE_FAILED")
            enhanced, _ = upsampler.enhance(image, outscale=args.scale)
            destination = output_dir / f"{frame.stem}.png"
            if not cv2.imwrite(str(destination), enhanced):
                fail("FRAME_WRITE_FAILED")
    except SystemExit:
        raise
    except Exception:
        fail("REALESRGAN_INFERENCE_FAILED")

    print(json.dumps({
        "ok": True,
        "provider": "realesrgan-python",
        "device": device_name,
        "frameCount": len(frames),
        "scale": args.scale,
    }, separators=(",", ":")))


if __name__ == "__main__":
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    main()
