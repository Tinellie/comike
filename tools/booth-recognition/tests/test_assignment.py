import copy
import unittest

from booth_recognition.recognizer import Booth
from booth_blocks import pixel_adjacent
from island_assignment import AssignmentError, BoothIslandAssigner, validate_assignment
from island_assignment.assigner import island_seeds
from island_assignment.geometry import ContactGraphBuilder, LayoutTopology
from island_recognition import IslandMarker
from map_recognition.common import Box


def booth(id: str, number: int | None, x: int, y: int, *, vertical: bool = False) -> Booth:
    return Booth(
        id, Box(x, y, 20, 30), f"{number:02}" if number is not None else None,
        raw_text=f"{number:02}" if number is not None else "?",
        recognition_score=0.99 if number is not None else 0.1,
        rotation=90 if vertical else 0,
        status="recognized" if number is not None else "unrecognized",
    )


def marker(id: str, label: str | None, x: int, y: int) -> IslandMarker:
    return IslandMarker(
        id, Box(x, y, 20, 24), "#cc2288", label=label, recognition_score=0.99,
        status="recognized" if label is not None else "unrecognized",
    )


class ContactTests(unittest.TestCase):
    def test_side_contact_is_hard_but_corner_or_aisle_is_not(self) -> None:
        a = Box(100, 100, 20, 30)
        self.assertTrue(pixel_adjacent(a, Box(119, 100, 20, 30)))
        self.assertTrue(pixel_adjacent(a, Box(100, 129, 20, 30)))
        self.assertFalse(pixel_adjacent(a, Box(119, 129, 20, 30)))
        self.assertFalse(pixel_adjacent(a, Box(125, 100, 20, 30)))

    def test_transitive_contacts_and_aisle_links(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 100),
                  booth("c", 3, 138, 100), booth("d", 4, 240, 100)]
        components = ContactGraphBuilder().build(booths, 2)
        self.assertEqual([len(c.booths) for c in components], [3, 1])
        self.assertEqual(components[0].id, "p002-block-0001")
        links = LayoutTopology().build(components, 30)
        self.assertEqual(len(links), 1)
        self.assertEqual(links[0].kind, "aligned_aisle")

    def test_perpendicular_wall_path_can_turn_corners(self) -> None:
        booths = [booth("a", 1, 100, 60), booth("b", 2, 119, 60),
                  booth("c", 3, 180, 100), booth("d", 4, 180, 129)]
        components = ContactGraphBuilder().build(booths, 1)
        self.assertTrue(all(c.thin for c in components))
        links = LayoutTopology().build(components, 30)
        self.assertTrue(any(link.kind == "wall_turn" for link in links))

    def test_pixel_adjacent_staircase_wall_remains_one_cell_thick(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 114), booth("c", 3, 138, 128)]
        components = ContactGraphBuilder().build(booths, 1)
        self.assertEqual(len(components), 1)
        self.assertTrue(components[0].thin)

    def test_repeated_distributed_labels_indicate_wrapping_without_fixed_label_names(self) -> None:
        seeds = island_seeds([
            marker("m1", "x", 20, 20), marker("m2", "x", 500, 20),
            marker("m3", "x", 500, 500), marker("m4", "y", 300, 200),
        ], 1, "lowercase")
        self.assertTrue(seeds[0].wraps)
        self.assertFalse(seeds[1].wraps)
        self.assertNotEqual(seeds[0].color, seeds[1].color)


class AssignmentTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assigner = BoothIslandAssigner(time_limit=3)

    def test_aisle_separated_fragments_and_contact_groups_stay_together(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 100),
                  booth("c", 3, 240, 100), booth("d", 4, 259, 100)]
        result = self.assigner.assign(booths, [marker("m1", "A", 180, 60)])
        self.assertEqual(len(result.islands), 1)
        self.assertEqual(len(result.components), 2)
        self.assertEqual(result.islands[0].numbers, ["01", "02", "03", "04"])
        validate_assignment(booths, result)

    def test_parallel_rows_with_repeated_numbers_are_different_islands(self) -> None:
        booths = [
            booth("a", 1, 100, 100), booth("b", 2, 119, 100),
            booth("c", 3, 250, 100), booth("d", 4, 269, 100),
            booth("e", 1, 100, 350), booth("f", 2, 119, 350),
            booth("g", 3, 250, 350), booth("h", 4, 269, 350),
        ]
        result = self.assigner.assign(booths, [marker("ma", "A", 170, 60), marker("mb", "B", 170, 310)])
        islands = {i.label: set(i.booth_ids) for i in result.islands}
        self.assertEqual(islands["A"], {"a", "b", "c", "d"})
        self.assertEqual(islands["B"], {"e", "f", "g", "h"})
        self.assertTrue(result.to_dict()["constraints"]["uniqueNumbers"])

    def test_global_uniqueness_overrides_nearest_marker_when_required(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 1, 300, 100),
                  booth("c", 2, 119, 100), booth("d", 2, 319, 100)]
        result = self.assigner.assign(booths, [marker("ma", "A", 150, 60), marker("mb", "B", 1200, 60)])
        self.assertNotEqual(result.memberships["a"].island_id, result.memberships["b"].island_id)
        self.assertTrue(any("global_constraint_choice" in m.issues for m in result.memberships.values()))

    def test_one_wall_island_wraps_multiple_sides_with_repeated_markers(self) -> None:
        booths = [
            booth("a", 1, 100, 60), booth("b", 2, 119, 60),
            booth("c", 3, 180, 100), booth("d", 4, 180, 129),
            booth("e", 5, 200, 300), booth("f", 6, 219, 300),
        ]
        result = self.assigner.assign(booths, [
            marker("m1", "め", 60, 60), marker("m2", "め", 200, 200), marker("m3", "め", 500, 500),
        ])
        self.assertEqual(len(result.islands), 1)
        self.assertEqual(len(result.islands[0].marker_ids), 3)
        self.assertEqual(len(result.islands[0].booth_ids), 6)
        self.assertGreater(result.wall_link_count, 0)

    def test_distinct_wall_islands_can_reuse_number_ranges(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 100),
                  booth("c", 1, 100, 600), booth("d", 2, 119, 600)]
        result = self.assigner.assign(booths, [marker("m1", "あ", 100, 60), marker("m2", "め", 100, 560)])
        self.assertEqual({i.label for i in result.islands}, {"あ", "め"})
        self.assertEqual(result.memberships["a"].island_id, next(i.id for i in result.islands if i.label == "あ"))

    def test_number_gaps_are_reported_without_mutating_any_booth(self) -> None:
        booths = [booth("a", 87, 100, 100), booth("b", 88, 119, 100), booth("c", 93, 300, 100)]
        original = copy.deepcopy(booths)
        result = self.assigner.assign(booths, [marker("m1", "A", 150, 60)])
        self.assertEqual(result.islands[0].number_gaps, [{"first": "89", "last": "92"}])
        self.assertEqual(result.islands[0].numbers, ["87", "88", "93"])
        self.assertEqual(booths, original)
        self.assertFalse(result.to_dict()["constraints"]["continuousNumbers"])
        self.assertNotIn("numbering_gaps", result.memberships["c"].issues)

    def test_number_range_does_not_have_to_start_at_one(self) -> None:
        booths = [booth("a", 50, 100, 100), booth("b", 51, 119, 100)]
        result = self.assigner.assign(booths, [marker("m1", "A", 100, 60)])
        self.assertEqual(result.islands[0].number_gaps, [])
        self.assertEqual(result.islands[0].to_dict()["numberRange"], {"first": "50", "last": "51"})

    def test_unrecognized_candidates_are_excluded_but_reviewed_digits_are_included(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 100), booth("bad", None, 500, 500)]
        booths[1].status = "needs_review"
        result = self.assigner.assign(booths, [marker("m1", "A", 100, 60)])
        self.assertEqual(set(result.memberships), {"a", "b"})
        self.assertEqual([b.id for b in result.excluded], ["bad"])
        self.assertIn("booth_ocr_needs_review", result.memberships["b"].issues)
        self.assertEqual(result.to_dict()["counts"]["excludedCandidates"], 1)

    def test_only_unrecognized_candidates_is_explicit_empty_result(self) -> None:
        result = self.assigner.assign([booth("bad", None, 100, 100)], [])
        self.assertEqual(result.solver_status, "no_booths")
        self.assertEqual(len(result.excluded), 1)

    def test_wrong_script_marker_retains_unknown_label_not_false_official_id(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 100)]
        markers = [marker("m1", "J", 100, 60)]
        result = self.assigner.assign(booths, markers, page_type="hiragana")
        self.assertIsNone(result.islands[0].label)
        self.assertEqual(markers[0].label, "J")
        self.assertIn("unresolved_island_label", result.memberships["a"].issues)

    def test_case_is_not_folded_without_page_type_evidence(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 1, 100, 350)]
        result = self.assigner.assign(booths, [marker("m1", "A", 100, 60), marker("m2", "a", 100, 310)])
        self.assertEqual({i.label for i in result.islands}, {"A", "a"})

    def test_touching_duplicate_numbers_fail_without_splitting_or_renumbering(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 1, 119, 100)]
        with self.assertRaises(AssignmentError) as error:
            self.assigner.assign(booths, [marker("m1", "A", 100, 60), marker("m2", "B", 300, 60)])
        self.assertEqual(error.exception.code, "contact_number_conflict")
        self.assertEqual(booths[1].number, "01")

    def test_insufficient_labels_or_skipped_ocr_are_explicit_errors(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 1, 300, 100)]
        with self.assertRaises(AssignmentError) as error:
            self.assigner.assign(booths, [marker("m1", "A", 100, 60)])
        self.assertEqual(error.exception.code, "insufficient_island_labels")
        booths[0].status = "not_run"
        with self.assertRaises(AssignmentError) as error:
            self.assigner.assign(booths, [])
        self.assertEqual(error.exception.code, "ocr_not_run")

    def test_infeasible_seed_count_is_not_hidden_by_unassigned_booths(self) -> None:
        with self.assertRaises(AssignmentError) as error:
            self.assigner.assign([booth("a", 1, 100, 100)], [
                marker("m1", "A", 100, 60), marker("m2", "B", 300, 60),
            ])
        self.assertEqual(error.exception.code, "constraints_infeasible")

    def test_validator_detects_incomplete_or_corrupted_output(self) -> None:
        booths = [booth("a", 1, 100, 100), booth("b", 2, 119, 100)]
        result = self.assigner.assign(booths, [marker("m1", "A", 100, 60)])
        broken = copy.deepcopy(result)
        del broken.memberships["b"]
        with self.assertRaises(AssignmentError):
            validate_assignment(booths, broken)
        broken = copy.deepcopy(result)
        broken.islands[0].number_gaps = [{"first": "01", "last": "01"}]
        with self.assertRaises(AssignmentError):
            validate_assignment(booths, broken)

    def test_invalid_configuration_or_recognized_digits_are_rejected(self) -> None:
        for value in [0, -1, float("nan"), float("inf")]:
            with self.assertRaises(ValueError):
                BoothIslandAssigner(time_limit=value)
        b = booth("a", None, 100, 100)
        b.status = "recognized"
        with self.assertRaises(AssignmentError) as error:
            self.assigner.assign([b], [marker("m1", "A", 100, 60)])
        self.assertEqual(error.exception.code, "invalid_booth_number")


if __name__ == "__main__":
    unittest.main()
