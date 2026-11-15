"""Streaming multipart parser (P1-8).

The parser must keep the same contract as the previous in-memory
email-parser implementation (field names, filenames, UTF-8 decoding) while
spooling the body to disk instead of holding it in RAM.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "services" / "vdgo"))

import app  # noqa: E402


def build_multipart(boundary: str, parts: list[tuple[str, str | None, bytes]]) -> bytes:
    out = bytearray()
    for name, filename, payload in parts:
        out += f"--{boundary}\r\n".encode()
        disposition = f'form-data; name="{name}"'
        if filename is not None:
            disposition += f'; filename="{filename}"'
        out += f"Content-Disposition: {disposition}\r\n".encode()
        if filename is None:
            out += b"Content-Type: text/plain; charset=utf-8\r\n"
        else:
            out += b"Content-Type: application/octet-stream\r\n"
        out += b"\r\n"
        out += payload
        out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()
    return bytes(out)


class FakeHandler:
    """Minimal stand-in exposing what _parse_multipart_streaming touches."""

    def __init__(self, body: bytes, content_type: str):
        import io

        self._body = io.BytesIO(body)
        self.headers = {"Content-Length": str(len(body)), "Content-Type": content_type}
        self.rfile = self._body
        self._request_hash = ""

    # bind the real methods
    _spool_body = app.Handler._spool_body
    _parse_multipart_streaming = app.Handler._parse_multipart_streaming


class StreamingMultipartTest(unittest.TestCase):
    def setUp(self):
        self._uploads = app.UPLOADS

    def tearDown(self):
        app.UPLOADS = self._uploads

    def _parse(self, body: bytes, content_type: str):
        handler = FakeHandler(body, content_type)
        boundary = app._multipart_boundary(content_type)
        return handler._parse_multipart_streaming(boundary)

    def test_boundary_extraction(self):
        self.assertEqual(
            app._multipart_boundary('multipart/form-data; boundary=abc123'),
            b"--abc123",
        )
        self.assertEqual(
            app._multipart_boundary('multipart/form-data; boundary="a b c"'),
            b"--a b c",
        )
        with self.assertRaises(ValueError):
            app._multipart_boundary("multipart/form-data")

    def test_text_fields_are_decoded_as_utf8(self):
        body = build_multipart(
            "BOUND",
            [
                ("report_number", None, "ВК-1".encode()),
                ("address", None, "ул. Мира, 1".encode()),
            ],
        )
        form, files = self._parse(body, "multipart/form-data; boundary=BOUND")
        self.assertEqual(form["report_number"], "ВК-1")
        self.assertEqual(form["address"], "ул. Мира, 1")
        self.assertEqual(files, {})

    def test_file_part_is_streamed_to_disk(self):
        import tempfile

        tmp = Path(tempfile.mkdtemp())
        app.UPLOADS = tmp
        payload = b"\x00\x01\x02binary\xff" * 100
        body = build_multipart(
            "BOUND",
            [
                ("report_number", None, b"1"),
                ("schemes", "scheme.pdf", payload),
            ],
        )
        form, files = self._parse(body, "multipart/form-data; boundary=BOUND")
        self.assertEqual(form["report_number"], "1")
        self.assertIn("schemes", files)
        stored = Path(files["schemes"]).read_bytes()
        self.assertEqual(stored, payload)

    def test_binary_content_with_crlf_is_preserved(self):
        import tempfile

        tmp = Path(tempfile.mkdtemp())
        app.UPLOADS = tmp
        payload = b"line1\r\nline2\r\n--not-a-boundary\r\nline3"
        body = build_multipart("BOUND", [("f", "a.bin", payload)])
        _, files = self._parse(body, "multipart/form-data; boundary=BOUND")
        self.assertEqual(Path(files["f"]).read_bytes(), payload)

    def test_structured_payload_field_is_renamed(self):
        body = build_multipart(
            "BOUND",
            [("workforce_schemes_json", None, b"[]")],
        )
        form, _ = self._parse(body, "multipart/form-data; boundary=BOUND")
        self.assertIn("workforce_schemes_json", form)
        self.assertEqual(form["workforce_schemes_json"], "[]")

    def test_structured_field_accepts_bracket_wrapper(self):
        body = build_multipart(
            "BOUND",
            [("form[workforce_schemes_json]", None, b"[]")],
        )
        form, _ = self._parse(body, "multipart/form-data; boundary=BOUND")
        self.assertIn("workforce_schemes_json", form)

    def test_request_hash_is_computed(self):
        body = build_multipart("BOUND", [("a", None, b"1")])
        handler = FakeHandler(body, "multipart/form-data; boundary=BOUND")
        handler._spool_body()
        self.assertEqual(len(handler._request_hash), 64)


if __name__ == "__main__":
    unittest.main()