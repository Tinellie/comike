import logging
from dataclasses import replace
from pathlib import Path
from typing import Sequence

from booth_recognition import BoothRecognizer
from booth_blocks import BoothBlockGrouper
from island_recognition import IslandRecognizer
from island_recognition.context import IslandContextRefiner
from island_assignment import BoothIslandAssigner

from .ocr_step import BoothRecognitionStep, IslandRecognitionStep
from .result import MapRecognitionResult
from .venue import VenueRecognizer
from .marker_alignment import IslandMarkerAligner
from .half_booths import HalfBoothSplitter

LOGGER = logging.getLogger(__name__)


class MapRecognizer:
    def __init__(
        self, *, booths: BoothRecognizer | None = None, islands: IslandRecognizer | None = None,
        refine: bool = True,
        assign: bool = True, assignment_time_limit: float = 30,
        venues: VenueRecognizer | None = None,
    ) -> None:
        self.booth_step = BoothRecognitionStep(booths)
        self.block_step = BoothBlockGrouper()
        self.island_step = IslandRecognitionStep(islands, venues)
        self.context_step = IslandContextRefiner() if refine else None
        self.assignment_step = BoothIslandAssigner(time_limit=assignment_time_limit) if assign else None
        self.marker_alignment_step = IslandMarkerAligner()
        self.half_booth_step = HalfBoothSplitter()

    def _postprocess(self, result: MapRecognitionResult) -> MapRecognitionResult:
        LOGGER.info("Step 5: Island marker center alignment")
        alignments = {
            page.page: self.marker_alignment_step.align(
                result.islands[page.page],
                result.assignments[page.page] if result.assignments is not None else None,
            )
            for page in result.booths.pages
        }
        result = replace(result, marker_alignments=alignments)
        if result.assignments is None or result.blocks is None:
            LOGGER.warning("Step 6 skipped: half-booth splitting requires Island assignment")
            return result
        LOGGER.info("Step 6: splitting Booths into a/b halves")
        return replace(result, half_booths={
            page.page: self.half_booth_step.split(
                result.blocks[page.page], result.assignments[page.page], alignments[page.page].layouts,
            )
            for page in result.booths.pages
        })

    def recognize(self, source: str | Path, *, pages: Sequence[int] | None = None) -> MapRecognitionResult:
        booths = self.booth_step.run(source, pages=pages)
        LOGGER.info("Step 2: pixel-adjacent booth Block grouping")
        blocks = {page.page: self.block_step.group(page.booths, page=page.page) for page in booths.pages}
        LOGGER.info("Step 3: island recognition")
        raw = self.island_step.run(booths)
        result = raw
        if self.context_step is not None:
            LOGGER.info("Step 3: page label type and local island sequence refinement")
            refinements = {
                number: self.context_step.refine(markers) for number, markers in raw.islands.items()
            }
            result = MapRecognitionResult(
                raw.booths, {number: page.markers for number, page in refinements.items()},
                raw.island_model, raw.island_kana_model, refinements, raw.to_dict(),
                venues=raw.venues,
            )
        stage2_data = result.to_dict()
        result = replace(result, blocks=blocks)
        if self.assignment_step is None:
            return self._postprocess(result)
        if self.booth_step.recognizer.detect_only or self.island_step.recognizer.detect_only:
            LOGGER.warning("Step 4 skipped: both booth and island OCR are required for assignment")
            return self._postprocess(result)
        LOGGER.info("Step 4: constrained Block-to-island assignment")
        assignments = {
            page.page: self.assignment_step.assign(
                page.booths, result.islands[page.page], page=page.page,
                page_type=result.refinements[page.page].page_type.label_type if result.refinements else None,
                blocks=blocks[page.page],
            )
            for page in result.booths.pages
        }
        return self._postprocess(replace(result, assignments=assignments, stage2_data=stage2_data))
