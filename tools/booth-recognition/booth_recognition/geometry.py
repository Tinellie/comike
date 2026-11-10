from collections import Counter
from dataclasses import dataclass
from typing import Literal

import cv2
import numpy as np
from numpy.typing import NDArray

ImageArray = NDArray[np.uint8]
Side = Literal["left", "right", "top", "bottom"]


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    width: int
    height: int

    def to_dict(self) -> dict[str, int]:
        return {
            "x": self.x, "y": self.y,
            "width": self.width, "height": self.height,
        }


@dataclass(frozen=True)
class Cell:
    box: Box
    repaired: bool = False
    missing_border: Side | None = None
    truncated: bool = False


def _rectangles(mask: ImageArray, max_side: int) -> list[Box]:
    contours, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if not (10 <= w <= max_side and 10 <= h <= max_side and 0.45 <= w / h <= 2.2):
            continue
        if cv2.contourArea(contour) / (w * h) < 0.80:
            continue
        polygon = cv2.approxPolyDP(contour, 0.025 * cv2.arcLength(contour, True), True)
        if len(polygon) == 4 and cv2.isContourConvex(polygon):
            boxes.append(Box(x, y, w, h))
    return boxes


def _open_cells(
    mask: ImageArray,
    horizontal: ImageArray,
    vertical: ImageArray,
    existing: list[Cell],
    width: int,
    height: int,
    tolerance: int,
) -> list[Cell]:
    image_height, image_width = mask.shape
    occupied = np.zeros(mask.shape, dtype=np.uint8)
    for cell in existing:
        b = cell.box
        occupied[b.y:b.y + b.height, b.x:b.x + b.width] = 1

    candidates: set[tuple[int, int]] = set()
    for lines, sideways in ((horizontal, False), (vertical, True)):
        contours, _ = cv2.findContours(lines, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if sideways:
                if h < height - tolerance or w > tolerance * 2 + 1:
                    continue
                cx = x + (w - 1) // 2
                for left in (cx, cx - width + 1):
                    for top in (y, y + h - height):
                        candidates.add((left, top))
            else:
                if w < width - tolerance or h > tolerance * 2 + 1:
                    continue
                cy = y + (h - 1) // 2
                for left in (x, x + w - width):
                    for top in (cy, cy - height + 1):
                        candidates.add((left, top))

    def coverage(
        lines: ImageArray, coordinate: int, start: int, end: int,
        sideways: bool, radius: int = 1,
    ) -> float:
        # Ignore intersections and allow small antialiasing/line-center offsets.
        limit = lines.shape[1] if sideways else lines.shape[0]
        if not 0 <= coordinate < limit:
            return 0.0
        lo, hi = max(0, coordinate - radius), min(limit, coordinate + radius + 1)
        length = lines.shape[0] if sideways else lines.shape[1]
        start, end = max(0, start + 3), min(length, end - 2)
        if end <= start:
            return 0.0
        strip = lines[start:end, lo:hi] if sideways else lines[lo:hi, start:end]
        return float(np.mean(np.any(strip > 0, axis=1 if sideways else 0)))

    recovered = []
    offsets = sorted(range(-tolerance, tolerance + 1), key=abs)
    for x, y in sorted(candidates, key=lambda p: (p[1], p[0])):
        # Morphological filtering can shift segment endpoints by a few pixels.
        x = max(
            (x + offset for offset in offsets),
            key=lambda left: (
                coverage(vertical, left, y, y + height - 1, True, 0)
                + coverage(vertical, left + width - 1, y, y + height - 1, True, 0)
            ),
        )
        y = max(
            (y + offset for offset in offsets),
            key=lambda top: (
                coverage(horizontal, top, x, x + width - 1, False, 0)
                + coverage(horizontal, top + height - 1, x, x + width - 1, False, 0)
            ),
        )
        right, bottom = x + width - 1, y + height - 1
        if x < -tolerance or y < -tolerance or right >= image_width + tolerance or bottom >= image_height + tolerance:
            continue
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(image_width, right + 1), min(image_height, bottom + 1)
        if np.mean(occupied[y0:y1, x0:x1]) > 0.25:
            continue
        scores: dict[Side, float] = {
            "left": coverage(vertical, x, y0, y1 - 1, True),
            "right": coverage(vertical, right, y0, y1 - 1, True),
            "top": coverage(horizontal, y, x0, x1 - 1, False),
            "bottom": coverage(horizontal, bottom, x0, x1 - 1, False),
        }
        missing = [side for side, score in scores.items() if score < 0.30]
        if len(missing) != 1 or any(score < 0.80 for side, score in scores.items() if side != missing[0]):
            continue
        # Require actual ink inside the cell; never extend a grid into blank space.
        interior = mask[y0 + 3:y1 - 3, x0 + 3:x1 - 3]
        ink = np.count_nonzero(interior)
        if ink < 4 or ink > interior.size * 0.50:
            continue
        character_mask = np.ascontiguousarray(np.rot90(interior)) if width > height else interior
        _, _, components, _ = cv2.connectedComponentsWithStats(character_mask)
        text_ink = sum(
            area for left, top, w, h, area in components[1:]
            if left > 0 and top > 0
            and left + w < character_mask.shape[1] and top + h < character_mask.shape[0]
            and h >= max(3, round(character_mask.shape[0] * 0.18)) and area >= 3
        )
        if text_ink < 4:
            continue
        near_edge = min(x0, y0, image_width - x1, image_height - y1) <= max(width, height)
        aligned_neighbor = any(
            (abs(c.box.y - y) <= tolerance and abs(c.box.x - x) <= 4 * width)
            or (abs(c.box.x - x) <= tolerance and abs(c.box.y - y) <= 4 * height)
            for c in existing if c.missing_border is None
        )
        if not near_edge and not aligned_neighbor:
            continue
        truncated = x != x0 or y != y0 or right + 1 != x1 or bottom + 1 != y1
        recovered.append(Cell(Box(x0, y0, x1 - x0, y1 - y0), True, missing[0], truncated))
        occupied[y0:y1, x0:x1] = 1
    return recovered


def detect_cells(rgb: ImageArray) -> list[Cell]:
    """Find repeated, axis-aligned cells. Coordinates include their border."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    max_side = max(64, min(200, int(min(gray.shape) * 0.12)))
    masks = [
        cv2.threshold(gray, threshold, 255, cv2.THRESH_BINARY_INV)[1]
        for threshold in (90, 160, 210)
    ]
    raw = [box for mask in masks for box in _rectangles(mask, max_side)]
    if not raw:
        return []

    width, height = Counter((b.width, b.height) for b in raw).most_common(1)[0][0]
    tolerance = max(2, round(min(width, height) * 0.10))

    def standard(box: Box) -> bool:
        return abs(box.width - width) <= tolerance and abs(box.height - height) <= tolerance

    # Keep one representative for nested contours and threshold variants.
    cells: list[Cell] = []
    buckets: dict[tuple[int, int], list[Cell]] = {}
    bucket_size = max(width, height)

    def add(box: Box, repaired: bool) -> None:
        if not standard(box):
            return
        cx, cy = box.x + box.width / 2, box.y + box.height / 2
        bx, by = int(cx // bucket_size), int(cy // bucket_size)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for existing in buckets.get((bx + dx, by + dy), []):
                    other = existing.box
                    if (abs(cx - other.x - other.width / 2) <= tolerance
                            and abs(cy - other.y - other.height / 2) <= tolerance):
                        return
        cell = Cell(box, repaired)
        buckets.setdefault((bx, by), []).append(cell)
        cells.append(cell)

    for box in sorted(raw, key=lambda b: abs(b.width - width) + abs(b.height - height)):
        add(box, False)

    # Remove characters, reconnect short gaps, then recover enclosed grid faces.
    line_masks = []
    for mask in masks:
        horizontal_input = cv2.morphologyEx(
            mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 1)),
        )
        vertical_input = cv2.morphologyEx(
            mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 3)),
        )
        horizontal = cv2.morphologyEx(
            horizontal_input, cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (max(8, width // 2), 1)),
        )
        vertical = cv2.morphologyEx(
            vertical_input, cv2.MORPH_OPEN,
            cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(8, height // 2))),
        )
        lines = cv2.morphologyEx(
            cv2.bitwise_or(horizontal, vertical), cv2.MORPH_CLOSE,
            cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)),
        )
        for box in _rectangles(lines, max_side):
            add(box, True)
        line_masks.append((horizontal, vertical))

    # Full missing sides cannot be closed by a small morphology kernel.
    # Infer only three-sided cells supported by real lines and interior ink.
    for horizontal, vertical in line_masks:
        cells.extend(_open_cells(masks[0], horizontal, vertical, cells, width, height, tolerance))

    return sorted(cells, key=lambda cell: (cell.box.y, cell.box.x))
