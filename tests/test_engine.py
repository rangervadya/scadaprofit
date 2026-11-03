import sys
import unittest
import json
import os
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import processor


class GraphTests(unittest.TestCase):
    def test_near_endpoints_are_snapped_to_same_node(self):
        segments = [
            {"x1": 10.0, "y1": 10.0, "x2": 40.0, "y2": 10.0, "source": "LSD", "support": .9, "length": 30, "angle": 0},
            {"x1": 43.0, "y1": 11.0, "x2": 70.0, "y2": 10.0, "source": "HOUGH", "support": .9, "length": 27, "angle": 0},
        ]
        nodes, edges, components = processor.endpoint_clusters(segments, radius=4.5)
        self.assertEqual(len(edges), 2)
        self.assertEqual(edges[0]["to"], edges[1]["from"])
        self.assertEqual(edges[0]["geometry"][-1], edges[1]["geometry"][0])

    def test_clean_cad_keeps_route_and_suppresses_short_symbol_stubs(self):
        segments = [
            {"x1": 10.0, "y1": 50.0, "x2": 50.0, "y2": 50.0, "source": "LSD", "support": .95, "length": 40, "angle": 0},
            {"x1": 50.0, "y1": 50.0, "x2": 100.0, "y2": 50.0, "source": "LSD", "support": .95, "length": 50, "angle": 0},
            # A short valve / hand-mark stroke attached to the main route.
            {"x1": 50.0, "y1": 50.0, "x2": 50.0, "y2": 36.0, "source": "HOUGH", "support": .85, "length": 14, "angle": 90},
        ]
        nodes, edges, _ = processor.endpoint_clusters(segments)
        stats = processor.select_primary_cad_edges(nodes, edges, 900)
        self.assertEqual(stats["cad_primary_edges"], 2)
        main = [edge for edge in edges if edge["cad_include"]]
        review = [edge for edge in edges if not edge["cad_include"]]
        self.assertEqual(len(main), 2)
        self.assertEqual(len(review), 1)
        self.assertEqual(review[0]["cad_reason"], "short-symbol-stub")
        self.assertTrue(all(edge["cad_reason"] == "collinear-continuation" for edge in main))

    def test_short_collinear_continuation_survives_clean_selection(self):
        segments = [
            {"x1": 10.0, "y1": 20.0, "x2": 100.0, "y2": 20.0, "source": "LSD", "support": .95, "length": 90, "angle": 0},
            {"x1": 105.0, "y1": 20.0, "x2": 120.0, "y2": 20.0, "source": "HOUGH", "support": .9, "length": 15, "angle": 0},
        ]
        nodes, edges, _ = processor.endpoint_clusters(segments)
        processor.select_primary_cad_edges(nodes, edges, 900)
        self.assertTrue(all(edge["cad_include"] for edge in edges))

    def test_isolated_short_mark_is_not_in_clean_sheet(self):
        segments = [
            {"x1": 20.0, "y1": 20.0, "x2": 55.0, "y2": 20.0, "source": "LSD", "support": .9, "length": 35, "angle": 0},
        ]
        nodes, edges, _ = processor.endpoint_clusters(segments)
        processor.select_primary_cad_edges(nodes, edges, 900)
        self.assertFalse(edges[0]["cad_include"])
        self.assertEqual(edges[0]["cad_reason"], "isolated-mark")

    def test_crossing_is_not_auto_joined(self):
        segments = [
            {"x1": 10.0, "y1": 50.0, "x2": 90.0, "y2": 50.0, "source": "LSD", "support": .8, "length": 80, "angle": 0},
            {"x1": 50.0, "y1": 10.0, "x2": 50.0, "y2": 90.0, "source": "LSD", "support": .8, "length": 80, "angle": 90},
        ]
        crossings = processor.detect_crossings(segments)
        self.assertEqual(len(crossings), 1)
        self.assertEqual(crossings[0]["status"], "needs_review")

    def test_unconfirmed_ocr_box_keeps_underlying_line_candidate(self):
        gray = np.full((100, 160), 255, np.uint8)
        ink = np.zeros((100, 160), np.uint8)
        cv2.line(gray, (15, 50), (145, 50), 35, 2, cv2.LINE_AA)
        cv2.line(ink, (15, 50), (145, 50), 255, 2, cv2.LINE_AA)
        annotations = [{"id": "T1", "bbox": {"x": 55, "y": 40, "w": 45, "h": 20}}]
        candidates = processor.extract_segments(gray, ink, annotations)
        self.assertTrue(candidates)
        self.assertTrue(any(x["ocr_overlap"] > 0 for x in candidates))
        # OCR overlap is metadata and must not subtract the underlying geometry.
        self.assertTrue(any(x["length"] > 100 for x in candidates))

    def test_ocr_overlap_does_not_reclassify_long_trace(self):
        segments = [
            {"x1": 10.0, "y1": 20.0, "x2": 60.0, "y2": 20.0, "source": "LSD", "support": .9, "length": 50, "angle": 0, "ocr_overlap": 1.0},
            {"x1": 60.0, "y1": 20.0, "x2": 110.0, "y2": 20.0, "source": "HOUGH", "support": .9, "length": 50, "angle": 0, "ocr_overlap": 1.0},
        ]
        _, edges, components = processor.endpoint_clusters(segments)
        self.assertEqual(len(edges), 2)
        self.assertTrue(all(edge["component_role"] == "line_structure" for edge in edges))

    def test_confirmed_ocr_text_strokes_are_removed_but_pipe_through_box_survives(self):
        gray = np.full((100, 160), 255, np.uint8)
        ink = np.zeros((100, 160), np.uint8)
        # Continuous pipe crossing the label area.
        cv2.line(gray, (10, 50), (150, 50), 25, 2, cv2.LINE_AA)
        cv2.line(ink, (10, 50), (150, 50), 255, 2, cv2.LINE_AA)
        # A vertical glyph stroke, fully contained by the OCR box.
        cv2.line(gray, (70, 42), (70, 58), 25, 2, cv2.LINE_AA)
        cv2.line(ink, (70, 42), (70, 58), 255, 2, cv2.LINE_AA)
        annotations = [{"id": "A1", "text": "DN 50", "bbox": {"x": 55, "y": 38, "w": 40, "h": 24},
                        "verified": True, "include": True, "source": "qwen3-vl"}]
        candidates = processor.extract_segments(gray, ink, annotations)
        self.assertTrue(any(item['length'] > 100 for item in candidates), 'pipe must pass through OCR box')
        self.assertFalse(any(abs(item['x1'] - 70) < 5 and abs(item['x2'] - 70) < 5 and item['length'] < 30 for item in candidates),
                         'glyph stroke must not be exported as a pipe')

    def test_unconfirmed_ocr_box_does_not_remove_geometry(self):
        gray = np.full((80, 120), 255, np.uint8)
        ink = np.zeros((80, 120), np.uint8)
        cv2.line(gray, (20, 40), (100, 40), 25, 2, cv2.LINE_AA)
        cv2.line(ink, (20, 40), (100, 40), 255, 2, cv2.LINE_AA)
        annotations = [{"bbox": {"x": 35, "y": 28, "w": 45, "h": 24}, "verified": False, "include": False}]
        candidates = processor.extract_segments(gray, ink, annotations)
        self.assertTrue(any(item['length'] > 70 for item in candidates))

    def test_cad_export_joins_edges_and_squares_nearly_orthogonal_corner(self):
        edges = [
            {"id": "E1", "from": "N1", "to": "N2", "geometry": [[10, 10], [50, 10.8]], "component_role": "line_structure"},
            {"id": "E2", "from": "N2", "to": "N3", "geometry": [[50, 10.8], [50.7, 60]], "component_role": "line_structure"},
        ]
        chains = processor._cad_edge_chains(edges)
        self.assertEqual(len(chains), 1)
        self.assertEqual(len(chains[0]), 3)
        self.assertAlmostEqual(chains[0][1][0], 50.7, delta=0.1)
        self.assertAlmostEqual(chains[0][1][1], 10.0, delta=0.1)
        svg = processor.build_clean_svg(100, 100, edges, [])
        self.assertEqual(svg.count('<polyline points='), 1)

    def test_svg_and_dxf_keep_short_line_components_thin(self):
        edges = [{"geometry": [[0, 0], [12, 0]], "component_role": "line_structure"}]
        svg = processor.build_clean_svg(120, 120, edges, [])
        dxf = processor.build_dxf(120, 120, edges, [])
        self.assertIn("<polyline points=", svg)
        self.assertIn('stroke-width="', svg)
        self.assertIn("370\n13", dxf)

    def test_short_collinear_continuation_is_kept_as_line_candidate(self):
        segments = [
            {"x1": 10.0, "y1": 20.0, "x2": 100.0, "y2": 20.0, "source": "LSD", "support": .95, "length": 90, "angle": 0, "ocr_overlap": 0},
            {"x1": 105.0, "y1": 20.0, "x2": 120.0, "y2": 20.0, "source": "HOUGH", "support": .9, "length": 15, "angle": 0, "ocr_overlap": 0},
        ]
        _, edges, components = processor.endpoint_clusters(segments)
        short_edge = min(edges, key=lambda edge: sum((edge["geometry"][1][i] - edge["geometry"][0][i]) ** 2 for i in (0, 1)))
        self.assertEqual(short_edge["component_role"], "line_structure")
        self.assertTrue(short_edge.get("continuation_candidate"))

    def test_qwen_annotation_coordinates_are_scaled_and_confident_text_preselected(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / "source.png"
            from PIL import Image as PILImage
            PILImage.new('RGB', (4000, 2000), 'white').save(image_path)
            response_body = {
                "message": {"content": json.dumps({"annotations": [
                    {"text": "DN 50", "bbox": {"x": 100, "y": 80, "w": 60, "h": 20}, "confidence": 92},
                    {"text": "?", "bbox": {"x": 300, "y": 100, "w": 20, "h": 18}, "confidence": 41},
                ]})}
            }
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {"QWEN_MAX_IMAGE_EDGE": "2000", "QWEN_OCR_TILE_GRID": "1", "QWEN_OCR_TIMEOUT": "20", "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}), \
                 patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                annotations, status = processor._qwen_annotations(str(image_path), 4000, 2000)
            self.assertTrue(status["available"])
            self.assertEqual(annotations[0]["bbox"], {"x": 200, "y": 160, "w": 120, "h": 40})
            self.assertTrue(annotations[0]["include"])
            self.assertFalse(annotations[1]["include"])


    def test_low_confidence_ocr_box_can_mask_glyphs_without_cutting_a_pipe(self):
        gray = np.full((100, 160), 255, np.uint8)
        ink = np.zeros((100, 160), np.uint8)
        cv2.line(gray, (10, 50), (150, 50), 25, 2, cv2.LINE_AA)
        cv2.line(ink, (10, 50), (150, 50), 255, 2, cv2.LINE_AA)
        cv2.line(gray, (70, 42), (70, 58), 25, 2, cv2.LINE_AA)
        cv2.line(ink, (70, 42), (70, 58), 255, 2, cv2.LINE_AA)
        annotations = [{"text": "5?", "bbox": {"x": 55, "y": 38, "w": 40, "h": 24},
                        "confidence": 44, "verified": False, "include": False,
                        "geometry_exclude": True}]
        candidates = processor.extract_segments(gray, ink, annotations)
        self.assertTrue(any(item['length'] > 100 for item in candidates))
        self.assertFalse(any(abs(item['x1'] - 70) < 5 and abs(item['x2'] - 70) < 5 for item in candidates))

    def test_qwen_tiled_ocr_upsamples_small_handwriting_and_maps_coordinates(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            response_body = {"message": {"content": json.dumps({"annotations": [
                {"text": "1500", "bbox": {"x": 100, "y": 80, "w": 60, "h": 20}, "confidence": 91}
            ]})}}
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {"QWEN_MAX_IMAGE_EDGE": "1200", "QWEN_OCR_TILE_GRID": "2",
                "QWEN_OCR_UPSCALE": "2", "QWEN_OCR_TIMEOUT": "20",
                "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}), \
                 patch('processor.urllib.request.urlopen', return_value=FakeResponse()) as request_mock:
                annotations, status = processor._qwen_annotations(str(image_path), 1000, 800)
            self.assertTrue(status['available'])
            self.assertEqual(status['successful_tiles'], 4)
            self.assertGreaterEqual(request_mock.call_count, 4)
            self.assertEqual(annotations[0]['bbox'], {"x": 50, "y": 40, "w": 30, "h": 10})
            self.assertTrue(annotations[0]['geometry_exclude'])

    def test_semantic_routes_are_requested_per_overlapping_tile_and_clipped_to_core(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            calls = []
            def fake_qwen_call(image, prompt, **kwargs):
                calls.append((image.size, prompt))
                return ({'routes': [{'id': 'R', 'points': [[0, 100], [600, 100]], 'confidence': 80}]}, 1.0, image.size)
            with patch.dict(os.environ, {
                'QWEN_PIPE_TILE_GRID': '2', 'QWEN_PIPE_UPSCALE': '1.0',
                'QWEN_PIPE_TILE_OVERLAP': '0.14', 'QWEN_PIPE_MAX_IMAGE_EDGE': '2000',
                'QWEN_PIPE_TRACE_TIMEOUT': '30', 'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat',
                'QWEN_MODEL': 'qwen3-vl:4b-instruct'
            }, clear=False), patch('processor._qwen_call', side_effect=fake_qwen_call):
                routes, status = processor._qwen_semantic_routes(str(image_path), 1000, 800)
            self.assertEqual(len(calls), 4)
            self.assertEqual(status['tiles'], 4)
            self.assertEqual(status['successful_tiles'], 4)
            self.assertEqual(len(routes), 4)
            # Tile 1 owns x=0..500; tile 2 owns x=500..1000; crop overlap is not double-exported.
            top_left = next(route for route in routes if route['tile'] == 1)
            top_right = next(route for route in routes if route['tile'] == 2)
            self.assertEqual(top_left['points'], [[0.0, 100.0], [500.0, 100.0]])
            self.assertEqual(top_right['points'], [[500.0, 100.0], [999.0, 100.0]])
            self.assertEqual(status['strategy'], 'overlapping semantic tiles clipped to non-overlapping cores')

    def test_qwen_empty_ocr_reports_tile_diagnostics(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            response_body = {'message': {'content': json.dumps({'annotations': []})},
                             'done': True, 'done_reason': 'stop', 'eval_count': 22, 'prompt_eval_count': 1500}
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {'QWEN_OCR_TILE_GRID': '1', 'QWEN_OCR_UPSCALE': '1',
                'QWEN_MAX_IMAGE_EDGE': '1200', 'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat',
                'QWEN_MODEL': 'qwen3-vl:4b-instruct'}, clear=False), \
                 patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                annotations, status = processor._qwen_annotations(str(image_path), 1000, 800)
            self.assertEqual(annotations, [])
            self.assertTrue(status['available'])
            self.assertTrue(status['empty_result'])
            tile = status['tile_diagnostics'][0]
            self.assertEqual(tile['done_reason'], 'stop')
            self.assertEqual(tile['eval_count'], 22)
            self.assertEqual(tile['json_keys'], ['annotations'])
            self.assertEqual(tile['raw_annotations'], 0)

    def test_qwen_semantic_pipe_routes_scale_to_original_image(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (4000, 2000), 'white').save(image_path)
            response_body = {"message": {"content": json.dumps({"routes": [
                {"id": "P1", "points": [[100, 80], [400, 80]], "confidence": 92},
                {"id": "P2", "points": [[100, 100], [120, 110]], "confidence": 30}
            ]})}}
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {"QWEN_PIPE_MAX_IMAGE_EDGE": "2000", "QWEN_PIPE_TRACE_TIMEOUT": "20",
                "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}), \
                 patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                routes, status = processor._qwen_semantic_routes(str(image_path), 4000, 2000)
            self.assertTrue(status['available'])
            self.assertEqual(len(routes), 1)
            self.assertEqual(routes[0]['points'], [[200.0, 160.0], [800.0, 160.0]])


    def test_qwen_route_without_confidence_is_not_silently_discarded(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            response_body = {"message": {"content": json.dumps({"routes": [
                {"id": "P1", "points": [[100, 100], [800, 100], [800, 600]]}
            ]})}}
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {"QWEN_PIPE_MAX_IMAGE_EDGE": "2000", "QWEN_PIPE_TRACE_TIMEOUT": "20",
                "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}, clear=False),                  patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                routes, status = processor._qwen_semantic_routes(str(image_path), 1000, 800)
            self.assertEqual(len(routes), 1)
            self.assertEqual(routes[0]['confidence'], 60)
            self.assertTrue(routes[0]['confidence_assumed'])
            self.assertTrue(status['available'])

    def test_qwen_accepts_simple_coordinate_array_as_single_route(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            response_body = {"message": {"content": json.dumps({"routes": [[100, 100], [800, 100]]})}}
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {"QWEN_PIPE_MAX_IMAGE_EDGE": "2000", "QWEN_PIPE_TRACE_TIMEOUT": "20",
                "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}, clear=False),                  patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                routes, status = processor._qwen_semantic_routes(str(image_path), 1000, 800)
            self.assertEqual(len(routes), 1)
            self.assertEqual(routes[0]['points'], [[100.0, 100.0], [800.0, 100.0]])

    def test_empty_qwen_routes_produce_actionable_diagnostic(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            response_body = {"message": {"content": json.dumps({"routes": []})}}
            class FakeResponse:
                def __enter__(self): return self
                def __exit__(self, *_args): return False
                def read(self): return json.dumps(response_body).encode('utf-8')
            with patch.dict(os.environ, {"QWEN_PIPE_MAX_IMAGE_EDGE": "2000", "QWEN_PIPE_TRACE_TIMEOUT": "20",
                "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}, clear=False),                  patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                routes, status = processor._qwen_semantic_routes(str(image_path), 1000, 800)
            self.assertEqual(routes, [])
            self.assertTrue(status['available'])
            self.assertIn('пустой список', status['error'])
            self.assertTrue(status['hint'])


    def test_missing_ollama_model_error_includes_pull_command(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            with patch.dict(os.environ, {"QWEN_PIPE_TRACE_TIMEOUT": "20", "OLLAMA_CHAT_URL": "http://ollama.test/api/chat",
                "QWEN_MODEL": "qwen3-vl:4b"}, clear=False), \
                 patch('processor.urllib.request.urlopen', side_effect=RuntimeError("Ollama HTTP 404: model 'qwen3-vl:4b' not found")):
                routes, status = processor._qwen_semantic_routes(str(image_path), 1000, 800)
            self.assertEqual(routes, [])
            self.assertFalse(status['available'])
            self.assertIn('не найдена', status['error'])
            self.assertIn('ollama pull qwen3-vl:4b', status['hint'])

    def test_qwen_routes_do_not_replace_selected_opencv_primary_geometry(self):
        selected_edges = [
            {"id": "E1", "from": "N1", "to": "N2", "geometry": [[10, 10], [20, 90]],
             "cad_include": True, "component_role": "line_structure"},
            {"id": "E2", "from": "N2", "to": "N3", "geometry": [[20, 90], [110, 100]],
             "cad_include": True, "component_role": "line_structure"},
        ]
        # Deliberately different Qwen coordinates: suggestions must not erase
        # the selected detector geometry from the primary clean drawing.
        routes = [{"id": "P1", "points": [[10, 10], [100, 10], [100, 100]], "confidence": 90, "include": True}]
        svg = processor.build_clean_svg(120, 120, selected_edges, [], semantic_routes=routes)
        self.assertEqual(svg.count('<polyline points='), 1)
        self.assertIn('10.00,10.00 20.00,90.00 110.00,100.00', svg)
        self.assertNotIn('100.00,10.00 100.00,100.00', svg)
        dxf = processor.build_dxf(120, 120, selected_edges, [], semantic_routes=routes)
        self.assertIn('8\nPIPE_MAIN\n100\nAcDbPolyline', dxf)
        self.assertIn('QWEN_REVIEW', dxf)
        self.assertIn('QWEN_REVIEW\n70\n1', dxf)


    def test_empty_semantic_trace_does_not_suppress_selected_opencv_primary_geometry(self):
        edges = [{"id": "E1", "from": "N1", "to": "N2", "geometry": [[10, 10], [110, 10]],
                  "cad_include": True, "component_role": "line_structure"}]
        svg = processor.build_clean_svg(120, 120, edges, [], semantic_routes=[])
        self.assertEqual(svg.count('<polyline points='), 1)
        self.assertNotIn('НЕ НАЙДЕНЫ ОСНОВНЫЕ ГЕОМЕТРИЧЕСКИЕ ЛИНИИ', svg)
        dxf = processor.build_dxf(120, 120, edges, [], semantic_routes=[])
        self.assertIn('8\nPIPE_MAIN\n100\nAcDbPolyline', dxf)
        self.assertIn('DETAIL_REVIEW\n70\n1', dxf)
        self.assertIn('QWEN_REVIEW\n70\n1', dxf)

    def test_lsd_and_hough_edges_of_one_thick_stroke_collapse_to_one_candidate(self):
        image = np.full((180, 260, 3), 255, np.uint8)
        cv2.line(image, (20, 90), (240, 90), (20, 20, 20), 2, cv2.LINE_AA)
        gray, _ = processor.normalize_document(image)
        ink = processor.make_ink_mask(image, gray)
        candidates = processor.extract_segments(gray, ink, [])
        self.assertEqual(len(candidates), 1)
        self.assertGreater(candidates[0]['length'], 200)

    def test_duplicate_segments_merge_but_separate_parallel_strokes_survive(self):
        ink = np.zeros((120, 180), np.uint8)
        cv2.line(ink, (10, 35), (160, 35), 255, 2)
        cv2.line(ink, (10, 80), (160, 80), 255, 2)
        dilated = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=1)
        first = {"x1": 10., "y1": 34., "x2": 100., "y2": 34., "length": 90., "angle": 0., "source": "LSD", "support": .9, "ocr_overlap": 0}
        repeat = {"x1": 20., "y1": 36., "x2": 150., "y2": 36., "length": 130., "angle": 0., "source": "HOUGH", "support": .8, "ocr_overlap": 0}
        merged = processor._merge_aligned_duplicate(first, repeat, ink, dilated, continuity_gap=5)
        self.assertIsNotNone(merged)
        self.assertGreater(merged["length"], 130)
        parallel = {"x1": 10., "y1": 80., "x2": 150., "y2": 80., "length": 140., "angle": 0., "source": "HOUGH", "support": .9, "ocr_overlap": 0}
        self.assertIsNone(processor._merge_aligned_duplicate(first, parallel, ink, dilated, continuity_gap=5))

        # A one-pixel white gap between close parallel marks is a real separation.
        close_ink = np.zeros((60, 180), np.uint8)
        cv2.line(close_ink, (10, 25), (160, 25), 255, 1)
        cv2.line(close_ink, (10, 27), (160, 27), 255, 1)
        close_dilated = cv2.dilate(close_ink, np.ones((3, 3), np.uint8), iterations=1)
        close_first = {**first, 'y1': 25., 'y2': 25.}
        close_parallel = {**parallel, 'y1': 27., 'y2': 27.}
        self.assertIsNone(processor._merge_aligned_duplicate(
            close_first, close_parallel, close_ink, close_dilated, continuity_gap=5))

    def test_svg_has_separate_verified_text(self):
        edges = [{"geometry": [[0, 0], [100, 100]], "component_role": "line_structure"}]
        annotations = [{"verified": True, "text": "DN 50", "bbox": {"x": 20, "y": 20, "w": 30, "h": 10}}]
        svg = processor.build_clean_svg(120, 120, edges, annotations)
        self.assertIn("<polyline", svg)
        self.assertIn("DN 50", svg)
        self.assertIn("fill=\"#fff\"", svg)
        self.assertIn("stroke=\"#15191d\"", svg)

    def test_dxf_keeps_removed_marks_on_frozen_review_layer(self):
        edges = [
            {"id": "E1", "from": "N1", "to": "N2", "geometry": [[0, 0], [100, 0]], "component_role": "line_structure", "cad_include": True},
            {"id": "E2", "from": "N2", "to": "N3", "geometry": [[100, 0], [100, 12]], "component_role": "line_structure", "cad_include": False},
        ]
        dxf = processor.build_dxf(120, 120, edges, [])
        self.assertIn("PIPE_MAIN", dxf)
        self.assertIn("DETAIL_REVIEW", dxf)
        # DXF layer flag 1 means frozen by default.
        self.assertIn("DETAIL_REVIEW\n70\n1", dxf)

    def test_dxf_has_pipe_and_verified_text_layers(self):
        edges = [{"geometry": [[0, 0], [100, 100]], "component_role": "line_structure"}]
        annotations = [{"verified": True, "text": "DN50", "bbox": {"x": 12, "y": 15, "w": 25, "h": 9}}]
        dxf = processor.build_dxf(120, 120, edges, annotations)
        self.assertIn("PIPE_MAIN", dxf)
        self.assertIn("370\n13", dxf)
        self.assertIn("VERIFIED_TEXT", dxf)
        self.assertIn("DN50", dxf)
        self.assertIn("9\n$INSUNITS\n70\n4", dxf)
        self.assertIn("100\nAcDbPolyline", dxf)


    def test_ocr_uses_separate_output_token_budget(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            with patch.dict(os.environ, {
                'QWEN_OCR_TILE_GRID': '1', 'QWEN_OCR_MAX_TOKENS': '700',
                'QWEN_OCR_TIMEOUT': '180', 'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat',
                'QWEN_MODEL': 'qwen3-vl:4b-instruct'
            }, clear=False), patch('processor._qwen_call', return_value=({'annotations': []}, 1.0, (1000, 800))) as call:
                annotations, status = processor._qwen_annotations(str(image_path), 1000, 800)
            self.assertTrue(status['available'])
            self.assertEqual(call.call_args.kwargs['num_predict'], 700)

    def test_semantic_routes_use_separate_output_token_budget(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            response = {'routes': [{'id': 'P1', 'points': [[100, 100], [900, 100]], 'confidence': 80}]}
            with patch.dict(os.environ, {
                'QWEN_PIPE_MAX_TOKENS': '1200', 'QWEN_PIPE_TRACE_TIMEOUT': '240',
                'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat', 'QWEN_MODEL': 'qwen3-vl:4b-instruct'
            }, clear=False), patch('processor._qwen_call', return_value=(response, 1.0, (1000, 800))) as call:
                routes, status = processor._qwen_semantic_routes(str(image_path), 1000, 800)
            self.assertTrue(status['available'])
            self.assertEqual(len(routes), 1)
            self.assertEqual(call.call_args.kwargs['num_predict'], 1200)

    def test_qwen_call_serializes_requested_num_predict(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self):
                return json.dumps({'message': {'content': '{"ok":true}'}}).encode('utf-8')
        from PIL import Image as PILImage
        image = PILImage.new('RGB', (32, 24), 'white')
        with patch('processor.urllib.request.urlopen', return_value=FakeResponse()) as mocked:
            processor._qwen_call(image, 'return json', url='http://ollama.test/api/chat',
                                  model='qwen3-vl:4b-instruct', timeout=10, max_edge=64, num_predict=777)
        payload = json.loads(mocked.call_args.args[0].data.decode('utf-8'))
        self.assertEqual(payload['options']['num_predict'], 777)


    def test_qwen_ocr_and_pipe_calls_use_required_structured_schemas(self):
        with TemporaryDirectory() as temp:
            image_path = Path(temp) / 'source.png'
            from PIL import Image as PILImage
            PILImage.new('RGB', (1000, 800), 'white').save(image_path)
            with patch.dict(os.environ, {
                'QWEN_OCR_TILE_GRID': '1', 'QWEN_OCR_UPSCALE': '1', 'QWEN_OCR_MAX_TOKENS': '2048',
                'QWEN_PIPE_TILE_GRID': '1', 'QWEN_PIPE_UPSCALE': '1', 'QWEN_PIPE_MAX_TOKENS': '2048',
                'QWEN_MAX_IMAGE_EDGE': '1200', 'QWEN_PIPE_MAX_IMAGE_EDGE': '1200',
                'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat', 'QWEN_MODEL': 'qwen3-vl:4b-instruct'
            }, clear=False), patch('processor._qwen_call', return_value=({'annotations': []}, 1.0, (1000, 800))) as call:
                processor._qwen_annotations(str(image_path), 1000, 800)
                ocr_kwargs = call.call_args.kwargs
                self.assertEqual(ocr_kwargs['num_predict'], 2048)
                self.assertEqual(ocr_kwargs['format_schema']['required'], ['annotations'])
                self.assertEqual(ocr_kwargs['format_schema']['properties']['annotations']['maxItems'], 48)

            with patch.dict(os.environ, {
                'QWEN_PIPE_TILE_GRID': '1', 'QWEN_PIPE_UPSCALE': '1', 'QWEN_PIPE_MAX_TOKENS': '2048',
                'QWEN_PIPE_MAX_IMAGE_EDGE': '1200', 'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat',
                'QWEN_MODEL': 'qwen3-vl:4b-instruct'
            }, clear=False), patch('processor._qwen_call', return_value=({'routes': []}, 1.0, (1000, 800))) as call:
                processor._qwen_semantic_routes(str(image_path), 1000, 800)
                pipe_kwargs = call.call_args.kwargs
                self.assertEqual(pipe_kwargs['num_predict'], 2048)
                self.assertEqual(pipe_kwargs['format_schema']['required'], ['routes'])
                route_item = pipe_kwargs['format_schema']['properties']['routes']['items']
                self.assertEqual(route_item['properties']['points']['maxItems'], 2)
                self.assertEqual(pipe_kwargs['format_schema']['properties']['routes']['maxItems'], 48)
                self.assertIn('каждый видимый прямой участок трубы отдельно', call.call_args.args[1])

    def test_qwen_call_accepts_schema_and_marks_truncated_generation(self):
        class FakeResponse:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self):
                return json.dumps({
                    'message': {'content': '{"routes":[]}'},
                    'done': True, 'done_reason': 'length', 'eval_count': 2048,
                    'prompt_eval_count': 1400
                }).encode('utf-8')
        from PIL import Image as PILImage
        image = PILImage.new('RGB', (32, 24), 'white')
        diagnostics = {}
        schema = {'type': 'object', 'properties': {'routes': {'type': 'array'}}, 'required': ['routes']}
        with patch('processor.urllib.request.urlopen', return_value=FakeResponse()) as mocked:
            processor._qwen_call(image, 'return JSON routes', url='http://ollama.test/api/chat',
                                  model='qwen3-vl:4b-instruct', timeout=10, max_edge=64,
                                  num_predict=2048, diagnostics=diagnostics, format_schema=schema)
        payload = json.loads(mocked.call_args.args[0].data.decode('utf-8'))
        self.assertEqual(payload['format'], schema)
        self.assertTrue(diagnostics['truncated'])
        self.assertEqual(diagnostics['eval_count'], 2048)


class BrowserExportRegressionTests(unittest.TestCase):
    def test_browser_main_layer_uses_opencv_selection_even_if_qwen_routes_exist(self):
        app_js = (ROOT / 'public' / 'app.js').read_text(encoding='utf-8')
        self.assertIn('function isPrimaryCadEdge(edge)', app_js)
        self.assertIn('edge.cad_include === true', app_js)
        self.assertIn('const primaryEdges = graph.edges.filter(isPrimaryCadEdge);', app_js)
        self.assertIn("addPolyline('PIPE_MAIN',points,false,13);", app_js)
        self.assertIn("addPolyline('QWEN_REVIEW',points,false,9);", app_js)
        self.assertNotIn('if (Array.isArray(graph?.semanticRoutes)) {', app_js)

    def test_ui_does_not_describe_qwen_as_the_only_main_geometry_source(self):
        index_html = (ROOT / 'public' / 'index.html').read_text(encoding='utf-8')
        self.assertIn('Основной PIPE_MAIN строится по отобранным CAD-путям OpenCV', index_html)
        self.assertIn('замороженный QWEN_REVIEW', index_html)
        self.assertNotIn('Основной лист строится только из семантических маршрутов Qwen', index_html)


if __name__ == "__main__":
    unittest.main()
