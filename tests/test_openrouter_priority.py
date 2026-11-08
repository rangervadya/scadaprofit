"""Regression tests: OpenRouter OCR is cloud-first with local Qwen fallback."""
import os
import unittest
from unittest.mock import patch

import processor


class OpenRouterOcrPriorityTests(unittest.TestCase):
    def setUp(self):
        self.annotations = [{
            'id': 'OR1', 'text': 'Ду 25', 'confidence': 55,
            'bbox': {'x': 12, 'y': 14, 'w': 55, 'h': 18},
            'verified': False, 'include': False, 'geometry_exclude': True,
            'source': 'openrouter-vision-ocr',
        }]

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_openrouter_success_skips_local_qwen(self, cloud, qwen):
        cloud.return_value = (self.annotations.copy(), {
            'available': True, 'complete': True, 'annotations': 1,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        qwen.side_effect = AssertionError('Qwen OCR should be skipped after cloud OCR success')
        with patch.dict(os.environ, {
            'OPENROUTER_OCR_ENABLED': '1', 'OPENROUTER_API_KEY': 'test-key',
            'OPENROUTER_MODEL': 'nvidia/nemotron-3.5-super-vl:free',
        }, clear=False):
            items, status = processor.ocr_annotations('unused.jpg', __import__('numpy').zeros((100, 120), dtype='uint8'))
        cloud.assert_called_once()
        qwen.assert_not_called()
        self.assertTrue(status['openrouter']['complete'])
        self.assertTrue(status['qwen']['skipped'])
        self.assertIn('openrouter-vision-ocr', [item['source'] for item in items])

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_openrouter_failure_falls_back_to_local_qwen(self, cloud, qwen):
        cloud.side_effect = RuntimeError('temporary provider failure')
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {
            'OPENROUTER_OCR_ENABLED': '1', 'OPENROUTER_API_KEY': 'test-key',
        }, clear=False):
            _, status = processor.ocr_annotations('unused.jpg', __import__('numpy').zeros((100, 120), dtype='uint8'))
        cloud.assert_called_once()
        qwen.assert_called_once()
        self.assertFalse(status['openrouter']['complete'])
        self.assertTrue(status['qwen']['complete'])

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_empty_openrouter_result_falls_back_to_local_qwen(self, cloud, qwen):
        cloud.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {
            'OPENROUTER_OCR_ENABLED': '1', 'OPENROUTER_API_KEY': 'test-key',
        }, clear=False):
            _, status = processor.ocr_annotations('unused.jpg', __import__('numpy').zeros((100, 120), dtype='uint8'))
        cloud.assert_called_once()
        qwen.assert_called_once()
        self.assertTrue(status['openrouter']['complete'])
        self.assertTrue(status['qwen']['complete'])

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_disabled_openrouter_uses_local_qwen(self, cloud, qwen):
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {'OPENROUTER_OCR_ENABLED': '0', 'OPENROUTER_API_KEY': ''}, clear=False):
            _, status = processor.ocr_annotations('unused.jpg', __import__('numpy').zeros((100, 120), dtype='uint8'))
        cloud.assert_not_called()
        qwen.assert_called_once()
        self.assertTrue(status['qwen']['complete'])


if __name__ == '__main__':
    unittest.main()
