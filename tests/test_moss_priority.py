"""Regression tests: MOSS-VL is cloud-first, with local Qwen/Tesseract fallback."""
import os
import unittest
from unittest.mock import patch

import numpy as np
import processor


class MossOcrPriorityTests(unittest.TestCase):
    def setUp(self):
        self.annotations = [{
            'id': 'MS1', 'text': 'Ду 25', 'confidence': 55,
            'bbox': {'x': 12, 'y': 14, 'w': 55, 'h': 18},
            'verified': False, 'include': False, 'geometry_exclude': True,
            'source': 'moss-vl-ocr', 'provider': 'moss',
        }]
        self.gray = np.zeros((100, 120), dtype='uint8')

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    def test_moss_success_skips_local_qwen(self, cloud, qwen):
        cloud.return_value = (self.annotations.copy(), {
            'available': True, 'complete': True, 'annotations': 1,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [], 'provider': 'moss',
        })
        qwen.side_effect = AssertionError('Qwen OCR should be skipped after MOSS OCR success')
        with patch.dict(os.environ, {
            'MOSS_OCR_ENABLED': '1', 'MOSS_API_KEY': 'test-key', 'MOSS_MODEL': 'moss-vl-1.0',
            'OPENROUTER_OCR_ENABLED': '1', 'OPENROUTER_API_KEY': 'blocked-openrouter-key',
        }, clear=False):
            items, status = processor.ocr_annotations('unused.jpg', self.gray)
        cloud.assert_called_once()
        qwen.assert_not_called()
        self.assertTrue(status['moss']['complete'])
        self.assertTrue(status['qwen']['skipped'])
        self.assertTrue(status['openrouter']['disabled'])
        self.assertIn('moss-vl-ocr', [item['source'] for item in items])

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    def test_moss_failure_falls_back_to_local_qwen(self, cloud, qwen):
        cloud.side_effect = RuntimeError('temporary MOSS provider failure')
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {
            'MOSS_OCR_ENABLED': '1', 'MOSS_API_KEY': 'test-key',
            'OPENROUTER_OCR_ENABLED': '1', 'OPENROUTER_API_KEY': 'blocked-openrouter-key',
        }, clear=False):
            _, status = processor.ocr_annotations('unused.jpg', self.gray)
        cloud.assert_called_once()
        qwen.assert_called_once()
        self.assertFalse(status['moss']['complete'])
        self.assertTrue(status['qwen']['complete'])
        self.assertTrue(status['openrouter']['disabled'])

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    def test_empty_moss_result_falls_back_to_local_qwen(self, cloud, qwen):
        cloud.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [], 'provider': 'moss',
        })
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {'MOSS_OCR_ENABLED': '1', 'MOSS_API_KEY': 'test-key'}, clear=False):
            _, status = processor.ocr_annotations('unused.jpg', self.gray)
        cloud.assert_called_once()
        qwen.assert_called_once()
        self.assertTrue(status['moss']['complete'])
        self.assertTrue(status['qwen']['complete'])

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    def test_disabled_moss_uses_local_qwen(self, cloud, qwen):
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {
            'MOSS_OCR_ENABLED': '0', 'MOSS_API_KEY': '',
            'OPENROUTER_OCR_ENABLED': '0', 'OPENROUTER_API_KEY': '',
        }, clear=False):
            _, status = processor.ocr_annotations('unused.jpg', self.gray)
        cloud.assert_not_called()
        qwen.assert_called_once()
        self.assertTrue(status['qwen']['complete'])


if __name__ == '__main__':
    unittest.main()
