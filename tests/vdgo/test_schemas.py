"""Tests for the typed CAD attachment payload."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "services" / "vdgo"
sys.path.insert(0, str(BACKEND))

from schemas import parse_workforce_schemes


class WorkforceSchemeSchemaTests(unittest.TestCase):
    def test_valid_payload_keeps_known_fields_and_defaults(self):
        raw = json.dumps([{
            "id": "report-1",
            "street": "Тестовая",
            "address": "15",
            "userName": "Иванов Иван",
            "submittedAt": "11.11.2026",
            "status": "accepted",
            "pngBase64": "AAAA",
        }])
        entries = parse_workforce_schemes(raw)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["street"], "Тестовая")
        self.assertEqual(entries[0]["status"], "accepted")
        self.assertEqual(entries[0]["id"], "report-1")

    def test_non_list_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "неверный формат"):
            parse_workforce_schemes('{"pngBase64":"AAAA"}')

    def test_too_many_entries_are_rejected(self):
        raw = json.dumps([{"pngBase64": "AAAA"} for _ in range(41)])
        with self.assertRaisesRegex(ValueError, "не более 40"):
            parse_workforce_schemes(raw)

    def test_oversized_base64_is_rejected(self):
        raw = json.dumps([{"pngBase64": "A" * (16 * 1024 * 1024 + 1)}])
        with self.assertRaisesRegex(ValueError, "Схема № 1"):
            parse_workforce_schemes(raw)

    def test_missing_png_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "Схема № 1"):
            parse_workforce_schemes(json.dumps([{"street": "Тестовая"}]))

    def test_unknown_fields_are_ignored(self):
        raw = json.dumps([{"pngBase64": "AAAA", "unexpected": {"nested": True}}])
        entries = parse_workforce_schemes(raw)
        self.assertNotIn("unexpected", entries[0])


if __name__ == "__main__":
    unittest.main()