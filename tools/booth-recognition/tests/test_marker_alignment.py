import copy
import unittest

from island_assignment.models import AssignedIsland, AssignmentResult, ContactComponent
from island_recognition import IslandMarker
from map_recognition.common import Box
from map_recognition.marker_alignment import IslandMarkerAligner, Point
from test_assignment import booth


def marker(id: str, x: int, y: int, *, width: int = 9, height: int = 9) -> IslandMarker:
    return IslandMarker(id, Box(x - (width - 1) // 2, y - (height - 1) // 2, width, height), "#cc2288", "A")


def block(id: str, x: int, y: int, *, thin: bool = False, axis="vertical") -> ContactComponent:
    positions = [(i * 19, 0) for i in range(4)] if thin else [
        (0, 0), (19, 0), (0, 29), (19, 29),
    ]
    if thin and axis == "vertical":
        positions = [(0, i * 29) for i in range(4)]
    booths = [booth(f"{id}-{i}", i + 1, x + dx, y + dy) for i, (dx, dy) in enumerate(positions)]
    width = max(b.bbox.x + b.bbox.width for b in booths) - x
    height = max(b.bbox.y + b.bbox.height for b in booths) - y
    return ContactComponent(id, booths, Box(x, y, width, height), axis, thin)


def assignment(groups) -> AssignmentResult:
    islands = [
        AssignedIsland(
            id, id, "#cc2288", ids, [b.id for c in blocks for b in c.booths],
            [c.id for c in blocks], ["01", "02", "03", "04"], [], [],
        )
        for id, blocks, ids in groups
    ]
    return AssignmentResult({}, islands, [c for _, blocks, _ in groups for c in blocks], [], "feasible", 0, 0, 0)


class MarkerAlignmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.aligner = IslandMarkerAligner()

    def test_internal_row_uses_centers_then_centers_other_axis_on_whole_island(self) -> None:
        markers = [marker("a", 116, 80, width=17), marker("b", 216, 82, height=17)]
        assigned = assignment([
            ("A", [block("ca", 100, 100)], ["a"]),
            ("B", [block("cb", 200, 100)], ["b"]),
        ])
        before = copy.deepcopy((markers, assigned))
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.centers, {"a": Point(119, 81), "b": Point(219, 81)})
        self.assertEqual((result.aligned, result.centered), (2, 2))
        self.assertEqual(result.layouts, {"A": "interior", "B": "interior"})
        self.assertEqual((markers, assigned), before)
        self.assertNotIn("bbox", result.marker_dict(markers[0]))
        self.assertEqual(result.marker_dict(markers[0])["center"], {"x": 119, "y": 81})
        self.assertIn("bbox", markers[0].to_dict())

    def test_internal_column_centers_y_not_x_and_uses_all_blocks(self) -> None:
        markers = [marker("a", 80, 155), marker("b", 82, 255)]
        assigned = assignment([
            ("A", [block("ca", 100, 100, axis="horizontal"), block("ca2", 100, 160, axis="horizontal")], ["a"]),
            ("B", [block("cb", 100, 230, axis="horizontal")], ["b"]),
        ])
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.centers, {"a": Point(81, 159), "b": Point(81, 259)})

    def test_wall_rows_do_not_mix_with_interior_and_never_center_along_wall(self) -> None:
        markers = [marker("a", 115, 180), marker("b", 255, 184), marker("c", 416, 183)]
        assigned = assignment([
            ("A", [block("ca", 100, 200, thin=True, axis="horizontal")], ["a"]),
            ("B", [block("cb", 240, 200, thin=True, axis="horizontal")], ["b"]),
            ("C", [block("cc", 400, 200)], ["c"]),
        ])
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.centers["a"], Point(115, 182))
        self.assertEqual(result.centers["b"], Point(255, 182))
        self.assertEqual(result.centers["c"], Point(416, 183))
        self.assertEqual(result.centered, 0)
        self.assertEqual(result.layouts["A"], "wall")

    def test_wall_columns_keep_y_and_wrapping_island_markers_do_not_move_to_island_middle(self) -> None:
        markers = [marker("a", 80, 110), marker("b", 82, 240), marker("c", 130, 80)]
        assigned = assignment([
            ("A", [
                block("ca", 100, 100, thin=True),
                block("cb", 100, 230, thin=True),
                block("cc", 100, 100, thin=True, axis="horizontal"),
            ], ["a", "b", "c"]),
        ])
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.centers, {"a": Point(81, 110), "b": Point(81, 240), "c": Point(130, 80)})
        self.assertEqual(result.centered, 0)

    def test_far_wall_markers_and_diagonal_chain_do_not_collapse_into_one_line(self) -> None:
        markers = [marker("a", 110, 80), marker("b", 210, 87), marker("c", 310, 94), marker("d", 1100, 81)]
        assigned = assignment([
            (id, [block(f"c{id}", x, 100, thin=True, axis="horizontal")], [id])
            for id, x in [("a", 100), ("b", 200), ("c", 300), ("d", 1090)]
        ])
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.centers["a"].y, 83.5)
        self.assertEqual(result.centers["b"].y, 83.5)
        self.assertEqual(result.centers["c"].y, 94)
        self.assertEqual(result.centers["d"].y, 81)

    def test_uncertain_and_slanted_wall_layouts_are_not_forced_to_axis_lines(self) -> None:
        a = block("ca", 100, 100, thin=True, axis="horizontal")
        for i, b in enumerate(a.booths):
            b.bbox = Box(b.bbox.x, b.bbox.y + i * 14, b.bbox.width, b.bbox.height)
        a.bbox = Box(100, 100, a.bbox.width, 72)
        markers = [marker("a", 110, 80), marker("b", 210, 82), marker("c", 310, 80)]
        assigned = assignment([
            ("A", [a], ["a"]),
            ("B", [block("cb", 200, 100, thin=True, axis="horizontal")], ["b"]),
            ("C", [block("cc", 300, 100), block("cc2", 300, 200, thin=True)], ["c"]),
        ])
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.aligned, 0)
        self.assertEqual(result.layouts["C"], "uncertain")

    def test_centering_does_not_jump_far_or_land_inside_booths(self) -> None:
        markers = [marker("a", 119, 105), marker("b", 219, 107), marker("c", 450, 106)]
        assigned = assignment([
            ("A", [block("ca", 100, 100)], ["a"]),
            ("B", [block("cb", 200, 100)], ["b"]),
            ("C", [block("cc", 500, 100)], ["c"]),
        ])
        result = self.aligner.align(markers, assigned)
        self.assertEqual(result.centered, 0)
        self.assertTrue(all(p.y == 106 for p in result.centers.values()))

    def test_no_assignment_records_centers_only_and_invalid_membership_fails(self) -> None:
        markers = [marker("a", 119, 80)]
        result = self.aligner.align(markers)
        self.assertEqual(result.centers, {"a": Point(119, 80)})
        self.assertEqual(result.to_dict()["status"], "centers_only")
        with self.assertRaises(ValueError):
            self.aligner.align(markers + markers)
        with self.assertRaises(ValueError):
            self.aligner.align(markers, assignment([("A", [block("ca", 100, 100)], ["missing"])]))

    def test_result_is_deterministic_for_marker_input_order(self) -> None:
        markers = [marker("a", 116, 80), marker("b", 216, 82)]
        assigned = assignment([
            ("A", [block("ca", 100, 100)], ["a"]),
            ("B", [block("cb", 200, 100)], ["b"]),
        ])
        self.assertEqual(self.aligner.align(markers, assigned), self.aligner.align(list(reversed(markers)), assigned))


if __name__ == "__main__":
    unittest.main()
