import unittest
import cv2
import numpy as np
from mask_processor import (build_ink_mask, build_two_masks, preprocess_for_ocr, antialiased_preview, zhang_suen_skeleton, trace_skeleton_paths, bridge_skeleton_gaps, create_line_svg, sanitize_override_boxes, create_clean_drawing_svg)


class TwoMaskTests(unittest.TestCase):
    def make_blue_image(self):
        image = np.full((120, 180, 3), 245, dtype=np.uint8)
        cv2.line(image, (10, 60), (165, 60), (180, 45, 25), 2)
        cv2.putText(image, "P1 250", (45, 45), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 45, 25), 1, cv2.LINE_AA)
        return image

    def test_auto_detects_blue_ink(self):
        image = self.make_blue_image()
        mask, info = build_ink_mask(image, "auto")
        self.assertGreater(cv2.countNonZero(mask), 100)
        self.assertEqual(info["modeUsed"], "color")
        self.assertIsNotNone(info["dominantHue"])

    def test_text_and_line_masks_partition_ink(self):
        image = self.make_blue_image()
        ink, _ = build_ink_mask(image, "blue")
        text_mask, line_mask, _ = build_two_masks(ink, [{"x": 42, "y": 30, "width": 52, "height": 18}], 2, 0)
        self.assertGreater(cv2.countNonZero(text_mask), 0)
        self.assertGreater(cv2.countNonZero(line_mask), 0)
        self.assertEqual(cv2.countNonZero(cv2.bitwise_and(text_mask, line_mask)), 0)
        self.assertTrue(np.array_equal(cv2.bitwise_or(text_mask, line_mask), ink))

    def test_zero_padding_is_really_zero(self):
        ink = np.zeros((50, 60), dtype=np.uint8)
        ink[10:31, 15:46] = 255
        box = [{"x": 20, "y": 15, "width": 10, "height": 10}]
        text0, _, _ = build_two_masks(ink, box, 0, 0)
        text5, _, _ = build_two_masks(ink, box, 5, 0)
        self.assertLess(cv2.countNonZero(text0), cv2.countNonZero(text5))

    def test_proportional_padding_is_independent(self):
        ink = np.zeros((80, 80), dtype=np.uint8)
        ink[20:40, 20:40] = 255
        box = [{"x": 25, "y": 25, "width": 10, "height": 10}]
        px0, _, _ = build_two_masks(ink, box, 0, 0)
        ratio50, _, _ = build_two_masks(ink, box, 0, 50)
        self.assertLess(cv2.countNonZero(px0), cv2.countNonZero(ratio50))

    def test_polygon_lasso_masks_only_inside_contour(self):
        ink = np.zeros((80, 100), dtype=np.uint8)
        ink[10:70, 10:90] = 255
        lasso = [{"x": 25, "y": 20}, {"x": 60, "y": 20}, {"x": 55, "y": 55}, {"x": 20, "y": 50}]
        text_mask, line_mask, _ = build_two_masks(
            ink, [{"x": 20, "y": 20, "width": 40, "height": 35, "polygon": lasso}], 0, 0
        )
        self.assertGreater(cv2.countNonZero(text_mask), 500)
        self.assertGreater(cv2.countNonZero(line_mask), 1000)
        self.assertEqual(cv2.countNonZero(cv2.bitwise_and(text_mask, line_mask)), 0)
        self.assertTrue(np.array_equal(cv2.bitwise_or(text_mask, line_mask), ink))
        # Pixel well outside the hand-drawn contour must remain a line pixel.
        self.assertEqual(int(line_mask[65, 80]), 255)

    def test_polygon_override_is_sanitized_and_preserved(self):
        boxes = sanitize_override_boxes([
            {"x": 0, "y": 0, "width": 1, "height": 1, "polygon": [
                {"x": -5, "y": 10}, {"x": 30, "y": 10}, {"x": 25, "y": 35}, {"x": 10, "y": 30}
            ], "manual": True, "mask": True}
        ], 100, 80)
        self.assertEqual(len(boxes), 1)
        self.assertEqual(len(boxes[0]["polygon"]), 4)
        self.assertEqual(boxes[0]["polygon"][0]["x"], 0)
        self.assertEqual(boxes[0]["x"], 0)
        self.assertEqual(boxes[0]["width"], 30)

    def test_min_component_area_removes_speckles(self):
        image = np.full((50, 80, 3), 245, dtype=np.uint8)
        cv2.line(image, (5, 25), (70, 25), (180, 45, 25), 2)
        image[4, 4] = (180, 45, 25)
        keep, _ = build_ink_mask(image, "blue", min_component_area=1)
        clean, _ = build_ink_mask(image, "blue", min_component_area=2)
        self.assertGreaterEqual(cv2.countNonZero(keep), cv2.countNonZero(clean))

    def test_purple_mode(self):
        image = np.full((40, 80, 3), 245, dtype=np.uint8)
        cv2.line(image, (5, 20), (75, 20), (160, 40, 100), 2)
        mask, info = build_ink_mask(image, "purple")
        self.assertGreater(cv2.countNonZero(mask), 20)
        self.assertEqual(info["modeUsed"], "purple")

    def test_dark_mode(self):
        image = np.full((40, 80, 3), 245, dtype=np.uint8)
        cv2.line(image, (5, 20), (75, 20), (20, 20, 20), 2)
        mask, info = build_ink_mask(image, "dark")
        self.assertGreater(cv2.countNonZero(mask), 20)
        self.assertEqual(info["modeUsed"], "dark")

    def test_ocr_preprocess_modes(self):
        image = self.make_blue_image()
        ink, _ = build_ink_mask(image, "blue")
        for method in ("original", "ink", "clahe", "otsu", "adaptive"):
            processed = preprocess_for_ocr(image, ink, method)
            self.assertEqual(processed.shape, image.shape[:2])
            self.assertEqual(processed.dtype, np.uint8)


    def test_antialiased_preview_is_scaled_and_source_is_unchanged(self):
        mask = np.zeros((20, 30), dtype=np.uint8)
        cv2.line(mask, (2, 3), (25, 17), 255, 2)
        original = mask.copy()
        preview = antialiased_preview(mask, 3)
        self.assertEqual(preview.shape, (60, 90))
        self.assertTrue(np.array_equal(mask, original))
        self.assertTrue(np.any((preview > 0) & (preview < 255)))

    def test_skeleton_reduces_stroke_width_and_preserves_connected_line(self):
        mask = np.zeros((60, 80), dtype=np.uint8)
        cv2.line(mask, (5, 30), (70, 30), 255, 5)
        skeleton = zhang_suen_skeleton(mask)
        self.assertGreater(cv2.countNonZero(skeleton), 40)
        self.assertLess(cv2.countNonZero(skeleton), cv2.countNonZero(mask))

    def test_skeleton_graph_traces_a_branch(self):
        mask = np.zeros((80, 80), dtype=np.uint8)
        cv2.line(mask, (10, 40), (40, 40), 255, 3)
        cv2.line(mask, (40, 40), (65, 15), 255, 3)
        cv2.line(mask, (40, 40), (65, 65), 255, 3)
        skeleton = zhang_suen_skeleton(mask)
        paths, isolated = trace_skeleton_paths(skeleton)
        self.assertGreaterEqual(len(paths), 3)
        self.assertEqual(isolated, 0)

    def test_bridge_joins_only_short_facing_endpoints(self):
        mask = np.zeros((50, 110), dtype=np.uint8)
        cv2.line(mask, (5, 25), (45, 25), 255, 1)
        cv2.line(mask, (49, 25), (100, 25), 255, 1)
        skeleton = zhang_suen_skeleton(mask)
        bridged, bridges = bridge_skeleton_gaps(skeleton, 6, 24)
        self.assertEqual(len(bridges), 1)
        paths, isolated = trace_skeleton_paths(bridged)
        self.assertEqual(len(paths), 1)
        self.assertEqual(isolated, 0)
        # The input skeleton is not modified.
        self.assertEqual(int(skeleton[25, 47]), 0)

    def test_bridge_does_not_join_parallel_offset_lines(self):
        mask = np.zeros((60, 110), dtype=np.uint8)
        cv2.line(mask, (5, 22), (45, 22), 255, 1)
        cv2.line(mask, (50, 27), (100, 27), 255, 1)
        skeleton = zhang_suen_skeleton(mask)
        bridged, bridges = bridge_skeleton_gaps(skeleton, 8, 24)
        self.assertEqual(bridges, [])
        paths, _ = trace_skeleton_paths(bridged)
        self.assertEqual(len(paths), 2)

    def test_long_bridge_requires_removed_text_region(self):
        mask = np.zeros((60, 120), dtype=np.uint8)
        cv2.line(mask, (5, 30), (45, 30), 255, 1)
        cv2.line(mask, (60, 30), (110, 30), 255, 1)
        skeleton = zhang_suen_skeleton(mask)
        without_region, no_links = bridge_skeleton_gaps(skeleton, 20, 18, None)
        self.assertEqual(no_links, [])
        self.assertEqual(len(trace_skeleton_paths(without_region)[0]), 2)
        removed = np.zeros_like(mask)
        removed[25:36, 46:60] = 255
        with_region, links = bridge_skeleton_gaps(skeleton, 20, 18, removed)
        self.assertEqual(len(links), 1)
        self.assertEqual(len(trace_skeleton_paths(with_region)[0]), 1)

    def test_bridge_disabled_keeps_gap(self):
        mask = np.zeros((50, 110), dtype=np.uint8)
        cv2.line(mask, (5, 25), (45, 25), 255, 1)
        cv2.line(mask, (49, 25), (100, 25), 255, 1)
        bridged, bridges = bridge_skeleton_gaps(zhang_suen_skeleton(mask), 0, 24)
        self.assertEqual(bridges, [])
        paths, _ = trace_skeleton_paths(bridged)
        self.assertEqual(len(paths), 2)

    def test_svg_generation_is_valid_and_returns_vector_stats(self):
        mask = np.zeros((80, 100), dtype=np.uint8)
        cv2.line(mask, (8, 40), (45, 40), 255, 3)
        cv2.line(mask, (45, 40), (80, 22), 255, 3)
        cv2.line(mask, (45, 40), (80, 58), 255, 3)
        svg, stats = create_line_svg(mask, 0.6, 35, 90, 2.0, 1.0)
        self.assertTrue(svg.startswith('<svg'))
        self.assertIn('<path d=', svg)
        self.assertTrue(svg.endswith('</svg>'))
        self.assertGreaterEqual(stats['vectorPaths'], 2)

if __name__ == "__main__":
    unittest.main()
