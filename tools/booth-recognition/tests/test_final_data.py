import copy
import json
import tempfile
import unittest
from pathlib import Path

from map_recognition.final_data import save_final_result, simplify_result


def fixture() -> dict:
    return {
        "schemaVersion": 7,
        "counts": {"recognized": 1},
        "pages": [{
            "page": 1, "venue": {"label": "East", "recognitionScore": 0.99},
            "islandAssignment": {"solverStatus": "feasible"},
            "islands": [{
                "id": "i1", "label": "A", "markerIds": ["m1"], "blockIds": ["b1"],
                "numbers": ["01"], "issues": [],
            }],
            "islandMarkers": [{"id": "m1", "center": {"x": 10.5, "y": 2}, "rawText": "A"}],
            "blocks": [{
                "id": "b1", "bbox": {"x": 10, "y": 20, "width": 41, "height": 29},
                "grid": {"rows": 1, "columns": 1}, "axis": "horizontal", "thin": True,
                "boothIds": ["c1"],
            }],
            "booths": [{
                "id": "c1", "number": "01", "bbox": {"x": 10, "y": 20, "width": 41, "height": 29},
                "status": "needs_review", "recognitionScore": 0.9, "issues": ["low_confidence"],
            }],
            "halfBooths": [
                {"id": "c1-h1", "boothId": "c1", "suffix": "a",
                 "bbox": {"x": 10, "y": 20, "width": 20.5, "height": 29}},
                {"id": "c1-h2", "boothId": "c1", "suffix": "b",
                 "bbox": {"x": 30.5, "y": 20, "width": 20.5, "height": 29}},
            ],
        }],
    }


class FinalDataTests(unittest.TestCase):
    def test_exact_nested_output_strips_diagnostics_without_mutating_source(self) -> None:
        source = fixture()
        original = copy.deepcopy(source)
        self.assertEqual(simplify_result(source), {"halls": [{
            "name": "East", "islands": [{
                "id": "i1", "code": "A", "markers": [{"id": "m1", "pos": {"x": 10.5, "y": 2}}],
                "blocks": [{
                    "id": "b1", "bbox": {"x": 10, "y": 20, "width": 41, "height": 29},
                    "grid": {"rows": 1, "columns": 1}, "booths": [{
                        "id": "c1", "number": "01", "bbox": {"x": 10, "y": 20, "width": 41, "height": 29},
                        "split": {"a": "l", "b": "r"},
                    }],
                }],
            }],
        }]})
        self.assertEqual(source, original)

    def test_all_split_positions_use_geometry_not_record_order_or_ids(self) -> None:
        for vertical in (False, True):
            for reverse in (False, True):
                with self.subTest(vertical=vertical, reverse=reverse):
                    source = fixture()
                    halves = source["pages"][0]["halfBooths"]
                    if vertical:
                        halves[0]["bbox"] = {"x": 10, "y": 20, "width": 41, "height": 14.5}
                        halves[1]["bbox"] = {"x": 10, "y": 34.5, "width": 41, "height": 14.5}
                    if reverse:
                        halves[0]["suffix"], halves[1]["suffix"] = "b", "a"
                    halves.reverse()
                    booth = simplify_result(source)["halls"][0]["islands"][0]["blocks"][0]["booths"][0]
                    sides = ("t", "b") if vertical else ("l", "r")
                    self.assertEqual(booth["split"], dict(zip(("b", "a") if reverse else ("a", "b"), sides)))

    def test_irregular_block_omits_grid(self) -> None:
        source = fixture()
        source["pages"][0]["blocks"][0]["grid"] = None
        block = simplify_result(source)["halls"][0]["islands"][0]["blocks"][0]
        self.assertNotIn("grid", block)
        self.assertEqual(len(block["booths"]), 1)

    def test_unknown_values_are_retained_with_explicit_warnings(self) -> None:
        source = fixture()
        page = source["pages"][0]
        page["venue"]["label"] = page["islands"][0]["label"] = None
        for half in page["halfBooths"]:
            half["suffix"] = None
        with self.assertLogs("map_recognition.final_data", level="WARNING") as logs:
            hall = simplify_result(source)["halls"][0]
        self.assertIsNone(hall["name"])
        self.assertIsNone(hall["islands"][0]["code"])
        self.assertIsNone(hall["islands"][0]["blocks"][0]["booths"][0]["split"])
        self.assertEqual(len(logs.output), 3)

    def test_same_name_pages_remain_separate_coordinate_spaces(self) -> None:
        source = fixture()
        source["pages"].append(copy.deepcopy(source["pages"][0]))
        self.assertEqual(len(simplify_result(source)["halls"]), 2)

    def test_invalid_or_incomplete_input_is_rejected(self) -> None:
        def duplicate_block(page: dict) -> None:
            page["islands"][0]["blockIds"].append("b1")

        def orphan_booth(page: dict) -> None:
            page["booths"].append({**page["booths"][0], "id": "orphan"})

        def invalid_split(page: dict) -> None:
            page["halfBooths"][0]["bbox"]["width"] = 20

        def mixed_suffixes(page: dict) -> None:
            page["halfBooths"][0]["suffix"] = None

        def bad_grid(page: dict) -> None:
            page["blocks"][0]["grid"]["columns"] = 2

        def invalid_position(page: dict) -> None:
            page["islandMarkers"][0]["center"]["x"] = float("nan")

        for mutation in (
            duplicate_block, orphan_booth, invalid_split, mixed_suffixes, bad_grid, invalid_position,
            lambda page: page.pop("islandAssignment"),
            lambda page: page.pop("halfBooths"),
            lambda page: page["islands"][0]["markerIds"].append("missing"),
            lambda page: page["halfBooths"].pop(),
            lambda page: page["blocks"].append(copy.deepcopy(page["blocks"][0])),
        ):
            with self.subTest(mutation=mutation):
                source = fixture()
                mutation(source["pages"][0])
                with self.assertRaises(ValueError):
                    simplify_result(source)

    def test_saved_result_is_preserved_and_failed_export_does_not_replace_final(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "result.json"
            original = json.dumps(fixture(), ensure_ascii=False)
            source.write_text(original, encoding="utf-8")
            target = save_final_result(source)
            self.assertEqual(target.name, "final.json")
            self.assertEqual(source.read_text(encoding="utf-8"), original)
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), simplify_result(fixture()))
            saved_final = target.read_bytes()
            source.write_text('{"pages": [{}]}', encoding="utf-8")
            with self.assertRaises(ValueError):
                save_final_result(source)
            self.assertEqual(target.read_bytes(), saved_final)
            with self.assertRaises(ValueError):
                save_final_result(target)


if __name__ == "__main__":
    unittest.main()
