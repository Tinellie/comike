import math
from statistics import median

from booth_recognition.recognizer import Booth
from booth_blocks import BlockGroupingResult, BoothBlockGrouper, validate_blocks
from map_recognition.common import Box

from .models import ComponentLink, ContactComponent, IslandSeed


def rectangle_gap(a: Box, b: Box) -> tuple[float, float]:
    return (
        max(a.x - b.x - b.width, b.x - a.x - a.width, 0),
        max(a.y - b.y - b.height, b.y - a.y - a.height, 0),
    )


class ContactGraphBuilder:
    def build(
        self, booths: list[Booth], page: int, blocks: BlockGroupingResult | None = None,
    ) -> list[ContactComponent]:
        if blocks is None:
            blocks = BoothBlockGrouper().group(booths, page=page)
        else:
            if blocks.page != page:
                raise ValueError("Block grouping page does not match assignment page")
            validate_blocks(booths, blocks)
        if not blocks.blocks:
            return []
        width = median(b.bbox.width for block in blocks.blocks for b in block.booths)
        height = median(b.bbox.height for block in blocks.blocks for b in block.booths)
        components = []
        for block in blocks.blocks:
            box = block.bbox
            axis = "horizontal" if box.width / width >= box.height / height else "vertical"
            # A single-cell wall strip can step diagonally and have a tall bounding box.
            thin = len(block.booths) <= max(box.width / width, box.height / height) * 1.3
            components.append(ContactComponent(block.id, block.booths, box, axis, thin))
        return components


class LayoutTopology:
    def build(self, components: list[ContactComponent], scale: float) -> list[ComponentLink]:
        candidates: dict[tuple[int, int], ComponentLink] = {}
        for i, a in enumerate(components):
            directional: dict[int, tuple[float, int, str]] = {}
            for j, b in enumerate(components):
                if i == j or a.numbers & b.numbers:
                    continue
                if not any(n + 1 in b.numbers or n - 1 in b.numbers for n in a.numbers):
                    continue
                dx, dy = rectangle_gap(a.bbox, b.bbox)
                distance = math.hypot(dx, dy)
                ax, ay = a.bbox.x + a.bbox.width / 2, a.bbox.y + a.bbox.height / 2
                bx, by = b.bbox.x + b.bbox.width / 2, b.bbox.y + b.bbox.height / 2
                aligned = (
                    a.axis == b.axis == "vertical" and abs(ax - bx) <= scale * 0.6
                    or a.axis == b.axis == "horizontal" and abs(ay - by) <= scale * 0.6
                )
                turn = a.thin and b.thin and a.axis != b.axis and distance <= scale * 4
                if not (aligned or turn) or distance > scale * 14:
                    continue
                direction = (0 if bx < ax else 1) if a.axis == "horizontal" else (2 if by < ay else 3)
                if direction not in directional or distance < directional[direction][0]:
                    directional[direction] = (distance, j, "wall_turn" if turn else "aligned_aisle")
            for distance, j, kind in directional.values():
                key = (min(i, j), max(i, j))
                weight = round(300 * min(len(a.booths), len(components[j].booths)) / (1 + distance / scale))
                link = ComponentLink(key[0], key[1], max(1, weight), kind)
                if key not in candidates or link.weight > candidates[key].weight:
                    candidates[key] = link
        return sorted(candidates.values(), key=lambda link: (link.left, link.right))


def marker_cost(component: ContactComponent, seed: IslandSeed, scale: float) -> int:
    costs = []
    b = component.bbox
    for marker in seed.markers:
        m = marker.bbox
        mx, my = m.x + m.width / 2, m.y + m.height / 2
        dx = max(b.x - mx, mx - b.x - b.width, 0)
        dy = max(b.y - my, my - b.y - b.height, 0)
        along, cross = (dx, dy) if component.axis == "horizontal" else (dy, dx)
        # A marker may be in an aisle far along the same booth row/column.
        costs.append(math.hypot(cross, along * 0.15) / scale)
    wall_mismatch = 12 if seed.wraps and not component.thin else 0
    return round((min(costs) + wall_mismatch) * 100) * len(component.booths)
