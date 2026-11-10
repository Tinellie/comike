import copy
import unittest

from booth_blocks import BoothBlockGrouper
from island_assignment.geometry import ContactGraphBuilder
from island_assignment.models import AssignedIsland, AssignmentResult
from map_recognition.common import Box
from map_recognition.half_booths import HalfBoothSplitter
from test_assignment import booth


def assigned(grouping):
    components = ContactGraphBuilder().build(
        [b for block in grouping.blocks for b in block.booths], grouping.page, grouping,
    )
    island = AssignedIsland(
        "i", "A", "#112233", [], [b.id for c in components for b in c.booths],
        [c.id for c in components], ["01"], [], [],
    )
    return AssignmentResult({}, [island], components, [], "feasible", 0, 0, 0)


def matrix(*, vertical=False):
    booths = []
    for row, numbers in enumerate([[1, 2, 3, 4], [8, 7, 6, 5]]):
        for column, number in enumerate(numbers):
            x, y = (row * 19, column * 29) if vertical else (column * 19, row * 29)
            booths.append(booth(str(number), number, x + 100, y + 100))
    return booths


class HalfBoothTests(unittest.TestCase):
    def split(self, booths, layout="interior"):
        grouping = BoothBlockGrouper().group(booths)
        return HalfBoothSplitter().split(grouping, assigned(grouping), {"i": layout})

    def pair(self, result, id):
        return [h for h in result.halves if h.booth_id == id]

    def test_horizontal_snake_numbering_and_corrected_terminal_outer_rule(self):
        result = self.split(matrix())
        self.assertEqual(list(result.axes.values()), ["horizontal"])
        self.assertEqual([h.suffix for h in self.pair(result, "2")], ["a", "b"])
        self.assertEqual([h.suffix for h in self.pair(result, "7")], ["b", "a"])
        self.assertEqual([h.suffix for h in self.pair(result, "1")], ["b", "a"])
        self.assertEqual([h.suffix for h in self.pair(result, "4")], ["a", "b"])
        self.assertEqual([h.suffix for h in self.pair(result, "8")], ["b", "a"])
        self.assertEqual([h.suffix for h in self.pair(result, "5")], ["a", "b"])
        self.assertEqual(self.pair(result, "2")[0].bbox["width"], 10)
        self.assertEqual(self.pair(result, "1")[0].bbox["height"], 15)
        self.assertTrue(all(not h.issues for h in result.halves))

    def test_vertical_matrix_uses_horizontal_cuts_except_terminal_vertical_cuts(self):
        result = self.split(matrix(vertical=True))
        self.assertEqual(list(result.axes.values()), ["vertical"])
        self.assertEqual(self.pair(result, "2")[0].bbox["height"], 15)
        self.assertEqual(self.pair(result, "1")[0].bbox["width"], 10)
        self.assertEqual([h.suffix for h in self.pair(result, "1")], ["b", "a"])
        self.assertEqual([h.suffix for h in self.pair(result, "4")], ["a", "b"])

    def test_wall_endpoints_do_not_switch_to_parallel_cuts(self):
        booths = [booth(str(n), n, 100 + (4 - n) * 19, 100) for n in range(1, 5)]
        result = self.split(booths, "wall")
        for b in booths:
            pair = self.pair(result, b.id)
            self.assertEqual(pair[0].bbox["width"], 10)
            self.assertEqual([h.suffix for h in pair], ["b", "a"])

    def test_staircase_wall_uses_actual_shared_border_neighbors(self):
        booths = [booth(str(n), n, 100 + n * 19, 100 + n * 14) for n in range(1, 5)]
        result = self.split(booths, "wall")
        self.assertTrue(all(not h.issues for h in result.halves))
        self.assertEqual([h.suffix for h in self.pair(result, "2")], ["a", "b"])

    def test_square_grid_inherits_same_island_direction_not_pixel_aspect(self):
        booths = matrix()
        booths += [booth(f"s{row}{col}", 20 + row * 2 + col, 230 + col * 19, 100 + row * 29)
                   for row in range(2) for col in range(2)]
        grouping = BoothBlockGrouper().group(booths)
        square = next(b for b in grouping.blocks if len(b.booths) == 4)
        self.assertLess(square.bbox.width, square.bbox.height)
        result = HalfBoothSplitter().split(grouping, assigned(grouping), {"i": "interior"})
        self.assertEqual(result.axes[square.id], "horizontal")
        self.assertEqual(len(result.halves), len(booths) * 2)

    def test_singleton_wall_uses_nearest_aligned_same_island_booth(self):
        booths = [booth(str(n), n, 100 + n * 19, 100) for n in range(1, 5)]
        booths += [booth("single", 5, 230, 100)]
        result = self.split(booths, "wall")
        pair = self.pair(result, "single")
        self.assertEqual([h.suffix for h in pair], ["a", "b"])
        self.assertEqual(pair[0].bbox["width"], 10)
        self.assertTrue(all(not h.issues for h in pair))

    def test_missing_or_conflicting_evidence_remains_explicit_not_guessed(self):
        result = self.split([booth("single", 1, 100, 100)], "wall")
        self.assertEqual(len(result.halves), 2)
        self.assertTrue(all(h.suffix is None and h.issues for h in result.halves))
        conflict = self.split([
            booth("a", 1, 100, 100), booth("b", 3, 119, 100), booth("c", 2, 138, 100),
        ], "wall")
        self.assertTrue(all(h.suffix is None for h in self.pair(conflict, "b")))
        self.assertIn("number_direction_conflict", self.pair(conflict, "b")[0].issues)

    def test_conflicting_local_order_uses_nearest_aligned_same_island_block(self):
        result = self.split([
            booth("a", 1, 100, 100), booth("b", 3, 119, 100), booth("c", 2, 138, 100),
            booth("d", 4, 220, 100), booth("e", 5, 239, 100),
        ], "wall")
        self.assertEqual([h.suffix for h in self.pair(result, "b")], ["a", "b"])
        self.assertTrue(all(not h.issues for h in self.pair(result, "b")))

    def test_exact_half_partition_fractional_coordinates_no_input_mutation(self):
        booths = matrix()
        before = copy.deepcopy(booths)
        result = self.split(booths)
        self.assertEqual(booths, before)
        self.assertEqual(len({h.id for h in result.halves}), len(booths) * 2)
        for b in booths:
            pair = self.pair(result, b.id)
            self.assertEqual(sum(h.bbox["width"] * h.bbox["height"] for h in pair), b.bbox.width * b.bbox.height)
            self.assertEqual({h.suffix for h in pair}, {"a", "b"})
        odd = booth("odd", 1, 100, 100)
        odd.bbox = Box(100, 100, 21, 31)
        result = self.split([odd, booth("next", 2, 120, 100)], "wall")
        self.assertEqual(self.pair(result, "odd")[0].bbox["width"], 10.5)

    def test_never_uses_another_islands_direction_or_number(self):
        booths = matrix() + [booth("single", 20, 230, 100)]
        grouping = BoothBlockGrouper().group(booths)
        assignment = assigned(grouping)
        single = next(b for b in grouping.blocks if len(b.booths) == 1)
        assignment.islands[0].component_ids.remove(single.id)
        assignment.islands.append(AssignedIsland("j", "B", "#112233", [], ["single"], [single.id], ["20"], [], []))
        result = HalfBoothSplitter().split(grouping, assignment, {"i": "interior", "j": "wall"})
        self.assertTrue(all(h.suffix is None for h in self.pair(result, "single")))
        assignment.islands[-1].component_ids = []
        with self.assertRaises(ValueError):
            HalfBoothSplitter().split(grouping, assignment, {"i": "interior", "j": "wall"})


if __name__ == "__main__":
    unittest.main()
