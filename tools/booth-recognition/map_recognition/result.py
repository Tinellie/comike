import json
import logging
from collections import Counter
from dataclasses import dataclass, replace
from pathlib import Path

from PIL import Image, ImageDraw

from booth_recognition import RecognitionResult
from booth_blocks import BlockGroupingResult
from island_recognition import IslandMarker
from island_recognition.context import PageRefinement
from island_assignment.models import AssignmentResult
from .venue import Venue
from .marker_alignment import MarkerAlignmentResult
from .half_booths import HalfBoothResult
from .final_data import save_final_result

LOGGER = logging.getLogger(__name__)


@dataclass
class MapRecognitionResult:
    booths: RecognitionResult
    islands: dict[int, list[IslandMarker]]
    island_model: str | None
    island_kana_model: str | None = None
    refinements: dict[int, PageRefinement] | None = None
    stage1_data: dict[str, object] | None = None
    assignments: dict[int, AssignmentResult] | None = None
    stage2_data: dict[str, object] | None = None
    blocks: dict[int, BlockGroupingResult] | None = None
    venues: dict[int, Venue] | None = None
    marker_alignments: dict[int, MarkerAlignmentResult] | None = None
    half_booths: dict[int, HalfBoothResult] | None = None

    def to_dict(self) -> dict[str, object]:
        data = self.booths.to_dict()
        data["schemaVersion"] = 3 if self.refinements is not None else 2
        data["processingSteps"] = ["ocr", "island_context"] if self.refinements is not None else ["ocr"]
        data["islandModel"] = self.island_model
        data["islandKanaModel"] = self.island_kana_model
        data["islandCounts"] = dict(Counter(m.status for markers in self.islands.values() for m in markers))
        data["pages"] = [
            {
                **page.to_dict(),
                **({"venue": self.venues[page.page].to_dict()} if self.venues is not None else {}),
                "islandMarkers": [m.to_dict() for m in self.islands[page.page]],
                "islandCounts": dict(Counter(m.status for m in self.islands[page.page])),
                **({"islandInference": self.refinements[page.page].to_dict()} if self.refinements is not None else {}),
            }
            for page in self.booths.pages
        ]
        if self.assignments is not None or self.blocks is not None:
            data["schemaVersion"] = 7 if self.marker_alignments is not None else 6
            data["processingSteps"] = [
                "booth_recognition", *(["booth_block_grouping"] if self.blocks is not None else []),
                "island_recognition", *(["booth_island_assignment"] if self.assignments is not None else []),
                *(["island_marker_alignment"] if self.marker_alignments is not None else []),
                *(["half_booth_splitting"] if self.half_booths is not None else []),
            ]
            pages = []
            total_counts: Counter[str] = Counter()
            for page in self.booths.pages:
                assignment = self.assignments[page.page] if self.assignments is not None else None
                alignment = self.marker_alignments[page.page] if self.marker_alignments is not None else None
                halves = self.half_booths[page.page] if self.half_booths is not None else None
                if self.blocks is None:
                    raise ValueError("Normalized island export requires Block grouping")
                blocks = self.blocks[page.page]
                if blocks is not None:
                    memberships = blocks.memberships
                elif assignment is not None:
                    memberships = assignment.memberships
                else:
                    raise ValueError("Missing Block grouping and island assignment")
                counts = dict(Counter(b.status for b in page.booths if b.id in memberships))
                total_counts.update(counts)
                block_data = blocks.to_dict()
                block_records = block_data.pop("blocks")
                assignment_data = assignment.to_dict() if assignment is not None else None
                island_records = [
                    {**island.to_dict(), **({"layoutKind": alignment.layouts[island.id]} if alignment else {})}
                    for island in assignment.islands
                ] if assignment is not None else []
                if assignment_data is not None:
                    del assignment_data["islands"]
                if assignment is not None:
                    features = {component.id: component for component in assignment.components}
                    block_records = [
                        {**block.to_dict(), "axis": halves.axes[block.id] if halves else features[block.id].axis,
                         "thin": features[block.id].thin}
                        for block in blocks.blocks
                    ]
                pages.append({
                    **page.to_dict(),
                    **({"venue": self.venues[page.page].to_dict()} if self.venues is not None else {}),
                    "candidateCounts": page.to_dict()["counts"],
                    "counts": counts,
                    "booths": [
                        b.to_dict()
                        for b in page.booths if b.id in memberships
                    ],
                    "excludedCandidates": [b.to_dict() for b in (blocks.excluded if blocks is not None else assignment.excluded)],
                    "islandMarkers": [
                        alignment.marker_dict(m) if alignment else m.to_dict()
                        for m in self.islands[page.page]
                    ],
                    **({"markerAlignment": alignment.to_dict()} if alignment else {}),
                    **({"halfBooths": [h.to_dict() for h in halves.halves],
                        "halfBoothSplitting": halves.to_dict()} if halves else {}),
                    "islandCounts": dict(Counter(m.status for m in self.islands[page.page])),
                    **({"islandInference": self.refinements[page.page].to_dict()} if self.refinements else {}),
                    **({"islandAssignment": assignment_data} if assignment_data is not None else {}),
                    "blockGrouping": block_data, "blocks": block_records, "islands": island_records,
                })
            data["pages"] = pages
            data["counts"] = dict(total_counts)
        return data

    def save(self, directory: str | Path) -> Path:
        directory = Path(directory)
        booths = self.booths
        included = None
        if self.blocks is not None:
            included = {number: set(grouping.memberships) for number, grouping in self.blocks.items()}
        elif self.assignments is not None:
            included = {number: set(assignment.memberships) for number, assignment in self.assignments.items()}
        if included is not None:
            booths = replace(self.booths, pages=[
                replace(page, booths=[b for b in page.booths if b.id in included[page.page]])
                for page in self.booths.pages
            ])
        booths.save(directory)
        colors = {
            "recognized": "#8b35d1", "needs_review": "#e08000",
            "unrecognized": "#df2020", "not_run": "#2275dd",
        }
        for page in self.booths.pages:
            target = directory / f"page-{page.page:03}-overlay.png"
            if self.blocks is not None:
                overlay = page.image.convert("RGB").copy()
            else:
                with Image.open(target) as source:
                    overlay = source.convert("RGB")
            draw = ImageDraw.Draw(overlay)
            if self.assignments is not None:
                assignment = self.assignments[page.page]
                colors_by_id = {island.id: island.color for island in assignment.islands}
                tint = Image.new("RGBA", overlay.size)
                tint_draw = ImageDraw.Draw(tint)
                for booth in page.booths:
                    membership = assignment.memberships.get(booth.id)
                    if membership is None:
                        continue
                    b = booth.bbox
                    rgb = tuple(bytes.fromhex(colors_by_id[membership.island_id][1:]))
                    tint_draw.rectangle(
                        (b.x, b.y, b.x + b.width - 1, b.y + b.height - 1), fill=rgb + (65,),
                    )
                overlay = Image.alpha_composite(overlay.convert("RGBA"), tint).convert("RGB")
                draw = ImageDraw.Draw(overlay)
            if self.blocks is not None:
                booth_colors = {
                    "recognized": "#159447", "needs_review": "#e08000",
                    "unrecognized": "#df2020", "not_run": "#2275dd",
                }
                for kind in ("outline", "dividers"):
                    for block in self.blocks[page.page].blocks:
                        for edge in getattr(block, kind):
                            draw.line((edge.x1, edge.y1, edge.x2, edge.y2), fill=booth_colors[edge.status], width=2)
                for booth in (b for block in self.blocks[page.page].blocks for b in block.booths):
                    if booth.status != "not_run":
                        b = booth.bbox
                        draw.rectangle((b.x, b.y, b.x + 14, b.y + 10), fill="white")
                        draw.text((b.x, b.y), booth.number or "?", fill=booth_colors[booth.status])
            for marker in self.islands[page.page]:
                if self.marker_alignments is not None:
                    p = self.marker_alignments[page.page].centers[marker.id]
                    color = colors[marker.status]
                    draw.line((p.x - 4, p.y, p.x + 4, p.y), fill=color, width=2)
                    draw.line((p.x, p.y - 4, p.x, p.y + 4), fill=color, width=2)
                    draw.text((p.x + 5, max(0, p.y - 12)), marker.id.rsplit("-", 1)[-1], fill=color)
                    continue
                b = marker.bbox
                color = colors[marker.status]
                draw.rectangle(
                    (b.x, b.y, b.x + b.width - 1, b.y + b.height - 1),
                    outline=color, width=2,
                )
                # ASCII occurrence IDs keep PNG export portable without a Japanese font.
                draw.text((b.x, max(0, b.y - 12)), marker.id.rsplit("-", 1)[-1], fill=color)
            overlay.save(target)
        if self.stage1_data is not None:
            (directory / "step-1.json").write_text(
                json.dumps(self.stage1_data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8",
            )
        if self.stage2_data is not None:
            (directory / "step-2.json").write_text(
                json.dumps(self.stage2_data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8",
            )
        if self.blocks is not None:
            (directory / "block-grouping.json").write_text(
                json.dumps(
                    {"pages": [{"page": page, **grouping.to_dict()} for page, grouping in self.blocks.items()]},
                    ensure_ascii=False, indent=2, allow_nan=False,
                ), encoding="utf-8",
            )
        target = directory / "result.json"
        target.write_text(
            json.dumps(self.to_dict(), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8",
        )
        if self.assignments is not None and self.half_booths is not None:
            final_target = save_final_result(target)
            LOGGER.info("Final data: %s", final_target.resolve())
        else:
            LOGGER.warning("Final export skipped: completed Island assignment and half-booth splitting are required")
        return target
