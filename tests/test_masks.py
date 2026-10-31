import unittest
import cv2
import numpy as np
from mask_processor import (build_ink_mask, build_two_masks, preprocess_for_ocr, antialiased_preview, zhang_suen_skeleton, trace_skeleton_paths, create_line_svg, sanitize_override_boxes, create_clean_drawing_svg)


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
