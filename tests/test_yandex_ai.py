import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import yandex_ai


class YandexImagePreparationTests(unittest.TestCase):
    def test_bbox_from_polygon_scales_back_to_source_pixels(self):
        bbox = yandex_ai._bbox_from_polygon({
            "vertices": [
                {"x": 10, "y": 12}, {"x": 30, "y": 12},
                {"x": 30, "y": 22}, {"x": 10, "y": 22},
            ]
        }, 2, 3)
        self.assertEqual(bbox, {"x": 20, "y": 36, "w": 40, "h": 30})

    def test_model_json_parser_accepts_fenced_json(self):
        value = yandex_ai._parse_model_json('```json\n{"routes": []}\n```')
        self.assertEqual(value, {"routes": []})

    def test_image_prepare_produces_jpeg_and_coordinate_scales(self):
        with TemporaryDirectory() as directory:
            image_path = Path(directory) / "source.png"
            Image.new("RGB", (320, 160), "white").save(image_path)
            content, width, height, scale_x, scale_y = yandex_ai._prepare_image(image_path, max_edge=100)
            self.assertTrue(content.startswith(b"\xff\xd8"))
            self.assertEqual((width, height), (100, 50))
            self.assertAlmostEqual(scale_x, 3.2)
            self.assertAlmostEqual(scale_y, 3.2)


class YandexProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.image_path = Path(self.temp.name) / "source.png"
        Image.new("RGB", (640, 480), "white").save(self.image_path)

    @patch("yandex_ai._post_json")
    def test_ocr_returns_unverified_handwriting_annotations(self, post_json):
        post_json.return_value = {
            "result": {
                "textAnnotation": {
                    "fullText": "Ду 25",
                    "blocks": [{"lines": [{
                        "text": "Ду 25",
                        "boundingBox": {"vertices": [
                            {"x": 20, "y": 30}, {"x": 100, "y": 30},
                            {"x": 100, "y": 50}, {"x": 20, "y": 50},
                        ]},
                    }]}],
                }
            }
        }
        items, status = yandex_ai.yandex_ocr_annotations(self.image_path, "test-key", "folder-123")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["text"], "Ду 25")
        self.assertEqual(items[0]["source"], "yandex-vision-ocr")
        self.assertFalse(items[0]["verified"])
        self.assertFalse(items[0]["include"])
        self.assertTrue(items[0]["geometry_exclude"])
        self.assertTrue(status["complete"])
        args, kwargs = post_json.call_args
        self.assertEqual(args[0], yandex_ai.OCR_URL)
        self.assertEqual(kwargs, {})
        self.assertEqual(args[1]["Authorization"], "Api-Key test-key")
        self.assertNotIn("x-folder-id", args[1])
        self.assertEqual(args[2]["model"], "handwritten")
        self.assertEqual(args[2]["languageCodes"], ["ru", "en"])

    @patch("yandex_ai._post_json")
    def test_multimodal_routes_are_structured_and_coordinate_checked(self, post_json):
        post_json.return_value = {
            "choices": [{"message": {"content": json.dumps({"routes": [
                {"id": "R1", "points": [[20, 20], [200, 20], [200, 140]], "confidence": 82},
                {"id": "R2", "points": [[-10, 0], [30, 0]], "confidence": 90},
                {"id": "R3", "points": [[20, 20], [22, 20]], "confidence": 90},
            ]})}}],
            "usage": {"total_tokens": 123},
        }
        routes, status = yandex_ai.yandex_semantic_routes(
            self.image_path, "test-key", "folder-123", "qwen3.6-35b-a3b"
        )
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["id"], "YR1")
        self.assertEqual(routes[0]["source"], "yandex-cloud-qwen3.6-35b-a3b")
        self.assertEqual(routes[0]["points"], [[20.0, 20.0], [200.0, 20.0], [200.0, 140.0]])
        self.assertEqual(status["rejected_invalid"], 2)
        self.assertTrue(status["complete"])
        args, _kwargs = post_json.call_args
        self.assertEqual(args[0], yandex_ai.CHAT_URL)
        self.assertEqual(args[2]["model"], "gpt://folder-123/qwen3.6-35b-a3b")
        self.assertEqual(args[2]["response_format"]["type"], "json_schema")
        image_part = args[2]["messages"][0]["content"][1]
        self.assertTrue(image_part["image_url"]["url"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(args[1]["Authorization"], "Api-Key test-key")
        self.assertNotIn("x-folder-id", args[1])

    @patch("yandex_ai._post_json")
    def test_vision_ocr_uses_service_account_folder_without_folder_header(self, post_json):
        post_json.return_value = {"result": {"textAnnotation": {"blocks": []}}}
        items, status = yandex_ai.yandex_ocr_annotations(self.image_path, "test-key", "")
        self.assertEqual(items, [])
        self.assertTrue(status["complete"])
        headers = post_json.call_args.args[1]
        self.assertEqual(headers["Authorization"], "Api-Key test-key")
        self.assertNotIn("x-folder-id", headers)

    @patch("yandex_ai.yandex_semantic_routes")
    @patch("yandex_ai.yandex_ocr_annotations")
    def test_smoke_test_reports_each_provider_separately(self, ocr, vision):
        ocr.return_value = ([{"text": "Ду 25"}], {"complete": True})
        vision.return_value = ([{"id": "R1"}], {"complete": True})
        result = yandex_ai.test_yandex_ai(self.image_path, "test-key", "folder-123")
        self.assertTrue(result["ok"])
        self.assertEqual(result["ocr"]["annotations"], 1)
        self.assertEqual(result["vision"]["routes"], 1)


if __name__ == "__main__":
    unittest.main()
