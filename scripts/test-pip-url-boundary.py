"""Offline regression for GHSA-qwm4-qh6w-59xr in the locked audit toolchain.

Exercise pip's real filename parser without downloading or writing artifacts.
These private imports intentionally fail closed if pip changes the boundary.
"""

import unittest

from pip._internal.models.link import Link
from pip._internal.network.download import _get_http_response_filename
from pip._vendor.requests import Response


class PipFilenameBoundaryTests(unittest.TestCase):
    def test_url_filename_remains_one_component(self):
        for filename in (
            "%252e%252e%252fprobe.whl",
            "a%252Fb.whl",
            "%2e%2e",
            "%2e",
        ):
            with self.subTest(filename=filename):
                try:
                    parsed = Link(f"https://example.invalid/{filename}").filename
                except ValueError:
                    continue
                self.assertNotIn("/", parsed)
                self.assertNotIn(parsed, ("", ".", ".."))

    def test_response_header_cannot_escape_directory(self):
        for filename in ("../probe.whl", "..", ".", "/tmp/probe.whl"):
            with self.subTest(filename=filename):
                response = Response()
                response.url = "https://example.invalid/demo.whl"
                response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
                try:
                    parsed = _get_http_response_filename(response, Link(response.url))
                except ValueError:
                    continue
                self.assertNotIn("/", parsed)
                self.assertNotIn(parsed, ("", ".", ".."))

    def test_legitimate_filenames_are_preserved(self):
        for encoded, expected in (
            ("demo-1.0-py3-none-any.whl", "demo-1.0-py3-none-any.whl"),
            ("demo-1.0%2Blocal-py3-none-any.whl", "demo-1.0+local-py3-none-any.whl"),
        ):
            self.assertEqual(Link(f"https://example.invalid/{encoded}").filename, expected)
        response = Response()
        response.url = "https://example.invalid/download"
        response.headers["Content-Disposition"] = 'attachment; filename="demo-1.0.whl"'
        self.assertEqual(
            _get_http_response_filename(response, Link(response.url)), "demo-1.0.whl"
        )


if __name__ == "__main__":
    unittest.main()
