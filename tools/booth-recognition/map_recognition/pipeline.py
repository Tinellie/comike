import logging
from pathlib import Path
from typing import Sequence

from booth_recognition import BoothRecognizer
from island_recognition import IslandRecognizer
from island_recognition.context import IslandContextRefiner

from .ocr_step import OcrRecognitionStep
from .result import MapRecognitionResult

LOGGER = logging.getLogger(__name__)


class MapRecognizer:
    def __init__(
        self, *, booths: BoothRecognizer | None = None, islands: IslandRecognizer | None = None,
        refine: bool = True,
    ) -> None:
        self.ocr_step = OcrRecognitionStep(booths=booths, islands=islands)
        self.context_step = IslandContextRefiner() if refine else None

    def recognize(self, source: str | Path, *, pages: Sequence[int] | None = None) -> MapRecognitionResult:
        raw = self.ocr_step.run(source, pages=pages)
        if self.context_step is None:
            return raw
        LOGGER.info("Step 2: page label type and local island sequence refinement")
        refinements = {
            number: self.context_step.refine(markers) for number, markers in raw.islands.items()
        }
        return MapRecognitionResult(
            raw.booths, {number: result.markers for number, result in refinements.items()},
            raw.island_model, raw.island_kana_model, refinements, raw.to_dict(),
        )
