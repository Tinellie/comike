import logging
from dataclasses import dataclass
from typing import Sequence

import cv2
import numpy as np
from PIL import Image

from .common import Box, opaque_rgb

LOGGER = logging.getLogger(__name__)


def _cross(a: np.ndarray, b: np.ndarray) -> float:
    return float(a[0] * b[1] - a[1] * b[0])


def _long_line_outline(
    contour: np.ndarray, booths: Sequence[Box], shape: tuple[int, int],
) -> np.ndarray:
    # Remove raster stair steps before measuring the 120-pixel support segments.
    points = cv2.approxPolyDP(contour, 2, True).reshape(-1, 2)
    lines = [
        np.array([a, b], dtype=float)
        for a, b in zip(points, np.roll(points, -1, axis=0))
        if np.linalg.norm(b - a) >= 120
    ]
    changed = True
    while changed and len(lines) > 3:
        changed = False
        for i, first in enumerate(lines):
            for step in range(1, len(lines) - 1):
                j = (i + step) % len(lines)
                second = lines[j]
                u, v = first[1] - first[0], second[1] - second[0]
                length_u, length_v = float(np.linalg.norm(u)), float(np.linalg.norm(v))
                if np.dot(u, v) / (length_u * length_v) < np.cos(np.deg2rad(3)):
                    continue
                if np.linalg.norm(second[0] - first[1]) >= min(length_u, length_v):
                    continue
                anchor = first if length_u >= length_v else second
                direction = (anchor[1] - anchor[0]) / max(length_u, length_v)
                endpoints = np.concatenate((first, second))
                tolerance = max(3.0, min(12.0, min(length_u, length_v) * 0.01))
                if any(abs(_cross(direction, p - anchor[0])) > tolerance for p in endpoints):
                    continue
                projections = (endpoints - anchor[0]) @ direction
                merged = anchor[0] + np.array([projections.min(), projections.max()])[:, None] * direction
                remaining = [lines[(j + k) % len(lines)] for k in range(1, len(lines) - step)]
                if len(remaining) < 2:
                    continue
                lines = [merged, *remaining]
                changed = True
                break
            if changed:
                break

    vertices = []
    if len(lines) >= 3:
        for previous, current in zip(lines[-1:] + lines[:-1], lines):
            u, v = previous[1] - previous[0], current[1] - current[0]
            determinant = _cross(u, v)
            if abs(determinant) < 1e-6 * np.linalg.norm(u) * np.linalg.norm(v):
                break
            t = _cross(current[0] - previous[0], v) / determinant
            vertices.append(previous[0] + t * u)
        else:
            polygon = np.rint(vertices).astype(np.int32).reshape(-1, 1, 2)
            height, width = shape
            if (np.all(polygon >= 0) and np.all(polygon[:, 0, 0] < width)
                    and np.all(polygon[:, 0, 1] < height)
                    and cv2.contourArea(polygon) > 0 and _simple_polygon(polygon)):
                interior = np.zeros(shape, np.uint8)
                cv2.fillPoly(interior, [polygon], 1)
                if all(interior[b.y:b.y + b.height, b.x:b.x + b.width].all() for b in booths):
                    return polygon
    LOGGER.warning("Hall outline: long-line reconstruction unsafe or insufficient; retaining source contour")
    return cv2.approxPolyDP(contour, 0, True)


def _simple_polygon(polygon: np.ndarray) -> bool:
    points = polygon.reshape(-1, 2)
    for i, (a, b) in enumerate(zip(points, np.roll(points, -1, axis=0))):
        if np.array_equal(a, b):
            return False
        for j in range(i + 2, len(points)):
            if i == 0 and j == len(points) - 1:
                continue
            c, d = points[j], points[(j + 1) % len(points)]
            if (np.all(np.maximum(np.minimum(a, b), np.minimum(c, d))
                       <= np.minimum(np.maximum(a, b), np.maximum(c, d)))
                    and _cross(b - a, c - a) * _cross(b - a, d - a) <= 0
                    and _cross(d - c, a - c) * _cross(d - c, b - c) <= 0):
                return False
    return True


@dataclass(frozen=True)
class HallOutline:
    method: str
    polygon: tuple[tuple[int, int], ...]
    bbox: Box

    def to_dict(self) -> dict[str, object]:
        return {
            "method": self.method,
            "polygon": [{"x": x, "y": y} for x, y in self.polygon],
            "bbox": self.bbox.to_dict(),
        }


def detect_hall_outline(
    image: Image.Image, booths: Sequence[Box], *, venue_label: str | None = None,
) -> HallOutline:
    rgb = np.asarray(opaque_rgb(image))
    height, width = rgb.shape[:2]
    for box in booths:
        if (box.width <= 0 or box.height <= 0 or box.x < 0 or box.y < 0
                or box.x + box.width > width or box.y + box.height > height):
            raise ValueError("Hall outline Booth bbox is outside the source image")
    nonwhite = np.any(rgb != 255, axis=2)
    if not nonwhite.any():
        raise ValueError("Cannot determine a Hall boundary from an entirely white image")

    # Do not close/dilate: a gap in the original frame must remain a gap.
    neutral = (rgb.max(axis=2).astype(int) - rgb.min(axis=2).astype(int) <= 20) & (rgb.min(axis=2) < 210)
    contours, hierarchy = cv2.findContours(
        neutral.astype(np.uint8) * 255, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE,
    )
    candidates = {}
    if booths and hierarchy is not None:
        min_x = min(b.x for b in booths)
        min_y = min(b.y for b in booths)
        max_x = max(b.x + b.width - 1 for b in booths)
        max_y = max(b.y + b.height - 1 for b in booths)
        footprint = max(1, (max_x - min_x) * (max_y - min_y))
        minimum_enclosure = max(footprint * 0.25, max(b.width * b.height for b in booths))
        corners = [
            (x, y) for b in booths
            for x, y in ((b.x, b.y), (b.x + b.width - 1, b.y),
                         (b.x + b.width - 1, b.y + b.height - 1), (b.x, b.y + b.height - 1))
        ]
        for index, hole in enumerate(contours):
            parent = int(hierarchy[0, index, 3])
            if parent < 0 or cv2.contourArea(hole) <= minimum_enclosure:
                continue
            depth = 0
            ancestor = index
            while hierarchy[0, ancestor, 3] >= 0:
                depth += 1
                ancestor = int(hierarchy[0, ancestor, 3])
            if depth % 2 != 1 or parent in candidates:
                continue
            contour = contours[parent]
            if all(cv2.pointPolygonTest(contour, point, False) >= 0 for point in corners):
                interior = np.zeros((height, width), dtype=np.uint8)
                cv2.drawContours(interior, [contour], -1, 1, cv2.FILLED)
                if all(interior[b.y:b.y + b.height, b.x:b.x + b.width].all() for b in booths):
                    candidates[parent] = contour
    if candidates:
        contour = max(candidates.values(), key=cv2.contourArea)
        points = _long_line_outline(contour, booths, (height, width))
        polygon = tuple((int(x), int(y)) for x, y in points.reshape(-1, 2))
        x, y, w, h = cv2.boundingRect(points)
        LOGGER.info("Hall outline: closed source frame, %d vertices", len(polygon))
        return HallOutline("closed_frame", polygon, Box(x, y, w, h))

    ys, xs = np.nonzero(nonwhite)
    x, y, right, bottom = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    bbox = Box(x, y, right - x + 1, bottom - y + 1)
    if venue_label == "\u897f12" and image.size == (2680, 2520) and bbox == Box(0, 0, 2680, 2520):
        # The West 1–2 PDF crop has no closed frame around its open central recess.
        inner, top, lower = 984, 762, 1757
        if booths and all(b.x + b.width - 1 <= inner or b.y + b.height - 1 <= top or b.y >= lower for b in booths):
            LOGGER.info("Hall outline: West 1-2 layout recess")
            return HallOutline("layout_notch", (
                (x, y), (right, y), (right, top), (inner, top),
                (inner, lower), (right, lower), (right, bottom), (x, bottom),
            ), bbox)
        LOGGER.warning("Hall outline: West 1-2 layout recess could not be verified against Booths")
    LOGGER.info("Hall outline: no enclosing closed frame; using all nonwhite pixel bounds")
    return HallOutline(
        "nonwhite_bbox", ((x, y), (right, y), (right, bottom), (x, bottom)),
        bbox,
    )