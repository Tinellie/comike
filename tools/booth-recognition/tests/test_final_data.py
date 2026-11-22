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
                "status": "needs_review", "recognitionScore": 0.9, "issues": ["low_confidence"], "rotation": 270,
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
    def test_map_export_nodes_crossings_and_connects_only_paths_reaching_the_outer_tile(self) -> None:
        source_data = fixture()
        page = source_data["pages"][0]
        page["page"] = 7
        page["pdfPreview"] = {
            "image": "page-007-pdf.png", "width": 64, "height": 64, "transform": [1, 0, 0, 1, 4, 8],
        }
        page["hallOutline"] = {"polygon": [
            {"x": x, "y": y} for x, y in ((4, 4), (43, 4), (43, 43), (4, 43))
        ]}
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "result.json"
            source.write_text(json.dumps(source_data), encoding="utf-8")
            source.with_name("page-007-paths.json").write_text(json.dumps({
                "width": 64, "height": 64, "segments": [
                    [10, 26, 34, 26], [22, 18, 22, 38], [22, 38, 38, 38], [30, 26, 38, 26],
                ],
            }), encoding="utf-8")
            graph = json.loads(save_final_result(source).read_text(encoding="utf-8"))["halls"][0]["pathGraph"]

        nodes = [(p["x"], p["y"]) for p in graph["nodes"]]
        self.assertEqual(len(nodes), len(set(nodes)))
        edges = {(frozenset((nodes[e["from"]], nodes[e["to"]])), e["kind"]) for e in graph["edges"]}
        self.assertEqual(len(edges), len(graph["edges"]))

        def neighbors(node, kind):
            return {next(iter(ends - {node})) for ends, edge_kind in edges if node in ends and kind == edge_kind}

        self.assertEqual(neighbors((18, 18), "indoor"), {(6, 18), (18, 10), (18, 30), (26, 18)})
        self.assertEqual(neighbors((4, 18), "indoor"), {(6, 18)})
        self.assertEqual(neighbors((4, 18), "perimeter"), {(4, 4), (4, 43)})
        self.assertEqual(neighbors((34, 18), "indoor"), {(30, 18)})
        self.assertNotIn((43, 18), nodes)

    def test_pdf_metadata_preserves_source_page_and_registration_without_mutation(self) -> None:
        source = fixture()
        source["pages"][0]["page"] = 7
        pdf = {"image": "page-007-pdf.png", "width": 400, "height": 320, "transform": [1, 0, 0, 1, 30, 40]}
        source["pages"][0]["pdfPreview"] = pdf
        original = copy.deepcopy(source)
        hall = simplify_result(source)["halls"][0]
        self.assertEqual(hall["sourcePage"], 7)
        self.assertEqual(hall["pdfPreview"], pdf)
        self.assertEqual(source, original)
        for patch in (
            {"image": "page-001-pdf.png"}, {"width": 0}, {"height": True},
            {"transform": [1, 0]}, {"transform": [1, 2, 2, 4, 0, 0]},
            {"transform": [1, 0, 0, 1, float("nan"), 0]},
        ):
            source["pages"][0]["pdfPreview"] = {**pdf, **patch}
            with self.subTest(patch=patch), self.assertRaisesRegex(ValueError, "PDF"):
                simplify_result(source)

    def test_hall_labels_export_text_code_and_source_center_only(self) -> None:
        source = fixture()
        source["pages"][0]["hallLabels"] = [{
            "id": "p001-hall-001", "text": "西2/W2", "code": "W2", "label": "西2",
            "center": {"x": 40.5, "y": 15}, "bbox": {"x": 20, "y": 5, "width": 41, "height": 20},
            "recognitionScore": 0.99, "rotation": 270, "status": "recognized", "issues": [],
        }]
        self.assertEqual(simplify_result(source)["halls"][0]["labels"], [{
            "id": "p001-hall-001", "text": "西2/W2", "code": "W2", "pos": {"x": 40.5, "y": 15},
        }])

    def test_hall_boundary_exports_vertices_without_detection_metadata(self) -> None:
        source = fixture()
        polygon = [{"x": 1, "y": 2}, {"x": 80, "y": 2}, {"x": 80, "y": 90}, {"x": 1, "y": 90}]
        source["pages"][0]["hallOutline"] = {"method": "nonwhite_bbox", "polygon": polygon}
        hall = simplify_result(source)["halls"][0]
        self.assertEqual(hall["boundary"], polygon)
        self.assertEqual(set(hall), {"name", "textRotation", "islands", "boundary"})

    def test_exact_nested_output_strips_diagnostics_without_mutating_source(self) -> None:
        source = fixture()
        original = copy.deepcopy(source)
        self.assertEqual(simplify_result(source), {"halls": [{
            "name": "East", "textRotation": 270, "islands": [{
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

    def test_text_rotation_preserves_shared_ocr_direction_and_rejects_missing_or_mixed_evidence(self) -> None:
        for rotation in (0, 90, 180, 270):
            source = fixture()
            source["pages"][0]["booths"][0]["rotation"] = rotation
            self.assertEqual(simplify_result(source)["halls"][0]["textRotation"], rotation)
        for invalid in (None, True, 45, "90", -90, 360):
            source = fixture()
            source["pages"][0]["booths"][0]["rotation"] = invalid
            with self.assertRaises(ValueError):
                simplify_result(source)
        source = fixture()
        source["pages"][0]["booths"].append({**source["pages"][0]["booths"][0], "id": "c2", "rotation": 0})
        with self.assertRaisesRegex(ValueError, "one shared"):
            simplify_result(source)

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
