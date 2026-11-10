import io
import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter

from booth_recognition import BoothRecognizer, RecognitionResult
from booth_recognition.geometry import detect_cells
from booth_recognition.ocr import Reading, digit_crop
from booth_recognition.recognizer import valid_number


def grid(*, rotated: bool = False, gray: bool = False, broken: bool = False) -> Image.Image:
    image = Image.new("RGB", (180, 230), "white")
    draw = ImageDraw.Draw(image)
    if gray:
        draw.rectangle((30, 30, 58, 70), fill="#888888")
    for column in range(5):
        x = 30 + column * 28
        draw.line((x, 30, x, 190), fill="black", width=1)
    for row in range(5):
        y = 30 + row * 40
        draw.line((30, y, 142, y), fill="black", width=1)
    for row in range(4):
        for column in range(4):
            draw.text((34 + column * 28, 44 + row * 40), "01", fill="black")
    if broken:
        draw.line((58, 48, 58, 49), fill="white", width=1)
    return image.transpose(Image.Transpose.ROTATE_90) if rotated else image


def open_grid(side: str) -> Image.Image:
    image = grid()
    edges = {
        "right": (142, 30, 142, 190),
        "left": (30, 30, 30, 190),
        "top": (30, 30, 142, 30),
        "bottom": (30, 190, 142, 190),
    }
    ImageDraw.Draw(image).line(edges[side], fill="white", width=1)
    return image


class StubReader:
    def __init__(self, value: Reading = Reading("01", 0.99)) -> None:
        self.value = value
        self.calls = 0

    def read(self, images: list[np.ndarray]) -> list[Reading]:
        self.calls += 1
        # The first two calls are page orientation probes.
        if self.calls == 2:
            return [Reading("", 0.1) for _ in images]
        return [self.value for _ in images]


class DetectionTests(unittest.TestCase):
    def test_exact_grid_count_and_no_duplicate_contours(self) -> None:
        cells = detect_cells(np.asarray(grid()))
        self.assertEqual(len(cells), 16)
        self.assertEqual(len({(c.box.x, c.box.y) for c in cells}), 16)
        self.assertTrue(all(abs(c.box.width - 29) <= 2 for c in cells))
        self.assertTrue(all(abs(c.box.height - 41) <= 2 for c in cells))

    def test_gray_background(self) -> None:
        self.assertEqual(len(detect_cells(np.asarray(grid(gray=True)))), 16)

    def test_rotated_grid(self) -> None:
        cells = detect_cells(np.asarray(grid(rotated=True)))
        self.assertEqual(len(cells), 16)
        self.assertTrue(all(c.box.width > c.box.height for c in cells))

    def test_small_border_gap_is_recovered_and_flagged(self) -> None:
        cells = detect_cells(np.asarray(grid(broken=True)))
        self.assertEqual(len(cells), 16)
        self.assertTrue(any(cell.repaired for cell in cells))

    def test_empty_image_is_not_success(self) -> None:
        self.assertEqual(detect_cells(np.full((300, 300, 3), 255, dtype=np.uint8)), [])
        with self.assertRaisesRegex(ValueError, "No repeated"):
            BoothRecognizer(detect_only=True).recognize_image(Image.new("RGB", (300, 300), "white"))

    def test_entire_missing_edge_is_recovered_in_all_four_directions(self) -> None:
        for side in ("left", "right", "top", "bottom"):
            with self.subTest(side=side):
                image = open_grid(side)
                before = np.asarray(image).copy()
                cells = detect_cells(np.asarray(image))
                self.assertEqual(len(cells), 16)
                inferred = [c for c in cells if c.missing_border]
                self.assertEqual(len(inferred), 4)
                self.assertTrue(all(c.missing_border == side and c.repaired for c in inferred))
                self.assertEqual(
                    {c.box for c in cells},
                    {c.box for c in detect_cells(np.asarray(grid()))},
                )
                np.testing.assert_array_equal(np.asarray(image), before)

    def test_open_blank_cells_are_not_invented(self) -> None:
        image = open_grid("right")
        ImageDraw.Draw(image).rectangle((116, 32, 140, 188), fill="white")
        self.assertEqual(len(detect_cells(np.asarray(image))), 12)

    def test_two_missing_edges_are_not_guessed(self) -> None:
        image = open_grid("right")
        ImageDraw.Draw(image).line((114, 30, 142, 30), fill="white")
        self.assertEqual(len(detect_cells(np.asarray(image))), 15)

    def test_wall_strokes_in_open_cells_are_not_digit_evidence(self) -> None:
        image = open_grid("right")
        draw = ImageDraw.Draw(image)
        draw.rectangle((116, 32, 140, 188), fill="white")
        for row in range(4):
            draw.rectangle((118, 34 + row * 40, 121, 66 + row * 40), fill="black")
        self.assertEqual(len(detect_cells(np.asarray(image))), 12)

    def test_edge_clipped_by_one_pixel_is_bounded_and_flagged(self) -> None:
        image = grid().crop((0, 0, 142, 230))
        cells = detect_cells(np.asarray(image))
        self.assertEqual(len(cells), 16)
        edge = [cell for cell in cells if cell.missing_border]
        self.assertEqual(len(edge), 4)
        self.assertTrue(all(c.truncated and c.box.x + c.box.width == image.width for c in edge))

    def test_isolated_u_shape_away_from_grid_and_image_edges_is_rejected(self) -> None:
        image = Image.new("RGB", (900, 900), "white")
        image.paste(grid(), (0, 0))
        draw = ImageDraw.Draw(image)
        draw.line((450, 450, 478, 450), fill="black")
        draw.line((450, 450, 450, 490), fill="black")
        draw.line((450, 490, 478, 490), fill="black")
        draw.text((454, 464), "01", fill="black")
        self.assertEqual(len(detect_cells(np.asarray(image))), 16)

    def test_rotated_open_grid_preserves_original_image_coordinates(self) -> None:
        image = open_grid("right").transpose(Image.Transpose.ROTATE_90)
        cells = detect_cells(np.asarray(image))
        self.assertEqual(len(cells), 16)
        self.assertEqual(sum(c.missing_border == "top" for c in cells), 4)
        self.assertTrue(all(c.box.width > c.box.height for c in cells))


class RecognitionTests(unittest.TestCase):
    def test_inferred_borders_require_review_even_with_high_ocr_score(self) -> None:
        result = BoothRecognizer(reader=StubReader()).recognize_image(open_grid("right"))
        inferred = [b for b in result.booths if "missing_right_border" in b.issues]
        self.assertEqual(len(inferred), 4)
        self.assertTrue(all(b.number == "01" and b.status == "needs_review" for b in inferred))

    def test_clipped_candidates_export_review_markers(self) -> None:
        result = BoothRecognizer(reader=StubReader()).recognize_image(grid().crop((0, 0, 142, 230)))
        edge = [b.to_dict() for b in result.booths if "missing_right_border" in b.issues]
        self.assertEqual(len(edge), 4)
        self.assertTrue(all("truncated_at_image_edge" in b["issues"] for b in edge))
        self.assertTrue(all(b["status"] == "needs_review" for b in edge))

    def test_inferred_border_with_failed_ocr_does_not_invent_number(self) -> None:
        result = BoothRecognizer(reader=StubReader(Reading("T", 0.99))).recognize_image(open_grid("right"))
        inferred = [b for b in result.booths if "missing_right_border" in b.issues]
        self.assertEqual(len(inferred), 4)
        self.assertTrue(all(b.number is None and b.status == "unrecognized" for b in inferred))

    def test_only_exact_ascii_two_digit_strings_are_valid(self) -> None:
        for value in ["01", "99", "00"]:
            self.assertTrue(valid_number(value))
        for value in ["1", "001", "O1", "１２", " 01", ""]:
            self.assertFalse(valid_number(value))

    def test_leading_zero_and_stable_original_coordinates(self) -> None:
        image = grid(rotated=True)
        geometry = BoothRecognizer(detect_only=True).recognize_image(image)
        recognized = BoothRecognizer(reader=StubReader()).recognize_image(image)
        self.assertEqual([b.bbox for b in geometry.booths], [b.bbox for b in recognized.booths])
        self.assertTrue(all(b.number == "01" for b in recognized.booths))
        self.assertTrue(all(b.rotation == 90 for b in recognized.booths))
        self.assertTrue(all(b.status == "recognized" for b in recognized.booths))

    def test_low_score_is_not_silently_accepted(self) -> None:
        result = BoothRecognizer(reader=StubReader(Reading("01", 0.7))).recognize_image(grid())
        self.assertTrue(all(b.status == "needs_review" for b in result.booths))
        self.assertTrue(all("low_confidence" in b.issues for b in result.booths))

    def test_invalid_number_is_null_not_guessed(self) -> None:
        result = BoothRecognizer(reader=StubReader(Reading("O1", 0.99))).recognize_image(grid())
        self.assertTrue(all(b.number is None and b.status == "unrecognized" for b in result.booths))

    def test_disagreeing_preprocessing_requires_review(self) -> None:
        class DisagreeingReader(StubReader):
            def read(self, images: list[np.ndarray]) -> list[Reading]:
                values = super().read(images)
                return [Reading("02", 0.99) for _ in images] if self.calls == 4 else values

        result = BoothRecognizer(reader=DisagreeingReader(Reading("01", 0.8))).recognize_image(grid())
        self.assertTrue(all(b.status == "needs_review" for b in result.booths))
        self.assertTrue(all("preprocessing_disagreement" in b.issues for b in result.booths))

    def test_crop_shape_after_rotation(self) -> None:
        cells = detect_cells(np.asarray(grid(rotated=True)))
        crop = digit_crop(np.asarray(grid(rotated=True)), cells[0].box, 90)
        self.assertEqual(crop.shape[0], 80)
        self.assertEqual(crop.shape[2], 3)

    def test_missing_file_and_invalid_parameters_fail(self) -> None:
        with self.assertRaises(FileNotFoundError):
            BoothRecognizer().recognize("does-not-exist.png")
        for threshold in [0, 1.1, float("nan")]:
            with self.assertRaises(ValueError):
                BoothRecognizer(confidence=threshold)

    def test_exports_json_and_both_images(self) -> None:
        page = BoothRecognizer(detect_only=True).recognize_image(grid())
        result = RecognitionResult("sample.png", None, [page], [])
        with tempfile.TemporaryDirectory() as directory:
            target = result.save(directory)
            data = json.loads(target.read_text(encoding="utf-8"))
            self.assertEqual(data["schemaVersion"], 1)
            self.assertEqual(data["pages"][0]["width"], 180)
            self.assertEqual(len(data["pages"][0]["booths"]), 16)
            self.assertEqual(data["counts"], {"not_run": 16})
            self.assertTrue((Path(directory) / "page-001.png").is_file())
            self.assertTrue((Path(directory) / "page-001-overlay.png").is_file())
            self.assertIsNone(data["pages"][0]["booths"][0]["number"])

    def test_pdf_image_extraction_and_blank_page_reporting(self) -> None:
        stream = io.BytesIO()
        grid().save(stream, format="PDF", resolution=72)
        pdf = PdfWriter()
        pdf.add_page(PdfReader(stream).pages[0])
        pdf.add_blank_page(width=180, height=230)
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "map.pdf"
            with source.open("wb") as file:
                pdf.write(file)
            result = BoothRecognizer(detect_only=True).recognize(source)
            self.assertEqual(len(result.pages), 1)
            self.assertEqual(len(result.pages[0].booths), 16)
            self.assertEqual(result.skipped_pages, [{"page": 2, "reason": "no_embedded_map_image"}])
            for pages in [[0], [1, 1], [3], []]:
                with self.assertRaises(ValueError):
                    BoothRecognizer(detect_only=True).recognize(source, pages=pages)


if __name__ == "__main__":
    unittest.main()
