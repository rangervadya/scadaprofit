"""Regression tests: configured Yandex Vision OCR must run before slow local Qwen OCR."""
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import processor


class YandexOcrPriorityTests(unittest.TestCase):
    def setUp(self):
        self.gray = np.zeros((120, 160), dtype=np.uint8)
        self.image_path = str(ROOT / 'unused-test-image.png')
        self.annotations = [{
            'id': 'Y1', 'text': 'ДУ 25', 'bbox': {'x': 10, 'y': 10, 'w': 30, 'h': 10},
            'confidence': 60, 'verified': False, 'include': False,
            'geometry_exclude': True, 'source': 'yandex-vision-ocr',
        }]
        self.tess_data = {
            'text': [], 'conf': [], 'left': [], 'top': [], 'width': [], 'height': [],
        }

    @patch('pytesseract.image_to_data')
    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'yandex_ocr_annotations')
    def test_successful_yandex_ocr_skips_slow_local_qwen(self, yandex, qwen, tess):
        yandex.return_value = (self.annotations.copy(), {
            'available': True, 'complete': True, 'annotations': 1,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        tess.return_value = self.tess_data
        with patch.dict(os.environ, {
            'YANDEX_OCR_ENABLED': '1', 'YANDEX_API_KEY': 'test-key',
            'YANDEX_FOLDER_ID': 'folder-123',
        }, clear=False):
            items, status = processor.ocr_annotations(self.image_path, self.gray)
        yandex.assert_called_once()
        qwen.assert_not_called()
        self.assertTrue(status['yandex']['complete'])
        self.assertTrue(status['qwen']['skipped'])
        self.assertEqual([item['source'] for item in items], ['yandex-vision-ocr'])

    @patch('pytesseract.image_to_data')
    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'yandex_ocr_annotations')
    def test_failed_yandex_ocr_falls_back_to_local_qwen(self, yandex, qwen, tess):
        yandex.side_effect = RuntimeError('temporary Yandex failure')
        qwen.return_value = ([{'id': 'Q1', 'text': 'ДУ 25', 'bbox': {'x': 10, 'y': 10, 'w': 30, 'h': 10},
                               'source': 'qwen3-vl'}], {
            'available': True, 'complete': True, 'annotations': 1,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        tess.return_value = self.tess_data
        with patch.dict(os.environ, {
            'YANDEX_OCR_ENABLED': '1', 'YANDEX_API_KEY': 'test-key',
            'YANDEX_FOLDER_ID': 'folder-123',
        }, clear=False):
            items, status = processor.ocr_annotations(self.image_path, self.gray)
        yandex.assert_called_once()
        qwen.assert_called_once()
        self.assertFalse(status['yandex']['complete'])
        self.assertTrue(status['qwen']['complete'])
        self.assertEqual(items[0]['source'], 'qwen3-vl')

    @patch('pytesseract.image_to_data')
    @patch.object(processor, '_qwen_annotations')
    @patch.object(processor, 'yandex_ocr_annotations')
    def test_empty_yandex_ocr_falls_back_to_local_qwen(self, yandex, qwen, tess):
        yandex.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        qwen.return_value = ([], {
            'available': True, 'complete': True, 'annotations': 0,
            'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        tess.return_value = self.tess_data
        with patch.dict(os.environ, {
            'YANDEX_OCR_ENABLED': '1', 'YANDEX_API_KEY': 'test-key',
            'YANDEX_FOLDER_ID': 'folder-123',
        }, clear=False):
            _, status = processor.ocr_annotations(self.image_path, self.gray)
        qwen.assert_called_once()
        self.assertTrue(status['qwen']['complete'])


if __name__ == '__main__':
    unittest.main()
