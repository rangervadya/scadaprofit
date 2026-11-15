import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "vdgo"))

from datetime import UTC

import database  # noqa: E402


class FakeCursor:
    def __init__(self, row=None):
        self.row = row
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((" ".join(sql.split()), params))

    def fetchone(self):
        return self.row

    def fetchall(self):
        return [self.row] if self.row else []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    def __init__(self, cursor):
        self._cursor = cursor

    def execute(self, sql, params=None):
        self._cursor.execute(sql, params)
        return self._cursor

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class IdempotencyHelpersTest(unittest.TestCase):
    def setUp(self):
        self._dsn = database._dsn
        self._connect = database._connect
        database._dsn = lambda: "postgresql://x"

    def tearDown(self):
        database._dsn = self._dsn
        database._connect = self._connect

    def test_find_returns_none_without_key(self):
        database._connect = lambda: FakeConn(FakeCursor())
        self.assertIsNone(database.find_idempotent("POST /generate", ""))
        self.assertIsNone(database.find_idempotent("", "abc"))

    def test_find_returns_stored_response(self):
        from datetime import datetime, timedelta

        row = ({"file": "/app/output/.idem/a.pdf"}, datetime.now(UTC) + timedelta(hours=1))
        database._connect = lambda: FakeConn(FakeCursor(row))
        got = database.find_idempotent("POST /generate", "a" * 64)
        self.assertEqual(got["file"], "/app/output/.idem/a.pdf")

    def test_find_ignores_expired(self):
        from datetime import datetime, timedelta

        row = ({"file": "/app/output/.idem/a.pdf"}, datetime.now(UTC) - timedelta(hours=1))
        database._connect = lambda: FakeConn(FakeCursor(row))
        self.assertIsNone(database.find_idempotent("POST /generate", "a" * 64))

    def test_save_uses_upsert_with_jsonb(self):
        cursor = FakeCursor()
        database._connect = lambda: FakeConn(cursor)
        database.save_idempotent("POST /generate", "b" * 64, {"file": "/x.pdf", "contentType": "application/pdf"})
        self.assertTrue(cursor.executed, "no SQL executed")
        sql, params = cursor.executed[0]
        self.assertIn("INSERT INTO idempotency_keys", sql)
        self.assertIn("ON CONFLICT (key, endpoint) DO UPDATE", sql)
        self.assertEqual(params[0], "b" * 64)
        self.assertEqual(params[1], "POST /generate")
        # response is passed as a json string for the jsonb cast
        self.assertEqual(json.loads(params[2])["file"], "/x.pdf")

    def test_helpers_noop_without_dsn(self):
        database._dsn = lambda: ""
        self.assertIsNone(database.find_idempotent("POST /generate", "k"))
        self.assertIsNone(database.save_idempotent("POST /generate", "k", {"a": 1}))


if __name__ == "__main__":
    unittest.main()