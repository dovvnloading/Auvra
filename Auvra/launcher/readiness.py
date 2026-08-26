"""Loopback HTTP readiness checks."""

from __future__ import annotations

from dataclasses import dataclass
import http.client
import time
from typing import Callable


@dataclass(frozen=True)
class ReadinessResult:
    ready: bool
    url: str
    attempts: int
    detail: str = ""
    reason: str = ""


def probe_http(host: str, port: int, *, timeout: float = 1.0) -> tuple[bool, str]:
    connection: http.client.HTTPConnection | None = None
    try:
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
        connection.request("GET", "/", headers={"Connection": "close"})
        response = connection.getresponse()
        # Any complete HTTP response is evidence of a listening HTTP server;
        # Vite may return a non-2xx response for a malformed project root.
        return True, f"HTTP {response.status}"
    except (OSError, http.client.HTTPException) as exc:
        return False, str(exc)[:160]
    finally:
        if connection is not None:
            connection.close()


def wait_for_readiness(
    host: str,
    port: int,
    process_alive: Callable[[], bool],
    *,
    timeout: float = 30.0,
    interval: float = 0.15,
    probe: Callable[[str, int], tuple[bool, str]] = probe_http,
) -> ReadinessResult:
    url = f"http://{host}:{port}/"
    deadline = time.monotonic() + timeout
    attempts = 0
    detail = "no response"
    while time.monotonic() < deadline:
        attempts += 1
        if not process_alive():
            return ReadinessResult(
                False,
                url,
                attempts,
                "launcher child exited before readiness",
                "child-exited",
            )
        ready, detail = probe(host, port)
        if ready and process_alive():
            return ReadinessResult(True, url, attempts, detail)
        time.sleep(interval)
    return ReadinessResult(
        False,
        url,
        attempts,
        f"timed out after {timeout:.1f}s ({detail})",
        "timeout",
    )
