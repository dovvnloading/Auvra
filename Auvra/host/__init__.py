"""Fail-closed, provider-neutral host protocol foundations."""

from .dispatcher import HostDispatcher
from .fake import FakeHost
from .session import SessionManager

__all__ = ["FakeHost", "HostDispatcher", "SessionManager"]
