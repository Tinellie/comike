import argparse
import json
import logging
import math
from pathlib import Path

from .hall_paths import build_hall_paths

LOGGER = logging.getLogger(__name__)


def _object(value: object, field: str) -> dict[str, object]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{field} must be an object")
    return {key: item for key, item in value.items()}


def _records(value: object, field: str) -> list[dict[str, object]]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be an array")
    return [_object(item, field) for item in value]


def _ids(value: object, field: str) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise ValueError(f"{field} must contain nonempty IDs")
    return [str(item) for item in value]


def _index(value: object, field: str) -> dict[str, dict[str, object]]:
    result = {}
    for record in _records(value, field):
        id = record.get("id")
        if not isinstance(id, str) or not id or id in result:
            raise ValueError(f"Missing or duplicate ID in {field}: {id}")
        result[id] = record
    return result


def _coordinates(value: object, fields: tuple[str, ...], field: str) -> dict[str, float]:
    source = _object(value, field)
    result = {}
    for key in fields:
        number = source.get(key)
        if isinstance(number, bool) or not isinstance(number, (int, float)) or not math.isfinite(number):
            raise ValueError(f"{field}.{key} must be finite")
        if key in ("width", "height") and number <= 0:
            raise ValueError(f"{field}.{key} must be positive")
        result[key] = number
    return result


def _text(value: object, field: str) -> str | None:
    if value is None:
        LOGGER.warning("Final export: %s is unknown; retaining null", field)
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(f"{field} must be nonempty text or null")
    return value


def _split(booth: dict[str, object], halves: list[dict[str, object]]) -> dict[str, str] | None:
    id = booth["id"]
    if len(halves) != 2:
        raise ValueError(f"Booth {id} must have exactly two halves")
    box = _coordinates(booth.get("bbox"), ("x", "y", "width", "height"), f"Booth {id}.bbox")
    boxes = [_coordinates(h.get("bbox"), tuple(box), f"Booth {id} half bbox") for h in halves]
    positions = None
    for axis, extent, sides in (("x", "width", ("l", "r")), ("y", "height", ("t", "b"))):
        expected = [dict(box), dict(box)]
        for half in expected:
            half[extent] /= 2
        expected[1][axis] += box[extent] / 2
        order = sorted(range(2), key=lambda index: boxes[index][axis])
        if all(
            math.isclose(boxes[index][key], target[key], rel_tol=0, abs_tol=1e-6)
            for index, target in zip(order, expected) for key in box
        ):
            positions = {index: side for index, side in zip(order, sides)}
            break
    if positions is None:
        raise ValueError(f"Booth {id} halves are not an equal left/right or top/bottom partition")
    suffixes = [half.get("suffix") for half in halves]
    if all(suffix is None for suffix in suffixes):
        LOGGER.warning("Final export: Booth %s a/b is unknown; retaining split: null", id)
        return None
    if not all(isinstance(suffix, str) and suffix in ("a", "b") for suffix in suffixes) or suffixes[0] == suffixes[1]:
        raise ValueError(f"Booth {id} must have an a/b pair or two unknown suffixes")
    return {str(half["suffix"]): positions[index] for index, half in enumerate(halves)}


def simplify_result(data: dict[str, object]) -> dict[str, object]:
    halls = []
    for page in _records(data.get("pages"), "pages"):
        if "islandAssignment" not in page or "halfBooths" not in page:
            raise ValueError("Final export requires completed Island assignment and half-booth splitting")
        booths = _index(page.get("booths"), "booths")
        rotations: set[int] = set()
        for booth in booths.values():
            rotation = booth.get("rotation")
            if isinstance(rotation, bool) or not isinstance(rotation, int) or rotation not in (0, 90, 180, 270):
                raise ValueError("Final export requires a quarter-turn OCR rotation for every Booth")
            rotations.add(rotation)
        if len(rotations) != 1:
            raise ValueError("Final export requires one shared Booth text rotation per page")
        text_rotation = rotations.pop()
        blocks = _index(page.get("blocks"), "blocks")
        markers = _index(page.get("islandMarkers"), "islandMarkers")
        islands = _index(page.get("islands"), "islands")
        halves_by_booth: dict[str, list[dict[str, object]]] = {id: [] for id in booths}
        for half in _index(page["halfBooths"], "halfBooths").values():
            parent = half.get("boothId")
            if not isinstance(parent, str) or parent not in booths:
                raise ValueError(f"Unknown half-booth parent: {parent}")
            halves_by_booth[parent].append(half)
        used_blocks: set[str] = set()
        used_booths: set[str] = set()
        used_markers: set[str] = set()

        def claim(id: str, records: dict[str, dict[str, object]], used: set[str]) -> dict[str, object]:
            if id not in records or id in used:
                raise ValueError(f"Unknown or repeated membership: {id}")
            used.add(id)
            return records[id]

        final_islands = []
        for island_id, island in islands.items():
            final_markers = []
            for id in _ids(island.get("markerIds"), "markerIds"):
                marker = claim(id, markers, used_markers)
                final_markers.append({
                    "id": id, "pos": _coordinates(marker.get("center"), ("x", "y"), f"Marker {id}.center"),
                })
            final_blocks = []
            for id in _ids(island.get("blockIds"), "blockIds"):
                block = claim(id, blocks, used_blocks)
                final_booths = []
                for booth_id in _ids(block.get("boothIds"), "boothIds"):
                    booth = claim(booth_id, booths, used_booths)
                    final_booths.append({
                        "id": booth_id, "number": _text(booth.get("number"), f"Booth {booth_id}.number"),
                        "bbox": _coordinates(booth.get("bbox"), ("x", "y", "width", "height"), "Booth bbox"),
                        "split": _split(booth, halves_by_booth[booth_id]),
                    })
                final_block: dict[str, object] = {
                    "id": id,
                    "bbox": _coordinates(block.get("bbox"), ("x", "y", "width", "height"), "Block bbox"),
                    "booths": final_booths,
                }
                if block.get("grid") is not None:
                    grid = _object(block["grid"], "grid")
                    rows, columns = grid.get("rows"), grid.get("columns")
                    if (isinstance(rows, bool) or not isinstance(rows, int) or rows < 1
                            or isinstance(columns, bool) or not isinstance(columns, int) or columns < 1):
                        raise ValueError(f"Block {id} grid dimensions must be positive integers")
                    if rows * columns != len(final_booths):
                        raise ValueError(f"Block {id} grid does not match Booth count")
                    final_block["grid"] = {"rows": rows, "columns": columns}
                final_blocks.append(final_block)
            final_islands.append({
                "id": island_id, "code": _text(island.get("label"), f"Island {island_id}.code"),
                "markers": final_markers, "blocks": final_blocks,
            })
        if used_blocks != set(blocks) or used_booths != set(booths) or used_markers != set(markers):
            raise ValueError("Final export would omit unassigned Blocks, Booths or markers")
        venue = _object(page.get("venue"), "venue")
        hall = {
            "name": _text(venue.get("label"), f"Page {page.get('page')} hall name"),
            "textRotation": text_rotation, "islands": final_islands,
        }
        if "pdfPreview" in page:
            source_page = page.get("page")
            pdf = _object(page["pdfPreview"], "pdfPreview")
            if isinstance(source_page, bool) or not isinstance(source_page, int) or source_page < 1:
                raise ValueError("PDF source page must be a positive integer")
            image = f"page-{source_page:03}-pdf.png"
            width, height = pdf.get("width"), pdf.get("height")
            if (pdf.get("image") != image
                    or any(isinstance(n, bool) or not isinstance(n, int) or n <= 0 for n in (width, height))):
                raise ValueError("PDF image or dimensions are invalid")
            transform = pdf.get("transform")
            if (not isinstance(transform, list) or len(transform) != 6
                    or any(isinstance(n, bool) or not isinstance(n, (int, float))
                           or not math.isfinite(n) for n in transform)):
                raise ValueError("PDF transform must contain six finite numbers")
            if abs(transform[0] * transform[3] - transform[1] * transform[2]) < 1e-12:
                raise ValueError("PDF transform must be invertible")
            hall["sourcePage"] = source_page
            hall["pdfPreview"] = {"image": image, "width": width, "height": height, "transform": list(transform)}
        if "hallLabels" in page:
            hall["labels"] = [
                {
                    "id": label["id"], "text": _text(label.get("text"), "Hall label text"),
                    "code": _text(label.get("code"), "Hall label code"),
                    "pos": _coordinates(label.get("center"), ("x", "y"), "Hall label position"),
                }
                for label in _index(page["hallLabels"], "hallLabels").values()
            ]
        if "hallOutline" in page:
            outline = _object(page["hallOutline"], "hallOutline")
            polygon = _records(outline.get("polygon"), "hallOutline.polygon")
            if len(polygon) < 3:
                raise ValueError("Hall outline must have at least three vertices")
            hall["boundary"] = [_coordinates(point, ("x", "y"), "Hall boundary") for point in polygon]
        halls.append(hall)
    return {"halls": halls}


def save_final_result(source: str | Path) -> Path:
    source = Path(source)
    target = source.with_name("final.json")
    if source.resolve() == target.resolve():
        raise ValueError("Final export source must not be final.json")
    data = simplify_result(_object(json.loads(source.read_text(encoding="utf-8")), "result"))
    halls = _records(data["halls"], "halls")
    for hall in halls:
        if "pdfPreview" not in hall or "boundary" not in hall:
            continue
        pdf = _object(hall["pdfPreview"], "PDF preview")
        source_page = hall["sourcePage"]
        width, height, transform = pdf["width"], pdf["height"], pdf["transform"]
        assert isinstance(source_page, int) and isinstance(width, int) and isinstance(height, int)
        assert isinstance(transform, list)
        paths = source.with_name(f"page-{source_page:03}-paths.json")
        if not paths.exists():
            LOGGER.warning("Hall path graph not exported: %s is missing", paths)
            continue
        graph = _object(json.loads(paths.read_text(encoding="utf-8")), "path graph")
        if (graph.get("width"), graph.get("height")) != (width, height):
            raise ValueError(f"{paths.name} dimensions must match the PDF preview")
        segments = []
        raw_segments = graph.get("segments")
        if not isinstance(raw_segments, list):
            raise ValueError(f"{paths.name} must contain a segments array")
        for segment in raw_segments:
            if (not isinstance(segment, list) or len(segment) != 4
                    or any(type(n) is not int for n in segment)):
                raise ValueError(f"{paths.name} contains an invalid segment")
            x, y, u, v = segment
            if not (0 <= x < width and 0 <= u < width and 0 <= y < height and 0 <= v < height
                    and (x == u) != (y == v)):
                raise ValueError(f"{paths.name} contains a non-orthogonal, empty or out-of-bounds segment")
            segments.append((x, y, u, v))
        boundary = [_coordinates(p, ("x", "y"), "Hall boundary") for p in _records(hall["boundary"], "boundary")]
        hall["pathGraph"] = build_hall_paths(segments, [(p["x"], p["y"]) for p in boundary],
                                             transform, (width, height))
    data["halls"] = halls
    pending = target.with_suffix(".json.tmp")
    pending.write_text(json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    pending.replace(target)
    return target


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export nested final.json from an existing result.json without rerunning OCR.")
    parser.add_argument("result", type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        print(save_final_result(args.result).resolve())
    except (ValueError, OSError) as error:
        LOGGER.error("Final export failed: %s", error)
        raise SystemExit(1) from error
