from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest

from Auvra.launcher.readiness import probe_http, wait_for_readiness


class ReadinessTests(unittest.TestCase):
    def test_probe_requires_launch_identity_token(self) -> None:
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                self.send_response(200)
                self.send_header("Content-Type", "text/plain")
                self.send_header("X-Auvra-Ready-Token", "actual-token")
                self.end_headers()
                self.wfile.write(b"ready\n")

            def log_message(self, *_args: object) -> None:
                return

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            port = server.server_address[1]
            self.assertEqual(probe_http("127.0.0.1", port, expected_token="wrong"),
                             (False, "Auvra readiness identity mismatch"))
            self.assertEqual(probe_http("127.0.0.1", port, expected_token="actual-token"),
                             (True, "Auvra Vite readiness identity verified"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_success_requires_child_alive_and_reports_url(self) -> None:
        alive = iter([True, True, True])
        probes: list[tuple[str, int]] = []

        def probe(host: str, port: int) -> tuple[bool, str]:
            probes.append((host, port))
            return True, "HTTP 200"

        result = wait_for_readiness("127.0.0.1", 3042, lambda: next(alive), timeout=0.1, interval=0, probe=probe)
        self.assertTrue(result.ready)
        self.assertEqual(result.url, "http://127.0.0.1:3042/")
        self.assertEqual(result.attempts, 1)
        self.assertEqual(probes, [("127.0.0.1", 3042)])

    def test_timeout_is_actionable_when_server_never_answers(self) -> None:
        result = wait_for_readiness("127.0.0.1", 3043, lambda: True, timeout=0.01, interval=0, probe=lambda *_: (False, "connection refused"))
        self.assertFalse(result.ready)
        self.assertIn("timed out", result.detail)
        self.assertIn("connection refused", result.detail)
        self.assertGreaterEqual(result.attempts, 1)

    def test_child_exit_fails_before_unrelated_listener_can_count_as_ready(self) -> None:
        result = wait_for_readiness("127.0.0.1", 3000, lambda: False, timeout=1, interval=0, probe=lambda *_: (True, "HTTP 200"))
        self.assertFalse(result.ready)
        self.assertIn("child exited", result.detail)
        self.assertEqual(result.attempts, 1)


if __name__ == "__main__":
    unittest.main()
