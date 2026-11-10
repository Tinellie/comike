import logging
import math
from dataclasses import dataclass
from statistics import median
from typing import Literal

from booth_blocks import BlockGroupingResult, pixel_adjacent
from booth_blocks.grouping import BoothBlock, matrix_grid
from booth_recognition.recognizer import Booth
from island_assignment.models import AssignmentResult

LOGGER = logging.getLogger(__name__)
Axis = Literal["horizontal", "vertical"]
Suffix = Literal["a", "b"]


@dataclass(frozen=True)
class HalfBooth:
    id: str
    booth_id: str
    suffix: Suffix | None
    bbox: dict[str, float]
    issues: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id, "boothId": self.booth_id, "suffix": self.suffix, "bbox": self.bbox,
            "status": "needs_review" if self.issues else "resolved", "issues": list(self.issues),
        }


@dataclass
class HalfBoothResult:
    halves: list[HalfBooth]
    axes: dict[str, Axis]

    def to_dict(self) -> dict[str, object]:
        return {
            "method": "island-neighbor-ab",
            "counts": {
                "booths": len(self.halves) // 2, "halfBooths": len(self.halves),
                "reviewBooths": len({h.booth_id for h in self.halves if h.issues}),
            },
        }


def _center(booth: Booth) -> tuple[float, float]:
    b = booth.bbox
    return b.x + b.width / 2, b.y + b.height / 2


def _number(booth: Booth) -> int:
    if booth.number is None:
        raise ValueError(f"Missing Booth number: {booth.id}")
    return int(booth.number)


def _neighbors(booth: Booth, pool: list[Booth], axis: Axis, *, contact: bool = False) -> list[Booth]:
    along = 0 if axis == "horizontal" else 1
    cross = 1 - along
    p = _center(booth)
    tolerance = (booth.bbox.height if cross == 1 else booth.bbox.width) * 0.4
    candidates = [
        other for other in pool
        if other.id != booth.id
        and (abs(_center(other)[cross] - p[cross]) <= tolerance
             or contact and pixel_adjacent(booth.bbox, other.bbox)
             and abs(_center(other)[cross] - p[cross]) < abs(_center(other)[along] - p[along]))
        and abs(_center(other)[along] - p[along]) > 1
    ]
    return sorted(candidates, key=lambda other: (math.dist(_center(other), p), other.id))


class HalfBoothSplitter:
    def split(
        self, grouping: BlockGroupingResult, assignment: AssignmentResult, layouts: dict[str, str],
    ) -> HalfBoothResult:
        blocks = {b.id: b for b in grouping.blocks}
        if len(blocks) != len(grouping.blocks):
            raise ValueError("Duplicate Block IDs in half-booth input")
        owners: dict[str, str] = {}
        pools: dict[str, list[Booth]] = {}
        for island in assignment.islands:
            if layouts.get(island.id) not in ("wall", "interior", "uncertain"):
                raise ValueError("Missing Island layout for half-booth splitting")
            pools[island.id] = []
            for id in island.component_ids:
                if id not in blocks or id in owners:
                    raise ValueError("Invalid or repeated Block membership in half-booth input")
                owners[id] = island.id
                pools[island.id].extend(blocks[id].booths)
        if set(owners) != set(blocks):
            raise ValueError("Every Block needs an Island before half-booth splitting")
        if any(b.number is None for pool in pools.values() for b in pool):
            raise ValueError("Half-booth lettering requires recognized Booth numbers")
        axes: dict[str, Axis] = {}
        for block in grouping.blocks:
            grid = matrix_grid(block.booths)
            if grid is not None:
                if grid["columns"] != grid["rows"]:
                    axes[block.id] = "horizontal" if grid["columns"] > grid["rows"] else "vertical"
            else:
                width = median(b.bbox.width for b in block.booths)
                height = median(b.bbox.height for b in block.booths)
                axes[block.id] = "horizontal" if block.bbox.width / width >= block.bbox.height / height else "vertical"
        # Only use independently determined directions; inferred square Blocks cannot seed a chain.
        anchors = dict(axes)
        unresolved: set[str] = set()
        for block in grouping.blocks:
            if block.id in axes:
                continue
            owner = owners[block.id]
            local = []
            for id, axis in anchors.items():
                if owners[id] != owner:
                    continue
                for booth in block.booths:
                    candidates = _neighbors(booth, blocks[id].booths, axis)
                    if candidates:
                        local.append((math.dist(_center(booth), _center(candidates[0])), id, axis))
            if local:
                axes[block.id] = min(local)[2]
                continue
            # A wall's local direction can also be recovered from nearby aligned Booth centers.
            directions: list[tuple[float, Axis]] = []
            other_booths = [b for b in pools[owner] if all(b.id != own.id for own in block.booths)]
            possible_axes: tuple[Axis, Axis] = ("horizontal", "vertical")
            for booth in block.booths:
                for axis in possible_axes:
                    candidates = _neighbors(booth, other_booths, axis)
                    if candidates:
                        directions.append((math.dist(_center(booth), _center(candidates[0])), axis))
            if directions:
                axes[block.id] = min(directions)[1]
            else:
                # Geometry can still define two halves, but does not establish a/b.
                axes[block.id] = "horizontal" if block.bbox.width >= block.bbox.height else "vertical"
                unresolved.add(block.id)
        halves: list[HalfBooth] = []
        for block in grouping.blocks:
            axis = axes[block.id]
            along = 0 if axis == "horizontal" else 1
            cross = 1 - along
            owner = owners[block.id]
            layout = layouts[owner]
            compatible = [
                b for id, other in blocks.items() if owners[id] == owner and axes[id] == axis
                and id != block.id for b in other.booths
            ]
            for booth in block.booths:
                issues: list[str] = []
                if block.id in unresolved:
                    issues.append("axis_evidence_missing")
                neighbors = _neighbors(booth, block.booths, axis, contact=True)
                p = _center(booth)
                lower = next((b for b in neighbors if _center(b)[along] < p[along]), None)
                upper = next((b for b in neighbors if _center(b)[along] > p[along]), None)
                end = layout == "interior" and (lower is None or upper is None)
                if layout == "uncertain":
                    issues.append("island_layout_uncertain")
                evidence = [b for b in (lower, upper) if b is not None]
                if not evidence:
                    # Restrict fallback to this Island, this lane and a compatible Block direction.
                    evidence = _neighbors(booth, compatible, axis)[:1]
                negative: Suffix | None = None
                if evidence and block.id not in unresolved:
                    if end:
                        neighbor = min(evidence, key=lambda b: (math.dist(_center(b), p), b.id))
                        outer: Suffix = "a" if _number(neighbor) < _number(booth) else "b"
                        middle = (
                            block.bbox.y + block.bbox.height / 2 if cross == 1
                            else block.bbox.x + block.bbox.width / 2
                        )
                        if abs(p[cross] - middle) < 1:
                            # A single lane has no geometrically defined outer vs inner side.
                            issues.append("outer_side_ambiguous")
                        else:
                            negative = outer if p[cross] < middle else ("b" if outer == "a" else "a")
                    else:
                        votes = {
                            "a" if (_number(b) < _number(booth)) == (_center(b)[along] < p[along]) else "b"
                            for b in evidence
                        }
                        if len(votes) == 1:
                            negative = "a" if "a" in votes else "b"
                        else:
                            # Use nearest same-Island evidence without propagating inferred labels.
                            fallback = _neighbors(booth, compatible, axis)
                            if fallback:
                                b = fallback[0]
                                negative = "a" if (_number(b) < _number(booth)) == (_center(b)[along] < p[along]) else "b"
                            else:
                                issues.append("number_direction_conflict")
                if negative is None and not any(issue in issues for issue in (
                    "axis_evidence_missing", "outer_side_ambiguous", "number_direction_conflict",
                )):
                    issues.append("number_evidence_missing")
                cut_vertical = (axis == "horizontal") != end
                b = booth.bbox
                for index in range(2):
                    bbox = {
                        "x": b.x + (index * b.width / 2 if cut_vertical else 0),
                        "y": b.y + (index * b.height / 2 if not cut_vertical else 0),
                        "width": b.width / 2 if cut_vertical else b.width,
                        "height": b.height if cut_vertical else b.height / 2,
                    }
                    suffix = negative if index == 0 else (
                        None if negative is None else "b" if negative == "a" else "a"
                    )
                    halves.append(HalfBooth(
                        f"{booth.id}-h{index + 1}", booth.id, suffix, bbox, tuple(issues),
                    ))
        result = HalfBoothResult(halves, axes)
        reviews = result.to_dict()["counts"]
        if any(h.issues for h in halves):
            LOGGER.warning("Half-booth splitting contains items requiring review: %s", reviews)
        LOGGER.info("Half-booth splitting: %s", reviews)
        return result
