"""Loopback HTTP readiness checks."""

from __future__ import annotations

from dataclasses import dataclass
import http.client
import time
from typing import Callable


READY_PATH = "/__auvra_ready__"
READY_TOKEN_HEADER = "X-Auvra-Ready-Token"


@dataclass(frozen=True)
class ReadinessResult:
    ready: bool
    url: str
    attempts: int
    detail: str = ""
    reason: str = ""


def probe_http(host: str, port: int, *, timeout: float = 1.0,
               expected_token: str | None = None) -> tuple[bool, str]:
    connection: http.client.HTTPConnection | None = None
    try:
        connection = http.client.HTTPConnection(host, port, timeout=timeout)
        path = READY_PATH if expected_token is not None else "/"
        connection.request("GET", path, headers={"Connection": "close"})
        response = connection.getresponse()
        if expected_token is not None:
            observed_token = response.getheader(READY_TOKEN_HEADER)
            if response.status != 200 or observed_token != expected_token:
                return False, "Auvra readiness identity mismatch"
            return True, "Auvra Vite readiness identity verified"
        # Without a launch token this helper remains useful for generic
        # loopback diagnostics, where any complete HTTP response is evidence
        # of a listening server.
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
    expected_token: str | None = None,
    probe: Callable[[str, int], tuple[bool, str]] | None = None,
) -> ReadinessResult:
    url = f"http://{host}:{port}/"
    deadline = time.monotonic() + timeout
    attempts = 0
    detail = "no response"
    probe_fn = probe or (lambda probe_host, probe_port: probe_http(
        probe_host, probe_port, expected_token=expected_token,
    ))
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
        ready, detail = probe_fn(host, port)
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
