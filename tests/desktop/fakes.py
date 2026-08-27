"""Tiny event argument fakes used to exercise native handlers offline."""

from __future__ import annotations


class EventArgs:
    def __init__(self, **values: object) -> None:
        self.__dict__.update(values)


class FakeRequest:
    def __init__(self, uri: str, *, method: str = "GET", headers: dict[str, str] | None = None, content: object = None) -> None:
        self.Uri = uri
        self.Method = method
        self.Headers = FakeHeaders(headers or {})
        self.Content = content


class FakeHeaders:
    def __init__(self, values: dict[str, str]) -> None:
        self.values = {key.lower(): value for key, value in values.items()}

    def GetHeader(self, name: str) -> str:
        return self.values.get(name.lower(), "")


def navigation(uri: str) -> EventArgs:
    return EventArgs(Uri=uri, Cancel=False)


def frame_navigation(uri: str) -> EventArgs:
    return EventArgs(Uri=uri, Cancel=False)


def new_window() -> EventArgs:
    return EventArgs(Handled=False, Cancel=False)


def download() -> EventArgs:
    return EventArgs(Cancel=False)


def permission() -> EventArgs:
    return EventArgs(State=0)


def resource(uri: str, *, method: str = "GET", headers: dict[str, str] | None = None, content: object = None) -> EventArgs:
    return EventArgs(Request=FakeRequest(uri, method=method, headers=headers, content=content), Cancel=False, Response=None)


def message(source: str, body: str) -> EventArgs:
    return EventArgs(Source=source, WebMessageAsJson=body)
