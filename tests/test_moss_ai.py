"""Unit tests for MOSS-VL image upload, Responses parsing, and CAD coordinate validation."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

import moss_ai


class MossImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.image_path = Path(self.temp.name) / 'source.png'
        Image.new('RGB', (640, 480), 'white').save(self.image_path)

    def tearDown(self):
        self.temp.cleanup()

    def test_prepare_image_resizes_and_returns_pixel_scale(self):
        data, width, height, sx, sy = moss_ai._prepare_image(self.image_path, max_edge=320)
        self.assertTrue(data.startswith(b'\xff\xd8'))
        self.assertEqual((width, height), (320, 240))
        self.assertEqual((sx, sy), (2.0, 2.0))

    def test_response_text_reads_responses_api_output_and_usage(self):
        text, usage = moss_ai._response_text({
            'status': 'completed',
            'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': '{"routes": []}'}]}],
            'usage': {'input_tokens': 10, 'output_tokens': 4, 'total_tokens': 14},
        })
        self.assertEqual(text, '{"routes": []}')
        self.assertEqual(usage['total_tokens'], 14)

    def test_incomplete_response_is_rejected(self):
        with self.assertRaises(moss_ai.MossAIError):
            moss_ai._response_text({'status': 'incomplete', 'incomplete_details': {'reason': 'max_output_tokens'}, 'output': []})

    def test_json_parser_accepts_fenced_output(self):
        self.assertEqual(moss_ai._parse_json('```json\n{"annotations": []}\n```'), {'annotations': []})

    @patch('moss_ai._delete_image')
    @patch('moss_ai._request_json')
    @patch('moss_ai._upload_image')
    def test_ocr_maps_boxes_to_original_pixels(self, upload, request, delete):
        upload.return_value = 'file_test'
        request.return_value = {
            'status': 'completed',
            'output': [{'content': [{'type': 'output_text', 'text': json.dumps({'annotations': [
                {'text': 'Ду 25', 'bbox': [10, 20, 50, 40], 'confidence': 72}
            ]}, ensure_ascii=False)}]}],
            'usage': {'input_tokens': 100, 'output_tokens': 20, 'total_tokens': 120},
        }
        items, status = moss_ai.moss_ocr_annotations(self.image_path, 'moss-test-key')
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['bbox'], {'x': 10, 'y': 20, 'w': 40, 'h': 20})
        self.assertEqual(items[0]['source'], 'moss-vl-ocr')
        self.assertFalse(items[0]['verified'])
        self.assertEqual(status['provider'], 'moss')
        self.assertTrue(status['complete'])
        delete.assert_called_once_with('moss-test-key', 'file_test', timeout=20.0)

    @patch('moss_ai._delete_image')
    @patch('moss_ai._request_json')
    @patch('moss_ai._upload_image')
    def test_route_parser_rejects_out_of_bounds_and_maps_valid_points(self, upload, request, delete):
        upload.return_value = 'file_routes'
        request.return_value = {
            'status': 'completed',
            'output': [{'content': [{'type': 'output_text', 'text': json.dumps({'routes': [
                {'id': 'R1', 'points': [[10, 20], [200, 20]], 'confidence': 80},
                {'id': 'R2', 'points': [[-1, 5], [30, 5]], 'confidence': 90},
            ]})}]}],
            'usage': {'total_tokens': 80},
        }
        routes, status = moss_ai.moss_semantic_routes(self.image_path, 'moss-test-key')
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]['points'], [[10.0, 20.0], [200.0, 20.0]])
        self.assertEqual(status['rejected_invalid'], 1)
        self.assertEqual(status['provider'], 'moss')
        delete.assert_called_once()

    @patch('moss_ai.urllib.request.urlopen')
    def test_upload_uses_bearer_key_and_multipart_image_purpose(self, urlopen):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size): return b'{"id":"file_uploaded_1"}'
        urlopen.return_value = FakeResponse()
        file_id = moss_ai._upload_image('moss-secret-key', b'JPEGDATA', timeout=10)
        request = urlopen.call_args.args[0]
        self.assertEqual(file_id, 'file_uploaded_1')
        self.assertEqual(request.get_header('Authorization'), 'Bearer moss-secret-key')
        self.assertIn('multipart/form-data', request.get_header('Content-type'))
        self.assertIn(b'name="purpose"', request.data)
        self.assertIn(b'image', request.data)
        self.assertIn(b'name="file"', request.data)

    @patch('moss_ai.urllib.request.urlopen')
    def test_api_error_never_exposes_api_key(self, urlopen):
        error = __import__('urllib.error').error.HTTPError(
            moss_ai.RESPONSES_URL, 401, 'Unauthorized', {}, io.BytesIO(b'{"error":{"message":"bad token"}}')
        )
        urlopen.side_effect = error
        with self.assertRaises(moss_ai.MossAIError) as caught:
            moss_ai._request_json('moss-secret-key', moss_ai.RESPONSES_URL, body=b'{}', timeout=10)
        self.assertNotIn('moss-secret-key', str(caught.exception))
        self.assertIn('HTTP 401', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
