"""Fail-closed, out-of-process provider plugin SDK.

The package intentionally has no import hook and never executes code from a
project or plugin archive in-process.  A plugin is an immutable, signed
package whose executable is launched only through the guarded Windows
AppContainer backend (with an injectable seam for tests).
"""

from .package import (
    MAX_ARCHIVE_BYTES, MAX_MANIFEST_BYTES, MAX_MEMBER_BYTES, PackageError,
    PluginPackage, attach_signature, build_unsigned_package, signature_body,
    signature_envelope,
)
from .security import (
    CngSignatureVerifier, PermissionGrantStore, PersistentSecurityState,
    RevocationStore, SecurityError, TrustStore,
)
from .protocol import MAX_FRAME_BYTES, ProviderProtocolError, read_frame, write_frame
from .install import InstallError, InstalledPlugin, PluginInstaller
from .worker import (
    IsolationUnavailable, PluginLoader, PluginWorker, ProviderBroker, WorkerPolicy,
    WindowsAppContainerLauncher, WindowsAppContainerPolicy,
)

__all__ = [
    "CngSignatureVerifier", "IsolationUnavailable", "MAX_ARCHIVE_BYTES",
    "MAX_FRAME_BYTES", "MAX_MANIFEST_BYTES", "MAX_MEMBER_BYTES", "PackageError", "PermissionGrantStore",
    "InstallError", "InstalledPlugin", "PluginInstaller", "PluginLoader", "PluginPackage", "PluginWorker", "ProviderBroker", "ProviderProtocolError",
    "PersistentSecurityState", "RevocationStore", "SecurityError", "TrustStore", "WindowsAppContainerLauncher",
    "WindowsAppContainerPolicy", "WorkerPolicy",
    "attach_signature", "build_unsigned_package", "read_frame", "signature_body",
    "signature_envelope", "write_frame",
]
