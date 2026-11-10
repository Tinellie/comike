from collections import defaultdict
from dataclasses import dataclass
from math import floor

from booth_recognition.recognizer import Booth
from map_recognition.common import Box


def pixel_adjacent(a: Box, b: Box) -> bool:
    right_a, bottom_a = a.x + a.width - 1, a.y + a.height - 1
    right_b, bottom_b = b.x + b.width - 1, b.y + b.height - 1
    return (
        min(abs(right_a - b.x), abs(right_b - a.x)) <= 1
        and min(bottom_a, bottom_b) > max(a.y, b.y)
        or min(abs(bottom_a - b.y), abs(bottom_b - a.y)) <= 1
        and min(right_a, right_b) > max(a.x, b.x)
    )


@dataclass(frozen=True)
class BlockEdge:
    x1: float
    y1: float
    x2: float
    y2: float
    status: str

    def to_dict(self) -> dict[str, object]:
        return {
            "x1": self.x1, "y1": self.y1, "x2": self.x2, "y2": self.y2,
            "status": self.status,
        }


@dataclass
class BoothBlock:
    id: str
    booths: list[Booth]
    bbox: Box
    outline: list[BlockEdge]
    dividers: list[BlockEdge]

    def to_dict(self) -> dict[str, object]:
        return {
            "id": self.id, "boothIds": [b.id for b in self.booths], "bbox": self.bbox.to_dict(),
            "grid": matrix_grid(self.booths),
        }


@dataclass
class BlockGroupingResult:
    page: int
    blocks: list[BoothBlock]
    excluded: list[Booth]

    @property
    def memberships(self) -> dict[str, str]:
        return {b.id: block.id for block in self.blocks for b in block.booths}

    def to_dict(self) -> dict[str, object]:
        return {
            "method": "pixel-edge-connected-components",
            "maxBorderPixelDistance": 1,
            "counts": {
                "blocks": len(self.blocks), "booths": sum(len(b.booths) for b in self.blocks),
                "excludedCandidates": len(self.excluded),
            },
            "blocks": [block.to_dict() for block in self.blocks],
        }


def _snap(spans: list[tuple[int, int]]) -> dict[int, float]:
    protected = set(spans)
    groups: list[list[int]] = []
    for value in sorted({value for span in spans for value in span}):
        if groups and value - groups[-1][0] <= 1 and not any(
            (other, value) in protected for other in groups[-1]
        ):
            groups[-1].append(value)
        else:
            groups.append([value])
    return {value: (group[0] + group[-1]) / 2 for group in groups for value in group}


def matrix_grid(booths: list[Booth]) -> dict[str, int] | None:
    if not booths:
        return None
    xs = _snap([(b.bbox.x, b.bbox.x + b.bbox.width - 1) for b in booths])
    ys = _snap([(b.bbox.y, b.bbox.y + b.bbox.height - 1) for b in booths])
    columns = sorted(set(xs.values()))
    rows = sorted(set(ys.values()))
    if (len(columns) - 1) * (len(rows) - 1) != len(booths):
        return None
    for coordinates in (columns, rows):
        step = (coordinates[-1] - coordinates[0]) / (len(coordinates) - 1)
        if any(abs(value - (coordinates[0] + index * step)) > 1e-8
               for index, value in enumerate(coordinates)):
            return None
    occupied = set()
    for booth in booths:
        b = booth.bbox
        x, y = columns.index(xs[b.x]), rows.index(ys[b.y])
        if (x + 1 >= len(columns) or y + 1 >= len(rows)
                or xs[b.x + b.width - 1] != columns[x + 1]
                or ys[b.y + b.height - 1] != rows[y + 1] or (x, y) in occupied):
            return None
        occupied.add((x, y))
    return {"rows": len(rows) - 1, "columns": len(columns) - 1}


def _edges(booths: list[Booth]) -> tuple[list[BlockEdge], list[BlockEdge]]:
    # Snap only display geometry, never the source OCR rectangles.
    xs = _snap([(b.bbox.x, b.bbox.x + b.bbox.width - 1) for b in booths])
    ys = _snap([(b.bbox.y, b.bbox.y + b.bbox.height - 1) for b in booths])
    lines: dict[tuple[str, float], list[tuple[float, float, int, str]]] = defaultdict(list)
    for booth in booths:
        b = booth.bbox
        left, right = xs[b.x], xs[b.x + b.width - 1]
        top, bottom = ys[b.y], ys[b.y + b.height - 1]
        lines["h", top].append((left, right, -1, booth.status))
        lines["h", bottom].append((left, right, 1, booth.status))
        lines["v", left].append((top, bottom, -1, booth.status))
        lines["v", right].append((top, bottom, 1, booth.status))
    outline: list[BlockEdge] = []
    dividers: list[BlockEdge] = []
    priority = {"recognized": 0, "not_run": 1, "unrecognized": 2, "needs_review": 3}
    for (axis, coordinate), segments in sorted(lines.items()):
        stops = sorted({point for start, end, _, _ in segments for point in (start, end)})
        merged: list[tuple[float, float, bool, str]] = []
        for start, end in zip(stops, stops[1:]):
            active = [s for s in segments if s[0] <= start and s[1] >= end]
            if not active:
                continue
            internal = {s[2] for s in active} == {-1, 1}
            status = max((s[3] for s in active), key=priority.__getitem__)
            if merged and merged[-1][1] == start and merged[-1][2:] == (internal, status):
                merged[-1] = (merged[-1][0], end, internal, status)
            else:
                merged.append((start, end, internal, status))
        for start, end, internal, status in merged:
            edge = BlockEdge(start, coordinate, end, coordinate, status) if axis == "h" else BlockEdge(
                coordinate, start, coordinate, end, status,
            )
            (dividers if internal else outline).append(edge)
    return outline, dividers


class BoothBlockGrouper:
    def group(self, booths: list[Booth], *, page: int = 1) -> BlockGroupingResult:
        if page < 1 or len({b.id for b in booths}) != len(booths):
            raise ValueError("Block grouping requires a positive page and unique booth IDs")
        eligible = sorted((b for b in booths if b.status != "unrecognized"), key=lambda b: b.id)
        if any(b.bbox.width < 2 or b.bbox.height < 2 for b in eligible):
            raise ValueError("Block grouping requires booth rectangles at least two pixels wide/high")
        if not eligible:
            return BlockGroupingResult(page, [], list(booths))
        scale = max(max(b.bbox.width, b.bbox.height) for b in eligible)
        parent = list(range(len(eligible)))

        def find(index: int) -> int:
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        buckets: dict[tuple[int, int], list[int]] = defaultdict(list)
        for index, booth in enumerate(eligible):
            key = (floor(booth.bbox.x / scale), floor(booth.bbox.y / scale))
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    for other in buckets.get((key[0] + dx, key[1] + dy), []):
                        if pixel_adjacent(booth.bbox, eligible[other].bbox):
                            parent[find(index)] = find(other)
            buckets[key].append(index)
        groups: dict[int, list[Booth]] = defaultdict(list)
        for index, booth in enumerate(eligible):
            groups[find(index)].append(booth)
        blocks = []
        for index, group in enumerate(sorted(groups.values(), key=lambda items: items[0].id), 1):
            left, top = min(b.bbox.x for b in group), min(b.bbox.y for b in group)
            right = max(b.bbox.x + b.bbox.width for b in group)
            bottom = max(b.bbox.y + b.bbox.height for b in group)
            outline, dividers = _edges(group)
            blocks.append(BoothBlock(
                f"p{page:03}-block-{index:04}", group, Box(left, top, right - left, bottom - top),
                outline, dividers,
            ))
        return BlockGroupingResult(page, blocks, [b for b in booths if b.status == "unrecognized"])


def validate_blocks(booths: list[Booth], result: BlockGroupingResult) -> None:
    expected = BoothBlockGrouper().group(booths, page=result.page)
    actual_booths = sorted((b for block in result.blocks for b in block.booths), key=lambda b: b.id)
    expected_booths = sorted((b for block in expected.blocks for b in block.booths), key=lambda b: b.id)
    if (result.to_dict() != expected.to_dict() or result.blocks != expected.blocks
            or actual_booths != expected_booths or result.excluded != expected.excluded):
        raise ValueError("Block grouping does not match pixel-adjacent booth geometry or source records")
