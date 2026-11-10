import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer
from island_recognition.recognizer import detect_markers, marker_crop, valid_label
from map_recognition.common import Reading
from map_recognition.ocr_step import OcrRecognitionStep
from map_recognition.pipeline import MapRecognizer
from map_recognition.venue import VenueRecognizer
from test_recognizer import grid


def colored_markers(count: int = 4) -> Image.Image:
    image = Image.new("RGB", (max(200, count * 70), 200), "white")
    draw = ImageDraw.Draw(image)
    colors = ["#22b573", "#87bc4f", "#cca701", "#db86b9"]
    for i in range(count):
        x = i * 70 + 15
        draw.rectangle((x, 50, x + 23, 79), fill=colors[i % 4])
    draw.rectangle((15, 120, 45, 150), outline="black", width=2)
    draw.text((20, 125), "01", fill="black")
    return image


class MarkerReader:
    def __init__(self, labels: list[str] | None = None, score: float = 0.99) -> None:
        self.labels = ["A", "a", "あ", "ア"] if labels is None else labels
        self.score = score
        self.calls = 0

    def read(self, images: list[np.ndarray]) -> list[Reading]:
        turn = self.calls
        self.calls += 1
        if turn in (1, 2, 3):
            return [Reading("", 0.0) for _ in images]
        return [Reading(self.labels[i % len(self.labels)], self.score) for i in range(len(images))]


class IslandDetectionTests(unittest.TestCase):
    def test_detects_arbitrary_colors_not_black_booths(self) -> None:
        image = colored_markers()
        original = np.asarray(image).copy()
        markers = IslandRecognizer(detect_only=True).recognize_image(image)
        self.assertEqual(len(markers), 4)
        self.assertEqual({m.color for m in markers}, {"#22b573", "#87bc4f", "#cca701", "#db86b9"})
        self.assertTrue(all(m.status == "not_run" and m.label is None for m in markers))
        np.testing.assert_array_equal(np.asarray(image), original)

    def test_empty_or_grayscale_map_has_no_markers(self) -> None:
        self.assertEqual(IslandRecognizer(detect_only=True).recognize_image(grid()), [])
        self.assertEqual(IslandRecognizer(detect_only=True).recognize_image(Image.new("RGB", (100, 100), "white")), [])

    def test_detached_strokes_merge_without_merging_nearby_markers(self) -> None:
        image = Image.new("RGB", (160, 160), "white")
        draw = ImageDraw.Draw(image)
        for x in (20, 85):
            draw.rectangle((x, 40, x + 25, 45), fill="#aa33cc")
            draw.rectangle((x, 53, x + 25, 58), fill="#aa33cc")
        boxes, _ = detect_markers(np.asarray(image))
        self.assertEqual(len(boxes), 2)
        self.assertTrue(all(box.height == 19 for box in boxes))

    def test_thin_attached_annotation_is_not_part_of_main_glyph(self) -> None:
        image = colored_markers(1)
        ImageDraw.Draw(image).line((20, 80, 20, 89), fill="#22b573", width=1)
        boxes, _ = detect_markers(np.asarray(image))
        self.assertEqual(len(boxes), 1)
        self.assertLessEqual(boxes[0].y + boxes[0].height, 80)

    def test_detached_dot_on_narrow_stem_is_preserved(self) -> None:
        image = Image.new("RGB", (160, 160), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((30, 60, 35, 83), fill="#22b573")
        draw.rectangle((30, 50, 35, 55), fill="#22b573")
        boxes, _ = detect_markers(np.asarray(image))
        self.assertEqual(len(boxes), 1)
        self.assertEqual(boxes[0].height, 34)

    def test_transparency_and_boundary_markers(self) -> None:
        image = Image.new("RGBA", (150, 100), (255, 0, 0, 0))
        ImageDraw.Draw(image).rectangle((0, 20, 23, 49), fill=(200, 30, 150, 255))
        markers = IslandRecognizer(detect_only=True).recognize_image(image)
        self.assertEqual(len(markers), 1)
        self.assertIn("truncated_at_image_edge", markers[0].issues)

    def test_color_crop_removes_noncolored_buildings(self) -> None:
        image = colored_markers(1)
        boxes, mask = detect_markers(np.asarray(image))
        crop = marker_crop(mask, boxes[0], 90)
        self.assertEqual(crop.shape[0], 96)
        self.assertTrue(np.all(crop[0] == 255))


class IslandRecognitionTests(unittest.TestCase):
    def recognizer(self, reader: MarkerReader) -> IslandRecognizer:
        return IslandRecognizer(reader=reader, kana_model_name=None)

    def test_preserves_case_kana_and_repeated_occurrences(self) -> None:
        markers = self.recognizer(MarkerReader()).recognize_image(colored_markers())
        self.assertEqual([m.label for m in markers], ["A", "a", "あ", "ア"])
        repeated = self.recognizer(MarkerReader(["A"])).recognize_image(colored_markers())
        self.assertEqual(len(repeated), 4)
        self.assertEqual(len({m.id for m in repeated}), 4)
        self.assertTrue(all(m.label == "A" for m in repeated))

    def test_low_confidence_and_invalid_labels_are_explicit(self) -> None:
        low = self.recognizer(MarkerReader(["a"], 0.5)).recognize_image(colored_markers(1))
        self.assertEqual(low[0].status, "needs_review")
        for value in ["01", "AB", "東", ""]:
            marker = self.recognizer(MarkerReader([value])).recognize_image(colored_markers(1))[0]
            self.assertIsNone(marker.label)
            self.assertEqual(marker.status, "unrecognized")
            self.assertEqual(marker.raw_text, value)

    def test_nfc_does_not_fold_case_or_kana(self) -> None:
        self.assertTrue(valid_label("カ\u3099"))
        self.assertFalse(valid_label("ｱ"))
        self.assertFalse(valid_label("Ａ"))
        self.assertFalse(valid_label("А"))
        marker = self.recognizer(MarkerReader(["カ\u3099"])).recognize_image(colored_markers(1))[0]
        self.assertEqual(marker.label, "ガ")
        self.assertEqual(marker.raw_text, "カ\u3099")

    def test_wrong_ocr_result_count_is_an_error(self) -> None:
        class BadReader(MarkerReader):
            def read(self, images: list[np.ndarray]) -> list[Reading]:
                return []
        with self.assertRaisesRegex(RuntimeError, "wrong number"):
            self.recognizer(BadReader()).recognize_image(colored_markers())

    def test_raw_ocr_does_not_apply_page_context(self) -> None:
        markers = self.recognizer(MarkerReader(["a"] * 9 + ["A"])).recognize_image(colored_markers(10))
        self.assertEqual(markers[-1].label, "A")
        self.assertEqual(markers[-1].status, "recognized")
        self.assertNotIn("script_outlier", markers[-1].issues)

    def test_preprocessing_disagreement_is_reviewed(self) -> None:
        class DisagreeingReader(MarkerReader):
            def read(self, images: list[np.ndarray]) -> list[Reading]:
                result = super().read(images)
                return [Reading("a", 0.98) for _ in images] if self.calls == 5 else result
        marker = self.recognizer(DisagreeingReader(["A"])).recognize_image(colored_markers(1))[0]
        self.assertEqual(marker.status, "needs_review")
        self.assertIn("recognition_disagreement", marker.issues)

    def test_kana_model_is_called_without_booth_dependency(self) -> None:
        primary = MarkerReader(["東"])
        kana = MarkerReader(["あ"])
        recognizer = IslandRecognizer(reader=primary, kana_reader=kana)
        marker = recognizer.recognize_image(colored_markers(1))[0]
        self.assertEqual(marker.label, "あ")
        self.assertEqual(kana.calls, 1)

    def test_invalid_configuration_fails(self) -> None:
        for confidence in [0, -1, 2, float("nan")]:
            with self.assertRaises(ValueError):
                IslandRecognizer(confidence=confidence)
        with self.assertRaises(ValueError):
            IslandRecognizer(model_dir="does-not-exist")
        with self.assertRaises(ValueError):
            IslandRecognizer(detect_only=True).recognize_image(colored_markers(), page=0)


class PipelineTests(unittest.TestCase):
    def test_complete_three_phase_pipeline_exports_memberships_and_pre_assignment_snapshot(self) -> None:
        class SequentialReader:
            def read(self, images: list[np.ndarray]) -> list[Reading]:
                return [Reading(f"{index + 1:02}", 0.99) for index in range(len(images))]

        image = Image.new("RGB", (420, 300), "white")
        image.paste(grid(), (0, 0))
        image.paste(colored_markers(1).crop((0, 0, 100, 100)), (250, 0))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            image.save(path)
            result = MapRecognizer(
                venues=VenueRecognizer(detect_only=True),
                booths=BoothRecognizer(reader=SequentialReader()),
                islands=IslandRecognizer(reader=MarkerReader(["A"]), kana_model_name=None),
                assignment_time_limit=3,
            ).recognize(path)
            data = result.to_dict()
            self.assertEqual(data["schemaVersion"], 7)
            self.assertEqual(data["processingSteps"], [
                "booth_recognition", "booth_block_grouping", "island_recognition", "booth_island_assignment",
                "island_marker_alignment",
                "half_booth_splitting",
            ])
            self.assertEqual(data["pages"][0]["islandAssignment"]["counts"]["assignedBooths"], 16)
            self.assertEqual(len(data["pages"][0]["islands"]), 1)
            self.assertTrue(all(b["number"] is not None for b in data["pages"][0]["booths"]))
            page = data["pages"][0]
            self.assertEqual(len(page["blocks"]), 1)
            self.assertEqual(page["islands"][0]["blockIds"], [page["blocks"][0]["id"]])
            self.assertEqual(set(page["blocks"][0]["boothIds"]), {b["id"] for b in page["booths"]})
            self.assertEqual(page["blocks"][0]["grid"], {"rows": 4, "columns": 4})
            self.assertFalse({"outline", "dividers", "islandId"} & page["blocks"][0].keys())
            self.assertNotIn("components", page["islandAssignment"])
            self.assertEqual(len(page["halfBooths"]), 32)
            self.assertEqual({h["boothId"] for h in page["halfBooths"]}, {b["id"] for b in page["booths"]})
            self.assertEqual(page["halfBoothSplitting"]["counts"]["booths"], 16)
            self.assertNotIn("boothIds", page["islands"][0])
            self.assertNotIn("componentIds", page["islands"][0])
            self.assertTrue(all(not {"blockId", "islandId", "assignment"} & b.keys() for b in page["booths"]))
            target = result.save(Path(directory) / "result")
            stage2 = json.loads((target.parent / "step-2.json").read_text(encoding="utf-8"))
            self.assertEqual(stage2["schemaVersion"], 3)
            self.assertEqual(stage2["pages"][0]["venue"]["status"], "not_run")
            self.assertEqual(page["venue"]["status"], "not_run")
            self.assertNotIn("islandId", stage2["pages"][0]["booths"][0])
            self.assertIn("bbox", stage2["pages"][0]["islandMarkers"][0])
            self.assertNotIn("bbox", page["islandMarkers"][0])
            self.assertIn("center", page["islandMarkers"][0])
            self.assertTrue((target.parent / "block-grouping.json").is_file())
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), data)
            final = json.loads((target.parent / "final.json").read_text(encoding="utf-8"))
            self.assertEqual(set(final), {"halls"})
            island = final["halls"][0]["islands"][0]
            self.assertEqual(island["code"], "A")
            self.assertEqual(len(island["blocks"][0]["booths"]), 16)
            self.assertEqual(island["markers"][0]["pos"], page["islandMarkers"][0]["center"])
            self.assertEqual(page["hallOutline"]["method"], "nonwhite_bbox")
            self.assertEqual(final["halls"][0]["boundary"], page["hallOutline"]["polygon"])

    def test_assignment_can_be_disabled_without_losing_context_stage(self) -> None:
        image = Image.new("RGB", (420, 300), "white")
        image.paste(grid(), (0, 0))
        image.paste(colored_markers(1).crop((0, 0, 100, 100)), (250, 0))
        from test_recognizer import StubReader

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            image.save(path)
            result = MapRecognizer(
                venues=VenueRecognizer(detect_only=True),
                booths=BoothRecognizer(reader=StubReader()),
                islands=IslandRecognizer(reader=MarkerReader(["A"]), kana_model_name=None),
                assign=False,
            ).recognize(path)
            self.assertEqual(result.to_dict()["schemaVersion"], 7)
            self.assertIsNone(result.assignments)
            self.assertIsNotNone(result.refinements)

    def test_step_one_runs_independently_and_can_bypass_context(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            colored_markers().save(path)
            step = OcrRecognitionStep(
                venues=VenueRecognizer(detect_only=True),
                booths=BoothRecognizer(detect_only=True),
                islands=IslandRecognizer(reader=MarkerReader(), kana_model_name=None),
            )
            raw = step.run(path)
            self.assertEqual(raw.to_dict()["schemaVersion"], 2)
            self.assertEqual([m.label for m in raw.islands[1]], ["A", "a", "あ", "ア"])
            self.assertTrue(all(m.inference is None for m in raw.islands[1]))
            pipeline = MapRecognizer(
                venues=VenueRecognizer(detect_only=True),
                booths=BoothRecognizer(detect_only=True),
                islands=IslandRecognizer(detect_only=True), refine=False,
            )
            output = pipeline.recognize(path)
            self.assertIsNone(output.refinements)
            self.assertEqual(output.to_dict()["processingSteps"], [
                "booth_recognition", "booth_block_grouping", "island_recognition", "island_marker_alignment",
            ])

    def test_detect_only_skips_all_context_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            colored_markers().save(path)
            result = MapRecognizer(
                venues=VenueRecognizer(detect_only=True),
                booths=BoothRecognizer(detect_only=True), islands=IslandRecognizer(detect_only=True),
            ).recognize(path)
            self.assertEqual(result.to_dict()["schemaVersion"], 7)
            self.assertTrue(all(m.status == "not_run" and m.label is None for m in result.islands[1]))
            self.assertEqual(result.refinements[1].to_dict()["outcomes"], {"skipped": 4})

    def test_pipeline_combines_separate_recognizers_and_exports_both_steps(self) -> None:
        image = Image.new("RGB", (420, 300), "white")
        image.paste(grid(), (0, 0))
        image.paste(colored_markers(1).crop((0, 0, 100, 100)), (250, 0))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            image.save(path)
            pipeline = MapRecognizer(
                venues=VenueRecognizer(detect_only=True),
                booths=BoothRecognizer(detect_only=True),
                islands=IslandRecognizer(reader=MarkerReader(["あ"]), kana_model_name=None),
            )
            result = pipeline.recognize(path)
            data = result.to_dict()
            self.assertEqual(data["schemaVersion"], 7)
            self.assertEqual(len(data["pages"][0]["booths"]), 16)
            self.assertEqual(len(data["pages"][0]["islandMarkers"]), 1)
            self.assertEqual(data["pages"][0]["islandMarkers"][0]["label"], "あ")
            target = result.save(Path(directory) / "result")
            self.assertEqual(json.loads(target.read_text(encoding="utf-8")), data)
            self.assertFalse((target.parent / "final.json").exists())
            self.assertTrue((target.parent / "page-001-overlay.png").is_file())
            raw = json.loads((target.parent / "step-1.json").read_text(encoding="utf-8"))
            self.assertEqual(raw["schemaVersion"], 2)
            self.assertEqual(raw["processingSteps"], ["ocr"])
            self.assertNotIn("inference", raw["pages"][0]["islandMarkers"][0])
            self.assertEqual(data["processingSteps"], [
                "booth_recognition", "booth_block_grouping", "island_recognition", "island_marker_alignment",
            ])
            self.assertEqual(result.booths.to_dict()["schemaVersion"], 1)


if __name__ == "__main__":
    unittest.main()
