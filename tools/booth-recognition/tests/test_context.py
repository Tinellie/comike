import unittest
from copy import deepcopy

from island_recognition.context import IslandContextRefiner, PageTypeInferer
from island_recognition.recognizer import IslandMarker
from map_recognition.common import Box


def row(labels: list[str | None], *, vertical: bool = False) -> list[IslandMarker]:
    return [
        IslandMarker(
            id=f"m{i}", bbox=Box(50 if vertical else 50 + i * 70, 50 + i * 70 if vertical else 50, 30, 30),
            color="#ff0088", label=label, raw_text=label, recognition_score=0.99,
            status="recognized" if label is not None else "unrecognized",
            issues=[] if label is not None else ["invalid_island_label"],
        )
        for i, label in enumerate(labels)
    ]


def review(marker: IslandMarker, score: float = 0.6) -> None:
    marker.status = "needs_review"
    marker.recognition_score = score
    marker.issues = ["low_confidence"]


class PageTypeTests(unittest.TestCase):
    def test_all_four_types(self) -> None:
        for family, labels in [
            ("uppercase", "ABCDE"), ("lowercase", "abcde"),
            ("hiragana", "あいうえお"), ("katakana", "アイウエオ"),
        ]:
            result = PageTypeInferer().infer(row(list(labels)))
            self.assertEqual(result.label_type, family)
            self.assertEqual(result.confidence, 1)
            self.assertEqual(result.distinct[family], 5)

    def test_repeated_wall_label_cannot_dominate_type_vote(self) -> None:
        result = PageTypeInferer().infer(row(list("a" * 100 + "BCDEF")))
        self.assertEqual(result.label_type, "uppercase")
        self.assertEqual(result.counts["lowercase"], 100)
        self.assertEqual(result.distinct["lowercase"], 1)

    def test_insufficient_or_conflicting_type_is_not_forced(self) -> None:
        for labels in ["aaa", "ab", "ABCabc", "あいアイ"]:
            self.assertIsNone(PageTypeInferer().infer(row(list(labels))).label_type)
        self.assertIsNone(PageTypeInferer().infer([]).label_type)

    def test_detection_only_does_not_vote(self) -> None:
        markers = row(list("ABC"))
        for marker in markers:
            marker.status = "not_run"
        result = IslandContextRefiner().refine(markers)
        self.assertIsNone(result.page_type.label_type)
        self.assertTrue(all(m.inference.outcome == "skipped" for m in result.markers))


class ContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.refiner = IslandContextRefiner()

    def test_fixes_case_outlier_even_if_original_ocr_was_confident(self) -> None:
        markers = row(list("abCde"))
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "c")
        self.assertEqual(fixed.status, "recognized")
        self.assertEqual(fixed.inference.outcome, "corrected")
        self.assertEqual(fixed.inference.original_status, "recognized")
        self.assertIn("script_outlier", fixed.inference.resolved_issues)

    def test_confirms_low_confidence_with_both_neighbors(self) -> None:
        markers = row(list("ABCDE"))
        review(markers[2])
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "C")
        self.assertEqual(fixed.status, "recognized")
        self.assertEqual(fixed.recognition_score, 0.6)
        self.assertEqual(fixed.inference.outcome, "confirmed")
        self.assertEqual(fixed.inference.original_issues, ["low_confidence"])
        self.assertGreaterEqual(fixed.inference.score, 0.85)

    def test_recovers_invalid_label_using_three_or_more_bracketing_anchors(self) -> None:
        markers = row(["A", "B", None, "D", "E"])
        markers[2].raw_text = "日"
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "C")
        self.assertEqual(fixed.raw_text, "日")
        self.assertEqual(fixed.inference.outcome, "corrected")
        self.assertGreaterEqual(len(fixed.inference.supporting_ids), 3)

    def test_absent_visual_evidence_requires_more_than_two_anchors(self) -> None:
        markers = row(["A", None, "C"])
        markers.extend(row(list("XYZ")))
        for i, marker in enumerate(markers[3:]):
            marker.id = f"remote{i}"
            marker.bbox = Box(i * 70, 1000, 30, 30)
        fixed = self.refiner.refine(markers).markers[1]
        self.assertIsNone(fixed.label)
        self.assertEqual(fixed.inference.proposed_label, "B")
        self.assertEqual(fixed.inference.outcome, "unresolved")

    def test_vertical_and_reversed_sequences(self) -> None:
        for vertical in [True, False]:
            markers = row(list("edCba"), vertical=vertical)
            fixed = self.refiner.refine(markers).markers[2]
            self.assertEqual(fixed.label, "c")
            self.assertEqual(fixed.inference.reason, "vertical_sequence" if vertical else "horizontal_sequence")

    def test_kana_uses_gojuon_not_unicode_order(self) -> None:
        for labels, expected in [(["か", "き", None, "け", "こ"], "く"), (["カ", "キ", None, "ケ", "コ"], "ク")]:
            fixed = self.refiner.refine(row(labels)).markers[2]
            self.assertEqual(fixed.label, expected)

    def test_kana_counterpart_has_visual_support_but_not_automatic_conversion(self) -> None:
        markers = row(["ハ", "ヒ", "ふ", "ヘ", "ホ"])
        self.assertEqual(self.refiner.refine(markers).markers[2].label, "フ")
        markers[2].bbox = Box(1000, 1000, 30, 30)
        unresolved = self.refiner.refine(markers).markers[2]
        self.assertEqual(unresolved.label, "ふ")
        self.assertEqual(unresolved.status, "needs_review")

    def test_endpoint_needs_visual_support_and_two_anchors(self) -> None:
        markers = row(list("ABCDE"))
        review(markers[0])
        self.assertEqual(self.refiner.refine(markers).markers[0].inference.outcome, "confirmed")
        markers[0].label = None
        markers[0].status = "unrecognized"
        self.assertIsNone(self.refiner.refine(markers).markers[0].label)

    def test_boundary_and_unknown_issues_are_not_cleared(self) -> None:
        markers = row(list("ABCDE"))
        review(markers[2])
        markers[2].issues += ["truncated_at_image_edge", "uncertain_page_orientation", "custom_issue"]
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.inference.outcome, "confirmed")
        self.assertEqual(fixed.status, "needs_review")
        self.assertEqual(fixed.issues, ["truncated_at_image_edge", "uncertain_page_orientation", "custom_issue"])

    def test_does_not_cross_large_aisles(self) -> None:
        markers = row(list("ABCDE"))
        review(markers[2])
        markers[2].bbox = Box(900, 50, 30, 30)
        self.assertEqual(self.refiner.refine(markers).markers[2].inference.outcome, "unresolved")

    def test_repeated_wall_markers_are_not_a_sequence(self) -> None:
        markers = row(list("AAAAA"))
        review(markers[2])
        extra = row(list("BCDE"))
        for i, marker in enumerate(extra):
            marker.id = f"remote{i}"
            marker.bbox = Box(i * 70, 1000, 30, 30)
        markers += extra
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "A")
        self.assertEqual(fixed.inference.outcome, "unresolved")

    def test_skipped_letter_or_conflicting_neighbors_does_not_force_repair(self) -> None:
        markers = row(list("ABXEF"))
        review(markers[2])
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "X")
        self.assertEqual(fixed.inference.outcome, "unresolved")

    def test_horizontal_and_vertical_disagreement_is_preserved(self) -> None:
        markers = row(list("ABXDE"))
        review(markers[2])
        extra = row(list("FGHIJ"), vertical=True)
        extra.pop(2)
        for i, marker in enumerate(extra):
            marker.id = f"v{i}"
            marker.bbox = Box(190, marker.bbox.y - 140, 30, 30)
        markers += extra
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "X")
        self.assertEqual(fixed.inference.reason, "conflicting_local_sequences")

    def test_no_cascading_from_newly_repaired_markers(self) -> None:
        markers = row(["A", "B", None, None, "E", "F"])
        original = deepcopy(markers)
        result = self.refiner.refine(markers)
        self.assertEqual(markers, original)
        for marker in result.markers:
            if marker.inference.outcome == "corrected":
                self.assertTrue(set(marker.inference.supporting_ids).isdisjoint({"m2", "m3"}))
        with self.assertRaisesRegex(ValueError, "original stage-1"):
            self.refiner.refine(result.markers)

    def test_alternative_visual_reading_is_considered_only_at_chosen_rotation(self) -> None:
        markers = row(["A", "B", None, "D"])
        markers[2].alternatives = [{"label": "C", "score": 0.8, "rotation": 0, "model": "test"}]
        fixed = self.refiner.refine(markers).markers[2]
        self.assertEqual(fixed.label, "C")
        self.assertEqual(fixed.recognition_score, 0.99)


if __name__ == "__main__":
    unittest.main()
