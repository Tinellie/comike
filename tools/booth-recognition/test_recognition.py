"""Run from any directory; defaults to page 1 of the repository sample PDF."""

import argparse
import logging
import sys
import time
from pathlib import Path

from booth_recognition import BoothRecognizer

ROOT = Path(__file__).resolve().parent


def page_numbers(value: str) -> list[int] | None:
    if value.lower() == "all":
        return None
    try:
        numbers = [int(item) for item in value.split(",")]
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use all or comma-separated page numbers, e.g. 1,2,3") from error
    if not numbers or min(numbers) < 1 or len(numbers) != len(set(numbers)):
        raise argparse.ArgumentTypeError("Page numbers must be positive and distinct")
    return numbers


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect booth boxes and recognize two-digit numbers locally.")
    parser.add_argument("input", nargs="?", type=Path, default=ROOT.parents[1] / "ref" / "official-map.pdf")
    parser.add_argument("--pages", type=page_numbers, default=[1], help="1-based pages: 1,2,3 or all (default: 1)")
    parser.add_argument("--output", type=Path, default=ROOT / "output")
    parser.add_argument("--detect-only", action="store_true", help="Skip PaddleOCR and only export cell coordinates")
    parser.add_argument("--confidence", type=float, default=0.95)
    parser.add_argument("--model", default="en_PP-OCRv5_mobile_rec")
    parser.add_argument("--model-dir", type=Path, help="Local model directory for offline use")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    start = time.perf_counter()
    recognizer = BoothRecognizer(
        detect_only=args.detect_only, confidence=args.confidence,
        model_name=args.model, model_dir=args.model_dir,
    )
    result = recognizer.recognize(args.input, pages=args.pages)
    target = result.save(args.output)
    print(f"\nResult: {target.resolve()}")
    print(f"Counts: {result.to_dict()['counts']}")
    print(f"Pages: {len(result.pages)}; skipped: {len(result.skipped_pages)}")
    print(f"Elapsed: {time.perf_counter() - start:.1f}s")
    print("Overlay: green=recognized, orange=review, red=unrecognized, blue=not run")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, FileNotFoundError) as error:
        logging.error("%s", error)
        sys.exit(1)
