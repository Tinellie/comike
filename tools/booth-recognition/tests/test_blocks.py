import copy
import unittest
from dataclasses import replace

from booth_blocks import BoothBlockGrouper, pixel_adjacent, validate_blocks
from island_assignment import BoothIslandAssigner
from map_recognition.common import Box
from test_assignment import booth, marker


class BlockTests(unittest.TestCase):
    def setUp(self) -> None:
        self.grouper = BoothBlockGrouper()

    def test_pixel_contact_excludes_even_a_one_pixel_blank_gap_and_corner(self) -> None:
        a = Box(0, 0, 20, 30)
        for x in (19, 20):
            self.assertTrue(pixel_adjacent(a, Box(x, 0, 20, 30)))
        for x in (21, 22, 40):
            self.assertFalse(pixel_adjacent(a, Box(x, 0, 20, 30)))
        self.assertFalse(pixel_adjacent(a, Box(19, 29, 20, 30)))
        self.assertFalse(pixel_adjacent(a, Box(20, 30, 20, 30)))
        self.assertTrue(pixel_adjacent(a, Box(19, 20, 20, 30)))

    def test_matrix_has_one_outer_rectangle_and_two_shared_dividers(self) -> None:
        booths = [
            booth("a", 1, 0, 0), booth("b", 2, 19, 0),
            booth("c", 3, 0, 29), booth("d", 4, 19, 29),
        ]
        original = copy.deepcopy(booths)
        result = self.grouper.group(booths, page=2)
        self.assertEqual(len(result.blocks), 1)
        block = result.blocks[0]
        self.assertEqual(block.id, "p002-block-0001")
        self.assertEqual(block.bbox, Box(0, 0, 39, 59))
        self.assertEqual(len(block.outline), 4)
        self.assertEqual(len(block.dividers), 2)
        self.assertEqual(sum(abs(e.x2-e.x1)+abs(e.y2-e.y1) for e in block.outline), 192)
        self.assertEqual(booths, original)
        self.assertEqual(block.to_dict()["grid"], {"rows": 2, "columns": 2})
        self.assertNotIn("outline", block.to_dict())
        self.assertNotIn("dividers", block.to_dict())
        validate_blocks(booths, result)

    def test_nonuniform_rectangular_cells_do_not_export_an_equal_spacing_grid(self) -> None:
        booths = [
            booth("a", 1, 0, 0),
            replace(booth("b", 2, 19, 0), bbox=Box(19, 0, 23, 30)),
        ]
        block = self.grouper.group(booths).blocks[0]
        self.assertIsNone(block.to_dict()["grid"])
        self.assertEqual(len(block.outline), 4)
        self.assertEqual(block.dividers[0].x1, 19)

    def test_singleton_and_aisle_are_separate_blocks_even_if_one_island(self) -> None:
        booths = [booth("a", 1, 0, 40), booth("b", 2, 19, 40), booth("c", 3, 200, 40)]
        blocks = self.grouper.group(booths)
        self.assertEqual([len(block.booths) for block in blocks.blocks], [2, 1])
        assigned = BoothIslandAssigner(time_limit=2).assign(
            booths, [marker("m", "A", 80, 0)], blocks=blocks,
        )
        self.assertEqual(len(assigned.islands), 1)
        self.assertEqual([c.id for c in assigned.components], [b.id for b in blocks.blocks])
        self.assertEqual({assigned.memberships[b.id].island_id for b in booths}, {assigned.islands[0].id})

    def test_l_shape_does_not_draw_bounding_box_across_missing_cell(self) -> None:
        result = self.grouper.group([
            booth("a", 1, 0, 0), booth("b", 2, 19, 0), booth("c", 3, 0, 29),
        ])
        block = result.blocks[0]
        self.assertEqual(len(block.outline), 6)
        self.assertEqual(len(block.dividers), 2)
        self.assertIsNone(block.to_dict()["grid"])
        self.assertFalse(any(e.y1 == e.y2 == 58 and e.x2 > 19 for e in block.outline))

    def test_hole_is_outlined_and_has_no_internal_line_through_empty_space(self) -> None:
        booths = [booth(f"{x}{y}", 1+x+y*3, x*19, y*29)
                  for y in range(3) for x in range(3) if (x, y) != (1, 1)]
        block = self.grouper.group(booths).blocks[0]
        self.assertIsNone(block.to_dict()["grid"])
        self.assertEqual(len(block.outline), 8)
        self.assertFalse(any(
            (e.y1 == e.y2 and 29 < e.y1 < 58 and e.x1 < 38 and e.x2 > 19)
            or (e.x1 == e.x2 and 19 < e.x1 < 38 and e.y1 < 58 and e.y2 > 29)
            for e in block.dividers
        ))

    def test_adjacent_pixel_borders_snap_only_the_drawing_geometry(self) -> None:
        booths = [booth("a", 1, 0, 0), booth("b", 2, 20, 0)]
        block = self.grouper.group(booths).blocks[0]
        self.assertEqual(len(block.outline), 4)
        self.assertEqual(len(block.dividers), 1)
        self.assertEqual(block.dividers[0].x1, 19.5)
        self.assertEqual(booths[1].bbox.x, 20)
        self.assertEqual(self.grouper.group(list(reversed(booths))).to_dict(), self.grouper.group(booths).to_dict())

    def test_partial_shared_border_is_split_into_outer_and_inner_segments(self) -> None:
        block = self.grouper.group([booth("a", 1, 0, 0), booth("b", 2, 19, 20)]).blocks[0]
        self.assertEqual(len(block.dividers), 1)
        self.assertEqual((block.dividers[0].y1, block.dividers[0].y2), (20, 29))

    def test_unknown_candidates_do_not_bridge_blocks_and_detect_only_can_group(self) -> None:
        booths = [booth("a", 1, 0, 0), booth("b", None, 19, 0), booth("c", 2, 38, 0)]
        result = self.grouper.group(booths)
        self.assertEqual(len(result.blocks), 2)
        self.assertEqual([b.id for b in result.excluded], ["b"])
        booths[1].status = "not_run"
        self.assertEqual(len(self.grouper.group(booths).blocks), 1)

    def test_review_color_is_preserved_on_shared_edges(self) -> None:
        booths = [booth("a", 1, 0, 0), booth("b", 2, 19, 0)]
        booths[1].status = "needs_review"
        block = self.grouper.group(booths).blocks[0]
        self.assertEqual(block.dividers[0].status, "needs_review")
        self.assertEqual({edge.status for edge in block.outline}, {"recognized", "needs_review"})

    def test_validator_rejects_stale_geometry_partition_and_wrong_page(self) -> None:
        booths = [booth("a", 1, 0, 0), booth("b", 2, 19, 0)]
        blocks = self.grouper.group(booths)
        blocks.blocks[0].dividers.clear()
        with self.assertRaisesRegex(ValueError, "does not match"):
            validate_blocks(booths, blocks)
        blocks = self.grouper.group(booths, page=2)
        with self.assertRaisesRegex(ValueError, "page"):
            BoothIslandAssigner().assign(booths, [marker("m", "A", 0, 80)], blocks=blocks)
        with self.assertRaisesRegex(ValueError, "unique"):
            self.grouper.group([booths[0], booths[0]])
        self.assertEqual(self.grouper.group([]).to_dict()["counts"]["blocks"], 0)


if __name__ == "__main__":
    unittest.main()
