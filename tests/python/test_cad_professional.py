from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import xml.etree.ElementTree as ET

import cv2
import numpy as np

from cad_symbols import SYMBOL_CATALOG, symbol_port_positions, symbol_primitives
from cad_overlay import render_cad_alignment_overlay
from clean_export import build_layout_dxf, build_layout_svg
from clean_layout import build_clean_layout, _merge_pipe_network
from drawing_quality import validate_clean_layout
from drawing_template import build_drawing_template


class ProfessionalSheetLayoutTests(unittest.TestCase):
    def test_photo_border_stays_reviewable_while_interior_pipe_is_kept(self):
        from processor import select_primary_cad_edges
        nodes = [{"id": str(i)} for i in range(6)]
        edges = [
            {"id": "border1", "from": "0", "to": "1", "geometry": [[998, 20], [998, 400]], "length": 380},
            {"id": "border2", "from": "1", "to": "2", "geometry": [[998, 400], [998, 790]], "length": 390},
            {"id": "pipe1", "from": "3", "to": "4", "geometry": [[100, 100], [500, 100]], "length": 400},
            {"id": "pipe2", "from": "4", "to": "5", "geometry": [[500, 100], [500, 500]], "length": 400},
        ]
        select_primary_cad_edges(nodes, edges, 800, image_size=(1000, 800))
        self.assertTrue(all(not edge["cad_include"] for edge in edges[:2]))
        self.assertTrue(all(edge["cad_include"] for edge in edges[2:]))
        self.assertEqual(len(edges), 4)
        self.assertEqual(edges[0]["cad_reason"], "image-border-review")

    def test_long_ink_supported_trunk_is_recovered_without_joining_gaps(self):
        from copy import deepcopy
        from processor import select_primary_cad_edges
        nodes = [{"id": str(i)} for i in range(8)]
        base = [
            {"id": "left1", "from": "0", "to": "1", "geometry": [[10, 100], [50, 100]], "length": 40},
            {"id": "left2", "from": "1", "to": "2", "geometry": [[50, 100], [95, 100]], "length": 45},
            {"id": "trunk", "from": "3", "to": "4", "geometry": [[100, 100], [300, 100]], "length": 200,
             "ink_support": 1, "ocr_overlap": 0.17},
            {"id": "right1", "from": "5", "to": "6", "geometry": [[305, 100], [305, 160]], "length": 60},
            {"id": "right2", "from": "6", "to": "7", "geometry": [[305, 160], [350, 160]], "length": 45},
        ]
        for edge in base:
            edge["component_id"] = "left" if edge["id"].startswith("left") else ("right" if edge["id"].startswith("right") else "trunk")
        for support, has_right, expected in ((1, True, True), (0.4, True, False), (1, False, False)):
            with self.subTest(support=support, has_right=has_right):
                edges = deepcopy(base if has_right else base[:3])
                edges[2]["ink_support"] = support
                select_primary_cad_edges(nodes, edges, 900)
                self.assertEqual(edges[2]["cad_include"], expected)
                self.assertEqual(edges[2]["geometry"], base[2]["geometry"])
                self.assertEqual(edges[2]["from"], "3")
                self.assertEqual(edges[2]["to"], "4")

    def _model(self):
        return {
            "sourceImage": {"width": 1200, "height": 1000, "coordinateSpace": "source-image-pixels"},
            "nodes": [
                {"id": "N1", "position": [250, 300], "state": "primary"},
                {"id": "N2", "position": [850, 300], "state": "primary"},
                {"id": "N3", "position": [850, 700], "state": "primary"},
            ],
            "pipes": [
                {"id": "P1", "fromNode": "N1", "toNode": "N2", "geometry": [[250, 300], [850, 300]], "state": "primary", "sourceEdgeIds": ["P1"]},
                {"id": "P2", "fromNode": "N2", "toNode": "N3", "geometry": [[850, 300], [850, 700]], "state": "primary", "sourceEdgeIds": ["P2"]},
            ],
            "symbols": [],
            "dimensions": [{"id": "D1", "kind": "length", "value": 1800, "rawText": "1800 мм", "targetId": "P1", "state": "primary"}],
            "labels": [],
        }

    def test_discontinuous_shared_node_never_drops_or_bridges_a_pipe(self):
        for gap in (2, 20):
            with self.subTest(gap=gap):
                pipes = [
                    {"id": "A", "fromNode": "N1", "toNode": "N2",
                     "geometry": [[0, 0], [100, 0]]},
                    {"id": "B", "fromNode": "N2", "toNode": "N3",
                     "geometry": [[100 + gap, 0], [200, 0]]},
                ]
                merged = _merge_pipe_network(pipes)
                self.assertEqual(len(merged), 2)
                for actual, original in zip(merged, pipes):
                    self.assertIn(actual["geometry"], [original["geometry"], original["geometry"][::-1]])
                self.assertEqual([p["sourceEdgeIds"] for p in merged], [["A"], ["B"]])

    def test_continuous_bent_route_keeps_all_source_vertices(self):
        pipes = [
            {"id": "A", "fromNode": "N1", "toNode": "N2", "geometry": [[0, 0], [100, 0]]},
            {"id": "B", "fromNode": "N2", "toNode": "N3", "geometry": [[100, 0], [100, 100]]},
        ]
        merged = _merge_pipe_network(pipes)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["geometry"], [[0, 0], [100, 0], [100, 100]])
        self.assertEqual(merged[0]["sourceEdgeIds"], ["A", "B"])

    def test_content_fit_uses_model_bbox_not_blank_photo_margins(self):
        layout, diagnostics = build_clean_layout(self._model(), template=build_drawing_template())
        crop = layout["sourceContentBounds"]
        self.assertLess(crop["w"], 900)
        self.assertLess(crop["h"], 700)
        self.assertGreater(diagnostics["sourcePageAreaUtilization"], 0.15)
        self.assertTrue(layout["coordinateTransform"]["topologyPreserved"])
        self.assertEqual(layout["pipes"][0]["geometry"][0], layout["nodes"][0]["position"])

    def test_page_header_content_and_footer_are_separate_zones(self):
        layout, _ = build_clean_layout(self._model(), template=build_drawing_template())
        area = layout["drawingArea"]
        frame = layout["frame"]
        self.assertGreaterEqual(area["y"], frame["headerBottom"])
        self.assertLessEqual(area["y"] + area["h"], frame["footerTop"])

    def test_wide_content_selects_landscape_without_reference_lock(self):
        model = {
            "sourceImage": {"width": 1200, "height": 800},
            "nodes": [{"id": "A", "position": [100, 300]}, {"id": "B", "position": [1100, 300]}],
            "pipes": [{"id": "P", "fromNode": "A", "toNode": "B", "geometry": [[100, 300], [1100, 300]], "state": "primary"}],
            "symbols": [], "dimensions": [], "labels": [],
        }
        layout, _ = build_clean_layout(model, template=build_drawing_template())
        self.assertEqual(layout["page"]["orientation"], "landscape")
        self.assertEqual(layout["page"]["widthMm"], 297)

    def _numbered_template(self):
        template = build_drawing_template()
        template["layout"]["autoNumberSections"] = True
        return template

    def test_default_sheet_does_not_invent_control_section_numbers(self):
        layout, diagnostics = build_clean_layout(self._model(), template=build_drawing_template())
        self.assertEqual(layout["sectionTags"], [])
        self.assertEqual(diagnostics["provisionalSectionNumbers"], 0)

    def test_unconfirmed_section_numbers_are_provisional_and_separate_from_model(self):
        model = self._model()
        layout, diagnostics = build_clean_layout(model, template=self._numbered_template())
        self.assertEqual(len(layout["sectionTags"]), 1)
        self.assertTrue(all(item["requiresConfirmation"] for item in layout["sectionTags"]))
        self.assertEqual(diagnostics["provisionalSectionNumbers"], 1)
        self.assertNotIn("sectionTags", model)

    def test_confirmed_number_label_prevents_duplicate_generated_tag(self):
        model = self._model()
        model["labels"] = [{"id": "L1", "text": "7", "targetId": "P1", "role": "section_number",
                            "state": "primary", "bbox": {"x": 450, "y": 260, "w": 15, "h": 12}}]
        layout, _ = build_clean_layout(model, template=self._numbered_template())
        self.assertEqual(len(layout["sectionTags"]), 0)
        self.assertEqual(layout["labels"][0]["text"], "7")

    def test_nearby_unlinked_numeric_label_prevents_duplicate_auto_number(self):
        model = self._model()
        model["labels"] = [{"id": "L2", "text": "12", "role": "pipe_label",
                            "state": "primary", "bbox": {"x": 500, "y": 280, "w": 20, "h": 14}}]
        layout, _ = build_clean_layout(model, template=self._numbered_template())
        self.assertEqual(len(layout["sectionTags"]), 0)

    def test_linked_length_dimension_has_extension_line_and_arrows(self):
        layout, _ = build_clean_layout(self._model(), template=build_drawing_template())
        dimension = layout["dimensions"][0]
        self.assertIsNotNone(dimension["graphic"])
        self.assertEqual(len(dimension["graphic"]["extensionLines"]), 2)
        self.assertEqual(len(dimension["graphic"]["arrowLines"]), 4)
        self.assertTrue(dimension["notToScale"])

    def test_new_catalog_symbols_have_editable_geometry_and_ports(self):
        for symbol_type in ("regulator", "filter", "tee", "reducer", "pressure_gauge", "riser_marker", "gas_consumer"):
            self.assertIn(symbol_type, SYMBOL_CATALOG)
            symbol = {"type": symbol_type, "bbox": {"x": 100, "y": 100, "w": 24, "h": 24}, "rotation": 90}
            self.assertTrue(symbol_primitives(symbol))
            self.assertTrue(symbol_port_positions(symbol))

    def test_svg_and_dxf_export_sheet_frame_dimensions_and_provisional_tags(self):
        layout, _ = build_clean_layout(self._model(), template=self._numbered_template())
        svg = build_layout_svg(layout)
        dxf = build_layout_dxf(layout)
        ET.fromstring(svg)
        self.assertIn('data-layer="SECTION_TAGS"', svg)
        self.assertIn('data-layer="DIMENSION_LINES"', svg)
        self.assertIn('data-zone="legend"', svg)
        self.assertIn('data-zone="signatures"', svg)
        self.assertIn('data-provisional="true"', svg)
        self.assertIn("SHEET_BLOCKS", dxf)
        self.assertIn("DIMENSION_LINES", dxf)
        self.assertIn("SECTION_TAGS", dxf)
        self.assertIn("LWPOLYLINE", dxf)

    def test_quality_report_never_claims_engineering_approval(self):
        layout, _ = build_clean_layout(self._model(), template=self._numbered_template())
        report = validate_clean_layout(layout, {"counts": {"error": 0, "review": 1, "warning": 0}})
        self.assertEqual(report["engineeringApproval"], "required")
        self.assertEqual(report["automatedChangesToGeometry"], 0)
        self.assertIn(report["status"], {"needs_review", "draft_ready"})
        self.assertTrue(any(item["code"] == "provisional_section_numbers" for item in report["findings"]))

    def test_source_photo_alignment_overlay_is_written(self):
        image = np.full((160, 240, 3), 245, dtype=np.uint8)
        model = {
            "pipes": [{"id": "P1", "state": "primary", "geometry": [[20, 80], [210, 80]]}],
            "nodes": [{"id": "N1", "state": "primary", "position": [20, 80]}],
            "symbols": [{"id": "S1", "state": "review", "bbox": {"x": 100, "y": 60, "w": 24, "h": 30}}],
        }
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "cad-alignment-overlay.png"
            meta = render_cad_alignment_overlay(image, model, output)
            self.assertTrue(output.is_file())
            self.assertTrue(meta["available"])
            self.assertEqual(meta["primaryPipes"], 1)
            saved = cv2.imread(str(output))
            self.assertIsNotNone(saved)
            self.assertEqual(saved.shape[:2], image.shape[:2])


if __name__ == "__main__":
    unittest.main()
