"""Regression tests for strict local-only semantic route selection."""
import os
import unittest
from unittest.mock import patch

import processor


class LocalPipeRoutePriorityTests(unittest.TestCase):
    @patch.object(processor, '_qwen_semantic_routes')
    def test_qwen_routes_remain_the_only_supported_semantic_route_provider(self, qwen):
        qwen.return_value = ([{'id': 'QPIPE1', 'points': [[10, 10], [80, 10]]}], {
            'available': True, 'complete': True, 'provider': 'ollama-qwen',
            'routes': 1, 'tiles': 1, 'successful_tiles': 1, 'failed_tiles': [],
        })
        with patch.dict(os.environ, {
            'MOSS_PIPE_ENABLED': '1', 'MOSS_API_KEY': 'legacy-moss-key',
            'OPENROUTER_PIPE_ENABLED': '1', 'OPENROUTER_API_KEY': 'legacy-openrouter-key',
        }, clear=False):
            routes, status = processor._qwen_semantic_routes('unused.jpg', 120, 100)
        self.assertEqual(len(routes), 1)
        self.assertTrue(status['complete'])
        self.assertEqual(status['provider'], 'ollama-qwen')
        qwen.assert_called_once()

    def test_local_completion_gate_does_not_accept_tesseract_only_or_cloud_status(self):
        self.assertFalse(processor._qwen_stage_is_complete({'available': False, 'complete': False}))
        self.assertTrue(processor._qwen_stage_is_complete({'available': True, 'complete': True}))


if __name__ == '__main__':
    unittest.main()
