"""Unit tests for OpenRouter request parsing and coordinate validation."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import openrouter_ai


class OpenRouterImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.image_path = Path(self.temp.name) / 'source.png'
        Image.new('RGB', (640, 480), 'white').save(self.image_path)

    def tearDown(self):
        self.temp.cleanup()

    def test_prepare_image_returns_data_url_and_scale(self):
        data, width, height, sx, sy = openrouter_ai._prepare_image(self.image_path, max_edge=320)
        self.assertTrue(data.startswith('data:image/jpeg;base64,'))
        self.assertEqual((width, height), (320, 240))
        self.assertEqual((sx, sy), (2.0, 2.0))

    def test_json_parser_accepts_fenced_output(self):
        parsed = openrouter_ai._parse_json('```json\n{"routes": []}\n```')
        self.assertEqual(parsed, {'routes': []})

    @patch('openrouter_ai._chat')
    def test_ocr_annotations_map_boxes_to_original_pixels(self, chat):
        chat.return_value = ({'annotations': [{
            'text': 'Ду 25', 'bbox': [10, 20, 50, 40], 'confidence': 72,
        }]}, {'prompt_tokens': 100, 'completion_tokens': 20})
        items, status = openrouter_ai.openrouter_ocr_annotations(self.image_path, 'sk-or-v1-test')
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['bbox'], {'x': 10, 'y': 20, 'w': 40, 'h': 20})
        self.assertFalse(items[0]['verified'])
        self.assertEqual(items[0]['source'], 'openrouter-vision-ocr')
        self.assertTrue(status['complete'])

    @patch('openrouter_ai._chat')
    def test_route_parser_rejects_out_of_bounds_and_maps_valid_points(self, chat):
        chat.return_value = ({'routes': [
            {'id': 'R1', 'points': [[10, 20], [200, 20]], 'confidence': 80},
            {'id': 'R2', 'points': [[-1, 5], [30, 5]], 'confidence': 90},
        ]}, {'prompt_tokens': 120, 'completion_tokens': 80})
        routes, status = openrouter_ai.openrouter_semantic_routes(self.image_path, 'sk-or-v1-test')
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]['points'], [[10.0, 20.0], [200.0, 20.0]])
        self.assertEqual(status['rejected_invalid'], 1)
        self.assertEqual(status['provider'], 'openrouter')

    @patch('openrouter_ai.urllib.request.urlopen')
    def test_api_request_uses_bearer_auth_and_never_logs_key(self, urlopen):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size): return json.dumps({'choices': [{'message': {'content': '{"routes": []}'}}]}).encode()
            status = 200
        urlopen.return_value = FakeResponse()
        result = openrouter_ai._post_json('sk-or-v1-secret-test', {'model': openrouter_ai.DEFAULT_MODEL}, 10)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.get_header('Authorization'), 'Bearer sk-or-v1-secret-test')
        self.assertIn('choices', result)

    @patch('openrouter_ai.urllib.request.urlopen')
    def test_api_error_redacts_key(self, urlopen):
        error = __import__('urllib.error').error.HTTPError(
            openrouter_ai.API_URL, 401, 'Unauthorized', {}, __import__('io').BytesIO(b'{"error":{"message":"bad sk-or-v1-secret-test"}}')
        )
        urlopen.side_effect = error
        with self.assertRaises(openrouter_ai.OpenRouterAIError) as caught:
            openrouter_ai._post_json('sk-or-v1-secret-test', {}, 10)
        self.assertNotIn('sk-or-v1-secret-test', str(caught.exception))
        self.assertIn('HTTP 401', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
