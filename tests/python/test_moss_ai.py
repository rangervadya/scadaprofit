"""Offline unit tests for MOSS-VL OCR, route parsing and coordinate validation."""
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
        self.image_path = Path(self.temp.name) / "source.png"
        Image.new("RGB", (640, 480), "white").save(self.image_path)

    def tearDown(self):
        self.temp.cleanup()

    def test_prepare_image_resizes_and_returns_pixel_scale(self):
        data, width, height, sx, sy = moss_ai._prepare_image(self.image_path, max_edge=320)
        self.assertTrue(data.startswith(b"\xff\xd8"))
        self.assertEqual((width, height), (320, 240))
        self.assertEqual((sx, sy), (2.0, 2.0))

    def test_response_text_reads_responses_api_output_and_usage(self):
        text, usage = moss_ai._response_text({
            "status": "completed",
            "output": [{"type": "message", "content": [{"type": "output_text", "text": '{"routes": []}'}]}],
            "usage": {"input_tokens": 10, "output_tokens": 4, "total_tokens": 14},
        })
        self.assertEqual(text, '{"routes": []}')
        self.assertEqual(usage["total_tokens"], 14)

    def test_incomplete_response_is_rejected(self):
        with self.assertRaises(moss_ai.MossAIError):
            moss_ai._response_text({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": []})

    def test_json_parser_accepts_fenced_output(self):
        self.assertEqual(moss_ai._parse_json('```json\n{"annotations": []}\n```'), {"annotations": []})

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_ocr_maps_boxes_to_original_pixels(self, upload, request, delete):
        upload.return_value = "file_test"
        request.return_value = {
            "status": "completed",
            "output": [{"content": [{"type": "output_text", "text": json.dumps({"annotations": [
                {"text": "Ду 25", "bbox": [10, 20, 50, 40], "confidence": 72}
            ]}, ensure_ascii=False)}]}],
            "usage": {"input_tokens": 100, "output_tokens": 20, "total_tokens": 120},
        }
        items, status = moss_ai.moss_ocr_annotations(self.image_path, "moss-test-key")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["bbox"], {"x": 10, "y": 20, "w": 40, "h": 20})
        self.assertEqual(items[0]["source"], "moss-vl-ocr")
        self.assertTrue(status["complete"])
        delete.assert_called_once_with("moss-test-key", "file_test", timeout=20.0)

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_ocr_accepts_single_top_level_text_bbox_record(self, upload, request, delete):
        upload.return_value = "file_single_record"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "text": "Ду 25", "bbox": [10, 20, 50, 40], "confidence": 0.84
        }, ensure_ascii=False)}]}]}
        items, status = moss_ai.moss_ocr_annotations(self.image_path, "moss-test-key")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["text"], "Ду 25")
        self.assertEqual(items[0]["confidence"], 84.0)
        self.assertEqual(status["annotations_field"], "$ (single text region)")
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_route_parser_keeps_valid_points_and_rejects_out_of_bounds(self, upload, request, delete):
        upload.return_value = "file_routes"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({"routes": [
            {"id": "R1", "points": [[10, 20], [200, 20]], "confidence": 80},
            {"id": "R2", "points": [[-10, 5], [30, 5]], "confidence": 90},
        ]})}]}], "usage": {"output_tokens": 100}}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        request_payload = json.loads(request.call_args.args[2].decode("utf-8")) if len(request.call_args.args) > 2 else json.loads(request.call_args.kwargs["body"].decode("utf-8"))
        self.assertGreaterEqual(request_payload["max_output_tokens"], 1)
        self.assertLessEqual(request_payload["max_output_tokens"], 8192)
        self.assertEqual(request_payload["max_output_tokens"], moss_ai.MOSS_PIPE_MAX_OUTPUT_TOKENS)
        self.assertEqual(request_payload["max_output_tokens"], 2048)
        self.assertLessEqual(len(request_payload["input"][0]["content"][0]["text"]), 1600)
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[10.0, 20.0], [200.0, 20.0]])
        self.assertEqual(status["raw_routes"], 2)
        self.assertEqual(status["rejected_out_of_bounds"], 1)
        self.assertEqual(status["route_field"], "$.routes")
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_route_parser_accepts_nested_segments_and_xy_objects(self, upload, request, delete):
        upload.return_value = "file_segments"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "result": {"segments": [
                {"id": "S1", "polyline": [{"x": 15, "y": 30}, {"x": 220, "y": 30}], "confidence": 70}
            ]}
        })}]}]}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[15.0, 30.0], [220.0, 30.0]])
        self.assertEqual(status["route_field"], "$.result.segments")
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_route_parser_accepts_direct_point_array_and_normalized_coordinates(self, upload, request, delete):
        upload.return_value = "file_normalized"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "coordinate_space": "normalized_0_1", "routes": [[0.1, 0.5], [0.9, 0.5]]
        })}]}]}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[64.0, 240.0], [576.0, 240.0]])
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_empty_routes_are_explicitly_reported(self, upload, request, delete):
        upload.return_value = "file_empty"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": '{"routes": [], "review_note": "no visible pipe strokes"}'}]}]}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(routes, [])
        self.assertEqual(status["result_state"], "model_returned_empty_routes")
        self.assertIn("пустой список", status["error"])
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_ocr_accepts_nested_single_text_bbox_record(self, upload, request, delete):
        upload.return_value = "file_nested_single_record"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "result": {"text": "Ø 32", "bbox": {"x": 20, "y": 30, "width": 48, "height": 16}}
        }, ensure_ascii=False)}]}]}
        items, status = moss_ai.moss_ocr_annotations(self.image_path, "moss-test-key")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["text"], "Ø 32")
        self.assertEqual(items[0]["bbox"], {"x": 20, "y": 30, "w": 48, "h": 16})
        self.assertEqual(status["annotations_field"], "$.result (single text region)")
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_ocr_accepts_polygon_coordinates(self, upload, request, delete):
        upload.return_value = "file_polygon"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "texts": [{"content": "DN 25", "polygon": [[12, 18], [62, 16], [64, 34], [14, 36]]}]
        }, ensure_ascii=False)}]}]}
        items, status = moss_ai.moss_ocr_annotations(self.image_path, "moss-test-key")
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["bbox"], {"x": 12, "y": 16, "w": 52, "h": 20})
        self.assertEqual(status["annotations_field"], "$.texts")
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_ocr_missing_regions_reports_only_json_keys(self, upload, request, delete):
        upload.return_value = "file_missing_regions"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "summary": "Sensitive handwritten address must not be echoed", "review_note": "no boxes"
        }, ensure_ascii=False)}]}]}
        with self.assertRaises(moss_ai.MossAIError) as caught:
            moss_ai.moss_ocr_annotations(self.image_path, "moss-test-key")
        self.assertIn("Поля JSON: review_note, summary", str(caught.exception))
        self.assertNotIn("Sensitive handwritten address", str(caught.exception))
        delete.assert_called_once()

    @patch("moss_ai.urllib.request.urlopen")
    def test_upload_uses_bearer_key_and_multipart_image_purpose(self, urlopen):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _size): return b'{"id":"file_uploaded_1"}'
        urlopen.return_value = FakeResponse()
        file_id = moss_ai._upload_image("moss-secret-key", b"JPEGDATA", timeout=10)
        request = urlopen.call_args.args[0]
        self.assertEqual(file_id, "file_uploaded_1")
        self.assertEqual(request.get_header("Authorization"), "Bearer moss-secret-key")
        self.assertIn("multipart/form-data", request.get_header("Content-type"))
        self.assertIn(b'name="purpose"', request.data)
        self.assertIn(b'image', request.data)
        self.assertIn(b'name="file"', request.data)

    @patch("moss_ai.urllib.request.urlopen")
    def test_api_error_never_exposes_api_key(self, urlopen):
        error = __import__("urllib.error").error.HTTPError(
            moss_ai.RESPONSES_URL, 401, "Unauthorized", {},
            __import__("io").BytesIO(b'{"error":{"message":"bad token"}}')
        )
        urlopen.side_effect = error
        with self.assertRaises(moss_ai.MossAIError) as caught:
            moss_ai._request_json("moss-secret-key", moss_ai.RESPONSES_URL, body=b"{}", timeout=10)
        self.assertNotIn("moss-secret-key", str(caught.exception))
        self.assertIn("HTTP 401", str(caught.exception))

    @patch("moss_ai.urllib.request.urlopen")
    def test_http_524_explains_provider_gateway_timeout(self, urlopen):
        error = __import__("urllib.error").error.HTTPError(
            moss_ai.RESPONSES_URL, 524, "Gateway Timeout", {},
            __import__("io").BytesIO(b"upstream timeout")
        )
        urlopen.side_effect = error
        with self.assertRaises(moss_ai.MossAIError) as caught:
            moss_ai._request_json("moss-test-key", moss_ai.RESPONSES_URL, body=b"{}", timeout=10)
        message = str(caught.exception)
        self.assertIn("HTTP 524", message)
        self.assertIn("синхронный ответ", message)
        self.assertNotIn("moss-test-key", message)

    def test_pipe_request_limits_are_below_gateway_risk(self):
        self.assertEqual(moss_ai.MOSS_PIPE_MAX_OUTPUT_TOKENS, 2048)
        self.assertLessEqual(moss_ai.MOSS_PIPE_MAX_OUTPUT_TOKENS, 8192)
        self.assertEqual(moss_ai.MOSS_PIPE_MAX_ROUTES, 32)
        self.assertEqual(moss_ai.MOSS_PIPE_MAX_POINTS, 64)


    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_route_parser_accepts_flat_coordinates_and_qualitative_confidence(self, upload, request, delete):
        upload.return_value = "file_flat_coords"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "routes": [{"id": "F1", "coordinates": [10, 20, 200, 20], "confidence": "high"}]
        })}]}], "usage": {"output_tokens": 40}}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[10.0, 20.0], [200.0, 20.0]])
        self.assertEqual(routes[0]["confidence"], 75.0)
        self.assertTrue(routes[0]["confidence_assumed"])
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_route_parser_accepts_points_object_with_start_and_end(self, upload, request, delete):
        upload.return_value = "file_endpoint_object"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "routes": [{"id": "E1", "points": {"start": {"x": 10, "y": 20}, "end": {"x": 240, "y": 20}}, "score": 0.9}]
        })}]}]}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[10.0, 20.0], [240.0, 20.0]])
        self.assertEqual(routes[0]["confidence"], 90.0)
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_invalid_route_logs_safe_schema_details(self, upload, request, delete):
        upload.return_value = "file_bad_shape"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "routes": [{"id": "bad", "path_data": {"unexpected": "shape"}, "confidence": "high"}]
        })}]}]}
        with patch("moss_ai._progress") as progress:
            routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(routes, [])
        self.assertEqual(status["result_state"], "all_routes_rejected_by_parser")
        self.assertTrue(any("Route rejection schema" in call.args[0] for call in progress.call_args_list))
        diagnostic = status["route_diagnostics"][0]
        self.assertEqual(diagnostic["reason"], "invalid-points")
        self.assertIn("path_data", diagnostic["shape"]["keys"])
        delete.assert_called_once()

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_route_parser_accepts_geojson_linestring_geometry(self, upload, request, delete):
        upload.return_value = "file_geojson"
        request.return_value = {"status": "completed", "output": [{"content": [{"type": "output_text", "text": json.dumps({
            "routes": [{"id": "G1", "geometry": {"type": "LineString", "coordinates": [[10, 20], [150, 20], [150, 80]]}, "confidence": "medium"}]
        })}]}]}
        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[10.0, 20.0], [150.0, 20.0], [150.0, 80.0]])
        self.assertEqual(routes[0]["confidence"], 60.0)
        delete.assert_called_once()


    def test_route_point_list_preserves_single_coordinate_as_one_point(self):
        points = moss_ai._route_point_list({"points": [[10, 20]]})
        self.assertEqual(points, [[10, 20]])
        self.assertEqual(len(points), 1)
        self.assertTrue(moss_ai._is_point(points[0]))

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_single_point_candidate_triggers_one_focused_moss_retry(self, upload, request, delete):
        upload.return_value = "file_single_point_retry"

        def response(routes, output_tokens=40):
            return {
                "status": "completed",
                "output": [{"content": [{"type": "output_text", "text": json.dumps({"routes": routes})}]}],
                "usage": {"output_tokens": output_tokens},
            }

        request.side_effect = [
            response([{"id": "R1", "points": [[10, 20]], "confidence": 90}], 24),
            response([{"id": "R1", "points": [[10, 20], [220, 20]], "confidence": 80}], 38),
        ]

        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")

        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["points"], [[10.0, 20.0], [220.0, 20.0]])
        self.assertTrue(status["retry"]["attempted"])
        self.assertEqual(status["retry"]["reason"], "single-point-route-candidates")
        self.assertEqual(status["retry"]["initial_single_point_routes"], 1)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(upload.call_count, 2)
        self.assertEqual(delete.call_count, 2)
        retry_payload = json.loads(request.call_args_list[1].kwargs["body"].decode("utf-8"))
        retry_prompt = retry_payload["input"][0]["content"][0]["text"]
        self.assertIn("минимум ДВЕ РАЗНЫЕ точки", retry_prompt)

    @patch("moss_ai._delete_image")
    @patch("moss_ai._request_json")
    @patch("moss_ai._upload_image")
    def test_single_point_retry_never_invents_a_second_endpoint(self, upload, request, delete):
        upload.return_value = "file_single_point_stays_invalid"
        one_point = {
            "status": "completed",
            "output": [{"content": [{"type": "output_text", "text": json.dumps({
                "routes": [{"id": "R1", "points": [[25, 40]], "confidence": 90}]
            })}]}],
            "usage": {"output_tokens": 24},
        }
        request.side_effect = [one_point, one_point]

        routes, status = moss_ai.moss_semantic_routes(self.image_path, "moss-test-key")

        self.assertEqual(routes, [])
        self.assertTrue(status["retry_attempt"])
        self.assertEqual(status["rejected_single_point"], 1)
        self.assertEqual(status["rejected_too_short"], 1)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(delete.call_count, 2)



if __name__ == "__main__":
    unittest.main()
