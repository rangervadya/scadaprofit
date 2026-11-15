"""Regression check for atomic engine artifact writes."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services' / 'ollama'))

from engine.processor import _atomic_write_text


class AtomicWriteTests(unittest.TestCase):
    def test_atomic_write_replaces_target_and_leaves_no_temporary_file(self):
        with TemporaryDirectory() as temporary:
            target = Path(temporary) / 'graph.json'
            _atomic_write_text(target, '{"status":"ok"}')
            self.assertEqual(target.read_text(encoding='utf-8'), '{"status":"ok"}')
            _atomic_write_text(target, '{"status":"updated"}')
            self.assertEqual(target.read_text(encoding='utf-8'), '{"status":"updated"}')
            self.assertEqual([path.name for path in Path(temporary).iterdir()], ['graph.json'])


if __name__ == '__main__':
    unittest.main()
