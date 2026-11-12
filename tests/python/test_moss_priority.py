"""Regression tests: legacy cloud OCR flags must not bypass the local Qwen path."""
import os
import sys
import types
import unittest
from unittest.mock import patch

import numpy as np
import processor


class LocalOcrPriorityTests(unittest.TestCase):
    def setUp(self):
        self.gray = np.zeros((100, 120), dtype='uint8')
        self.qwen_items = [{
            'id': 'Q1', 'text': 'Ду 25', 'confidence': 82,
            'bbox': {'x': 12, 'y': 14, 'w': 55, 'h': 18},
            'verified': True, 'include': True, 'geometry_exclude': True,
            'source': 'qwen-vl-ocr', 'provider': 'ollama-qwen',
        }]
        self.tesseract = types.SimpleNamespace(
            Output=types.SimpleNamespace(DICT='DICT'),
            get_languages=lambda config='': ['eng', 'rus'],
            image_to_data=lambda *args, **kwargs: {
                'text': ['Счётчик'], 'conf': ['88'],
                'left': [80], 'top': [20], 'width': [30], 'height': [12],
            },
        )

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_local_qwen_and_tesseract_run_even_when_legacy_cloud_flags_are_enabled(
        self, openrouter, moss, qwen
    ):
        qwen.return_value = (self.qwen_items.copy(), {
            'available': True, 'complete': True, 'annotations': 1,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
            'provider': 'ollama-qwen',
        })
        with patch.dict(sys.modules, {'pytesseract': self.tesseract}), patch.dict(os.environ, {
            'MOSS_OCR_ENABLED': '1', 'MOSS_API_KEY': 'unexpected-cloud-key',
            'OPENROUTER_OCR_ENABLED': '1', 'OPENROUTER_API_KEY': 'unexpected-openrouter-key',
        }, clear=False):
            items, status = processor.ocr_annotations('unused.jpg', self.gray)

        qwen.assert_called_once()
        moss.assert_not_called()
        openrouter.assert_not_called()
        self.assertEqual(status['provider'], 'local-qwen+tesseract')
        self.assertTrue(status['qwen']['complete'])
        self.assertTrue(status['tesseract']['complete'])
        self.assertTrue(status['moss']['disabled'])
        self.assertTrue(status['openrouter']['disabled'])
        self.assertEqual({item['source'] for item in items}, {'qwen-vl-ocr', 'tesseract'})

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_tesseract_duplicate_is_not_added_when_qwen_already_covered_the_region(
        self, openrouter, moss, qwen
    ):
        qwen.return_value = (self.qwen_items.copy(), {
            'available': True, 'complete': True, 'annotations': 1,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        self.tesseract.image_to_data = lambda *args, **kwargs: {
            'text': ['ДУ 25'], 'conf': ['95'],
            'left': [14], 'top': [15], 'width': [52], 'height': [17],
        }
        with patch.dict(sys.modules, {'pytesseract': self.tesseract}):
            items, status = processor.ocr_annotations('unused.jpg', self.gray)
        qwen.assert_called_once()
        moss.assert_not_called()
        openrouter.assert_not_called()
        self.assertEqual(len(items), 1)
        self.assertEqual(status['tesseract']['annotations'], 0)

    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'moss_ocr_annotations')
    @patch.object(processor, 'openrouter_ocr_annotations')
    def test_local_tesseract_remains_available_when_qwen_raises(self, openrouter, moss, qwen):
        qwen.side_effect = RuntimeError('Ollama недоступна')
        with patch.dict(sys.modules, {'pytesseract': self.tesseract}):
            items, status = processor.ocr_annotations('unused.jpg', self.gray)
        self.assertFalse(status['qwen']['complete'])
        self.assertTrue(status['tesseract']['complete'])
        self.assertEqual(len(items), 1)
        moss.assert_not_called()
        openrouter.assert_not_called()


if __name__ == '__main__':
    unittest.main()
