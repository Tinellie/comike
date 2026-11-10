import json
import logging
import re
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Sequence

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from pypdf import PdfReader

from .geometry import Box, Cell, ImageArray, detect_cells
from .ocr import DigitReader, PaddleDigitReader, Reading, digit_crop
from map_recognition.common import opaque_rgb

LOGGER = logging.getLogger(__name__)
Status = Literal["recognized", "needs_review", "unrecognized", "not_run"]


def valid_number(text: str) -> bool:
    return re.fullmatch(r"[0-9]{2}", text) is not None


@dataclass
class Booth:
    id: str
    bbox: Box
    number: str | None = None
    raw_text: str | None = None
    recognition_score: float | None = None
    rotation: int = 0
    status: Status = "not_run"
    issues: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id,
            "bbox": self.bbox.to_dict(),
            "number": self.number,
            "rawText": self.raw_text,
            "recognitionScore": self.recognition_score,
            "rotation": self.rotation,
            "status": self.status,
            "issues": self.issues,
        }


@dataclass
class MapPage:
    page: int
    image: Image.Image = field(repr=False)
    booths: list[Booth]

    def to_dict(self) -> dict[str, object]:
        stem = f"page-{self.page:03}"
        return {
            "page": self.page,
            "width": self.image.width,
            "height": self.image.height,
            "image": f"{stem}.png",
            "overlay": f"{stem}-overlay.png",
            "counts": dict(Counter(booth.status for booth in self.booths)),
            "booths": [booth.to_dict() for booth in self.booths],
        }


@dataclass
class RecognitionResult:
    source: str
    model: str | None
    pages: list[MapPage]
    skipped_pages: list[dict[str, object]]

    def to_dict(self) -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "source": self.source,
            "model": self.model,
            "coordinateSystem": {
                "origin": "top-left", "unit": "source-image-pixel",
                "bbox": "x,y,width,height; includes border",
                "rotation": "counterclockwise degrees applied to OCR crop only",
            },
            "counts": dict(Counter(b.status for page in self.pages for b in page.booths)),
            "skippedPages": self.skipped_pages,
            "pages": [page.to_dict() for page in self.pages],
        }

    def save(self, directory: str | Path) -> Path:
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        colors = {
            "recognized": "#159447", "needs_review": "#e08000",
            "unrecognized": "#df2020", "not_run": "#2275dd",
        }
        for page in self.pages:
            stem = f"page-{page.page:03}"
            page.image.save(directory / f"{stem}.png")
            overlay = page.image.copy()
            draw = ImageDraw.Draw(overlay)
            for booth in page.booths:
                box = booth.bbox
                color = colors[booth.status]
                draw.rectangle(
                    (box.x, box.y, box.x + box.width - 1, box.y + box.height - 1),
                    outline=color, width=2,
                )
                if booth.status != "not_run":
                    label = booth.number or "?"
                    draw.rectangle((box.x, box.y, box.x + 14, box.y + 10), fill="white")
                    draw.text((box.x, box.y), label, fill=color)
            overlay.save(directory / f"{stem}-overlay.png")
        target = directory / "result.json"
        target.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2, allow_nan=False),
            encoding="utf-8",
        )
        return target


class BoothRecognizer:
    """Local, reusable map recognizer. The Paddle model is loaded lazily once."""

    def __init__(
        self,
        *,
        detect_only: bool = False,
        confidence: float = 0.95,
        model_name: str = "en_PP-OCRv5_mobile_rec",
        model_dir: str | Path | None = None,
        reader: DigitReader | None = None,
    ) -> None:
        if not 0 < confidence <= 1:
            raise ValueError("confidence must be in (0, 1]")
        if model_dir is not None and not Path(model_dir).is_dir():
            raise ValueError(f"Model directory does not exist: {model_dir}")
        self.detect_only = detect_only
        self.confidence = confidence
        self.model_name = model_name
        self.model_dir = Path(model_dir) if model_dir is not None else None
        self._reader = reader

    @property
    def reader(self) -> DigitReader:
        if self._reader is None:
            self._reader = PaddleDigitReader(self.model_name, self.model_dir)
        return self._reader

    def recognize(
        self, source: str | Path, *, pages: Sequence[int] | None = None,
    ) -> RecognitionResult:
        source = Path(source)
        if not source.is_file():
            raise FileNotFoundError(source)
        requested = list(pages) if pages is not None else None
        if requested is not None and (
            not requested or any(isinstance(p, bool) or not isinstance(p, int) or p < 1 for p in requested)
            or len(set(requested)) != len(requested)
        ):
            raise ValueError("pages must contain distinct positive 1-based page numbers")
        result = RecognitionResult(
            source.name, None if self.detect_only else self.model_name, [], [],
        )

        if source.suffix.lower() == ".pdf":
            pdf = PdfReader(source)
            if pdf.is_encrypted:
                raise ValueError("Encrypted PDFs are not supported")
            numbers = requested if requested is not None else list(range(1, len(pdf.pages) + 1))
            if any(p > len(pdf.pages) for p in numbers):
                raise ValueError(f"PDF only has {len(pdf.pages)} pages")
            for number in numbers:
                images = [item.image for item in pdf.pages[number - 1].images]
                images = sorted(
                    (image for image in images if min(image.size) >= 64),
                    key=lambda image: image.width * image.height, reverse=True,
                )
                if not images:
                    LOGGER.warning("Skipping PDF page %s: no embedded map image", number)
                    result.skipped_pages.append({"page": number, "reason": "no_embedded_map_image"})
                    continue
                if len(images) > 1 and images[1].width * images[1].height > images[0].width * images[0].height / 4:
                    raise ValueError(
                        f"Page {number} has multiple large images. Export a single map image first."
                    )
                result.pages.append(self.recognize_image(images[0], page=number))
        else:
            if requested is not None and requested != [1]:
                raise ValueError("Image input only supports page 1")
            with Image.open(source) as image:
                if getattr(image, "n_frames", 1) != 1:
                    raise ValueError("Multi-frame images are not supported; export individual maps")
                result.pages.append(self.recognize_image(ImageOps.exif_transpose(image), page=1))
        if not result.pages:
            raise ValueError("No map images found. Export vector PDFs to PNG before recognition.")
        return result

    def recognize_image(self, image: Image.Image, *, page: int = 1) -> MapPage:
        if page < 1:
            raise ValueError("page must be positive")
        image = opaque_rgb(image)
        rgb = np.asarray(image)
        cells = detect_cells(rgb)
        if not cells:
            raise ValueError(f"No repeated rectangular cells detected on page {page}")
        LOGGER.info("Page %s: detected %s candidate cells", page, len(cells))
        booths = [
            Booth(
                id=f"p{page:03}-b{i:05}", bbox=cell.box,
                issues=(
                    (["repaired_border"] if cell.repaired else [])
                    + ([f"missing_{cell.missing_border}_border"] if cell.missing_border else [])
                    + (["truncated_at_image_edge"] if cell.truncated else [])
                ),
            )
            for i, cell in enumerate(cells, 1)
        ]
        if not self.detect_only:
            self._recognize_digits(rgb, cells, booths)
        return MapPage(page, image, booths)

    def _recognize_digits(self, rgb: ImageArray, cells: list[Cell], booths: list[Booth]) -> None:
        portrait = sum(c.box.height >= c.box.width for c in cells) >= len(cells) / 2
        rotations = (0, 180) if portrait else (90, 270)
        sample = np.linspace(0, len(cells) - 1, min(16, len(cells)), dtype=int)
        evidence: list[float] = []
        for rotation in rotations:
            readings = self.reader.read([digit_crop(rgb, cells[i].box, rotation) for i in sample])
            evidence.append(sum(r.score for r in readings if valid_number(r.text)))
        best_index = int(np.argmax(evidence))
        rotation = rotations[best_index]
        orientation_uncertain = (
            max(evidence) < len(sample) * 0.5
            or abs(evidence[0] - evidence[1]) < len(sample) * 0.10
        )
        LOGGER.info("OCR rotation: %s degrees CCW; evidence: %s", rotation, evidence)

        # Bound crop memory and retry only doubtful cells with binarization.
        for start in range(0, len(cells), 128):
            batch = cells[start:start + 128]
            crops = [digit_crop(rgb, cell.box, rotation) for cell in batch]
            readings = self.reader.read(crops)
            if len(readings) != len(batch):
                raise RuntimeError("Digit reader returned the wrong number of results")
            doubtful = [
                i for i, reading in enumerate(readings)
                if not valid_number(reading.text) or reading.score < self.confidence
            ]
            retries = self.reader.read([
                digit_crop(rgb, batch[i].box, rotation, binary=True) for i in doubtful
            ])
            if len(retries) != len(doubtful):
                raise RuntimeError("Digit reader returned the wrong number of retry results")
            disagreements: set[int] = set()
            for i, retry in zip(doubtful, retries):
                original = readings[i]
                if valid_number(original.text) and valid_number(retry.text) and original.text != retry.text:
                    disagreements.add(i)
                readings[i] = self._choose(original, retry)
            for i, reading in enumerate(readings):
                booth = booths[start + i]
                booth.rotation = rotation
                booth.raw_text = reading.text
                booth.recognition_score = round(reading.score, 6)
                booth.number = reading.text if valid_number(reading.text) else None
                if not valid_number(reading.text):
                    booth.issues.append("invalid_two_digit_number")
                elif reading.score < self.confidence:
                    booth.issues.append("low_confidence")
                if orientation_uncertain:
                    booth.issues.append("uncertain_page_orientation")
                if i in disagreements:
                    booth.issues.append("preprocessing_disagreement")
                booth.status = (
                    "unrecognized" if booth.number is None
                    else "needs_review" if booth.issues else "recognized"
                )
            LOGGER.info("Recognized %s/%s cells", min(start + 128, len(cells)), len(cells))

    @staticmethod
    def _choose(first: Reading, second: Reading) -> Reading:
        return max((first, second), key=lambda r: (valid_number(r.text), r.score))
