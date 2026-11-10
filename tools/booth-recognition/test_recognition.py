"""Run from any directory; defaults to page 1 of the repository sample PDF."""

import argparse
import json
import logging
import sys
import time
from pathlib import Path

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer
from island_assignment import AssignmentError
from map_recognition.pipeline import MapRecognizer

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
    parser = argparse.ArgumentParser(description="Booth OCR -> pixel-adjacent Blocks -> island OCR/context -> assignment.")
    parser.add_argument("input", nargs="?", type=Path, default=ROOT.parents[1] / "ref" / "official-map.pdf")
    parser.add_argument("--pages", type=page_numbers, default=[1], help="1-based pages: 1,2,3 or all (default: 1)")
    parser.add_argument("--output", type=Path, default=ROOT / "output")
    parser.add_argument("--detect-only", action="store_true", help="Skip both OCR stages and export candidate coordinates")
    parser.add_argument("--confidence", type=float, default=0.95)
    parser.add_argument("--model", default="en_PP-OCRv5_mobile_rec")
    parser.add_argument("--model-dir", type=Path, help="Local model directory for offline use")
    parser.add_argument("--booths-only", action="store_true", help="Run the independent booth recognizer only")
    parser.add_argument("--ocr-only", action="store_true", help="Run booth/island OCR only, without context or assignment")
    parser.add_argument("--no-assignment", action="store_true", help="Skip booth-to-island assignment")
    parser.add_argument("--assignment-time-limit", type=float, default=30, help="CP-SAT seconds per page (default: 30)")
    parser.add_argument("--island-model", default="PP-OCRv5_server_rec")
    parser.add_argument("--island-model-dir", type=Path)
    parser.add_argument("--island-kana-model-dir", type=Path)
    parser.add_argument("--island-confidence", type=float, default=0.90)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    start = time.perf_counter()
    recognizer = BoothRecognizer(
        detect_only=args.detect_only, confidence=args.confidence,
        model_name=args.model, model_dir=args.model_dir,
    )
    if args.booths_only:
        result = recognizer.recognize(args.input, pages=args.pages)
    else:
        result = MapRecognizer(
            refine=not args.ocr_only,
            assign=not args.ocr_only and not args.no_assignment,
            assignment_time_limit=args.assignment_time_limit,
            booths=recognizer,
            islands=IslandRecognizer(
                detect_only=args.detect_only, confidence=args.island_confidence,
                model_name=args.island_model, model_dir=args.island_model_dir,
                kana_model_dir=args.island_kana_model_dir,
            ),
        ).recognize(args.input, pages=args.pages)
    target = result.save(args.output)
    print(f"\nResult: {target.resolve()}")
    print(f"Counts: {result.to_dict()['counts']}")
    data = result.to_dict()
    print(f"Island counts: {data.get('islandCounts', 'not run')}")
    for page in data["pages"]:
        if "blockGrouping" in page:
            print(f"Page {page['page']} Blocks: {page['blockGrouping']['counts']}")
        if "halfBoothSplitting" in page:
            print(f"Page {page['page']} Half-booths: {page['halfBoothSplitting']['counts']}")
    if not args.booths_only and not args.ocr_only:
        print(f"Step 1: {(args.output / 'step-1.json').resolve()}")
        for page in data["pages"]:
            inference = page["islandInference"]
            print(f"Page {page['page']}: type={inference['type']}, outcomes={inference['outcomes']}")
            if "islandAssignment" in page:
                assignment = page["islandAssignment"]
                print(f"  Assignment: {assignment['counts']}; solver={assignment['solverStatus']}")
                print("  Number gaps: " + json.dumps(
                    [{"island": i["label"], "gaps": i["numberGaps"]}
                     for i in page["islands"] if i["numberGaps"]], ensure_ascii=True,
                ))
    print(f"Pages: {len(data['pages'])}; skipped: {len(data['skippedPages'])}")
    print(f"Elapsed: {time.perf_counter() - start:.1f}s")
    print("Booth overlay: green=recognized, orange=review, red=unrecognized, blue=not run")
    if not args.booths_only:
        print("Island overlay: status-colored boxes with occurrence IDs; Preview shows final labels")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except AssignmentError as error:
        logging.error("Assignment failed; no new final result was saved: %s", json.dumps(error.to_dict(), ensure_ascii=True))
        sys.exit(2)
    except (ValueError, FileNotFoundError) as error:
        logging.error("%s", error)
        sys.exit(1)
