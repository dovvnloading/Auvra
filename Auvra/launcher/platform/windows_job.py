"""Windows Job Object ownership, implemented with stdlib ctypes only."""

from __future__ import annotations

import ctypes
from ctypes import wintypes
import signal
import subprocess


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
JobObjectExtendedLimitInformation = 9
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_SUSPENDED = 0x00000004
THREAD_SUSPEND_RESUME = 0x0002
THREAD_QUERY_LIMITED_INFORMATION = 0x0800
TH32CS_SNAPTHREAD = 0x00000004


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD)]


class IO_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
kernel32.CreateJobObjectW.restype = wintypes.HANDLE
kernel32.SetInformationJobObject.argtypes = [
    wintypes.HANDLE,
    ctypes.c_int,
    ctypes.c_void_p,
    wintypes.DWORD,
]
kernel32.SetInformationJobObject.restype = wintypes.BOOL
kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
kernel32.ResumeThread.argtypes = [wintypes.HANDLE]
kernel32.ResumeThread.restype = wintypes.DWORD
kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
kernel32.Thread32First.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.Thread32First.restype = wintypes.BOOL
kernel32.Thread32Next.argtypes = [wintypes.HANDLE, ctypes.c_void_p]
kernel32.Thread32Next.restype = wintypes.BOOL
kernel32.OpenThread.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenThread.restype = wintypes.HANDLE


class THREADENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ThreadID", wintypes.DWORD), ("th32OwnerProcessID", wintypes.DWORD),
        ("tpBasePri", ctypes.c_long), ("tpDeltaPri", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
    ]
kernel32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
kernel32.TerminateJobObject.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
kernel32.CloseHandle.restype = wintypes.BOOL


class WindowsJob:
    """A private kill-on-close job; assignment failure is fatal to startup."""

    # The child cannot execute (and therefore cannot spawn descendants) until
    # ``assign`` has placed it in this private kill-on-close job.
    creation_kwargs = {"creationflags": CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED}

    def __init__(self) -> None:
        self.handle = kernel32.CreateJobObjectW(None, None)
        if not self.handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        info = IO_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            self.handle, JobObjectExtendedLimitInformation,
            ctypes.byref(info), ctypes.sizeof(info))
        if not ok:
            error = ctypes.get_last_error()
            try:
                self.close()
            except OSError:
                pass
            raise OSError(error, "SetInformationJobObject failed")

    def assign(self, process: subprocess.Popen[bytes] | subprocess.Popen[str]) -> None:
        process_handle = wintypes.HANDLE(int(process._handle))
        if not kernel32.AssignProcessToJobObject(self.handle, process_handle):
            error = ctypes.get_last_error()
            try:
                process.terminate()
                process.wait(timeout=2)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
            self.close()
            raise OSError(error, "AssignProcessToJobObject failed; child was stopped")
        if not self._resume_primary_thread(process):
            error = ctypes.get_last_error()
            try:
                self.kill(process)
            finally:
                self.close()
            raise OSError(error, "ResumeThread failed; child was stopped")

    @staticmethod
    def _resume_primary_thread(process: subprocess.Popen[bytes] | subprocess.Popen[str]) -> bool:
        """Resume the suspended process without relying on Popen's closed thread handle."""

        snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0)
        snapshot_value = getattr(snapshot, "value", snapshot)
        if not snapshot_value or snapshot_value == ctypes.c_void_p(-1).value:
            return False
        entry = THREADENTRY32()
        entry.dwSize = ctypes.sizeof(THREADENTRY32)
        try:
            found = bool(kernel32.Thread32First(snapshot, ctypes.byref(entry)))
            while found:
                if entry.th32OwnerProcessID == int(process.pid):
                    thread = kernel32.OpenThread(
                        THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                        False,
                        entry.th32ThreadID,
                    )
                    if thread:
                        try:
                            return kernel32.ResumeThread(thread) != 0xFFFFFFFF
                        finally:
                            kernel32.CloseHandle(thread)
                found = bool(kernel32.Thread32Next(snapshot, ctypes.byref(entry)))
            return False
        finally:
            kernel32.CloseHandle(snapshot)

    def close(self) -> None:
        if getattr(self, "handle", None):
            handle = self.handle
            if not kernel32.CloseHandle(handle):
                raise OSError(ctypes.get_last_error(), "CloseHandle for Job Object failed")
            self.handle = None

    def terminate(self, process: object, *, force: bool = False) -> None:
        """Request a graceful break from the exact child process group."""

        if force:
            self.kill(process)
            return
        poll = getattr(process, "poll", None)
        if callable(poll) and poll() is not None:
            return
        send_signal = getattr(process, "send_signal", None)
        if callable(send_signal):
            try:
                send_signal(signal.CTRL_BREAK_EVENT)
            except (OSError, ValueError):
                # The hard job termination in kill() remains the fail-closed
                # fallback when no console accepts CTRL_BREAK.
                return

    def kill(self, process: object) -> None:
        """Terminate only this private Job Object's process tree."""

        if getattr(self, "handle", None):
            if not kernel32.TerminateJobObject(self.handle, 1):
                raise OSError(ctypes.get_last_error(), "TerminateJobObject failed")
