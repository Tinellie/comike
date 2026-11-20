import unittest

import numpy as np
from PIL import Image, ImageDraw

from map_recognition.path_graph import (
    _edge_walkable_pixels, _extend_open_ends, _extend_to_venue_edge, _straighten_paths,
    build_path_graph, walkable_pixels,
)


class PathGraphTests(unittest.TestCase):
    def test_edge_frame_can_be_crossed_but_booth_and_wall_remain_blocked(self):
        image = Image.new("RGB", (181, 160), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((8, 8, 171, 151), outline="#595959", width=9)
        draw.rectangle((13, 30, 45, 70), fill="#dcdcdc")
        draw.rectangle((130, 102, 171, 137), fill="#595959")
        boundary = [(8, 8), (171, 8), (171, 151), (8, 151)]
        allowed = walkable_pixels(image)
        venue = np.zeros(allowed.shape, dtype=bool)
        venue[8:152, 8:172] = True
        edge_mask = _edge_walkable_pixels(image, allowed, boundary)
        paths = [(24, 21, 100, 21), (48, 50, 100, 50), (100, 120, 126, 120)]
        self.assertFalse(allowed[21, 11])
        self.assertFalse(edge_mask[50, 30])
        self.assertFalse(edge_mask[120, 150])
        self.assertEqual(_extend_to_venue_edge(edge_mask, venue, paths), [
            (8, 21, 171, 21), (48, 50, 171, 50), (8, 120, 126, 120),
        ])

    def test_edge_only_extension_does_not_make_an_internal_shortcut(self):
        mask = np.ones((6, 12), dtype=bool)
        paths = [(0, 3, 4, 3), (9, 0, 9, 5)]
        self.assertEqual(_extend_to_venue_edge(mask, mask, paths), paths)

    def test_extension_continues_through_starting_junction_and_stops_at_first_path(self):
        mask = np.ones((7, 12), dtype=bool)
        paths = [(1, 3, 4, 3), (6, 0, 6, 6), (9, 0, 9, 6), (1, 0, 1, 6)]
        expected = {(0, 3, 6, 3), *paths[1:]}
        self.assertEqual(set(_extend_open_ends(mask, paths)), expected)
        transposed = [(y, x, v, u) for x, y, u, v in paths]
        self.assertEqual(set(_extend_open_ends(mask.T, transposed)), {(y, x, v, u) for x, y, u, v in expected})

    def test_extension_targets_hall_edge_but_not_internal_booth_edge(self):
        venue = np.zeros((7, 14), dtype=bool)
        venue[1:6, 2:12] = True
        mask = venue.copy()
        mask[3, 7] = False
        paths = [(4, 3, 5, 3), (9, 1, 9, 5)]
        self.assertEqual(set(_extend_open_ends(mask, paths, venue=venue)), {(2, 3, 5, 3), paths[1]})

    def test_extension_merges_collinear_paths_at_contact(self):
        mask = np.ones((1, 12), dtype=bool)
        self.assertEqual(_extend_open_ends(mask, [(1, 0, 3, 0), (6, 0, 9, 0)]), [(0, 0, 11, 0)])

    def test_straightening_replaces_a_corridor_dogleg_in_either_direction(self):
        steps = [(1, 2, 12, 2), (12, 2, 12, 5), (12, 5, 23, 5)]
        mask = np.ones((8, 25), dtype=bool)
        path = _straighten_paths(mask, steps)
        self.assertEqual(len(path), 1)
        left, row, right, end_row = path[0]
        self.assertEqual((left, right, row), (1, 23, end_row))
        transposed = [(y, x, v, u) for x, y, u, v in steps]
        self.assertEqual(_straighten_paths(mask.T, transposed), [(row, left, row, right)])

    def test_straightening_keeps_side_branch_attached(self):
        steps = [(1, 2, 12, 2), (12, 2, 12, 5), (12, 5, 23, 5), (6, 0, 6, 2)]
        self.assertEqual(set(_straighten_paths(np.ones((8, 25), dtype=bool), steps)),
                         {(1, 2, 23, 2), (6, 0, 6, 2)})

    def test_straightening_does_not_cut_a_wall_or_drop_a_loop(self):
        steps = [(1, 2, 12, 2), (12, 2, 12, 5), (12, 5, 23, 5)]
        mask = np.ones((8, 25), dtype=bool)
        mask[3:, 1:12] = False
        mask[:5, 13:24] = False
        self.assertEqual(_straighten_paths(mask, steps), steps)

        loop = [(1, 2, 23, 2), (1, 5, 23, 5), (1, 2, 1, 5), (23, 2, 23, 5)]
        mask[:, :] = True
        mask[3:5, 8:16] = False
        self.assertEqual(_straighten_paths(mask, loop), loop)

    def test_long_colored_corridor_excludes_an_enclosed_room(self):
        image = Image.new("RGB", (96, 64), "#777777")
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 8, 91, 23), fill="white")
        # A saturated dark mark has only 8 levels of channel spread.
        draw.rectangle((36, 8, 59, 23), fill="#201820")
        draw.rectangle((28, 36, 67, 55), fill="white")
        segments = build_path_graph(image)
        self.assertEqual(len(segments), 1)
        x1, y1, x2, y2 = segments[0]
        self.assertEqual(y1, y2)
        self.assertIn(y1, range(8, 24))
        self.assertGreater(x2 - x1, 80)

    def test_preview_whitening_keeps_low_saturation_ink_blocked(self):
        image = Image.new("RGB", (7, 1000))
        image.putdata([
            (224, 234, 228), (128, 128, 128), (250, 249, 250), (240, 225, 233),
            (0, 0, 0), (224, 234, 228), (249, 250, 249),
        ] * image.height)
        self.assertEqual(walkable_pixels(image)[0].tolist(), [False, False, True, True, False, True, True])
        self.assertEqual(image.getpixel((5, 0)), (224, 234, 228))

    def test_only_small_gray_components_without_black_ink_are_ignored(self):
        image = Image.new("RGB", (88, 48), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 4, 30, 40), fill="#999999")
        draw.rectangle((36, 4, 60, 43), fill="#999999")
        draw.rectangle((68, 4, 73, 9), fill="#999999")
        draw.point((74, 10), fill="#101010")
        mask = walkable_pixels(image)
        self.assertTrue(mask[4:41, 4:31].all())
        self.assertFalse(mask[4:44, 36:61].any())
        self.assertFalse(mask[4:10, 68:74].any())
        self.assertFalse(mask[10, 74])

    def test_loop_around_dark_block_has_no_extra_cycles_or_crossings(self):
        image = Image.new("RGB", (80, 60), "black")
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 4, 75, 55), fill="white")
        draw.rectangle((20, 16, 59, 43), fill="#a0a0a0")
        adjacency = {}
        edges = set()
        for x1, y1, x2, y2 in build_path_graph(image):
            self.assertNotEqual(x1 == x2, y1 == y2)
            dx, dy = (0, 1) if x1 == x2 else (1, 0)
            start = (min(x1, x2), min(y1, y2))
            for i in range(abs(x2 - x1) + abs(y2 - y1) + 1):
                vertex = (start[0] + i * dx, start[1] + i * dy)
                self.assertEqual(image.getpixel(vertex), (255, 255, 255))
                if i:
                    prior = (vertex[0] - dx, vertex[1] - dy)
                    edges.add((prior, vertex))
                    adjacency.setdefault(prior, set()).add(vertex)
                    adjacency.setdefault(vertex, set()).add(prior)
        seen = set()
        pending = [next(iter(adjacency))]
        while pending:
            vertex = pending.pop()
            if vertex not in seen:
                seen.add(vertex)
                pending.extend(adjacency[vertex] - seen)
        self.assertEqual(seen, set(adjacency))
        self.assertEqual(len(edges) - len(seen) + 1, 1)

    def test_long_dead_end_stays_connected_to_main_aisle(self):
        image = Image.new("RGB", (120, 100), "black")
        draw = ImageDraw.Draw(image)
        draw.rectangle((4, 8, 115, 23), fill="white")
        draw.rectangle((52, 16, 67, 91), fill="white")
        segments = build_path_graph(image)
        self.assertEqual(len(segments), 2)
        horizontal, vertical = sorted(segments, key=lambda s: s[0] == s[2])
        self.assertEqual(vertical[1], horizontal[1])
        self.assertIn(vertical[0], range(horizontal[0], horizontal[2] + 1))
        self.assertGreaterEqual(vertical[3], 80)