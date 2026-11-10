import logging
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from PIL import Image

from .common import ImageArray, PaddleTextReader, TextReader, opaque_rgb

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class Venue:
    label: str | None = None
    raw_text: str | None = None
    recognition_score: float | None = None
    status: Literal["recognized", "needs_review", "unrecognized", "not_run"] = "not_run"
    issues: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, object]:
        return {
            "label": self.label, "rawText": self.raw_text,
            "recognitionScore": self.recognition_score, "status": self.status, "issues": self.issues,
        }


def venue_labels(text: str) -> set[str]:
    text = re.sub(r"\s+", "", unicodedata.normalize("NFKC", text)).replace("⻄", "西")
    return {
        match.group(1) + re.sub(r"[,、・/／]", "", match.group(2))
        for match in re.finditer(r"([東西南北])([1-9][0-9]*(?:[,、・/／][1-9][0-9]*)*)ホ[ー-]ル", text)
    }


def header_lines(image: Image.Image) -> list[ImageArray]:
    gray = cv2.cvtColor(np.asarray(opaque_rgb(image)), cv2.COLOR_RGB2GRAY)
    ink = gray < 160
    rows = np.flatnonzero(ink.sum(axis=1) >= max(2, gray.shape[1] * 0.002))
    groups: list[list[int]] = []
    for row in rows:
        if groups and row - groups[-1][-1] <= 3:
            groups[-1].append(int(row))
        else:
            groups.append([int(row)])
    crops = []
    for group in groups:
        top, bottom = group[0], group[-1] + 1
        if bottom - top < 6:
            continue
        columns = np.flatnonzero(ink[top:bottom].any(axis=0))
        if not len(columns):
            continue
        patch = gray[top:bottom, columns[0]:columns[-1] + 1]
        height, width = patch.shape
        if width < height:
            continue
        patch = cv2.resize(patch, (max(1, round(width * 64 / height)), 64), interpolation=cv2.INTER_CUBIC)
        patch = cv2.copyMakeBorder(patch, 12, 12, 12, 12, cv2.BORDER_CONSTANT, value=255)
        crops.append(cv2.cvtColor(patch, cv2.COLOR_GRAY2BGR))
    return crops


class VenueRecognizer:
    def __init__(
        self, *, reader: TextReader | None = None, detect_only: bool = False,
        confidence: float = 0.90,
    ) -> None:
        if not 0 < confidence <= 1:
            raise ValueError("confidence must be in (0, 1]")
        self.reader = reader
        self.detect_only = detect_only
        self.confidence = confidence

    def recognize_header(self, image: Image.Image) -> Venue:
        if self.detect_only:
            return Venue()
        crops = header_lines(image)
        if not crops:
            LOGGER.warning("Venue recognition: no header text found")
            return Venue(status="unrecognized", issues=["no_header_text"])
        if self.reader is None:
            self.reader = PaddleTextReader("PP-OCRv5_server_rec", batch_size=16)
        readings = self.reader.read(crops)
        if len(readings) != len(crops):
            raise RuntimeError("Venue OCR returned a different number of readings than header lines")
        if any(not np.isfinite(r.score) or not 0 <= r.score <= 1 for r in readings):
            raise RuntimeError("Venue OCR returned an invalid score")
        matches: dict[str, float] = {}
        for reading in readings:
            for label in venue_labels(reading.text):
                matches[label] = max(matches.get(label, 0), reading.score)
        raw_text = "\n".join(r.text for r in readings)
        if len(matches) != 1:
            issue = "ambiguous_venue" if matches else "venue_not_found"
            LOGGER.warning("Venue recognition: %s (%r)", issue, raw_text)
            return Venue(raw_text=raw_text, status="unrecognized", issues=[issue])
        label, score = next(iter(matches.items()))
        raw_text = "\n".join(r.text for r in readings if label in venue_labels(r.text))
        confident = score >= self.confidence
        if not confident:
            LOGGER.warning("Venue recognition: low confidence for %s: %.3f", label, score)
        return Venue(
            label, raw_text, score, "recognized" if confident else "needs_review",
            [] if confident else ["low_confidence"],
        )

    def recognize_pages(self, source: str | Path, images: dict[int, Image.Image]) -> dict[int, Venue]:
        if self.detect_only:
            return {number: Venue() for number in images}
        source = Path(source)
        if source.suffix.lower() != ".pdf":
            return {
                number: self.recognize_header(image.crop((
                    0, 0, max(1, round(image.width * 0.85)), max(1, round(image.height * 0.15)),
                )))
                for number, image in images.items()
            }
        import pypdfium2 as pdfium

        venues = {}
        with pdfium.PdfDocument(source) as document:
            for number in images:
                page = document[number - 1]
                try:
                    width, height = page.get_size()
                    bitmap = page.render(scale=3, crop=(0, height * 0.88, width * 0.15, 0))
                    try:
                        venues[number] = self.recognize_header(bitmap.to_pil())
                    finally:
                        bitmap.close()
                finally:
                    page.close()
        return venues
