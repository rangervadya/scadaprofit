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
            with patch.dict(os.environ, {"QWEN_MAX_IMAGE_EDGE": "2000", "QWEN_OCR_TIMEOUT": "20", "OLLAMA_CHAT_URL": "http://ollama.test/api/chat", "QWEN_MODEL": "qwen3-vl:4b"}), \
                 patch('processor.urllib.request.urlopen', return_value=FakeResponse()):
                annotations, status = processor._qwen_annotations(str(image_path), 4000, 2000)
            self.assertTrue(status["available"])
            self.assertEqual(annotations[0]["bbox"], {"x": 200, "y": 160, "w": 120, "h": 40})
            self.assertTrue(annotations[0]["include"])
            self.assertFalse(annotations[1]["include"])

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

    def test_dxf_has_pipe_and_verified_text_layers(self):
        edges = [{"geometry": [[0, 0], [100, 100]], "component_role": "line_structure"}]
        annotations = [{"verified": True, "text": "DN50", "bbox": {"x": 12, "y": 15, "w": 25, "h": 9}}]
        dxf = processor.build_dxf(120, 120, edges, annotations)
        self.assertIn("PIPE_CANDIDATES", dxf)
        self.assertIn("370\n13", dxf)
        self.assertIn("VERIFIED_TEXT", dxf)
        self.assertIn("DN50", dxf)
        self.assertIn("9\n$INSUNITS\n70\n4", dxf)
        self.assertIn("100\nAcDbPolyline", dxf)


if __name__ == "__main__":
    unittest.main()
