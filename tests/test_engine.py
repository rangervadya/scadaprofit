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
    def setUp(self):
        self._grid_patch = patch.dict(os.environ, {'QWEN_PIPE_TILE_GRID': '1'}, clear=False)
        self._grid_patch.start()

    def tearDown(self):
        self._grid_patch.stop()

    def test_near_endpoints_are_snapped_to_same_node(self):
        segments = [
            {"x1": 10.0, "y1": 10.0, "x2": 40.0, "y2": 10.0, "source": "LSD", "support": .9, "length": 30, "angle": 0},
            {"x1": 43.0, "y1": 11.0, "x2": 70.0, "y2": 10.0, "source": "HOUGH", "support": .9, "length": 27, "angle": 0},
        ]
        nodes, edges, components = processor.endpoint_clusters(segments, radius=4.5)
        self.assertEqual(len(edges), 2)
        self.assertEqual(edges[0]["to"], edges[1]["from"])
        self.assertEqual(edges[0]["geometry"][-1], edges[1]["geometry"][0])

    def test_ink_supported_collinear_gap_up_to_19px_is_joined(self):
        ink = np.zeros((100, 200), np.uint8)
        cv2.line(ink, (10, 50), (150, 50), 255, 2, cv2.LINE_AA)
        segments = [
            {"x1": 10.0, "y1": 50.0, "x2": 70.0, "y2": 50.0, "source": "LSD", "support": .9, "length": 60, "angle": 0},
            {"x1": 88.0, "y1": 50.0, "x2": 150.0, "y2": 50.0, "source": "LSD", "support": .9, "length": 62, "angle": 0},
        ]
        nodes, edges, _ = processor.endpoint_clusters(segments, radius=4.5, ink=ink)
        self.assertEqual(edges[0]['to'], edges[1]['from'])
        self.assertTrue(any(node.get('auto_joined_collinear') for node in nodes))

    def test_unsupported_collinear_gap_is_not_joined(self):
        ink = np.zeros((100, 200), np.uint8)
        cv2.line(ink, (10, 50), (70, 50), 255, 2, cv2.LINE_AA)
        cv2.line(ink, (88, 50), (150, 50), 255, 2, cv2.LINE_AA)
        segments = [
            {"x1": 10.0, "y1": 50.0, "x2": 70.0, "y2": 50.0, "source": "LSD", "support": .9, "length": 60, "angle": 0},
            {"x1": 88.0, "y1": 50.0, "x2": 150.0, "y2": 50.0, "source": "LSD", "support": .9, "length": 62, "angle": 0},
        ]
        _nodes, edges, _ = processor.endpoint_clusters(segments, radius=4.5, ink=ink)
        self.assertNotEqual(edges[0]['to'], edges[1]['from'])

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

    def test_supported_short_branch_attached_to_pipe_component_is_kept(self):
        nodes = [
            {'id': 'N1', 'x': 10, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 80, 'y': 50, 'degree': 3},
            {'id': 'N3', 'x': 145, 'y': 50, 'degree': 1},
            {'id': 'N4', 'x': 80, 'y': 72, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'N1', 'to': 'N2', 'geometry': [[10, 50], [80, 50]],
             'component_id': 'C1', 'component_role': 'line_structure', 'ink_support': .88, 'ocr_overlap': 0.0},
            {'id': 'E2', 'from': 'N2', 'to': 'N3', 'geometry': [[80, 50], [145, 50]],
             'component_id': 'C1', 'component_role': 'line_structure', 'ink_support': .86, 'ocr_overlap': 0.0},
            {'id': 'E3', 'from': 'N2', 'to': 'N4', 'geometry': [[80, 50], [80, 72]],
             'component_id': 'C1', 'component_role': 'line_structure', 'ink_support': .82, 'ocr_overlap': 0.0},
        ]
        stats = processor.select_primary_cad_edges(nodes, edges, 906)
        self.assertTrue(edges[2]['cad_include'])
        self.assertEqual(edges[2]['cad_reason'], 'supported-short-branch')
        self.assertEqual(stats['cad_primary_edges'], 3)

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
        self.assertEqual(edges[0]["cad_reason"], "isolated-stroke-review")

    def test_long_isolated_stroke_is_review_only_not_pipe_main(self):
        # A long dimension line / arrow shaft / handwriting flourish can be
        # geometrically indistinguishable from a pipe when it has no topology.
        segments = [
            {"x1": 20.0, "y1": 40.0, "x2": 210.0, "y2": 40.0,
             "source": "LSD", "support": .96, "length": 190.0, "angle": 0}
        ]
        nodes, edges, components = processor.endpoint_clusters(segments)
        stats = processor.select_primary_cad_edges(nodes, edges, 900)
        self.assertFalse(edges[0]["cad_include"])
        self.assertEqual(edges[0]["cad_reason"], "isolated-stroke-review")
        self.assertEqual(stats["cad_primary_edges"], 0)
        self.assertEqual(stats["cad_selection_reasons"]["isolated-stroke-review"], 1)

    def test_connected_ocr_overlapping_handwriting_component_is_not_pipe(self):
        # A compact connected chain of handwritten strokes should be classified
        # as text/annotation even though its total length looks substantial.
        segments = [
            {"x1": 20.0, "y1": 40.0, "x2": 42.0, "y2": 20.0, "source": "LSD", "support": .9, "length": 29.7, "angle": -42, "ocr_overlap": .8},
            {"x1": 42.0, "y1": 20.0, "x2": 58.0, "y2": 43.0, "source": "LSD", "support": .9, "length": 28.0, "angle": 55, "ocr_overlap": .8},
            {"x1": 58.0, "y1": 43.0, "x2": 78.0, "y2": 19.0, "source": "LSD", "support": .9, "length": 31.2, "angle": -50, "ocr_overlap": .8},
            {"x1": 78.0, "y1": 19.0, "x2": 96.0, "y2": 42.0, "source": "LSD", "support": .9, "length": 29.2, "angle": 52, "ocr_overlap": .8},
        ]
        nodes, edges, components = processor.endpoint_clusters(segments)
        self.assertEqual(len(components), 1)
        self.assertEqual(components[0]["role"], "text_or_annotation")
        processor.select_primary_cad_edges(nodes, edges, 900)
        self.assertFalse(any(edge["cad_include"] for edge in edges))

    def test_multi_edge_pipe_route_remains_primary(self):
        # A connected pipe with a real elbow is retained; only isolated strokes
        # and text-like components are denied automatic promotion.
        segments = [
            {"x1": 20.0, "y1": 100.0, "x2": 100.0, "y2": 100.0, "source": "LSD", "support": .95, "length": 80.0, "angle": 0},
            {"x1": 100.0, "y1": 100.0, "x2": 100.0, "y2": 180.0, "source": "LSD", "support": .95, "length": 80.0, "angle": 90},
            {"x1": 100.0, "y1": 180.0, "x2": 190.0, "y2": 180.0, "source": "LSD", "support": .95, "length": 90.0, "angle": 0},
        ]
        nodes, edges, components = processor.endpoint_clusters(segments)
        self.assertEqual(components[0]["role"], "line_structure")
        stats = processor.select_primary_cad_edges(nodes, edges, 900)
        self.assertEqual(stats["cad_primary_edges"], 3)

    def test_dense_connected_route_with_branch_is_not_vetoed_as_symbol(self):
        # A compact, segmented cross-shaped pipe route is connected and has
        # a real branch. The old dense-symbol veto overrode the route candidate.
        points = [
            ((20, 50), (35, 50)), ((35, 50), (50, 50)),
            ((50, 50), (65, 50)), ((65, 50), (80, 50)),
            ((50, 20), (50, 35)), ((50, 35), (50, 50)),
            ((50, 50), (50, 65)), ((50, 65), (50, 80)),
        ]
        segments = []
        for a, b in points:
            length = float(np.hypot(b[0] - a[0], b[1] - a[1]))
            segments.append({
                'x1': float(a[0]), 'y1': float(a[1]),
                'x2': float(b[0]), 'y2': float(b[1]),
                'source': 'HOUGH', 'support': .92, 'length': length,
                'angle': 0.0, 'ocr_overlap': 0.0, 'text_crossing': False,
            })
        nodes, edges, components = processor.endpoint_clusters(segments)
        self.assertEqual(len(components), 1)
        self.assertTrue(components[0]['connected_line_candidate'] or components[0]['elbow_route_candidate'])
        self.assertTrue(components[0]['dense_route_exemption'])
        self.assertEqual(components[0]['role'], 'line_structure')
        stats = processor.select_primary_cad_edges(nodes, edges, 100)
        self.assertGreater(stats['cad_primary_edges'], 0)

    def test_topology_rich_multibranch_network_with_degree_six_is_selected(self):
        # A connected pipe manifold can contain degree-six junctions. Earlier
        # component rules rejected it solely because max_degree exceeded five.
        # Strong ink, multiple branches, low OCR and moderate density support it.
        segments = []
        def add(a, b):
            length = float(np.hypot(b[0] - a[0], b[1] - a[1]))
            segments.append({
                'x1': float(a[0]), 'y1': float(a[1]),
                'x2': float(b[0]), 'y2': float(b[1]),
                'source': 'HOUGH', 'support': .92, 'length': length,
                'angle': 0.0, 'ocr_overlap': 0.0, 'text_crossing': False,
            })

        hub_a, hub_b = (20, 50), (120, 50)
        for endpoint in [(0, 50), (20, 20), (20, 80), (45, 25), (45, 75)]:
            add(hub_a, endpoint)
        for endpoint in [(150, 50), (120, 20), (120, 80), (145, 25)]:
            add(hub_b, endpoint)
        add(hub_a, hub_b)

        nodes, edges, components = processor.endpoint_clusters(segments)
        self.assertEqual(len(components), 1)
        self.assertEqual(components[0]['max_node_degree'], 6)
        self.assertTrue(components[0]['topology_network_candidate'])
        self.assertEqual(components[0]['role'], 'line_structure')
        stats = processor.select_primary_cad_edges(nodes, edges, 160)
        self.assertEqual(stats['cad_primary_edges'], len(edges))
        self.assertTrue(all(edge['cad_include'] for edge in edges))

    def test_topology_network_candidate_is_rejected_when_ocr_overlap_is_high(self):
        # Similar topology must not be promoted when it overlaps OCR regions.
        segments = []
        def add(a, b):
            length = float(np.hypot(b[0] - a[0], b[1] - a[1]))
            segments.append({
                'x1': float(a[0]), 'y1': float(a[1]),
                'x2': float(b[0]), 'y2': float(b[1]),
                'source': 'HOUGH', 'support': .92, 'length': length,
                'angle': 0.0, 'ocr_overlap': .35, 'text_crossing': False,
            })
        hub_a, hub_b = (20, 50), (120, 50)
        for endpoint in [(0, 50), (20, 20), (20, 80), (45, 25), (45, 75)]:
            add(hub_a, endpoint)
        for endpoint in [(150, 50), (120, 20), (120, 80), (145, 25)]:
            add(hub_b, endpoint)
        add(hub_a, hub_b)

        nodes, edges, components = processor.endpoint_clusters(segments)
        self.assertEqual(len(components), 1)
        self.assertFalse(components[0]['topology_network_candidate'])
        self.assertEqual(components[0]['role'], 'text_or_annotation')
        stats = processor.select_primary_cad_edges(nodes, edges, 160)
        self.assertEqual(stats['cad_primary_edges'], 0)

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
        # An unconfirmed generic box is not part of the geometry mask.
        self.assertTrue(any(x['length'] > 100 for x in candidates))
        # OCR overlap is metadata and must not subtract the underlying geometry.
        self.assertTrue(any(x["length"] > 100 for x in candidates))

    def test_ocr_overlap_does_not_reclassify_long_trace(self):
        segments = [
            {"x1": 10.0, "y1": 20.0, "x2": 60.0, "y2": 20.0, "source": "LSD", "support": .9, "length": 50, "angle": 0, "ocr_overlap": 1.0, "text_crossing": True},
            {"x1": 60.0, "y1": 20.0, "x2": 110.0, "y2": 20.0, "source": "HOUGH", "support": .9, "length": 50, "angle": 0, "ocr_overlap": 1.0, "text_crossing": True},
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
                    {"text": "?", "bbox": {"x": 300, "y": 100, "w": 20, "h": 18}, "confidence": 29},
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
            self.assertTrue(annotations[1]["geometry_exclude"],
                            "an illegible handwritten region must mask glyph strokes even when not text-verified")

    def test_pipe_through_multiple_adjacent_ocr_boxes_is_preserved(self):
        gray = np.full((100, 240), 255, np.uint8)
        ink = np.zeros((100, 240), np.uint8)
        cv2.line(gray, (10, 55), (230, 55), 25, 2, cv2.LINE_AA)
        cv2.line(ink, (10, 55), (230, 55), 255, 2, cv2.LINE_AA)
        annotations = [
            {"source": "qwen3-vl", "text": "1500", "confidence": 85, "bbox": {"x": 52, "y": 40, "w": 42, "h": 24}},
            {"source": "tesseract", "text": "DN50", "confidence": 82, "bbox": {"x": 112, "y": 40, "w": 46, "h": 24}},
        ]
        candidates = processor.extract_segments(gray, ink, annotations)
        self.assertTrue(any(item['length'] > 180 and item['text_crossing'] for item in candidates))

    def test_union_of_adjacent_ocr_boxes_masks_word_strokes(self):
        gray = np.full((110, 220), 255, np.uint8)
        ink = np.zeros((110, 220), np.uint8)
        # A zig-zag handwritten word covered by two adjacent OCR boxes.
        pts = [(55, 52), (72, 31), (89, 54), (106, 30), (124, 53), (145, 32)]
        for a, b in zip(pts, pts[1:]):
            cv2.line(gray, a, b, 25, 2, cv2.LINE_AA)
            cv2.line(ink, a, b, 255, 2, cv2.LINE_AA)
        annotations = [
            {"source": "qwen3-vl", "text": "AB", "confidence": 82, "bbox": {"x": 50, "y": 25, "w": 48, "h": 34}},
            {"source": "tesseract", "text": "CD", "confidence": 80, "bbox": {"x": 96, "y": 24, "w": 54, "h": 35}},
        ]
        candidates = processor.extract_segments(gray, ink, annotations)
        self.assertFalse(any(item.get("ocr_overlap", 0) >= 0.08 for item in candidates))

    def test_expanded_text_box_masks_a_handwritten_stroke_with_loose_endpoints(self):
        ink = np.zeros((100, 160), np.uint8)
        cv2.line(ink, (52, 50), (98, 50), 255, 2, cv2.LINE_AA)
        dilated = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=1)
        box = {"x": 55, "y": 40, "w": 40, "h": 20}
        self.assertTrue(processor._segment_inside_text_box((52, 50, 98, 50), box, dilated))

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

    def test_analyze_writes_text_mask_and_keeps_only_connected_pipe_as_primary(self):
        with TemporaryDirectory() as temp:
            source = Path(temp) / 'source.png'
            out_dir = Path(temp) / 'job'
            out_dir.mkdir()
            image = np.full((906, 1280, 3), 255, np.uint8)
            # A connected pipe with two elbows.
            cv2.line(image, (100, 220), (450, 220), (35, 45, 60), 3, cv2.LINE_AA)
            cv2.line(image, (450, 220), (450, 430), (35, 45, 60), 3, cv2.LINE_AA)
            cv2.line(image, (450, 430), (850, 430), (35, 45, 60), 3, cv2.LINE_AA)
            # A label box masks its characters from geometry.
            cv2.putText(image, 'DN 50', (230, 190), cv2.FONT_HERSHEY_SIMPLEX,
                        0.7, (30, 50, 70), 2, cv2.LINE_AA)
            # An isolated long dimension/arrow stroke must stay review-only.
            cv2.line(image, (900, 100), (1180, 100), (35, 45, 60), 2, cv2.LINE_AA)
            cv2.imwrite(str(source), image)
            annotations = [{
                'id': 'Q1', 'source': 'qwen3-vl', 'text': 'DN 50',
                'bbox': {'x': 225, 'y': 160, 'w': 110, 'h': 38},
                'confidence': 95, 'verified': True, 'include': True,
                'geometry_exclude': True,
            }]
            with patch.object(processor, 'ocr_annotations', return_value=(annotations, {
                    'qwen': {'available': True, 'annotations': 1},
                    'tesseract': {'annotations': 0}})),                  patch.object(processor, '_qwen_semantic_routes', return_value=([], {
                    'available': True, 'routes': 0, 'raw_routes': 0,
                    'successful_tiles': 4, 'tiles': 4, 'error': 'empty in test'})):
                graph = processor.analyze(str(source), str(out_dir))
            self.assertEqual(graph['summary']['cad_primary_edges'], 3)
            self.assertEqual(graph['summary']['isolated_strokes_kept_for_review'], 1)
            self.assertEqual(graph['summary']['text_regions_used_for_geometry_mask'], 1)
            for filename in ('primary-overlay.png', 'text-region-mask.png',
                             'ink-without-text-boxes.png', 'ink-inside-text-boxes.png', 'handwritten-text-blocks.png'):
                self.assertTrue((out_dir / filename).exists(), filename)
            self.assertTrue((out_dir / 'drawing.dxf').exists())
            dxf = (out_dir / 'drawing.dxf').read_text(encoding='utf-8')
            self.assertIn('PIPE_MAIN', dxf)
            self.assertIn('DETAIL_REVIEW', dxf)

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
                self.assertEqual(ocr_kwargs['format_schema']['properties']['annotations']['maxItems'], 64)

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
                self.assertEqual(pipe_kwargs['format_schema']['properties']['routes']['maxItems'], 64)
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


class SemanticSegmentRecoveryTests(unittest.TestCase):
    def test_clear_part_of_qwen_route_survives_neighboring_text_overlap(self):
        ink = np.zeros((140, 200), np.uint8)
        cv2.line(ink, (10, 60), (48, 60), 255, 2, cv2.LINE_AA)
        cv2.line(ink, (82, 60), (82, 120), 255, 2, cv2.LINE_AA)
        text_mask = np.zeros_like(ink)
        cv2.rectangle(text_mask, (45, 48), (72, 72), 255, -1)
        route = {'id': 'Q-partial', 'points': [[10, 60], [82, 60], [82, 120]], 'confidence': 80}
        accepted, stats = processor.validate_primary_semantic_routes([route], ink, text_mask, [], 140)
        self.assertEqual(len(accepted), 1)
        self.assertEqual(accepted[0]['points'][0], [82.0, 60.0])
        self.assertEqual(accepted[0]['points'][-1], [82.0, 120.0])
        self.assertEqual(stats['accepted_source_routes'], 1)


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
        self.assertIn('OpenCV собирает геометрический граф', index_html)
        self.assertIn('замороженный QWEN_REVIEW', index_html)
        self.assertNotIn('Основной лист строится только из семантических маршрутов Qwen', index_html)


class Recovery431RegressionTests(unittest.TestCase):
    def test_ink_supported_qwen_route_is_promoted_to_pipe_main(self):
        ink = np.zeros((120, 180), np.uint8)
        cv2.line(ink, (12, 60), (166, 60), 255, 3, cv2.LINE_AA)
        text_mask = np.zeros_like(ink)
        routes = [{'id': 'P7', 'points': [[12, 60], [166, 60]], 'confidence': 82}]
        accepted, stats = processor.validate_primary_semantic_routes(routes, ink, text_mask, [], 120)
        self.assertEqual(len(accepted), 1)
        self.assertGreaterEqual(accepted[0]['ink_support'], 0.38)
        svg = processor.build_clean_svg(180, 120, [], [], primary_semantic_routes=accepted)
        self.assertEqual(svg.count('<polyline points='), 1)
        dxf = processor.build_dxf(180, 120, [], [], semantic_routes=routes, primary_semantic_routes=accepted)
        self.assertIn('8\nPIPE_MAIN\n100\nAcDbPolyline', dxf)
        self.assertEqual(stats['accepted_routes'], 1)


    def test_ink_validation_tolerates_small_qwen_centerline_offset(self):
        ink = np.zeros((120, 180), np.uint8)
        cv2.line(ink, (12, 60), (166, 60), 255, 2, cv2.LINE_AA)
        text_mask = np.zeros_like(ink)
        # The predicted centreline is offset by 3 px but still follows the same
        # hand-drawn source stroke after the 7x7 support dilation.
        routes = [{'id': 'P9', 'points': [[12, 63], [166, 63]], 'confidence': 78}]
        accepted, stats = processor.validate_primary_semantic_routes(routes, ink, text_mask, [], 120)
        self.assertEqual(len(accepted), 1)
        self.assertGreaterEqual(accepted[0]['ink_support'], 0.30)

    def test_qwen_route_made_only_of_text_ink_is_not_promoted(self):
        ink = np.zeros((120, 180), np.uint8)
        # Ink exists only inside a text box; it does not continue outside it.
        cv2.line(ink, (65, 60), (115, 60), 255, 3, cv2.LINE_AA)
        text_mask = np.zeros_like(ink)
        cv2.rectangle(text_mask, (58, 48), (122, 72), 255, -1)
        routes = [{'id': 'P8', 'points': [[20, 60], [160, 60]], 'confidence': 88}]
        accepted, stats = processor.validate_primary_semantic_routes(routes, ink, text_mask, [], 120)
        self.assertEqual(accepted, [])
        self.assertIn(stats['reasons'].get('weak-source-ink', 0) + stats['reasons'].get('text-overlap', 0), [1])

    def test_multisegment_ambiguous_but_supported_route_can_be_primary(self):
        nodes = [
            {'id': 'N1', 'x': 10, 'y': 20, 'degree': 1},
            {'id': 'N2', 'x': 60, 'y': 20, 'degree': 2},
            {'id': 'N3', 'x': 60, 'y': 90, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'N1', 'to': 'N2', 'geometry': [[10, 20], [60, 20]],
             'component_id': 'C1', 'component_role': 'ambiguous', 'ink_support': .85, 'ocr_overlap': 0.0},
            {'id': 'E2', 'from': 'N2', 'to': 'N3', 'geometry': [[60, 20], [60, 90]],
             'component_id': 'C1', 'component_role': 'ambiguous', 'ink_support': .85, 'ocr_overlap': 0.0},
        ]
        stats = processor.select_primary_cad_edges(nodes, edges, 500)
        self.assertEqual(stats['cad_primary_edges'], 2)
        self.assertTrue(all(edge['cad_reason'] == 'ambiguous-but-connected-route' for edge in edges))

    def test_low_confidence_text_is_exported_to_frozen_text_review(self):
        annotations = [{
            'source': 'qwen3-vl-block', 'text': '4) насос + клапан (0511)',
            'confidence': 42, 'verified': False, 'include': False,
            'bbox': {'x': 40, 'y': 40, 'w': 170, 'h': 18}
        }]
        svg = processor.build_clean_svg(300, 180, [], annotations)
        self.assertIn('data-layer="TEXT_REVIEW"', svg)
        self.assertIn('насос + клапан', svg)
        dxf = processor.build_dxf(300, 180, [], annotations)
        self.assertIn('TEXT_REVIEW', dxf)
        self.assertIn('насос + клапан', dxf)
        self.assertIn('TEXT_REVIEW\n70\n1', dxf)

    def test_handwritten_note_box_cluster_is_detected_for_second_ocr_pass(self):
        items = []
        for i in range(10):
            items.append({'bbox': {'x': 600 + (i % 2) * 6, 'y': 100 + i * 20, 'w': 135 + (i % 3) * 8, 'h': 15},
                          'text': f'{i+1} test'})
        blocks = processor._candidate_handwritten_text_blocks(items, 1280, 906, max_blocks=2)
        self.assertTrue(blocks)
        self.assertGreaterEqual(blocks[0]['source_boxes'], 5)
        self.assertGreaterEqual(blocks[0]['h'], 100)

    def test_handwritten_block_ocr_returns_full_line_boxes(self):
        from PIL import Image as PILImage
        image = PILImage.new('RGB', (500, 400), 'white')
        response = {'annotations': [
            {'text': '1) Линия подачи (0405)', 'bbox': {'x': 10, 'y': 15, 'w': 138, 'h': 24}, 'confidence': 72},
            {'text': '2) Насос + клапан (0434)', 'bbox': {'x': 10, 'y': 48, 'w': 140, 'h': 24}, 'confidence': 55},
        ]}
        with patch('processor._qwen_call', return_value=(response, 1.0, (500, 400))) as call:
            lines, diagnostics = processor._run_handwritten_block_ocr(
                image,
                [{'bbox': {'x': 20, 'y': 18 + i*26, 'w': 145, 'h': 16}, 'text': str(i)} for i in range(6)],
                url='http://ollama.test/api/chat', model='qwen3-vl:4b-instruct',
                timeout=30, max_edge=1024, max_tokens=1200
            )
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]['source'], 'qwen3-vl-block')
        self.assertTrue(lines[0]['verified'])
        self.assertFalse(lines[1]['verified'])
        self.assertEqual(diagnostics[0]['accepted_lines'], 2)
        self.assertIn('строку целиком', call.call_args.args[1])



    def test_numbered_left_margin_detector_finds_all_ten_note_rows(self):
        from PIL import Image as PILImage
        canvas = np.full((490, 980, 3), 248, dtype=np.uint8)
        for i in range(10):
            y = 285 + i * 17
            cv2.circle(canvas, (595, y), 7, (68, 78, 125), 2, cv2.LINE_AA)
            cv2.putText(canvas, str(i + 1), (591, y + 3), cv2.FONT_HERSHEY_SIMPLEX, .35,
                        (68, 78, 125), 1, cv2.LINE_AA)
            cv2.putText(canvas, 'KCL + pump / line (0405)', (612, y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, .42, (68, 78, 125), 1, cv2.LINE_AA)
        image = PILImage.fromarray(canvas)
        block = processor._candidate_handwritten_text_blocks([], 980, 490, max_blocks=2, image=image)[0]
        rows = processor._detect_handwritten_row_bands(image, block)
        self.assertEqual(len(rows), 10)
        centers = [float(row['center_y']) for row in rows]
        self.assertTrue(all(14 <= b-a <= 20 for a, b in zip(centers, centers[1:])))

    def test_numbered_note_ocr_sends_one_qwen_request_per_row(self):
        from PIL import Image as PILImage
        canvas = np.full((490, 980, 3), 248, dtype=np.uint8)
        for i in range(10):
            y = 285 + i * 17
            cv2.circle(canvas, (595, y), 7, (68, 78, 125), 2, cv2.LINE_AA)
            cv2.putText(canvas, str(i + 1), (591, y + 3), cv2.FONT_HERSHEY_SIMPLEX, .35,
                        (68, 78, 125), 1, cv2.LINE_AA)
            cv2.putText(canvas, 'KCL + pump / line (0405)', (612, y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, .42, (68, 78, 125), 1, cv2.LINE_AA)
        image = PILImage.fromarray(canvas)
        block = processor._candidate_handwritten_text_blocks([], 980, 490, max_blocks=2, image=image)[0]
        calls = []
        def fake_qwen(crop, prompt, **kwargs):
            calls.append((crop.size, prompt))
            idx = len(calls)
            return {'text': f'{idx}) Test row (0{idx:03d})', 'confidence': 75}, 1.0, crop.size
        with patch('processor._qwen_call', side_effect=fake_qwen):
            lines, diagnostics = processor._run_handwritten_block_ocr(
                image, [], url='http://ollama.test/api/chat', model='qwen3-vl:4b-instruct',
                timeout=30, max_edge=1024, max_tokens=1200
            )
        self.assertEqual(len(calls), 10)
        self.assertEqual(len(lines), 10)
        self.assertTrue(all(line['source'] == 'qwen3-vl-block' for line in lines))
        self.assertTrue(all(line['geometry_exclude'] for line in lines))
        self.assertEqual(diagnostics[0]['strategy'], 'numbered-left-margin-row-crops')
        self.assertEqual(diagnostics[0]['rows_detected'], 10)

    def test_failed_note_row_ocr_still_returns_geometry_exclusion_review_box(self):
        from PIL import Image as PILImage
        canvas = np.full((490, 980, 3), 248, dtype=np.uint8)
        for i in range(10):
            y = 285 + i * 17
            cv2.circle(canvas, (595, y), 7, (68, 78, 125), 2, cv2.LINE_AA)
            cv2.putText(canvas, str(i + 1), (591, y + 3), cv2.FONT_HERSHEY_SIMPLEX, .35,
                        (68, 78, 125), 1, cv2.LINE_AA)
            cv2.putText(canvas, 'KCL + pump / line (0405)', (612, y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, .42, (68, 78, 125), 1, cv2.LINE_AA)
        def failed_qwen(*_args, **_kwargs):
            raise TimeoutError('synthetic timeout')
        with patch('processor._qwen_call', side_effect=failed_qwen) as call:
            lines, diagnostics = processor._run_handwritten_block_ocr(
                PILImage.fromarray(canvas), [], url='http://ollama.test/api/chat',
                model='qwen3-vl:4b-instruct', timeout=30, max_edge=1024, max_tokens=1200
            )
        self.assertEqual(call.call_count, 10)
        self.assertEqual(len(lines), 10)
        self.assertTrue(all(line['text'] == '?' for line in lines))
        self.assertTrue(all(line['geometry_exclude'] for line in lines))
        self.assertTrue(all(processor._annotation_export_kind(line) == 'TEXT_REVIEW' for line in lines))
        self.assertEqual(diagnostics[0]['rows_returned'], 10)

    def test_qwen_ocr_runs_second_pass_even_when_primary_ocr_returns_zero_boxes(self):
        from PIL import Image as PILImage
        with TemporaryDirectory() as temp:
            source = Path(temp) / 'note.png'
            canvas = np.full((490, 980, 3), 248, dtype=np.uint8)
            for i in range(10):
                y = 285 + i * 17
                cv2.circle(canvas, (595, y), 7, (68, 78, 125), 2, cv2.LINE_AA)
                cv2.putText(canvas, str(i + 1), (591, y + 3), cv2.FONT_HERSHEY_SIMPLEX, .35,
                            (68, 78, 125), 1, cv2.LINE_AA)
                cv2.putText(canvas, 'KCL + pump / line (0405)', (612, y + 4),
                            cv2.FONT_HERSHEY_SIMPLEX, .42, (68, 78, 125), 1, cv2.LINE_AA)
            PILImage.fromarray(canvas).save(source)
            with patch.dict(os.environ, {
                'QWEN_OCR_TILE_GRID': '1', 'QWEN_OCR_UPSCALE': '1',
                'QWEN_OCR_MAX_TOKENS': '1024', 'QWEN_OCR_BLOCK_MAX_TOKENS': '1200',
                'QWEN_MAX_IMAGE_EDGE': '1024', 'QWEN_OCR_TIMEOUT': '30',
                'OLLAMA_CHAT_URL': 'http://ollama.test/api/chat', 'QWEN_MODEL': 'qwen3-vl:4b-instruct'
            }, clear=False):
                def fake_qwen(crop, prompt, **kwargs):
                    if 'annotations' in prompt or 'Максимум 64 текстовые области' in prompt:
                        return {'annotations': []}, 1.0, crop.size
                    index = sum(1 for _ in [])  # call count is derived below
                    return {'text': '1) KCL + pump / line (0405)', 'confidence': 70}, 1.0, crop.size
                with patch('processor._qwen_call', side_effect=[
                    ({'annotations': []}, 1.0, (980, 490)),
                    *[({'text': f'{i}) KCL + pump / line (0405)', 'confidence': 70}, 1.0, (768, 60)) for i in range(1, 11)]
                ]) as call:
                    annotations, status = processor._qwen_annotations(str(source), 980, 490)
            self.assertEqual(call.call_count, 11)
            self.assertEqual(status['block_passes'], 1)
            self.assertEqual(status['block_annotations'], 10)
            self.assertEqual(len([a for a in annotations if a['source'] == 'qwen3-vl-block']), 10)

    def test_source_ink_detector_finds_handwritten_note_block_without_ocr_boxes(self):
        from PIL import Image as PILImage
        canvas = np.full((490, 980, 3), 248, dtype=np.uint8)
        # A separate ten-line note block with circled item numbers and cursive-like
        # connected marks. It should be found even when the OCR pass supplied no boxes.
        for i in range(10):
            y = 285 + i * 17
            cv2.circle(canvas, (595, y), 7, (68, 78, 125), 2, cv2.LINE_AA)
            cv2.putText(canvas, str(i + 1), (591, y + 3), cv2.FONT_HERSHEY_SIMPLEX, .35,
                        (68, 78, 125), 1, cv2.LINE_AA)
            cv2.putText(canvas, 'KCL + pump / line (0405)', (612, y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, .42, (68, 78, 125), 1, cv2.LINE_AA)
        blocks = processor._candidate_handwritten_text_blocks([], 980, 490, max_blocks=2,
                                                               image=PILImage.fromarray(canvas))
        self.assertTrue(blocks)
        self.assertEqual(blocks[0]['detection_source'], 'source-ink-multiline-block')
        self.assertGreaterEqual(blocks[0]['row_peaks'], 4)
        self.assertLess(blocks[0]['x'], 640)
        self.assertGreater(blocks[0]['h'], 80)


    def test_block_ocr_runs_from_source_ink_when_first_pass_found_no_text(self):
        from PIL import Image as PILImage
        canvas = np.full((490, 980, 3), 248, dtype=np.uint8)
        for i in range(10):
            y = 285 + i * 17
            cv2.circle(canvas, (595, y), 7, (68, 78, 125), 2, cv2.LINE_AA)
            cv2.putText(canvas, str(i + 1), (591, y + 3), cv2.FONT_HERSHEY_SIMPLEX, .35,
                        (68, 78, 125), 1, cv2.LINE_AA)
            cv2.putText(canvas, 'KCL + pump / line (0405)', (612, y + 4),
                        cv2.FONT_HERSHEY_SIMPLEX, .42, (68, 78, 125), 1, cv2.LINE_AA)
        def fake_qwen(crop, prompt, **kwargs):
            return {'text': '1) KCL + pump / line (0405)', 'confidence': 70}, 1.0, crop.size
        with patch('processor._qwen_call', side_effect=fake_qwen) as call:
            lines, diagnostics = processor._run_handwritten_block_ocr(
                PILImage.fromarray(canvas), [], url='http://ollama.test/api/chat',
                model='qwen3-vl:4b-instruct', timeout=30, max_edge=1024, max_tokens=1200
            )
        self.assertEqual(len(lines), 10)
        self.assertEqual(call.call_count, 10)
        self.assertEqual(diagnostics[0]['detection_source'], 'source-ink-multiline-block')
        self.assertGreaterEqual(diagnostics[0]['row_peaks'], 4)
        self.assertEqual(diagnostics[0]['strategy'], 'numbered-left-margin-row-crops')

    def test_primary_semantic_routes_are_used_by_browser_svg_and_dxf(self):
        app_js = (ROOT / 'public' / 'app.js').read_text(encoding='utf-8')
        self.assertIn('graph.primarySemanticRoutes', app_js)
        self.assertIn('handwrittenTextBlocksUrl', app_js)
        self.assertIn("addText(layer,annotation.text", app_js)
        self.assertIn("['TEXT_REVIEW',30,9,1]", app_js)
        self.assertIn('function annotationExportLayer(item)', app_js)



if __name__ == "__main__":
    unittest.main()

    def test_low_confidence_tesseract_box_does_not_mask_pipe_geometry(self):
        boxes = processor._confirmed_text_boxes([
            {'source': 'tesseract', 'text': 'noise', 'confidence': 34, 'verified': False,
             'bbox': {'x': 10, 'y': 10, 'w': 30, 'h': 15}},
            {'source': 'tesseract', 'text': 'DN50', 'confidence': 72, 'verified': True,
             'bbox': {'x': 50, 'y': 10, 'w': 35, 'h': 15}},
            {'source': 'qwen3-vl-block', 'text': '?', 'confidence': 0, 'verified': False,
             'bbox': {'x': 90, 'y': 10, 'w': 50, 'h': 18}},
            {'source': 'qwen3-vl', 'text': '1500', 'confidence': 31, 'verified': False,
             'bbox': {'x': 150, 'y': 10, 'w': 32, 'h': 15}},
        ])
        self.assertEqual(len(boxes), 3)
        self.assertNotIn({'x': 10, 'y': 10, 'w': 30, 'h': 15}, boxes)

    def test_join_candidates_reject_same_edge_self_join(self):
        nodes = [
            {'id': 'N1', 'x': 10, 'y': 10, 'degree': 1},
            {'id': 'N2', 'x': 110, 'y': 10, 'degree': 1},
        ]
        edges = [{'id': 'E1', 'from': 'N1', 'to': 'N2',
                  'geometry': [[10, 10], [110, 10]], 'component_id': 'C1',
                  'component_role': 'line_structure'}]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])

    def test_join_candidates_reject_endpoint_inside_other_edge(self):
        nodes = [
            {'id': 'N1', 'x': 100, 'y': 10, 'degree': 1},
            {'id': 'N2', 'x': 70, 'y': 11, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[0, 10], [100, 10]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[70, 11], [140, 11]],
             'component_id': 'C2', 'component_role': 'line_structure'},
        ]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])

    def test_join_candidates_require_gap_to_lie_on_both_tangent_axes(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 65, 'y': 65, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[0, 60], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[65, 65], [110, 55]],
             'component_id': 'C2', 'component_role': 'line_structure'},
        ]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])

    def test_join_candidates_keep_true_collinear_gap_for_review(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 62, 'y': 50, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[0, 50], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[62, 50], [112, 50]],
             'component_id': 'C2', 'component_role': 'line_structure'},
        ]
        result = processor._build_join_candidates(nodes, edges)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['distance'], 12.0)
        self.assertEqual(result[0]['status'], 'needs_review')

    def test_low_confidence_tesseract_box_does_not_mask_pipe_geometry(self):
        boxes = processor._confirmed_text_boxes([
            {'source': 'tesseract', 'text': 'noise', 'confidence': 34, 'verified': False,
             'bbox': {'x': 10, 'y': 10, 'w': 30, 'h': 15}},
            {'source': 'tesseract', 'text': 'DN50', 'confidence': 72, 'verified': True,
             'bbox': {'x': 50, 'y': 10, 'w': 35, 'h': 15}},
            {'source': 'qwen3-vl-block', 'text': '?', 'confidence': 0, 'verified': False,
             'bbox': {'x': 90, 'y': 10, 'w': 50, 'h': 18}},
            {'source': 'qwen3-vl', 'text': '1500', 'confidence': 31, 'verified': False,
             'bbox': {'x': 150, 'y': 10, 'w': 32, 'h': 15}},
        ])
        self.assertEqual(len(boxes), 3)
        self.assertNotIn({'x': 10, 'y': 10, 'w': 30, 'h': 15}, boxes)

    def test_join_candidates_reject_same_edge_self_join(self):
        nodes = [
            {'id': 'N1', 'x': 10, 'y': 10, 'degree': 1},
            {'id': 'N2', 'x': 110, 'y': 10, 'degree': 1},
        ]
        edges = [{'id': 'E1', 'from': 'N1', 'to': 'N2',
                  'geometry': [[10, 10], [110, 10]], 'component_id': 'C1',
                  'component_role': 'line_structure'}]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])

    def test_join_candidates_reject_endpoint_inside_other_edge(self):
        nodes = [
            {'id': 'N1', 'x': 100, 'y': 10, 'degree': 1},
            {'id': 'N2', 'x': 70, 'y': 11, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[0, 10], [100, 10]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[70, 11], [140, 11]],
             'component_id': 'C2', 'component_role': 'line_structure'},
        ]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])

    def test_join_candidates_require_gap_to_lie_on_both_tangent_axes(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 65, 'y': 65, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[0, 60], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[65, 65], [110, 55]],
             'component_id': 'C2', 'component_role': 'line_structure'},
        ]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])

    def test_join_candidates_keep_true_collinear_gap_for_review(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 62, 'y': 50, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[0, 50], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[62, 50], [112, 50]],
             'component_id': 'C2', 'component_role': 'line_structure'},
        ]
        result = processor._build_join_candidates(nodes, edges)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['distance'], 12.0)
        self.assertEqual(result[0]['status'], 'needs_review')

    def test_join_candidates_include_short_ink_supported_fragments_for_review(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 60.1, 'y': 52.2, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[35, 50], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure',
             'cad_reason': 'collinear-continuation', 'ink_support': 1.0, 'ocr_overlap': 0.0},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[60.1, 52.2], [75, 52.2]],
             'component_id': 'C2', 'component_role': 'line_structure',
             'cad_reason': 'branch-route', 'ink_support': 1.0, 'ocr_overlap': 0.0},
        ]
        result = processor._build_join_candidates(nodes, edges, image_size=(200, 120))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['from'], 'N1')
        self.assertEqual(result[0]['to'], 'N2')
        self.assertIn('short_fragment', result[0]['review_flags'])
        self.assertEqual(result[0]['status'], 'needs_review')
        self.assertEqual(result[0]['priority'], 'high')
        # Candidate generation is diagnostic and must not edit the source graph.
        self.assertEqual(len(edges), 2)

    def test_join_candidates_include_ambiguous_edges_but_keep_them_review_only(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 65, 'y': 50, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[35, 50], [50, 50]],
             'component_id': 'C1', 'component_role': 'ambiguous',
             'cad_reason': 'isolated-stroke-review', 'ink_support': 1.0, 'ocr_overlap': 0.0},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[65, 50], [80, 50]],
             'component_id': 'C2', 'component_role': 'line_structure',
             'cad_reason': 'branch-route', 'ink_support': 1.0, 'ocr_overlap': 0.0},
        ]
        result = processor._build_join_candidates(nodes, edges)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]['priority'], 'review')
        self.assertIn('ambiguous_component', result[0]['review_flags'])

    def test_join_candidates_flag_competing_partners_for_same_terminal(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 62, 'y': 50, 'degree': 1},
            {'id': 'N3', 'x': 65, 'y': 50, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[35, 50], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure',
             'ink_support': 1.0, 'ocr_overlap': 0.0},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[62, 50], [77, 50]],
             'component_id': 'C2', 'component_role': 'line_structure',
             'ink_support': 1.0, 'ocr_overlap': 0.0},
            {'id': 'E3', 'from': 'N3', 'to': 'C', 'geometry': [[65, 50], [80, 50]],
             'component_id': 'C3', 'component_role': 'line_structure',
             'ink_support': 1.0, 'ocr_overlap': 0.0},
        ]
        result = processor._build_join_candidates(nodes, edges)
        self.assertGreaterEqual(len(result), 2)
        competing = [item for item in result if item['has_alternatives']]
        self.assertTrue(competing)
        self.assertTrue(all('competing_candidate' in item['review_flags'] for item in competing))
        self.assertTrue(all(item['priority'] == 'review' for item in competing))

    def test_join_candidates_exclude_text_annotation_edges(self):
        nodes = [
            {'id': 'N1', 'x': 50, 'y': 50, 'degree': 1},
            {'id': 'N2', 'x': 65, 'y': 50, 'degree': 1},
        ]
        edges = [
            {'id': 'E1', 'from': 'A', 'to': 'N1', 'geometry': [[35, 50], [50, 50]],
             'component_id': 'C1', 'component_role': 'line_structure'},
            {'id': 'E2', 'from': 'N2', 'to': 'B', 'geometry': [[65, 50], [80, 50]],
             'component_id': 'C2', 'component_role': 'text_or_annotation'},
        ]
        self.assertEqual(processor._build_join_candidates(nodes, edges), [])
