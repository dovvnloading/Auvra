from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from Auvra.launcher.process import OwnedProcess, ProcessCleanupError, run_owned_command
from Auvra.launcher.platform import PosixProcessGroup


FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "fake_child.py"


def _wait_for_file(path: Path, process: OwnedProcess, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not path.exists() and process.is_alive():
        time.sleep(0.02)
    if not path.exists():
        raise AssertionError(f"child did not create {path}; return code={process.poll()}")


def _pid_exists(pid: int) -> bool:
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        process_query_limited_information = 0x1000
        still_active = 259
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL
        handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        try:
            exit_code = wintypes.DWORD()
            return bool(kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))) and exit_code.value == still_active
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def _wait_for_pid_exit(pid: int, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and _pid_exists(pid):
        time.sleep(0.02)
    if _pid_exists(pid):
        raise AssertionError(f"owned descendant {pid} survived cleanup")


class OwnedProcessTests(unittest.TestCase):
    def test_finite_owned_command_captures_output_from_space_safe_cwd(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra owned command spaces ") as raw:
            result = run_owned_command(
                [sys.executable, "-c", "import os; print(os.getcwd())"],
                cwd=raw,
            )
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.strip(), str(Path(raw)))

    def test_finite_owned_command_bounds_multimegabyte_partial_line(self) -> None:
        result = run_owned_command(
            [sys.executable, "-c", "import sys; sys.stdout.write('x' * 5000000)"],
            cwd=Path.cwd(),
        )
        self.assertEqual(result.returncode, 0)
        self.assertLessEqual(len(result.stdout.encode("utf-8")), 64 * 1024)
        self.assertTrue(result.stdout.endswith("x"))

    def test_live_output_reader_caps_partial_callbacks(self) -> None:
        chunks: list[str] = []
        with tempfile.TemporaryDirectory(prefix="auvra output chunks ") as raw:
            owned = OwnedProcess.launch(
                [sys.executable, "-c", "import sys;sys.stdout.write('y' * 1000000)"],
                Path(raw), on_output=chunks.append,
            )
            try:
                owned.wait(timeout=10)
            finally:
                owned.terminate(grace=1)
            self.assertGreater(len(chunks), 1)
            self.assertLessEqual(max(map(len, chunks)), 8192)

    def test_cleanup_uses_hard_owner_stop_when_graceful_signal_fails(self) -> None:
        process = mock.Mock(pid=1234, stdout=None)
        process.poll.return_value = 0
        owner = mock.Mock()
        owner.terminate.side_effect = OSError("graceful signal unavailable")
        owned = OwnedProcess(process, owner)
        owned.terminate(grace=0)
        owner.kill.assert_called_once_with(process)
        owner.close.assert_called_once_with()

    def test_cleanup_reports_hard_owner_stop_failure(self) -> None:
        process = mock.Mock(pid=1234, stdout=None)
        process.poll.return_value = 0
        owner = mock.Mock()
        owner.kill.side_effect = OSError("owned group could not be stopped")
        owned = OwnedProcess(process, owner)
        with self.assertRaisesRegex(ProcessCleanupError, "owned group could not be stopped"):
            owned.terminate(grace=0)
        owner.close.assert_called_once_with()

    def test_launch_uses_exact_cwd_and_cleanup_on_posix_group(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra process path with spaces ") as raw:
            cwd = Path(raw)
            pid_file = cwd / "child.pid"
            owned = OwnedProcess.launch([sys.executable, str(FIXTURE), "--pid-file", str(pid_file)], cwd)
            try:
                _wait_for_file(pid_file, owned)
                self.assertTrue(owned.is_alive())
                if os.name == "posix":
                    self.assertIsInstance(owned.owner, PosixProcessGroup)
                    self.assertEqual(os.getpgid(owned.process.pid), owned.process.pid)
            finally:
                owned.terminate(grace=2)
                if owned.process.stdout is not None:
                    owned.process.stdout.close()
            self.assertFalse(owned.is_alive())

    def test_cleanup_terminates_descendant_without_touching_unrelated_child(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra descendants ") as raw:
            cwd = Path(raw)
            child_pid = cwd / "child.pid"
            descendant_pid = cwd / "descendant.pid"
            unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(10)"])
            owned = OwnedProcess.launch([
                sys.executable, str(FIXTURE), "--pid-file", str(child_pid),
                "--spawn-pid-file", str(descendant_pid), "--child-script", str(FIXTURE),
            ], cwd)
            try:
                _wait_for_file(child_pid, owned)
                _wait_for_file(descendant_pid, owned)
                descendant = int(descendant_pid.read_text(encoding="utf-8"))
                owned.terminate(grace=2)
                self.assertFalse(owned.is_alive())
                _wait_for_pid_exit(descendant)
                self.assertIsNone(unrelated.poll())
            finally:
                if owned.is_alive():
                    owned.terminate(grace=1)
                if owned.process.stdout is not None:
                    owned.process.stdout.close()
                unrelated.terminate()
                unrelated.wait(timeout=2)

    @unittest.skipUnless(os.name == "nt", "Windows Job Objects only")
    def test_windows_launch_has_private_job_owner(self) -> None:
        with tempfile.TemporaryDirectory(prefix="auvra windows job ") as raw:
            cwd = Path(raw)
            pid_file = cwd / "child.pid"
            owned = OwnedProcess.launch([sys.executable, str(FIXTURE), "--pid-file", str(pid_file)], cwd)
            try:
                _wait_for_file(pid_file, owned)
                self.assertEqual(type(owned.owner).__name__, "WindowsJob")
            finally:
                owned.terminate(grace=2)
                if owned.process.stdout is not None:
                    owned.process.stdout.close()
        self.assertFalse(owned.is_alive())

    def test_windows_job_contains_child_before_resuming_it(self) -> None:
        source = (Path(__file__).parents[2] / "Auvra" / "launcher" / "platform" / "windows_job.py").read_text(encoding="utf-8")
        self.assertIn("CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED", source)
        self.assertIn("AssignProcessToJobObject", source)
        self.assertIn("_resume_primary_thread", source)

    @unittest.skipUnless(os.name == "nt", "Windows Job Objects only")
    def test_windows_job_reports_forced_termination_and_close_failures(self) -> None:
        from Auvra.launcher.platform import windows_job

        job = windows_job.WindowsJob.__new__(windows_job.WindowsJob)
        job.handle = 123
        fake_kernel = mock.Mock()
        fake_kernel.TerminateJobObject.return_value = False
        fake_kernel.CloseHandle.return_value = False
        with mock.patch.object(windows_job, "kernel32", fake_kernel):
            with self.assertRaisesRegex(OSError, "TerminateJobObject"):
                job.kill(mock.Mock())
            with self.assertRaisesRegex(OSError, "CloseHandle"):
                job.close()
        self.assertEqual(job.handle, 123)


if __name__ == "__main__":
    unittest.main()
