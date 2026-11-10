import unittest

from pdf_export import svg_to_pdf


class PdfExportTests(unittest.TestCase):
    def test_converts_svg_sheet_to_vector_pdf(self):
        svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">
          <rect x="10" y="10" width="190" height="277" fill="white" stroke="black"/>
          <path d="M20 40 H180 V120" fill="none" stroke="black" stroke-width="1"/>
          <text x="20" y="30" font-size="5">Test drawing</text>
        </svg>'''
        result = svg_to_pdf(svg)
        self.assertTrue(result.startswith(b"%PDF-"))
        self.assertGreater(len(result), 500)

    def test_rejects_non_svg_input(self):
        with self.assertRaises(ValueError):
            svg_to_pdf("not an svg")


if __name__ == "__main__":
    unittest.main()
