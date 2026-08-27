"""Canonical protocol validation shared by host components."""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker


SCHEMA_PATH = Path(__file__).resolve().parents[2] / "protocol" / "v1" / "auvra-host.schema.json"


class ProtocolValidationError(ValueError):
    """A message is not a valid protocol v1 message."""


@lru_cache(maxsize=1)
def _validator() -> Draft202012Validator:
    with SCHEMA_PATH.open(encoding="utf-8") as stream:
        schema = json.load(stream)
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=FormatChecker())


def validate_message(message: Any) -> dict[str, Any]:
    """Validate and return a message, never coercing or accepting extensions."""
    if not isinstance(message, dict):
        raise ProtocolValidationError("message must be an object")
    errors = sorted(_validator().iter_errors(message), key=lambda error: list(error.path))
    if errors:
        raise ProtocolValidationError("invalid protocol message")
    return message


def validate_request(message: Any) -> dict[str, Any]:
    value = validate_message(message)
    if value.get("type") != "request":
        raise ProtocolValidationError("message is not a request")
    return value


def validate_response(message: Any) -> dict[str, Any]:
    value = validate_message(message)
    if value.get("type") != "response":
        raise ProtocolValidationError("message is not a response")
    return value
