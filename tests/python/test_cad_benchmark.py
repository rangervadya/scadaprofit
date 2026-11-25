import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from PIL import Image

import processor
from evaluate_examples import distance, match_points, rates


class CadBenchmarkTests(unittest.TestCase):
    def test_coordinate_variants_remap_each_axis_and_reject_invalid_points(self):
        def response(image, prompt, *, stage, **kwargs):
            self.assertIn('0..1000', prompt)
            if stage == 'OCR':
                parsed = {'annotations': [
                    {'text': 'DN50', 'bbox': [100, 200, 300, 400], 'confidence': 90},
                    {'text': 'DN90', 'bbox': [100, 200, 1001, 400], 'confidence': 90},
                ]}
            else:
                parsed = {'routes': [
                    {'id': 'valid', 'points': [[100, 200], [300, 400]], 'confidence': 90},
                    {'id': 'invalid', 'points': [[100, 200], [1001, 400]], 'confidence': 90},
                ]}
            return parsed, 1.0, image.size

        env = {
            'QWEN_OCR_NORMALIZED_COORDS': '1', 'QWEN_PIPE_NORMALIZED_COORDS': '1',
            'QWEN_OCR_TILE_GRID': '1', 'QWEN_PIPE_TILE_GRID': '1',
            'QWEN_OCR_UPSCALE': '1', 'QWEN_PIPE_UPSCALE': '1',
        }
        with TemporaryDirectory() as root:
            image = Path(root) / 'input.png'
            Image.new('RGB', (1000, 600), 'white').save(image)
            with patch.dict(os.environ, env), patch.object(processor, '_ANALYSIS_HARD_DEADLINE', None), \
                 patch.object(processor, '_qwen_call_with_retry', side_effect=response), \
                 patch.object(processor, '_run_handwritten_block_ocr', return_value=([], [])):
                labels, ocr = processor._qwen_annotations(str(image), 1000, 600)
                routes, pipe = processor._qwen_semantic_routes(str(image), 1000, 600)
        self.assertEqual(labels[0]['bbox'], {'x': 100, 'y': 120, 'w': 200, 'h': 120})
        self.assertEqual(ocr['tile_diagnostics'][0]['rejected_out_of_crop_boxes'], 1)
        self.assertEqual(len(routes), 1)
        self.assertAlmostEqual(routes[0]['points'][0][0], 100, delta=1)
        self.assertAlmostEqual(routes[0]['points'][0][1], 120, delta=1)
        self.assertEqual(pipe['rejected_out_of_bounds_routes'], 1)

    def test_benchmark_primitives(self):
        self.assertEqual(distance('ABCD', 'AXD'), 2)
        self.assertEqual(match_points({'a': (1, 2)}, {'b': (1, 3)}, 2), {'a': 'b'})
        self.assertAlmostEqual(rates(2, 3, 4)['f1'], 4 / 7)
