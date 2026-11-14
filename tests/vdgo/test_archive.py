"""Regression checks for the file-backed conclusion archive."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "services" / "vdgo"
sys.path.insert(0, str(BACKEND))

import archive


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.old_dir = archive.ARCHIVE_DIR
        self.old_index = archive.ARCHIVE_INDEX
        archive.ARCHIVE_DIR = self.root / "archive"
        archive.ARCHIVE_INDEX = self.root / "archive_index.json"

    def tearDown(self):
        archive.ARCHIVE_DIR = self.old_dir
        archive.ARCHIVE_INDEX = self.old_index
        self.temporary.cleanup()

    def test_archive_document_copies_file_and_returns_client_safe_entry(self):
        source = self.root / "generated.pdf"
        source.write_bytes(b"%PDF-1.4 regression payload")

        entry = archive.archive_document(
            source,
            report_id=7,
            report_number="905_2025",
            report_date="14.11.2026",
            output_format="pdf",
            page_count=2,
            content_type="application/pdf",
            original_filename="Заключение_905_2025.pdf",
        )

        self.assertEqual(entry["id"], 7)
        self.assertTrue(entry["archived"])
        self.assertEqual(entry["page_count"], 2)
        self.assertNotIn("storage_path", entry)
        self.assertTrue((archive.ARCHIVE_DIR / entry["output_filename"]).is_file())

        listed = archive.list_archived(limit=10)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], 7)
        self.assertNotIn("storage_path", listed[0])

        self.assertEqual(archive.find_archived(7)["id"], 7)
        path = archive.archived_path(7)
        self.assertIsNotNone(path)
        self.assertEqual(path.read_bytes(), b"%PDF-1.4 regression payload")
        self.assertIsNone(archive.archived_path(999))

    def test_missing_source_is_not_archived(self):
        self.assertIsNone(
            archive.archive_document(
                self.root / "missing.pdf",
                report_id=1,
                report_number="1",
                report_date="01.01.2026",
                output_format="pdf",
                page_count=1,
                content_type="application/pdf",
                original_filename="missing.pdf",
            )
        )
        self.assertEqual(archive.list_archived(10), [])


if __name__ == "__main__":
    unittest.main()