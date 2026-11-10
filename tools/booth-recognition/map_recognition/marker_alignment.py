import logging
import math
from collections import Counter
from dataclasses import dataclass
from statistics import median
from typing import Literal

from island_assignment.models import AssignmentResult, ContactComponent
from island_recognition import IslandMarker

LOGGER = logging.getLogger(__name__)
Layout = Literal["wall", "interior", "uncertain"]


@dataclass(frozen=True)
class Point:
    x: float
    y: float

    def to_dict(self) -> dict[str, float]:
        return {"x": self.x, "y": self.y}


@dataclass
class MarkerAlignmentResult:
    centers: dict[str, Point]
    layouts: dict[str, Layout]
    aligned: int
    centered: int
    assigned: bool

    def to_dict(self) -> dict[str, object]:
        return {
            "method": "local-center-lines",
            "status": "aligned" if self.assigned else "centers_only",
            "counts": {
                "markers": len(self.centers), "aligned": self.aligned, "centered": self.centered,
                **dict(Counter(self.layouts.values())),
            },
        }

    def marker_dict(self, marker: IslandMarker) -> dict[str, object]:
        data = marker.to_dict()
        del data["bbox"]
        data["center"] = self.centers[marker.id].to_dict()
        return data


def _distance(point: Point, component: ContactComponent) -> float:
    b = component.bbox
    return math.hypot(
        max(b.x - point.x, point.x - (b.x + b.width - 1), 0),
        max(b.y - point.y, point.y - (b.y + b.height - 1), 0),
    )


def _wall_direction(component: ContactComponent) -> Literal["x", "y"] | None:
    centers = [
        Point(b.bbox.x + (b.bbox.width - 1) / 2, b.bbox.y + (b.bbox.height - 1) / 2)
        for b in component.booths
    ]
    along = [p.x if component.axis == "horizontal" else p.y for p in centers]
    cross = [p.y if component.axis == "horizontal" else p.x for p in centers]
    if max(cross) - min(cross) > max(1, (max(along) - min(along)) * 0.1):
        return None
    return "y" if component.axis == "horizontal" else "x"


class IslandMarkerAligner:
    def align(
        self, markers: list[IslandMarker], assignment: AssignmentResult | None = None,
    ) -> MarkerAlignmentResult:
        original = {
            m.id: Point(m.bbox.x + (m.bbox.width - 1) / 2, m.bbox.y + (m.bbox.height - 1) / 2)
            for m in markers
        }
        if len(original) != len(markers):
            raise ValueError("Duplicate Island marker IDs")
        if assignment is None:
            LOGGER.info("Marker alignment: no Island assignment, recording original centers only")
            return MarkerAlignmentResult(original, {}, 0, 0, False)
        components = {c.id: c for c in assignment.components}
        owners: dict[str, str] = {}
        layouts: dict[str, Layout] = {}
        island_components: dict[str, list[ContactComponent]] = {}
        for island in assignment.islands:
            blocks = [components[id] for id in island.component_ids]
            if not blocks:
                raise ValueError(f"Island {island.id} has no Blocks")
            island_components[island.id] = blocks
            layouts[island.id] = (
                "wall" if all(c.thin for c in blocks) and sum(len(c.booths) for c in blocks) >= 4
                else "interior" if all(not c.thin for c in blocks) else "uncertain"
            )
            for id in island.marker_ids:
                if id not in original or id in owners:
                    raise ValueError("Invalid or repeated Island marker membership")
                owners[id] = island.id
        if set(owners) != set(original):
            raise ValueError("Island marker membership is incomplete")
        booths = [b for c in components.values() for b in c.booths]
        if not booths:
            raise ValueError("Cannot align markers without assigned Booths")
        scale = median(min(b.bbox.width, b.bbox.height) for b in booths)
        tolerance, neighbor_gap = scale * 0.4, scale * 14
        buckets: dict[tuple[str, str, int], list[str]] = {}
        for id, point in original.items():
            owner = owners[id]
            layout = layouts[owner]
            if layout == "uncertain":
                continue
            local = min(island_components[owner], key=lambda c: (_distance(point, c), c.id))
            if layout == "wall":
                normal = _wall_direction(local)
                if normal is None:
                    continue
                b = local.bbox
                middle = b.x + (b.width - 1) / 2 if normal == "x" else b.y + (b.height - 1) / 2
                side = 1 if getattr(point, normal) >= middle else -1
            else:
                normal = "x" if local.axis == "horizontal" else "y"
                side = 0
            buckets.setdefault((layout, normal, side), []).append(id)
        groups: list[tuple[str, str, list[str]]] = []
        for layout, normal, side in sorted(buckets):
            ids = buckets[(layout, normal, side)]
            along = "y" if normal == "x" else "x"
            # Bound the full band width, rather than chaining small offsets into a diagonal.
            bands: list[list[str]] = []
            for id in sorted(ids, key=lambda id: (getattr(original[id], normal), id)):
                if bands and getattr(original[id], normal) - getattr(original[bands[-1][0]], normal) <= tolerance:
                    bands[-1].append(id)
                else:
                    bands.append([id])
            for band in bands:
                runs: list[list[str]] = []
                for id in sorted(band, key=lambda id: (getattr(original[id], along), id)):
                    if runs and getattr(original[id], along) - getattr(original[runs[-1][-1]], along) <= neighbor_gap:
                        runs[-1].append(id)
                    else:
                        runs.append([id])
                for run in runs:
                    if len(run) >= 2 and (layout == "wall" or len({owners[id] for id in run}) >= 2):
                        groups.append((layout, normal, run))
        centers = dict(original)
        aligned: set[str] = set()
        centered: set[str] = set()
        for layout, normal, ids in groups:
            target = float(median(getattr(original[id], normal) for id in ids))
            along = "y" if normal == "x" else "x"
            for id in ids:
                p = centers[id]
                p = Point(target, p.y) if normal == "x" else Point(p.x, target)
                aligned.add(id)
                if layout == "interior":
                    blocks = island_components[owners[id]]
                    low = min(getattr(c.bbox, along) for c in blocks)
                    high = max(
                        getattr(c.bbox, along) + (c.bbox.width if along == "x" else c.bbox.height) - 1
                        for c in blocks
                    )
                    middle = (low + high) / 2
                    candidate = Point(middle, p.y) if along == "x" else Point(p.x, middle)
                    occupied = any(
                        b.bbox.x - scale * 0.15 <= candidate.x <= b.bbox.x + b.bbox.width - 1 + scale * 0.15
                        and b.bbox.y - scale * 0.15 <= candidate.y <= b.bbox.y + b.bbox.height - 1 + scale * 0.15
                        for b in booths
                    )
                    collision = any(
                        other != id and math.hypot(candidate.x - q.x, candidate.y - q.y) < scale * 0.6
                        for other, q in centers.items()
                    )
                    if abs(middle - getattr(p, along)) <= scale * 2 and not occupied and not collision:
                        p = candidate
                        centered.add(id)
                centers[id] = p
        LOGGER.info(
            "Marker alignment: %s markers, %s line-aligned, %s Island-centered; layouts %s",
            len(markers), len(aligned), len(centered), dict(Counter(layouts.values())),
        )
        return MarkerAlignmentResult(centers, layouts, len(aligned), len(centered), True)
