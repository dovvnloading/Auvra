"""Tiny event argument fakes used to exercise native handlers offline."""

from __future__ import annotations


class EventArgs:
    def __init__(self, **values: object) -> None:
        self.__dict__.update(values)


class FakeRequest:
    def __init__(self, uri: str) -> None:
        self.Uri = uri


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


def resource(uri: str) -> EventArgs:
    return EventArgs(Request=FakeRequest(uri), Cancel=False)


def message(source: str, body: str) -> EventArgs:
    return EventArgs(Source=source, WebMessageAsJson=body)
