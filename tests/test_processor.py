import unittest

import cv2
import numpy as np

import processor


class ProcessorSmokeTests(unittest.TestCase):
    def test_blue_pen_elbow_and_branch_are_vectorized(self):
        image = np.full((360, 520, 3), 245, dtype=np.uint8)
        pen = (180, 55, 35)  # blue ballpoint in BGR
        cv2.line(image, (55, 95), (230, 95), pen, 7, cv2.LINE_AA)
        cv2.line(image, (230, 95), (230, 230), pen, 7, cv2.LINE_AA)
        cv2.line(image, (230, 180), (420, 180), pen, 7, cv2.LINE_AA)

        ink, method, _ = processor.extract_ink(image)
        skeleton, _ = processor.zhang_suen_thinning(ink)
        primary, details, annotations, stats = processor.trace_paths(skeleton, preserve_details=True)
        self.assertIsInstance(annotations, list)

        self.assertEqual(method, 'colour-pen-mask')
        self.assertGreater(int(np.count_nonzero(skeleton)), 100)
        self.assertGreaterEqual(len(primary), 2)
        self.assertGreater(stats['skeletonPixels'], 100)
        self.assertEqual(stats['annotationPathCount'], len(annotations))

    def test_grayscale_fallback_is_available(self):
        image = np.full((300, 420, 3), 250, dtype=np.uint8)
        cv2.line(image, (40, 80), (350, 80), (20, 20, 20), 5, cv2.LINE_AA)
        ink, method, _ = processor.extract_ink(image)
        skeleton, _ = processor.zhang_suen_thinning(ink)
        self.assertEqual(method, 'adaptive-grayscale')
        self.assertGreater(int(np.count_nonzero(skeleton)), 100)


if __name__ == '__main__':
    unittest.main()
