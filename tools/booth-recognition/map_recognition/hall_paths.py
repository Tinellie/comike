import cv2
import numpy as np

Point = tuple[float, float]
Line = tuple[Point, Point]
PATH_CELL_SIZE = 4
EPSILON = 1e-8


def _subtract(a: Point, b: Point) -> Point:
    return a[0] - b[0], a[1] - b[1]


def _cross(a: Point, b: Point) -> float:
    return a[0] * b[1] - a[1] * b[0]


def _parameter(line: Line, p: Point) -> float:
    a, b = line
    dx, dy = _subtract(b, a)
    return (p[0] - a[0]) / dx if abs(dx) >= abs(dy) else (p[1] - a[1]) / dy


def _intersections(first: Line, second: Line) -> list[Point]:
    a, b = first
    c, d = second
    ab, cd, ac = _subtract(b, a), _subtract(d, c), _subtract(c, a)
    det = _cross(ab, cd)
    if abs(det) < EPSILON:
        if abs(_cross(ac, ab)) >= EPSILON:
            return []
        return [p for line, ends in ((first, second), (second, first))
                for p in ends if -EPSILON <= _parameter(line, p) <= 1 + EPSILON]
    t, u = _cross(ac, cd) / det, _cross(ac, ab) / det
    if -EPSILON <= t <= 1 + EPSILON and -EPSILON <= u <= 1 + EPSILON:
        if abs(t) < EPSILON:
            return [a]
        if abs(t - 1) < EPSILON:
            return [b]
        if abs(u) < EPSILON:
            return [c]
        if abs(u - 1) < EPSILON:
            return [d]
        return [(a[0] + t * ab[0], a[1] + t * ab[1])]
    return []


def build_hall_paths(
    segments: list[tuple[int, int, int, int]], boundary: list[Point],
    transform: list[float], size: tuple[int, int],
) -> dict[str, object]:
    a, b, c, d, e, f = transform
    det = a * d - b * c
    outline = [(a * x + c * y + e, b * x + d * y + f) for x, y in boundary]
    perimeter = [(p, q) for p, q in zip(outline, outline[1:] + outline[:1]) if p != q]
    indoor: list[Line] = [((x, y), (u, v)) for x, y, u, v in segments]

    width, height = size
    cell = PATH_CELL_SIZE
    venue = np.zeros((height, width), np.uint8)
    cv2.fillPoly(venue, [np.array([(round(x), round(y)) for x, y in outline], np.int32)], 1)
    links: list[Line] = []
    for line in indoor:
        for start, end in (line, line[::-1]):
            dx, dy = _subtract(end, start)
            length = abs(dx) + abs(dy)
            dx, dy = dx / length, dy / length
            x = (int(end[0]) // cell + int(dx)) * cell
            y = (int(end[1]) // cell + int(dy)) * cell
            if 0 <= x <= width - cell and 0 <= y <= height - cell and venue[y:y + cell, x:x + cell].all():
                continue
            # The last full walkable tile ends short of the outline. Bridge only this grid inset.
            ray = (end, (end[0] + 2 * cell * dx, end[1] + 2 * cell * dy))
            hits = [p for side in perimeter for p in _intersections(ray, side)]
            if hits:
                nearest = min(hits, key=lambda p: _parameter(ray, p))
                if nearest != end:
                    links.append((end, nearest))

    lines = indoor + links + perimeter
    cuts = [set(line) for line in lines]
    for i, line in enumerate(lines):
        for j in range(i):
            hits = _intersections(line, lines[j])
            cuts[i].update(hits)
            cuts[j].update(hits)

    def hall_point(p: Point) -> Point:
        x, y = p[0] - e, p[1] - f
        return round((d * x - c * y) / det, 8), round((a * y - b * x) / det, 8)

    ids: dict[Point, int] = {}
    edges: dict[tuple[int, int], str] = {}
    for i, (line, points) in enumerate(zip(lines, cuts)):
        nodes = [hall_point(p) for p in sorted(points, key=lambda p: _parameter(line, p))]
        for p, q in zip(nodes, nodes[1:]):
            if p != q:
                start = ids.setdefault(p, len(ids))
                end = ids.setdefault(q, len(ids))
                edges[min(start, end), max(start, end)] = "perimeter" if i >= len(indoor) + len(links) else "indoor"
    return {
        "nodes": [{"x": x, "y": y} for x, y in ids],
        "edges": [{"from": start, "to": end, "kind": kind} for (start, end), kind in sorted(edges.items())],
    }
