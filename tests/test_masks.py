import unittest
import cv2
import numpy as np
from mask_processor import build_ink_mask, build_two_masks

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
        ink, _ = build_ink_mask(image, "auto")
        text_mask, line_mask, _ = build_two_masks(ink, [{"x": 42, "y": 30, "width": 52, "height": 18}], 2)
        self.assertGreater(cv2.countNonZero(text_mask), 0)
        self.assertGreater(cv2.countNonZero(line_mask), 0)
        overlap = cv2.bitwise_and(text_mask, line_mask)
        self.assertEqual(cv2.countNonZero(overlap), 0)
        merged = cv2.bitwise_or(text_mask, line_mask)
        self.assertTrue(np.array_equal(merged, ink))

    def test_no_ocr_boxes_puts_all_ink_in_line_mask(self):
        image = self.make_blue_image()
        ink, _ = build_ink_mask(image, "auto")
        text_mask, line_mask, _ = build_two_masks(ink, [], 3)
        self.assertEqual(cv2.countNonZero(text_mask), 0)
        self.assertTrue(np.array_equal(line_mask, ink))

    def test_dark_mode(self):
        image = np.full((40, 80, 3), 245, dtype=np.uint8)
        cv2.line(image, (5, 20), (75, 20), (20, 20, 20), 2)
        mask, info = build_ink_mask(image, "dark")
        self.assertGreater(cv2.countNonZero(mask), 20)
        self.assertEqual(info["modeUsed"], "dark")

if __name__ == "__main__":
    unittest.main()
