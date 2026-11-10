import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer
from map_recognition.common import Reading
from map_recognition.pipeline import MapRecognizer
from map_recognition.venue import VenueRecognizer, venue_labels
from test_recognizer import grid


class VenueReader:
    def __init__(self, text: str = "ComicMarket109 1日目 東123ホール", score: float = 0.98) -> None:
        self.text = text
        self.score = score
        self.calls = 0

    def read(self, images):
        self.calls += 1
        return [Reading(self.text, self.score) for _ in images]


def header() -> Image.Image:
    image = Image.new("RGB", (400, 180), "white")
    ImageDraw.Draw(image).text((15, 8), "ComicMarket109 1 Venue Hall", fill="black")
    return image


class VenueTests(unittest.TestCase):
    def test_normalizes_width_radicals_spacing_and_ocr_dash_in_hall_keyword(self) -> None:
        for text, expected in [
            ("１日目　東１２３ホール", "東123"), ("⻄ 1・2 ホ－ル", "西12"),
            ("南1/2ホ-ル", "南12"), ("東7ホール", "東7"),
            ("東10ホール", "東10"),
        ]:
            self.assertEqual(venue_labels(text), {expected})
        for text in ["1日目", "東3/E3", "73 72", "東123", "南0ホール", "東1-3ホール"]:
            self.assertEqual(venue_labels(text), set())

    def test_recognizes_header_without_mutating_image(self) -> None:
        image = header()
        original = image.tobytes()
        result = VenueRecognizer(reader=VenueReader()).recognize_header(image)
        self.assertEqual(result.label, "東123")
        self.assertEqual(result.status, "recognized")
        self.assertEqual(result.recognition_score, 0.98)
        self.assertEqual(image.tobytes(), original)
        self.assertEqual(result.to_dict()["rawText"], "ComicMarket109 1日目 東123ホール")

    def test_uncertain_missing_conflicting_and_skipped_headers_are_explicit(self) -> None:
        low = VenueRecognizer(reader=VenueReader(score=0.5)).recognize_header(header())
        self.assertEqual(low.label, "東123")
        self.assertEqual(low.status, "needs_review")
        self.assertEqual(low.issues, ["low_confidence"])
        for text, issue in [
            ("東3/E3", "venue_not_found"),
            ("東123ホール 西12ホール", "ambiguous_venue"),
        ]:
            result = VenueRecognizer(reader=VenueReader(text)).recognize_header(header())
            self.assertEqual(result.status, "unrecognized")
            self.assertIsNone(result.label)
            self.assertEqual(result.issues, [issue])
        reader = VenueReader()
        empty = VenueRecognizer(reader=reader).recognize_header(Image.new("RGB", (400, 180), "white"))
        self.assertEqual(empty.issues, ["no_header_text"])
        self.assertEqual(reader.calls, 0)
        self.assertEqual(VenueRecognizer(detect_only=True).recognize_header(header()).status, "not_run")
        with self.assertRaises(RuntimeError):
            VenueRecognizer(reader=VenueReader(score=float("nan"))).recognize_header(header())
        with self.assertRaises(ValueError):
            VenueRecognizer(confidence=0)

    def test_pdf_rasterizes_header_and_preserves_requested_page_numbers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.pdf"
            writer = PdfWriter()
            for _ in range(2):
                page = writer.add_blank_page(width=300, height=200)
                page[NameObject("/Resources")] = DictionaryObject({
                    NameObject("/Font"): DictionaryObject({
                        NameObject("/F1"): DictionaryObject({
                            NameObject("/Type"): NameObject("/Font"),
                            NameObject("/Subtype"): NameObject("/Type1"),
                            NameObject("/BaseFont"): NameObject("/Helvetica"),
                        }),
                    }),
                })
                stream = DecodedStreamObject()
                stream.set_data(b"BT /F1 14 Tf 15 180 Td (Venue Hall) Tj ET")
                page[NameObject("/Contents")] = writer._add_object(stream)
            writer.write(path)
            reader = VenueReader("南12ホール")
            results = VenueRecognizer(reader=reader).recognize_pages(path, {2: header()})
            self.assertEqual(set(results), {2})
            self.assertEqual(results[2].label, "南12")
            self.assertEqual(reader.calls, 1)

    def test_pipeline_and_stage_snapshots_keep_venue_without_changing_map_coordinates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.png"
            image = Image.new("RGB", (400, 320), "white")
            image.paste(header(), (0, 0))
            image.paste(grid(), (0, 70))
            image.save(path)
            result = MapRecognizer(
                booths=BoothRecognizer(detect_only=True),
                islands=IslandRecognizer(detect_only=True),
                venues=VenueRecognizer(reader=VenueReader("西12ホール")),
            ).recognize(path)
            output = result.save(Path(directory) / "result")
            for name in ["result.json", "step-1.json"]:
                page = json.loads(output.with_name(name).read_text(encoding="utf-8"))["pages"][0]
                self.assertEqual(page["venue"]["label"], "西12")
                self.assertEqual((page["width"], page["height"]), (400, 320))


if __name__ == "__main__":
    unittest.main()
