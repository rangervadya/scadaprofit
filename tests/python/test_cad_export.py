"""CAD export lives in its own module (P2-1).

`processor.py` used to hold the whole pipeline plus SVG/DXF export. The export
cluster moved to `cad_export.py` and is re-exported so `processor.build_clean_svg`
keeps working for callers and tests.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "ollama" / "engine"))

import cad_export  # noqa: E402
import processor  # noqa: E402


class CadExportModuleTests(unittest.TestCase):
    def test_export_helpers_live_in_cad_export(self):
        for name in [
            'build_clean_svg',
            'build_dxf',
            '_cad_edge_chains',
            '_clean_cad_points',
            '_sheet_layout',
            '_semantic_route_chains',
            '_annotation_export_kind',
            '_primary_semantic_chains',
        ]:
            self.assertTrue(hasattr(cad_export, name), f"cad_export.{name} is missing")

    def test_processor_reexports_the_export_api(self):
        for name in [
            'build_clean_svg',
            'build_dxf',
            '_cad_edge_chains',
            '_clean_cad_points',
        ]:
            self.assertIs(getattr(processor, name), getattr(cad_export, name), f"processor.{name} not re-exported")

    def test_build_clean_svg_produces_an_svg_document(self):
        edges = [
            {
                'geometry': [[10, 10], [110, 10], [110, 60]],
                'cad_include': True,
                'id': 'e1',
            }
        ]
        annotations = [
            {'text': 'ДН 100', 'bbox': {'x': 20, 'y': 20, 'w': 60, 'h': 14}, 'verified': True},
        ]
        svg = cad_export.build_clean_svg(200, 100, edges, annotations)
        self.assertTrue(svg.lstrip().startswith('<?xml') or '<svg' in svg[:200])
        self.assertIn('ДН 100', svg)
        self.assertIn('<svg', svg)

    def test_build_dxf_returns_a_dxf_payload(self):
        edges = [{'geometry': [[0, 0], [50, 0]], 'cad_include': True, 'id': 'e1'}]
        dxf = cad_export.build_dxf(200, 100, edges, [])
        self.assertIsInstance(dxf, str)
        self.assertIn('SECTION', dxf.upper())


if __name__ == '__main__':
    unittest.main()