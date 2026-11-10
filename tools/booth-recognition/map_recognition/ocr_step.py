import logging
from pathlib import Path
from typing import Sequence

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer

from .result import MapRecognitionResult

LOGGER = logging.getLogger(__name__)


class OcrRecognitionStep:
    def __init__(
        self, *, booths: BoothRecognizer | None = None, islands: IslandRecognizer | None = None,
    ) -> None:
        self.booths = booths if booths is not None else BoothRecognizer()
        self.islands = islands if islands is not None else IslandRecognizer()

    def run(self, source: str | Path, *, pages: Sequence[int] | None = None) -> MapRecognitionResult:
        LOGGER.info("Step 1: booth detection and OCR")
        booths = self.booths.recognize(source, pages=pages)
        LOGGER.info("Step 1: colored island detection and OCR")
        islands = {
            page.page: self.islands.recognize_image(page.image, page=page.page)
            for page in booths.pages
        }
        return MapRecognitionResult(
            booths, islands, None if self.islands.detect_only else self.islands.model_name,
            None if self.islands.detect_only else self.islands.kana_model_name,
        )
