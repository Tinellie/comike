import json
import tempfile
import unittest
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer
from map_recognition.common import Box, Reading
from map_recognition.hall_labels import (
    HallLabel, HallLabelRecognizer, _line_crops, detect_label_text, label_tokens,
)
from map_recognition.pipeline import MapRecognizer
from map_recognition.venue import VenueRecognizer
from test_recognizer import grid


def panel() -> Image.Image:
    rgb = np.full((160, 280, 3), 255, np.uint8)
    cv2.rectangle(rgb, (30, 30), (200, 110), (85, 85, 85), -1)
    cv2.putText(rgb, "E1", (60, 85), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (255, 255, 255), 3)
    return Image.fromarray(rgb)


class Reader:
    def __init__(self, text: str = "東1/E1", score: float = 0.99) -> None:
        self.text, self.score = text, score

    def read(self, images):
        return [Reading(self.text, self.score) for _ in images]


class HallLabelTests(unittest.TestCase):
    def test_strict_tokens_normalize_width_and_keep_language(self) -> None:
        for text, expected in [
            ("東１／Ｅ１", [("E1", "ja"), ("E1", "en")]),
            ("⻄2 W2", [("W2", "ja"), ("W2", "en")]),
            ("南1/S1", [("S1", "ja"), ("S1", "en")]),
            ("E7", [("E7", "en")]), ("北10", [("N10", "ja")]),
        ]:
            self.assertEqual(label_tokens(text), expected)
        for text in ["01", "A1", "E0", "E", "東123ホール", "東1ホール", "exit E1"]:
            self.assertEqual(label_tokens(text), [])

    def test_localizes_white_text_and_preserves_input(self) -> None:
        image = panel()
        original = image.tobytes()
        boxes, mask = detect_label_text(image)
        self.assertEqual(len(boxes), 1)
        box = boxes[0]
        self.assertGreater(box.x, 30)
        self.assertLess(box.x + box.width, 200)
        self.assertEqual(mask.shape, (160, 280))
        record = HallLabelRecognizer(reader=Reader()).recognize_image(image, page=2)[0]
        self.assertEqual(record.id, "p002-hall-001")
        self.assertEqual(record.code, "E1")
        self.assertEqual(record.label, "東1")
        self.assertEqual(record.status, "recognized")
        self.assertEqual(record.to_dict()["center"], {
            "x": box.x + box.width / 2, "y": box.y + box.height / 2,
        })
        self.assertEqual(image.tobytes(), original)

    def test_four_rotations_are_tested_in_source_coordinates(self) -> None:
        for rotation in (0, 90, 180, 270):
            with self.subTest(rotation=rotation):
                image = panel().rotate(rotation, expand=True)
                boxes, mask = detect_label_text(image)
                correction = (360 - rotation) % 360
                target = _line_crops(mask, boxes[0], correction, np.asarray(image.convert("L")))[0]

                class OrientationReader:
                    def read(self, images):
                        return [
                            Reading("E1" if p.shape == target.shape and np.array_equal(p, target) else "noise", 0.99)
                            for p in images
                        ]

                record = HallLabelRecognizer(reader=OrientationReader()).recognize_image(image)[0]
                self.assertEqual(record.rotation, correction)
                self.assertEqual(record.bbox, boxes[0])

    def test_dark_text_on_light_background_and_booth_exclusion(self) -> None:
        rgb = np.full((160, 280, 3), 255, np.uint8)
        cv2.putText(rgb, "W2", (60, 85), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (60, 60, 60), 3)
        image = Image.fromarray(rgb)
        boxes, _ = detect_label_text(image)
        self.assertEqual(len(boxes), 1)
        record = HallLabelRecognizer(reader=Reader("西2/W2")).recognize_image(image)[0]
        self.assertEqual(record.code, "W2")
        self.assertEqual(detect_label_text(image, [Box(0, 0, 280, 160)])[0], [])
        with self.assertRaisesRegex(ValueError, "outside"):
            HallLabelRecognizer().recognize_image(image, booths=[Box(-1, 0, 20, 20)])

    def test_pairs_complementary_languages_but_keeps_repeated_signs(self) -> None:
        recognizer = HallLabelRecognizer()
        labels = [
            HallLabel("", Box(20, 20, 30, 20), "西2", "西2", "W2", 0.99, 270, "recognized"),
            HallLabel("", Box(60, 20, 30, 20), "W2", "西2", "W2", 0.98, 270, "recognized"),
            HallLabel("", Box(200, 20, 30, 20), "西2", "西2", "W2", 0.99, 270, "recognized"),
            HallLabel("", Box(240, 20, 30, 20), "W2", "西2", "W2", 0.98, 270, "recognized"),
        ]
        result = recognizer._pair(labels)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].bbox, Box(20, 20, 70, 20))
        self.assertEqual(result[0].text, "西2 / W2")
        same_language = [labels[0], HallLabel("", Box(55, 20, 30, 20), "西2", "西2", "W2")]
        self.assertEqual(len(recognizer._pair(same_language)), 2)

    def test_uncertainty_noise_skip_and_errors_are_explicit(self) -> None:
        image = panel()
        with self.assertLogs("map_recognition.hall_labels", level="WARNING"):
            low = HallLabelRecognizer(reader=Reader(score=0.5)).recognize_image(image)[0]
        self.assertEqual(low.status, "needs_review")
        self.assertIn("low_confidence", low.issues)
        with self.assertLogs("map_recognition.hall_labels", level="WARNING"):
            conflict = HallLabelRecognizer(reader=Reader("東1/W2")).recognize_image(image)[0]
        self.assertIsNone(conflict.code)
        self.assertIn("conflicting_labels", conflict.issues)
        self.assertEqual(HallLabelRecognizer(reader=Reader("42")).recognize_image(image), [])
        skipped = HallLabelRecognizer(detect_only=True).recognize_image(image)[0]
        self.assertEqual(skipped.status, "not_run")
        self.assertIsNone(skipped.text)
        self.assertEqual(HallLabelRecognizer().recognize_image(Image.new("RGB", (100, 100), "white")), [])
        with self.assertRaises(RuntimeError):
            HallLabelRecognizer(reader=Reader(score=float("nan"))).recognize_image(image)

        class ShortReader:
            def read(self, images):
                return []

        with self.assertRaises(RuntimeError):
            HallLabelRecognizer(reader=ShortReader()).recognize_image(image)
        with self.assertRaises(ValueError):
            HallLabelRecognizer(confidence=0)
        with self.assertRaises(ValueError):
            HallLabelRecognizer().recognize_image(image, page=True)

    def test_pipeline_persists_labels_without_replacing_header_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            image = Image.new("RGB", (400, 420), "white")
            image.paste(panel(), (0, 0))
            image.paste(grid(), (0, 180))
            image.save(path)
            recognizer = MapRecognizer(
                booths=BoothRecognizer(detect_only=True), islands=IslandRecognizer(detect_only=True),
                venues=VenueRecognizer(detect_only=True), hall_labels=HallLabelRecognizer(reader=Reader()),
            )
            result = recognizer.recognize(path)
            target = result.save(Path(directory) / "out")
            page = json.loads(target.read_text(encoding="utf-8"))["pages"][0]
            self.assertEqual(page["hallLabels"][0]["code"], "E1")
            self.assertEqual(page["venue"]["status"], "not_run")
            self.assertEqual((page["width"], page["height"]), (400, 420))


if __name__ == "__main__":
    unittest.main()
