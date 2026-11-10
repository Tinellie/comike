import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw
from pypdf import PdfReader, PdfWriter, Transformation

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer
from map_recognition.pdf_preview import render_pdf_previews
from map_recognition.pipeline import MapRecognizer
from map_recognition.venue import VenueRecognizer
from test_recognizer import grid


def write_pdf(path: Path, image: Image.Image, rotation: int = 0) -> None:
    stream = io.BytesIO()
    image.save(stream, format="PDF", resolution=72)
    writer = PdfWriter()
    page = writer.add_blank_page(width=400, height=320)
    page.merge_transformed_page(PdfReader(stream).pages[0], Transformation().translate(30, 40))
    if rotation:
        page.rotate(rotation)
    with path.open("wb") as file:
        writer.write(file)


class PdfPreviewTests(unittest.TestCase):
    def test_complete_page_and_affine_map_alignment_with_optional_existing_padding(self) -> None:
        image = Image.new("RGB", (100, 80), "white")
        ImageDraw.Draw(image).rectangle((0, 0, 99, 79), outline="black", width=2)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.pdf"
            write_pdf(path, image)
            for border in (0, 2):
                source_image = Image.new("RGB", (100 + 2 * border, 80 + 2 * border), "white")
                preview = render_pdf_previews(path, {1: source_image}, image_border=border)[1]
                self.assertEqual(preview.image.size, (400, 320))
                a, b, c, d, e, f = preview.transform
                self.assertEqual((a, b, c, d), (1, 0, 0, 1))
                self.assertEqual((e, f), (30 - border, 200 - border))
                self.assertEqual(preview.to_dict()["image"], "page-001-pdf.png")
                self.assertLess(sum(preview.image.getpixel((30, 200))), 300)

    def test_rotated_pdf_page_maps_original_source_axes_without_rotating_booth_data(self) -> None:
        image = Image.new("RGB", (100, 80), "black")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.pdf"
            write_pdf(path, image, rotation=90)
            preview = render_pdf_previews(path, {1: image})[1]
            self.assertEqual(preview.image.size, (320, 400))
            a, b, c, d, e, f = preview.transform
            self.assertEqual((a, b, c, d), (0, 1, -1, 0))
            self.assertEqual((e, f), (120, 30))

    def test_mismatching_source_dimensions_fail_instead_of_guessing_placement(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.pdf"
            write_pdf(path, Image.new("RGB", (100, 80), "black"))
            with self.assertRaisesRegex(ValueError, "dimensions"):
                render_pdf_previews(path, {1: Image.new("RGB", (120, 90))})
            with self.assertRaisesRegex(ValueError, "out of range"):
                render_pdf_previews(path, {2: Image.new("RGB", (100, 80))})

    def test_pdf_pipeline_persists_full_page_asset_without_changing_recognition_extent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "map.pdf"
            image = grid()
            write_pdf(path, image)
            result = MapRecognizer(
                booths=BoothRecognizer(detect_only=True), islands=IslandRecognizer(detect_only=True),
                venues=VenueRecognizer(detect_only=True), assign=False,
            ).recognize(path)
            target = result.save(Path(directory) / "output")
            page = json.loads(target.read_text(encoding="utf-8"))["pages"][0]
            self.assertEqual((page["width"], page["height"]), image.size)
            self.assertEqual((page["pdfPreview"]["width"], page["pdfPreview"]["height"]), (400, 320))
            self.assertTrue((target.parent / "page-001-pdf.png").is_file())
            self.assertTrue((target.parent / "page-001.png").is_file())
            self.assertEqual(len(page["booths"]), 16)


if __name__ == "__main__":
    unittest.main()