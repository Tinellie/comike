import unittest

import cv2
import numpy as np
from PIL import Image, ImageDraw

from map_recognition.common import Box
from map_recognition.hall_outline import _long_line_outline, _simple_polygon, detect_hall_outline


class HallOutlineTests(unittest.TestCase):
    def test_closed_frame_is_preferred_over_outside_text_or_marker(self) -> None:
        image = Image.new("RGB", (240, 180), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 210, 150), outline="#575757", width=3)
        draw.rectangle((60, 60, 80, 80), outline="black")
        draw.rectangle((225, 160, 230, 170), fill="magenta")
        result = detect_hall_outline(image, [Box(60, 60, 21, 21)])
        self.assertEqual(result.method, "closed_frame")
        self.assertEqual(result.bbox, Box(20, 20, 191, 131))
        self.assertEqual(set(result.polygon), {(20, 20), (210, 20), (210, 150), (20, 150)})

    def test_one_pixel_gap_is_not_repaired(self) -> None:
        image = Image.new("RGB", (240, 180), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 210, 150), outline="black")
        draw.point((100, 20), fill="white")
        draw.rectangle((60, 60, 80, 80), outline="black")
        draw.point((235, 175), fill=(254, 255, 255))
        result = detect_hall_outline(image, [Box(60, 60, 21, 21)])
        self.assertEqual(result.method, "nonwhite_bbox")
        self.assertEqual(result.bbox, Box(20, 20, 216, 156))

    def test_local_closed_room_cannot_be_used_if_another_booth_is_outside(self) -> None:
        image = Image.new("RGB", (240, 180), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((20, 20, 100, 150), outline="black", width=2)
        draw.rectangle((40, 40, 60, 60), outline="black")
        draw.rectangle((180, 90, 200, 110), outline="black")
        result = detect_hall_outline(image, [Box(40, 40, 21, 21), Box(180, 90, 21, 21)])
        self.assertEqual(result.method, "nonwhite_bbox")
        self.assertEqual(result.bbox, Box(20, 20, 181, 131))

    def test_concave_closed_frame_preserves_notch_instead_of_convex_hull(self) -> None:
        image = Image.new("RGB", (240, 180), "white")
        points = [(20, 20), (200, 20), (200, 70), (100, 70), (100, 150), (20, 150)]
        draw = ImageDraw.Draw(image)
        draw.line(points + [points[0]], fill="black", width=2)
        result = detect_hall_outline(image, [Box(40, 90, 20, 20), Box(130, 35, 20, 20)])
        self.assertEqual(result.method, "closed_frame")
        contour = np.array(result.polygon, dtype=np.int32)
        self.assertLess(cv2.pointPolygonTest(contour, (160, 120), False), 0)
        self.assertGreater(cv2.pointPolygonTest(contour, (50, 100), False), 0)

    def test_booth_holes_do_not_turn_open_outer_walls_into_closed_frame(self) -> None:
        image = Image.new("RGB", (240, 180), "white")
        draw = ImageDraw.Draw(image)
        draw.line([(10, 160), (10, 10), (220, 10)], fill="#555555", width=3)
        boxes = [Box(40, 40, 20, 20), Box(100, 100, 20, 20)]
        for b in boxes:
            draw.rectangle((b.x, b.y, b.x + b.width - 1, b.y + b.height - 1), outline="black")
        self.assertEqual(detect_hall_outline(image, boxes).method, "nonwhite_bbox")

    def test_outermost_frame_wins_and_booth_pixels_on_wall_are_included(self) -> None:
        image = Image.new("RGB", (240, 180), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((5, 5, 235, 175), outline="black")
        draw.rectangle((20, 20, 210, 150), outline="black")
        draw.rectangle((20, 60, 40, 80), outline="black")
        result = detect_hall_outline(image, [Box(20, 60, 21, 21)])
        self.assertEqual(result.bbox, Box(5, 5, 231, 171))

    def test_fallback_includes_color_faint_pixels_and_transparency_on_white(self) -> None:
        image = Image.new("RGBA", (100, 100), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.point((10, 20), fill=(254, 255, 255, 255))
        draw.rectangle((80, 70, 90, 85), fill=(255, 0, 0, 255))
        result = detect_hall_outline(image, [])
        self.assertEqual(result.bbox, Box(10, 20, 81, 66))
        self.assertEqual(result.polygon, ((10, 20), (90, 20), (90, 85), (10, 85)))

    def test_white_image_and_invalid_boxes_fail_explicitly(self) -> None:
        with self.assertRaisesRegex(ValueError, "entirely white"):
            detect_hall_outline(Image.new("RGB", (100, 100), "white"), [])
        with self.assertRaisesRegex(ValueError, "outside"):
            detect_hall_outline(Image.new("RGB", (100, 100), "black"), [Box(95, 10, 20, 20)])

    def test_short_protrusions_are_ignored_and_long_edges_join(self) -> None:
        image = Image.new("RGB", (840, 640), "white")
        points = [(20, 20), (220, 20), (220, 70), (270, 70),
                  (270, 20), (820, 20), (820, 620), (20, 620)]
        ImageDraw.Draw(image).polygon(points, outline="black")
        result = detect_hall_outline(image, [Box(100, 100, 20, 20)])
        self.assertEqual(result.method, "closed_frame")
        self.assertEqual(set(result.polygon), {(20, 20), (820, 20), (820, 620), (20, 620)})

    def test_nearly_parallel_lines_merge_across_shorter_gap_and_across_seam(self) -> None:
        points = [(20, 20), (220, 20), (220, 180), (380, 180),
                  (380, 22), (780, 24), (780, 620), (20, 620)]
        for offset in range(len(points)):
            with self.subTest(offset=offset):
                rotated = points[offset:] + points[:offset]
                contour = np.array(rotated, np.int32).reshape(-1, 1, 2)
                polygon = _long_line_outline(contour, [Box(100, 200, 20, 20)], (640, 800))
                self.assertEqual(len(polygon), 4)
                self.assertTrue(_simple_polygon(polygon))
                self.assertTrue(all(
                    np.linalg.norm(b - a) >= 120
                    for a, b in zip(polygon[:, 0], np.roll(polygon[:, 0], -1, axis=0))
                ))

    def test_long_concave_turns_remain_instead_of_convex_hull(self) -> None:
        points = [(20, 20), (780, 20), (780, 300),
                  (450, 300), (450, 780), (20, 780)]
        contour = np.array(points, np.int32).reshape(-1, 1, 2)
        polygon = _long_line_outline(contour, [Box(100, 500, 20, 20)], (800, 800))
        self.assertEqual(set(map(tuple, polygon[:, 0])), set(points))
        self.assertLess(cv2.pointPolygonTest(polygon, (600, 500), False), 0)

    def test_120_pixel_threshold_is_inclusive(self) -> None:
        for width in (119, 120):
            with self.subTest(width=width):
                contour = np.array([(20, 20), (20 + width, 20),
                                    (20 + width, 420), (20, 420)], np.int32).reshape(-1, 1, 2)
                if width == 119:
                    with self.assertLogs("map_recognition.hall_outline", level="WARNING"):
                        polygon = _long_line_outline(contour, [], (440, 200))
                else:
                    with self.assertNoLogs("map_recognition.hall_outline", level="WARNING"):
                        polygon = _long_line_outline(contour, [], (440, 200))
                self.assertEqual(len(polygon), 4)

    def test_unsafe_reconstruction_keeps_booth_and_logs_warning(self) -> None:
        points = [(20, 20), (220, 20), (220, 10), (270, 10),
                  (270, 20), (820, 20), (820, 620), (20, 620)]
        contour = np.array(points, np.int32).reshape(-1, 1, 2)
        with self.assertLogs("map_recognition.hall_outline", level="WARNING"):
            polygon = _long_line_outline(contour, [Box(230, 10, 20, 20)], (640, 840))
        self.assertGreaterEqual(cv2.pointPolygonTest(polygon, (230, 10), False), 0)

    def test_self_intersecting_reconstruction_is_rejected(self) -> None:
        bowtie = np.array([(20, 20), (500, 500), (20, 500), (500, 20)], np.int32)
        self.assertFalse(_simple_polygon(bowtie))


if __name__ == "__main__":
    unittest.main()