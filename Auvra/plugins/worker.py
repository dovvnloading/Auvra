"""Provider worker policy, broker authorization, and fail-closed isolation gate."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import os
from pathlib import Path
import queue
import secrets
import sys
import threading
from typing import Any, Callable, Mapping, Protocol

from .package import PluginPackage, PackageError
from .protocol import ProviderProtocolError, read_frame, validate_payload, write_frame
from .security import PermissionGrantStore, RevocationStore, TrustStore
from Auvra.diagnostics import trace_public_class


class IsolationUnavailable(RuntimeError):
    """The required OS process boundary is not available."""


class WorkerPolicy(Protocol):
    def launch(self, executable: Path, *, package: PluginPackage) -> Any: ...


class WindowsAppContainerPolicy:
    """Launch only through the real AppContainer backend or a test seam.

    A plain ``subprocess.Popen`` fallback would turn an untrusted provider
    into a medium-integrity process and is therefore prohibited.
    """

    def __init__(self, launcher: Callable[..., Any] | None = None, *, min_build: int = 26100) -> None:
        self.launcher = launcher or WindowsAppContainerLauncher()
        self.min_build = min_build

    def require_supported(self) -> None:
        if sys.platform != "win32":
            raise IsolationUnavailable("provider plugins require Windows AppContainer isolation")
        try:
            build = int(sys.getwindowsversion().build)
        except (AttributeError, OSError, ValueError) as exc:
            raise IsolationUnavailable("Windows build cannot be verified") from exc
        if build < self.min_build:
            raise IsolationUnavailable("provider plugins require Windows 11 24H2 or newer")

    def launch(self, executable: Path, *, package: PluginPackage) -> Any:
        self.require_supported()
        return self.launcher(executable=executable, package=package,
                             appcontainer=True, job_object=True,
                             network=False, inherit_handles=False)


class WindowsAppContainerLauncher:
    """Create a no-network AppContainer process with a private Job Object.

    This backend uses documented Win32 APIs through ``ctypes`` and is loaded
    only on Windows.  It intentionally grants no AppContainer capabilities;
    all provider networking is host-mediated.  The package directory must be
    ACL-readable by the generated AppContainer SID, otherwise launch fails.
    """

    def __call__(self, *, executable: Path, package: PluginPackage,
                 appcontainer: bool, job_object: bool, network: bool,
                 inherit_handles: bool) -> Any:
        if not appcontainer or not job_object or network or inherit_handles:
            raise IsolationUnavailable("plugin launcher requested unsafe process options")
        if sys.platform != "win32":
            raise IsolationUnavailable("Windows AppContainer is unavailable")
        return _create_windows_sandbox_process(executable, package)


class _SandboxProcess:
    def __init__(self, process_handle: Any, thread_handle: Any, job_handle: Any,
                 stdin: Any, stdout: Any, pid: int = 0) -> None:
        self._process_handle = process_handle
        self._thread_handle = thread_handle
        self._job_handle = job_handle
        self.stdin = stdin
        self.stdout = stdout
        self.stderr = stdout
        self._pid = pid
        self._returncode: int | None = None

    def poll(self) -> int | None:
        if self._returncode is not None:
            return self._returncode
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel32.WaitForSingleObject.restype = ctypes.c_ulong
        kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel32.GetExitCodeProcess.restype = ctypes.c_int
        if kernel32.WaitForSingleObject(self._process_handle, 0) != 0:
            return None
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(self._process_handle, ctypes.byref(code)):
            return None
        self._returncode = int(code.value)
        return self._returncode

    @property
    def pid(self) -> int:
        return self._pid

    def wait(self, timeout: float | None = None) -> int:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        kernel32.WaitForSingleObject.restype = ctypes.c_ulong
        wait_ms = 0xFFFFFFFF if timeout is None else max(0, int(timeout * 1000))
        result = kernel32.WaitForSingleObject(self._process_handle, wait_ms)
        if result == 0x102:
            raise TimeoutError("plugin process wait timed out")
        value = self.poll()
        if value is None:
            raise OSError(ctypes.get_last_error(), "GetExitCodeProcess failed")
        return value

    def terminate(self) -> None:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
        kernel32.TerminateJobObject.restype = ctypes.c_int
        if self._job_handle and not kernel32.TerminateJobObject(self._job_handle, 1):
            raise OSError(ctypes.get_last_error(), "TerminateJobObject failed")

    kill = terminate

    def cpu_time_ms(self) -> float:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        class FILETIME(ctypes.Structure):
            _fields_ = [("low", ctypes.c_ulong), ("high", ctypes.c_ulong)]
        kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p, ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME),
                                             ctypes.POINTER(FILETIME), ctypes.POINTER(FILETIME)]
        kernel32.GetProcessTimes.restype = ctypes.c_int
        created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if not kernel32.GetProcessTimes(self._process_handle, ctypes.byref(created), ctypes.byref(exited),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            raise OSError(ctypes.get_last_error(), "GetProcessTimes failed")
        ticks = ((kernel.high << 32) | kernel.low) + ((user.high << 32) | user.low)
        return ticks / 10_000.0

    def close(self) -> None:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int
        for stream in (self.stdin, self.stdout):
            try:
                stream.close()
            except Exception:
                pass
        for handle in (self._thread_handle, self._process_handle, self._job_handle):
            if handle:
                kernel32.CloseHandle(handle)
        self._thread_handle = self._process_handle = self._job_handle = None


def _create_windows_sandbox_process(executable: Path, package: PluginPackage) -> _SandboxProcess:
    import ctypes
    from ctypes import wintypes
    try:
        stat = executable.stat()
    except OSError as exc:
        raise IsolationUnavailable("plugin executable cannot be inspected") from exc
    if (executable.is_symlink() or getattr(stat, "st_file_attributes", 0) & 0x400 or
            not executable.is_file() or executable.parent.name != "payload" or
            executable.parent.parent.name != package.package_digest):
        raise IsolationUnavailable("plugin executable is outside its payload directory")
    if package.manifest["entrypoint"]["path"].replace("/", "\\") != f"payload\\{executable.name}":
        raise IsolationUnavailable("plugin executable does not match the package entrypoint")
    expected = package.manifest["entrypoint"]["sha256"]
    digest = hashlib.sha256()
    try:
        with executable.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    except OSError as exc:
        raise IsolationUnavailable("plugin executable cannot be inspected") from exc
    if digest.hexdigest() != expected:
        raise IsolationUnavailable("plugin executable digest does not match package")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    userenv = ctypes.WinDLL("userenv", use_last_error=True)
    HANDLE = wintypes.HANDLE
    LPVOID = ctypes.c_void_p
    HRESULT = ctypes.c_long

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [("nLength", wintypes.DWORD), ("lpSecurityDescriptor", LPVOID), ("bInheritHandle", wintypes.BOOL)]

    class SECURITY_CAPABILITIES(ctypes.Structure):
        _fields_ = [("AppContainerSid", LPVOID), ("Capabilities", LPVOID), ("CapabilityCount", wintypes.DWORD), ("Reserved", wintypes.DWORD)]

    class STARTUPINFOEXW(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("lpReserved", wintypes.LPWSTR), ("lpDesktop", wintypes.LPWSTR), ("lpTitle", wintypes.LPWSTR), ("dwX", wintypes.DWORD), ("dwY", wintypes.DWORD), ("dwXSize", wintypes.DWORD), ("dwYSize", wintypes.DWORD), ("dwXCountChars", wintypes.DWORD), ("dwYCountChars", wintypes.DWORD), ("dwFillAttribute", wintypes.DWORD), ("dwFlags", wintypes.DWORD), ("wShowWindow", wintypes.WORD), ("cbReserved2", wintypes.WORD), ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)), ("hStdInput", HANDLE), ("hStdOutput", HANDLE), ("hStdError", HANDLE), ("lpAttributeList", LPVOID)]

    class PROCESS_INFORMATION(ctypes.Structure):
        _fields_ = [("hProcess", HANDLE), ("hThread", HANDLE), ("dwProcessId", wintypes.DWORD), ("dwThreadId", wintypes.DWORD)]

    class IO_COUNTERS(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in ("ReadOperationCount", "WriteOperationCount", "OtherOperationCount", "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong), ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t), ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD), ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class EXTENDED_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", BASIC_LIMIT), ("IoInfo", IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    for function, args, result in (
        (kernel32.CreatePipe, [ctypes.POINTER(HANDLE), ctypes.POINTER(HANDLE), ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.DWORD], wintypes.BOOL),
        (kernel32.SetHandleInformation, [HANDLE, wintypes.DWORD, wintypes.DWORD], wintypes.BOOL),
        (kernel32.InitializeProcThreadAttributeList, [LPVOID, wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(ctypes.c_size_t)], wintypes.BOOL),
        (kernel32.UpdateProcThreadAttribute, [LPVOID, wintypes.DWORD, ctypes.c_size_t, LPVOID, ctypes.c_size_t, LPVOID, LPVOID], wintypes.BOOL),
        (kernel32.DeleteProcThreadAttributeList, [LPVOID], None),
        (kernel32.ResumeThread, [HANDLE], wintypes.DWORD),
        (kernel32.CreateProcessW, [wintypes.LPCWSTR, wintypes.LPWSTR, LPVOID, LPVOID, wintypes.BOOL, wintypes.DWORD, LPVOID, wintypes.LPCWSTR, LPVOID, ctypes.POINTER(PROCESS_INFORMATION)], wintypes.BOOL),
        (kernel32.CreateJobObjectW, [LPVOID, wintypes.LPCWSTR], HANDLE),
        (kernel32.SetInformationJobObject, [HANDLE, ctypes.c_int, LPVOID, wintypes.DWORD], wintypes.BOOL),
        (kernel32.AssignProcessToJobObject, [HANDLE, HANDLE], wintypes.BOOL),
        (kernel32.CloseHandle, [HANDLE], wintypes.BOOL),
        (kernel32.TerminateProcess, [HANDLE, wintypes.UINT], wintypes.BOOL),
        (kernel32.TerminateJobObject, [HANDLE, wintypes.UINT], wintypes.BOOL),
    ):
        function.argtypes, function.restype = args, result
    userenv.CreateAppContainerProfile.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, LPVOID, wintypes.DWORD, ctypes.POINTER(LPVOID)]
    userenv.CreateAppContainerProfile.restype = HRESULT
    userenv.DeriveAppContainerSidFromAppContainerName.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(LPVOID)]
    userenv.DeriveAppContainerSidFromAppContainerName.restype = HRESULT
    userenv.GetAppContainerFolderPath.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(wintypes.LPWSTR)]
    userenv.GetAppContainerFolderPath.restype = HRESULT
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    advapi32.ConvertSidToStringSidW.argtypes = [LPVOID, ctypes.POINTER(wintypes.LPWSTR)]
    advapi32.ConvertSidToStringSidW.restype = wintypes.BOOL
    advapi32.FreeSid.argtypes = [LPVOID]
    advapi32.FreeSid.restype = LPVOID
    kernel32.LocalFree.argtypes = [LPVOID]
    kernel32.LocalFree.restype = LPVOID
    ole32 = ctypes.WinDLL("ole32", use_last_error=True)
    ole32.CoTaskMemFree.argtypes = [LPVOID]
    ole32.CoTaskMemFree.restype = None

    profile_name = "Auvra.Plugin." + package.manifest["pluginId"] + "." + package.package_digest[:16]
    sid = LPVOID()
    hr = userenv.CreateAppContainerProfile(profile_name, profile_name, "Auvra provider plugin", None, 0, ctypes.byref(sid))
    if hr != 0 and userenv.DeriveAppContainerSidFromAppContainerName(profile_name, ctypes.byref(sid)) != 0:
        raise IsolationUnavailable("AppContainer profile could not be created")
    if not sid:
        raise IsolationUnavailable("AppContainer SID is unavailable")
    sid_text_ptr = wintypes.LPWSTR()
    if not advapi32.ConvertSidToStringSidW(sid, ctypes.byref(sid_text_ptr)):
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("AppContainer SID could not be represented")
    try:
        sid_text = sid_text_ptr.value
    finally:
        kernel32.LocalFree(sid_text_ptr)
    if not sid_text:
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("AppContainer SID string is empty")
    folder_ptr = wintypes.LPWSTR()
    folder_hr = userenv.GetAppContainerFolderPath(sid_text, ctypes.byref(folder_ptr))
    if folder_hr != 0 or not folder_ptr:
        advapi32.FreeSid(sid)
        raise IsolationUnavailable(f"AppContainer local folder could not be resolved ({folder_hr})")
    try:
        app_folder = folder_ptr.value
    finally:
        ole32.CoTaskMemFree(folder_ptr)
    if not app_folder:
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("AppContainer local folder is empty")
    attrs = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), None, True)
    child_in, parent_in = HANDLE(), HANDLE()
    parent_out, child_out = HANDLE(), HANDLE()
    def close_pipes() -> None:
        for handle in (child_in, parent_in, parent_out, child_out):
            if handle:
                kernel32.CloseHandle(handle)
    if not kernel32.CreatePipe(ctypes.byref(child_in), ctypes.byref(parent_in), ctypes.byref(attrs), 0) or not kernel32.CreatePipe(ctypes.byref(parent_out), ctypes.byref(child_out), ctypes.byref(attrs), 0):
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("plugin stdio pipes could not be created")
    if not kernel32.SetHandleInformation(parent_in, 1, 0) or not kernel32.SetHandleInformation(parent_out, 1, 0):
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("plugin stdio handles could not be made non-inheritable")
    caps = SECURITY_CAPABILITIES(sid, None, 0, 0)
    inherited = (HANDLE * 2)(child_in, child_out)
    size = ctypes.c_size_t(0)
    kernel32.InitializeProcThreadAttributeList(None, 2, 0, ctypes.byref(size))
    buffer = ctypes.create_string_buffer(size.value)
    if not kernel32.InitializeProcThreadAttributeList(buffer, 2, 0, ctypes.byref(size)):
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("AppContainer process attributes could not be initialized")
    # PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (attribute number 9).
    if not kernel32.UpdateProcThreadAttribute(buffer, 0, 0x00020009, ctypes.byref(caps), ctypes.sizeof(caps), None, None):
        kernel32.DeleteProcThreadAttributeList(buffer)
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable(f"AppContainer security attributes could not be applied ({ctypes.get_last_error()})")
    # bInheritHandles is true only for these explicit child stdio handles;
    # this prevents unrelated inheritable handles from crossing the boundary.
    if not kernel32.UpdateProcThreadAttribute(buffer, 0, 0x00020002, ctypes.cast(inherited, LPVOID),
                                              ctypes.sizeof(inherited), None, None):
        kernel32.DeleteProcThreadAttributeList(buffer)
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("plugin stdio handle policy could not be applied")
    startup = STARTUPINFOEXW(); startup.cb = ctypes.sizeof(startup); startup.dwFlags = 0x00000100; startup.hStdInput = child_in; startup.hStdOutput = child_out; startup.hStdError = child_out; startup.lpAttributeList = ctypes.cast(buffer, LPVOID)
    process_info = PROCESS_INFORMATION()
    command = ctypes.create_unicode_buffer('"' + str(executable) + '"')
    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR")
    if not system_root:
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("Windows system root is unavailable")
    system_drive = Path(system_root).drive
    if not system_drive:
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("Windows system drive is unavailable")
    local_appdata = str(Path(app_folder) / "Local")
    temp_folder = str(Path(local_appdata) / "Temp")
    try:
        Path(temp_folder).mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        close_pipes()
        advapi32.FreeSid(sid)
        raise IsolationUnavailable("AppContainer temporary folder could not be prepared") from exc
    env = {"SystemDrive": system_drive, "SystemRoot": system_root, "WINDIR": system_root,
           "LOCALAPPDATA": local_appdata, "TEMP": temp_folder, "TMP": temp_folder}
    env_block = ctypes.create_unicode_buffer("\0".join(f"{key}={value}" for key, value in sorted(env.items())) + "\0\0")
    flags = 0x00080000 | 0x08000000 | 0x00000400  # extended startup, no window, Unicode environment
    created = kernel32.CreateProcessW(str(executable), command, None, None, True, flags | 0x00000004, env_block, str(executable.parent), ctypes.byref(startup), ctypes.byref(process_info))
    create_error = ctypes.get_last_error() if not created else 0
    kernel32.DeleteProcThreadAttributeList(buffer)
    advapi32.FreeSid(sid)
    if not created:
        for handle in (child_in, parent_in, parent_out, child_out):
            if handle:
                kernel32.CloseHandle(handle)
        raise IsolationUnavailable(f"AppContainer plugin process could not be started ({create_error})")
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        kernel32.TerminateProcess(process_info.hProcess, 1)
        kernel32.CloseHandle(process_info.hThread)
        kernel32.CloseHandle(process_info.hProcess)
        for handle in (parent_in, parent_out, child_in, child_out):
            if handle:
                kernel32.CloseHandle(handle)
        raise IsolationUnavailable("plugin Job Object could not be created")
    limits = EXTENDED_LIMIT(); limits.BasicLimitInformation.LimitFlags = 0x2000 | 0x8 | 0x100 | 0x200
    limits.BasicLimitInformation.ActiveProcessLimit = 1
    limits.ProcessMemoryLimit = package.manifest["resources"]["memoryMiB"] * 1024 * 1024
    limits.JobMemoryLimit = package.manifest["resources"]["memoryMiB"] * 1024 * 1024
    if not kernel32.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not kernel32.AssignProcessToJobObject(job, process_info.hProcess):
        kernel32.TerminateProcess(process_info.hProcess, 1); kernel32.CloseHandle(job)
        kernel32.CloseHandle(process_info.hThread)
        kernel32.CloseHandle(process_info.hProcess)
        for handle in (parent_in, parent_out, child_in, child_out):
            if handle:
                kernel32.CloseHandle(handle)
        raise IsolationUnavailable("plugin Job Object limits could not be applied")
    if kernel32.ResumeThread(process_info.hThread) == 0xFFFFFFFF:
        kernel32.TerminateJobObject(job, 1)
        kernel32.CloseHandle(process_info.hThread)
        kernel32.CloseHandle(process_info.hProcess)
        kernel32.CloseHandle(job)
        for handle in (parent_in, parent_out, child_in, child_out):
            if handle:
                kernel32.CloseHandle(handle)
        raise IsolationUnavailable("AppContainer plugin process could not be resumed")
    kernel32.CloseHandle(child_in); kernel32.CloseHandle(child_out); kernel32.CloseHandle(process_info.hThread)
    import msvcrt
    stdin = None
    stdout = None
    try:
        stdin = os.fdopen(msvcrt.open_osfhandle(int(parent_in.value), 0), "wb", buffering=0)
        stdout = os.fdopen(msvcrt.open_osfhandle(int(parent_out.value), 0), "rb", buffering=0)
    except (OSError, ValueError) as exc:
        kernel32.TerminateJobObject(job, 1)
        if stdin is not None:
            stdin.close()
        else:
            kernel32.CloseHandle(parent_in)
        if stdout is not None:
            stdout.close()
        else:
            kernel32.CloseHandle(parent_out)
        kernel32.CloseHandle(process_info.hProcess)
        kernel32.CloseHandle(job)
        raise IsolationUnavailable("plugin stdio streams could not be opened") from exc
    return _SandboxProcess(process_info.hProcess, None, job, stdin, stdout,
                           int(process_info.dwProcessId))


@dataclass(frozen=True, slots=True)
class BrokerDecision:
    allowed: bool
    reason: str


class ProviderBroker:
    """Authorize only host-mediated provider operations."""

    def __init__(self, package: PluginPackage, *, project_id: str,
                 grants: PermissionGrantStore) -> None:
        self.package = package
        self.project_id = project_id
        self.grants = grants

    def authorize(self, method: str, payload: Mapping[str, Any]) -> BrokerDecision:
        try:
            validate_payload(payload)
        except ProviderProtocolError:
            return BrokerDecision(False, "provider-payload-not-allowlisted")
        permissions = self.package.manifest["permissions"]
        if method == "broker.http":
            origin = payload.get("origin")
            if not isinstance(origin, str) or origin not in permissions.get("networkProxy", []):
                return BrokerDecision(False, "network-origin-not-declared")
            if not self.grants.allowed(project_id=self.project_id, plugin_id=self.package.manifest["pluginId"],
                                       publisher_key_id=self.package.manifest["publisherKeyId"], package_digest=self.package.package_digest,
                                       permission="networkProxy", value=origin):
                return BrokerDecision(False, "network-permission-not-granted")
            return BrokerDecision(True, "network-proxy-approved")
        if method == "broker.credential":
            if permissions.get("credentialUse") is not True or not self.grants.allowed(project_id=self.project_id, plugin_id=self.package.manifest["pluginId"], publisher_key_id=self.package.manifest["publisherKeyId"], package_digest=self.package.package_digest, permission="credentialUse"):
                return BrokerDecision(False, "credential-permission-not-granted")
            return BrokerDecision(True, "credential-use-approved")
        if method == "broker.asset.read":
            if permissions.get("assetRead") is not True or not self.grants.allowed(project_id=self.project_id, plugin_id=self.package.manifest["pluginId"], publisher_key_id=self.package.manifest["publisherKeyId"], package_digest=self.package.package_digest, permission="assetRead"):
                return BrokerDecision(False, "asset-read-not-granted")
            return BrokerDecision(True, "asset-read-approved")
        if method == "broker.asset.write":
            if permissions.get("assetWrite") is not True or not self.grants.allowed(project_id=self.project_id, plugin_id=self.package.manifest["pluginId"], publisher_key_id=self.package.manifest["publisherKeyId"], package_digest=self.package.package_digest, permission="assetWrite"):
                return BrokerDecision(False, "asset-write-not-granted")
            return BrokerDecision(True, "asset-write-approved")
        return BrokerDecision(False, "provider-operation-not-allowlisted")


@trace_public_class("plugin_loader", concise=("load",))
class PluginLoader:
    """Validate trust, grants, and revocation before any process launch."""

    def __init__(self, trust: TrustStore, grants: PermissionGrantStore,
                 revocations: RevocationStore, *, allow_unsigned: bool = False) -> None:
        self.trust = trust
        self.grants = grants
        self.revocations = revocations
        self.allow_unsigned = allow_unsigned

    def load(self, path: str | os.PathLike[str], *, project_id: str,
             verifier: Any = None) -> PluginPackage:
        package = PluginPackage.open(path, verifier=verifier or self.trust.verifier(),
                                    trusted_keys=self.trust.key_ids,
                                    allow_unsigned=self.allow_unsigned)
        plugin_id = package.manifest["pluginId"]
        signer = package.manifest["publisherKeyId"]
        if package.signed and not self.trust.contains(signer, plugin_id):
            raise PackageError("plugin signer is not trusted for this plugin")
        if self.revocations.is_revoked(package_digest=package.package_digest, signer_id=signer, plugin_id=plugin_id):
            raise PackageError("plugin is revoked")
        grant = self.grants.has_grant(project_id=project_id, plugin_id=plugin_id,
                                      publisher_key_id=signer, package_digest=package.package_digest)
        if not grant and not self.allow_unsigned:
            raise PackageError("project has not explicitly trusted this plugin")
        return package


@trace_public_class("plugin_worker", concise=("start", "request", "disable", "stop"))
class PluginWorker:
    """Run a validated provider process through an isolation backend."""

    def __init__(self, package: PluginPackage, *, project_id: str,
                 grants: PermissionGrantStore, policy: WorkerPolicy | None = None) -> None:
        self.package = package
        self.broker = ProviderBroker(package, project_id=project_id, grants=grants)
        self.policy = policy or WindowsAppContainerPolicy()
        self.process: Any = None
        self.disabled = False
        self._request_lock = threading.Lock()

    def start(self, executable: Path) -> None:
        if self.disabled:
            raise IsolationUnavailable("plugin is disabled for this session")
        expected = self.package.manifest["entrypoint"]["sha256"]
        try:
            candidate = Path(executable).expanduser().absolute()
            if candidate.is_symlink() or (getattr(candidate.stat(), "st_file_attributes", 0) & 0x400):
                raise IsolationUnavailable("plugin executable is linked or reparse-pointed")
            if candidate.parent.name != "payload" or candidate.parent.parent.name != self.package.package_digest:
                raise IsolationUnavailable("plugin executable is not bound to its digest-addressed install")
            digest = hashlib.sha256()
            with candidate.open("rb") as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(block)
            if digest.hexdigest() != expected:
                raise IsolationUnavailable("plugin executable digest does not match package")
        except OSError as exc:
            raise IsolationUnavailable("plugin executable cannot be inspected") from exc
        self.process = self.policy.launch(executable, package=self.package)

    def request(self, method: str, payload: Mapping[str, Any]) -> dict[str, Any]:
        """Exchange one bounded ABI request and enforce wall/CPU ceilings."""
        if self.disabled or self.process is None:
            raise IsolationUnavailable("plugin worker is not running")
        identity = "r-" + secrets.token_hex(16)
        message = {"protocol": "auvra.provider/1", "id": identity, "method": method, "payload": dict(payload)}
        wall_seconds = self.package.manifest["resources"]["wallMsPerRequest"] / 1000.0
        with self._request_lock:
            before_cpu = self.process.cpu_time_ms() if callable(getattr(self.process, "cpu_time_ms", None)) else None
            try:
                write_frame(self.process.stdin, message)
            except (OSError, ProviderProtocolError) as exc:
                self.stop()
                raise IsolationUnavailable("plugin request could not be sent") from exc
            result: queue.Queue[object] = queue.Queue(maxsize=1)

            def receive() -> None:
                try:
                    result.put(read_frame(self.process.stdout))
                except BaseException as exc:
                    result.put(exc)

            reader = threading.Thread(target=receive, name="auvra-plugin-response", daemon=True)
            reader.start()
            reader.join(wall_seconds)
            if reader.is_alive():
                self.stop()
                reader.join(1.0)
                raise IsolationUnavailable("plugin request exceeded its wall-time limit")
            response = result.get_nowait()
            if isinstance(response, BaseException) or not isinstance(response, dict) or response.get("id") != identity:
                self.stop()
                raise IsolationUnavailable("plugin returned an invalid response") from response if isinstance(response, BaseException) else None
            if before_cpu is not None:
                try:
                    consumed = self.process.cpu_time_ms() - before_cpu
                except OSError as exc:
                    self.stop()
                    raise IsolationUnavailable("plugin CPU use could not be measured") from exc
                if consumed > self.package.manifest["resources"]["cpuMsPerRequest"]:
                    self.stop()
                    raise IsolationUnavailable("plugin request exceeded its CPU-time limit")
            return response

    def authorize(self, method: str, payload: Mapping[str, Any]) -> BrokerDecision:
        if self.disabled:
            return BrokerDecision(False, "plugin-disabled")
        return self.broker.authorize(method, payload)

    def disable(self) -> None:
        self.disabled = True
        process = self.process
        if process is not None:
            terminate = getattr(process, "terminate", None)
            if callable(terminate):
                try:
                    terminate()
                except Exception:
                    pass

    def stop(self) -> None:
        self.disable()
        process = self.process
        if process is not None:
            try:
                wait = getattr(process, "wait", None)
                if callable(wait):
                    try:
                        wait(timeout=5)
                    except Exception:
                        kill = getattr(process, "kill", None)
                        if callable(kill):
                            kill()
            finally:
                close = getattr(process, "close", None)
                if callable(close):
                    close()
                self.process = None


__all__ = ["BrokerDecision", "IsolationUnavailable", "PluginLoader", "PluginWorker", "ProviderBroker", "WindowsAppContainerLauncher", "WindowsAppContainerPolicy", "WorkerPolicy"]
