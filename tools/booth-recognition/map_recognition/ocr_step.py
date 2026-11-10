import logging
from pathlib import Path
from typing import Sequence

from booth_recognition import BoothRecognizer, RecognitionResult
from island_recognition import IslandRecognizer

from .result import MapRecognitionResult
from .venue import VenueRecognizer

LOGGER = logging.getLogger(__name__)


class BoothRecognitionStep:
    def __init__(self, recognizer: BoothRecognizer | None = None) -> None:
        self.recognizer = recognizer if recognizer is not None else BoothRecognizer()

    def run(self, source: str | Path, *, pages: Sequence[int] | None = None) -> RecognitionResult:
        LOGGER.info("Step 1: booth detection and OCR")
        return self.recognizer.recognize(source, pages=pages)


class IslandRecognitionStep:
    def __init__(
        self, recognizer: IslandRecognizer | None = None, venues: VenueRecognizer | None = None,
    ) -> None:
        self.recognizer = recognizer if recognizer is not None else IslandRecognizer()
        self.venues = venues

    def run(self, booths: RecognitionResult) -> MapRecognitionResult:
        LOGGER.info("Island recognition: colored marker detection and OCR")
        venues = self.venues
        if venues is None:
            venues = VenueRecognizer(
                detect_only=self.recognizer.detect_only,
                reader=None if self.recognizer.detect_only else self.recognizer.reader,
            )
        LOGGER.info("Page metadata: upper-left venue header OCR")
        venue_results = venues.recognize_pages(booths.source, {p.page: p.image for p in booths.pages})
        islands = {
            page.page: self.recognizer.recognize_image(page.image, page=page.page)
            for page in booths.pages
        }
        return MapRecognitionResult(
            booths, islands, None if self.recognizer.detect_only else self.recognizer.model_name,
            None if self.recognizer.detect_only else self.recognizer.kana_model_name,
            venues=venue_results,
        )


class OcrRecognitionStep:
    def __init__(
        self, *, booths: BoothRecognizer | None = None, islands: IslandRecognizer | None = None,
        venues: VenueRecognizer | None = None,
    ) -> None:
        self.booths = booths if booths is not None else BoothRecognizer()
        self.islands = islands if islands is not None else IslandRecognizer()
        self.venues = venues

    def run(self, source: str | Path, *, pages: Sequence[int] | None = None) -> MapRecognitionResult:
        booths = BoothRecognitionStep(self.booths).run(source, pages=pages)
        return IslandRecognitionStep(self.islands, self.venues).run(booths)
