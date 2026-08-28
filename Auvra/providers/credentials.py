"""Host-only credentials: Windows Credential Manager or explicit memory."""

from __future__ import annotations

import ctypes
import sys
from typing import Protocol

from Auvra.diagnostics.core import trace_public_class


class CredentialError(RuntimeError):
    def __str__(self) -> str:
        return "credential operation unavailable"


class CredentialBackend(Protocol):
    def read(self, target: str) -> str | None: ...
    def write(self, target: str, value: str) -> None: ...
    def delete(self, target: str) -> None: ...


@trace_public_class("credential_store", concise=("write", "delete", "clear"))
class MemoryCredentialStore:
    """Explicit, process-lifetime credential store; never persisted."""

    def __init__(self) -> None:
        self._values: dict[str, str] = {}

    def read(self, target: str) -> str | None:
        return self._values.get(_target(target))

    def write(self, target: str, value: str) -> None:
        _validate(target, value)
        self._values[_target(target)] = value

    def delete(self, target: str) -> None:
        self._values.pop(_target(target), None)

    def clear(self) -> None:
        self._values.clear()


class _WinCredNative:
    CRED_TYPE_GENERIC = 1
    CRED_PERSIST_LOCAL_MACHINE = 2

    class CREDENTIAL(ctypes.Structure):
        _fields_ = [("Flags", ctypes.c_uint32), ("Type", ctypes.c_uint32),
                    ("TargetName", ctypes.c_wchar_p), ("Comment", ctypes.c_wchar_p),
                    ("LastWritten", ctypes.c_byte * 8), ("CredentialBlobSize", ctypes.c_uint32),
                    ("CredentialBlob", ctypes.c_void_p), ("Persist", ctypes.c_uint32),
                    ("AttributeCount", ctypes.c_uint32), ("Attributes", ctypes.c_void_p),
                    ("TargetAlias", ctypes.c_wchar_p), ("UserName", ctypes.c_wchar_p)]

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise CredentialError()
        self._advapi = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        self._kernel = ctypes.WinDLL("Kernel32.dll", use_last_error=True)
        self._read = self._advapi.CredReadW
        self._read.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
        self._read.restype = ctypes.c_bool
        self._write = self._advapi.CredWriteW
        self._write.argtypes = [ctypes.POINTER(self.CREDENTIAL), ctypes.c_uint32]
        self._write.restype = ctypes.c_bool
        self._delete = self._advapi.CredDeleteW
        self._delete.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
        self._delete.restype = ctypes.c_bool
        self._free = self._advapi.CredFree
        self._free.argtypes = [ctypes.c_void_p]
        self._free.restype = None

    def read(self, target: str) -> str | None:
        pointer = ctypes.c_void_p()
        if not self._read(target, self.CRED_TYPE_GENERIC, 0, ctypes.byref(pointer)):
            if ctypes.get_last_error() == 1168:  # ERROR_NOT_FOUND
                return None
            raise CredentialError()
        try:
            value = ctypes.cast(pointer, ctypes.POINTER(self.CREDENTIAL)).contents
            return ctypes.string_at(value.CredentialBlob, value.CredentialBlobSize).decode("utf-16-le")
        finally:
            self._free(pointer)

    def write(self, target: str, value: str) -> None:
        raw = value.encode("utf-16-le")
        buffer = ctypes.create_string_buffer(raw)
        credential = self.CREDENTIAL(0, self.CRED_TYPE_GENERIC, target, None, (ctypes.c_byte * 8)(),
                                     len(raw), ctypes.cast(buffer, ctypes.c_void_p),
                                     self.CRED_PERSIST_LOCAL_MACHINE, 0, None, None, "Auvra")
        try:
            if not self._write(ctypes.byref(credential), 0):
                raise CredentialError()
        finally:
            ctypes.memset(buffer, 0, len(raw))

    def delete(self, target: str) -> None:
        if not self._delete(target, self.CRED_TYPE_GENERIC, 0) and ctypes.get_last_error() != 1168:
            raise CredentialError()


@trace_public_class("credential_store", concise=("write", "delete"))
class WindowsCredentialManager:
    """Thin injectable wrapper around CredRead/CredWrite/CredDelete."""

    def __init__(self, backend: CredentialBackend | None = None) -> None:
        self._backend = backend if backend is not None else _WinCredNative()

    def read(self, target: str) -> str | None:
        return self._backend.read(_target(target))

    def write(self, target: str, value: str) -> None:
        _validate(target, value)
        self._backend.write(_target(target), value)

    def delete(self, target: str) -> None:
        self._backend.delete(_target(target))


CredentialVault = WindowsCredentialManager
SessionCredentialStore = MemoryCredentialStore


def _target(target: str) -> str:
    if not isinstance(target, str) or not target or len(target) > 256 or "\x00" in target:
        raise CredentialError()
    return target if target.startswith("Auvra/provider/") else "Auvra/provider/" + target


def _validate(target: str, value: str) -> None:
    _target(target)
    if not isinstance(value, str) or not value or len(value.encode("utf-16-le")) > 2560 or "\x00" in value:
        raise CredentialError()
