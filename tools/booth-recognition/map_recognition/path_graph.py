"""Build an orthogonal graph in the rendered PDF's pixel coordinates."""

import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

Point = tuple[int, int]
Segment = tuple[int, int, int, int]
SMALL_GRAY_AREA_THRESHOLD = 1000
BLACK_INK_MAX = 32


def walkable_pixels(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"))
    high, low = rgb.max(axis=2), rgb.min(axis=2)
    chroma = high - low
    colored = (chroma >= 8) & (chroma >= high * 0.06)
    # Clear tinted antialiasing near colored ink, without erasing neutral walls.
    near_ink = cv2.dilate(colored.astype(np.uint8), np.ones((5, 5), np.uint8)) != 0
    white = (low >= 250) | (near_ink & (chroma > 0))
    borderline = ~white & (high >= 250)
    r, g, b = rgb[borderline].T
    white[borderline] = 0.2126 * r + 0.7152 * g + 0.0722 * b >= 249.5
    _, labels, stats, _ = cv2.connectedComponentsWithStats((~white).astype(np.uint8), connectivity=8)
    small_gray = stats[:, cv2.CC_STAT_AREA] < SMALL_GRAY_AREA_THRESHOLD
    small_gray[0] = False
    small_gray[labels[high <= BLACK_INK_MAX]] = False
    return white | small_gray[labels]


def _runs(row: np.ndarray) -> list[tuple[int, int]]:
    boundaries = np.flatnonzero(np.diff(np.r_[False, row, False]))
    return list(zip(boundaries[::2].tolist(), boundaries[1::2].tolist()))


def _sweep(mask: np.ndarray, tips: np.ndarray) -> list[Segment]:
    # Each vertical run is contractible. Neighboring runs overlap in one interval;
    # one bridge per pair retains all the connections and holes of the tiled area.
    labels = np.zeros(mask.shape, np.int32)
    run_count = 0
    for x, column in enumerate(mask.T):
        for top, bottom in _runs(column):
            run_count += 1
            labels[top:bottom, x] = run_count

    bridges = np.zeros(mask.shape, bool)
    used: set[tuple[int, int]] = set()
    clearance = cv2.distanceTransform(np.pad(mask.astype(np.uint8), 1), cv2.DIST_L1, 3)[1:-1, 1:-1]
    candidates = []
    for y, row in enumerate(mask):
        for left, right in _runs(row):
            if right - left > 1:
                depth = float(clearance[y, left:right].mean())
                candidates.append((left, right, y, depth))
    for left, right, y, _ in sorted(candidates, key=lambda span: (span[0] - span[1], -span[3], span[2], span[0])):
        for x in range(left, right - 1):
            pair = (int(labels[y, x]), int(labels[y, x + 1]))
            if pair not in used:
                used.add(pair)
                bridges[y, x] = True

    segments: list[Segment] = []
    for y, row in enumerate(bridges):
        segments.extend((left, y, right, y) for left, right in _runs(row))
    contacts = bridges.copy()
    contacts[:, 1:] |= bridges[:, :-1]
    if contacts.any():
        # A long dead end can sit entirely inside a run shared with a through aisle.
        # Preserve its reach without following the skeleton between junctions.
        distance = cv2.distanceTransform((~contacts).astype(np.uint8), cv2.DIST_L1, 3)
        contacts |= tips & (distance > np.maximum(3, 2 * clearance))
    for x, column in enumerate(mask.T):
        for top, bottom in _runs(column):
            ends = np.flatnonzero(contacts[top:bottom, x])
            if len(ends) >= 2:
                segments.append((x, top + int(ends[0]), x, top + int(ends[-1])))
    if not segments:
        # A purely vertical aisle has no horizontal bridges.
        ys, xs = np.nonzero(mask)
        if len(ys) > 1:
            segments.append((int(xs[0]), int(ys[0]), int(xs[-1]), int(ys[-1])))
    return segments


def _transpose(segment: Segment) -> Segment:
    x, y, u, v = segment
    return y, x, v, u


def _points(segment: Segment) -> set[Point]:
    x, y, u, v = segment
    return {(col, row) for col in range(x, u + 1) for row in range(y, v + 1)}


def _merge_collinear(segments: list[Segment]) -> list[Segment]:
    groups: dict[tuple[bool, int], list[tuple[int, int]]] = {}
    for x, y, u, v in segments:
        key, interval = ((True, y), (x, u)) if y == v else ((False, x), (y, v))
        groups.setdefault(key, []).append(interval)
    merged = []
    for (horizontal, fixed), intervals in groups.items():
        spans: list[tuple[int, int]] = []
        for start, stop in sorted(intervals):
            if spans and start <= spans[-1][1]:
                spans[-1] = (spans[-1][0], max(stop, spans[-1][1]))
            else:
                spans.append((start, stop))
        merged.extend((start, fixed, stop, fixed) if horizontal else (fixed, start, fixed, stop)
                      for start, stop in spans)
    return merged


def _length(segments: list[Segment]) -> int:
    return sum(u - x + v - y for x, y, u, v in segments)


def _straighten_once(mask: np.ndarray, segments: list[Segment]) -> list[Segment] | None:
    horizontal = [line for line in segments if line[1] == line[3]]
    for connector in segments:
        x, start, u, end = connector
        if x != u:
            continue
        crossing = sorted((s for s in horizontal if s[0] <= x <= s[2] and start <= s[1] <= end),
                          key=lambda s: s[1])
        for first, last in zip(crossing, crossing[1:]):
            left, top, right, _ = first
            other_left, bottom, other_right, _ = last
            span_left, span_right = min(left, other_left), max(right, other_right)
            if top == bottom:
                continue
            rows = [
                row for row in range(top, bottom + 1)
                if mask[top:row + 1, left:right + 1].all()
                and mask[row:bottom + 1, other_left:other_right + 1].all()
            ]
            if not rows:
                continue

            remaining = [s for s in segments if s not in (first, last, connector)]
            if start < top:
                remaining.append((x, start, x, top))
            if bottom < end:
                remaining.append((x, bottom, x, end))
            occupied = set().union(*(
                _points((max(span_left, l), max(top, t), min(span_right, r), min(bottom, b)))
                for l, t, r, b in remaining
                if l <= span_right and r >= span_left and t <= bottom and b >= top
            ))
            removed = _points(first) | _points(last) | _points((x, top, x, bottom))
            contacts = occupied & removed
            best = None
            for row in rows:
                replacement = [(span_left, row, span_right, row)] + [
                    (col, min(y, row), col, max(y, row)) for col, y in sorted(contacts) if y != row
                ]
                # The replacement tree must meet the untouched graph at exactly the old junctions.
                if occupied.intersection(set().union(*map(_points, replacement))) != contacts:
                    continue
                candidate = _merge_collinear(remaining + replacement)
                if len(candidate) <= len(segments) and _length(candidate) < _length(segments):
                    if best is None or (len(candidate), _length(candidate)) < (len(best), _length(best)):
                        best = candidate
            if best is not None:
                return best
    return None


def _straighten_paths(mask: np.ndarray, segments: list[Segment]) -> list[Segment]:
    while True:
        horizontal = _straighten_once(mask, segments)
        if horizontal is not None:
            segments = horizontal
            continue
        vertical = _straighten_once(mask.T, [_transpose(segment) for segment in segments])
        if vertical is None:
            return segments
        segments = [_transpose(segment) for segment in vertical]


def _extend_open_ends(
    mask: np.ndarray, segments: list[Segment], *, venue: np.ndarray | None = None,
) -> list[Segment]:
    segments = _merge_collinear(segments)
    coverage = np.zeros(mask.shape, bool)
    for x, y, u, v in segments:
        coverage[y:v + 1, x:u + 1] = True

    height, width = mask.shape
    extensions: list[Segment] = []
    for x, y, u, v in sorted(segments):
        dx, dy = int(x != u), int(y != v)
        for start_x, start_y, step in ((x, y, -1), (u, v, 1)):
            end_x, end_y = start_x, start_y
            while True:
                col, row = end_x + step * dx, end_y + step * dy
                if not (0 <= col < width and 0 <= row < height) or (venue is not None and not venue[row, col]):
                    break
                if not mask[row, col]:
                    # A blocked interior tile is not a valid target; discard the ray.
                    end_x, end_y = start_x, start_y
                    break
                end_x, end_y = col, row
                if coverage[row, col]:
                    break
            if (end_x, end_y) != (start_x, start_y):
                extension = ((end_x, end_y, start_x, start_y) if step < 0
                             else (start_x, start_y, end_x, end_y))
                l, t, r, b = extension
                coverage[t:b + 1, l:r + 1] = True
                extensions.append(extension)
    return _merge_collinear(segments + extensions)


def build_path_graph(image: Image.Image, boundary: list[Point] | None = None, *, cell: int = 4) -> list[Segment]:
    if cell < 1:
        raise ValueError("Path graph cell size must be positive")
    allowed = walkable_pixels(image)
    height, width = (size // cell * cell for size in allowed.shape)
    if not height or not width:
        return []

    def full_tiles(pixels: np.ndarray) -> np.ndarray:
        return pixels[:height, :width].reshape(height // cell, cell, width // cell, cell).all(axis=(1, 3))

    # Keep the outline separate so internal obstacles cannot count as hall edges.
    grid = full_tiles(allowed)
    venue = None
    if boundary is not None:
        inside = np.zeros(allowed.shape, np.uint8)
        cv2.fillPoly(inside, [np.asarray(boundary, np.int32)], 1)
        venue = full_tiles(inside)
        grid &= venue
    count, labels, stats, _ = cv2.connectedComponentsWithStats(grid.astype(np.uint8), connectivity=4)
    if count <= 1:
        return []
    main = labels == (1 + int(stats[1:, cv2.CC_STAT_AREA].argmax()))
    skeleton = cv2.ximgproc.thinning(np.pad(main.astype(np.uint8) * 255, 1))[1:-1, 1:-1] > 0
    counts = cv2.filter2D(skeleton.astype(np.uint8), -1, np.ones((3, 3), np.uint8), borderType=cv2.BORDER_CONSTANT)
    tips = skeleton & (counts == 2)
    horizontal = _sweep(main, tips)
    vertical = [_transpose(segment) for segment in _sweep(main.T, tips.T)]
    best = min((horizontal, vertical), key=lambda path: (
        len(path), -sum(abs(x2 - x1) + abs(y2 - y1) for x1, y1, x2, y2 in path),
    ))
    best = _extend_open_ends(main, _straighten_paths(main, best), venue=venue)
    offset = cell // 2
    return [(x1 * cell + offset, y1 * cell + offset, x2 * cell + offset, y2 * cell + offset)
            for x1, y1, x2, y2 in best]


def save_path_graphs(result: Path) -> list[Path]:
    targets = []
    for page in json.loads(result.read_text(encoding="utf-8"))["pages"]:
        preview = page.get("pdfPreview")
        if not preview:
            continue
        polygon = page.get("hallOutline", {}).get("polygon")
        a, b, c, d, e, f = preview["transform"]
        if not polygon:
            polygon = [{"x": x, "y": y} for x, y in (
                (0, 0), (page["width"], 0), (page["width"], page["height"]), (0, page["height"]),
            )]
        boundary = [(round(a * p["x"] + c * p["y"] + e), round(b * p["x"] + d * p["y"] + f)) for p in polygon]
        with Image.open(result.with_name(preview["image"])) as image:
            segments = build_path_graph(image, boundary)
            graph = {"width": image.width, "height": image.height, "segments": segments}
        target = result.with_name(f"page-{page['page']:03}-paths.json")
        pending = target.with_suffix(".tmp")
        pending.write_text(json.dumps(graph, separators=(",", ":")), encoding="utf-8")
        pending.replace(target)
        targets.append(target)
    return targets


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate walkable path graphs from existing PDF preview images.")
    parser.add_argument("result", type=Path)
    for generated in save_path_graphs(parser.parse_args().result):
        print(generated)