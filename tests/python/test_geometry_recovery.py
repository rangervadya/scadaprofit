import unittest

import numpy as np

from geometry_recovery import filter_paper_rules, recover_vertical_connections


class GeometryRecoveryTests(unittest.TestCase):
    def test_full_width_ruling_is_kept_only_for_review(self):
        ink = np.zeros((300, 220), dtype=np.uint8)
        ink[270, 5:215] = 255
        edges = [
            {'geometry': [[6, 270], [80, 270]], 'cad_include': True},
            {'geometry': [[6, 270], [30, 200]], 'cad_include': True},
        ]
        cleaned = filter_paper_rules(edges, ink)
        self.assertEqual(edges[0]['cad_reason'], 'paper-rule-review')
        self.assertFalse(edges[0]['cad_include'])
        self.assertTrue(edges[1]['cad_include'])
        self.assertFalse(cleaned[270].any())
        self.assertTrue(ink[270].any())

    def test_connector_requires_continuous_ink_and_clear_text_mask(self):
        for blocked in ('ink-gap', 'ocr', None):
            with self.subTest(blocked=blocked):
                ink = np.zeros((600, 400), dtype=np.uint8)
                text = np.zeros_like(ink)
                ink[100:172, 100] = 255
                if blocked == 'ink-gap':
                    ink[125:137] = 0
                if blocked == 'ocr':
                    text[125:137, 100] = 255
                nodes = [
                    dict(id=k, x=x, y=y, degree=1)
                    for k, x, y in [('a', 50, 100), ('b', 100, 100), ('c', 100, 171), ('d', 150, 171)]
                ]
                edges = [
                    {'from': 'a', 'to': 'b', 'cad_include': True},
                    {'from': 'c', 'to': 'd', 'cad_include': True},
                ]
                recovered = recover_vertical_connections(nodes, edges, ink, text)
                self.assertEqual(recovered, int(blocked is None))
                if recovered:
                    self.assertEqual((edges[-1]['from'], edges[-1]['to']), ('b', 'c'))
