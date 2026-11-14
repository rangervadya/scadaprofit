"""Typed contracts for the structured parts of the VDGO form.

The conclusion form itself has ~100 flat fields and stays on the existing
field-level validator. The CAD attachment payload is structured JSON, so it is
validated here before base64 decoding and image verification.
"""
from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, RootModel, ValidationError, field_validator

MAX_SCHEME_BASE64_CHARS = 16 * 1024 * 1024
MAX_SCHEMES = 40


class WorkforceScheme(BaseModel):
    model_config = ConfigDict(extra="ignore")

    pngBase64: str = Field(min_length=1)
    street: str = Field(default="", max_length=160)
    address: str = Field(default="", max_length=80)
    userName: str = Field(default="", max_length=120)
    submittedAt: str = Field(default="", max_length=40)
    id: str = Field(default="", max_length=80)
    status: str = Field(default="", max_length=32)

    @field_validator("pngBase64")
    @classmethod
    def bounded_png(cls, value: str) -> str:
        if len(value) > MAX_SCHEME_BASE64_CHARS:
            raise ValueError("PNG пустой или превышает 12 МБ.")
        return value


class WorkforceSchemesPayload(RootModel[list[WorkforceScheme]]):
    pass


def parse_workforce_schemes(raw: str) -> list[dict[str, Any]]:
    """Parse and validate the CAD attachment list before it reaches the PDF."""
    try:
        entries = json.loads(raw)
    except Exception as exc:
        raise ValueError(
            "Не удалось прочитать список CAD-схем для пункта 7. "
            "Обновите страницу заключения и повторите экспорт."
        ) from exc
    if not isinstance(entries, list):
        raise ValueError("Список CAD-схем пункта 7 имеет неверный формат.")
    if len(entries) > MAX_SCHEMES:
        raise ValueError("За один раз можно включить не более 40 схем в пункт 7.")
    try:
        payload = WorkforceSchemesPayload.model_validate(entries)
    except ValidationError as exc:
        first = exc.errors()[0]
        location = first.get("loc") or ("?",)
        index = location[0] if isinstance(location[0], int) else 0
        raise ValueError(f"Схема № {index + 1}: {first.get('msg')}") from exc
    return [entry.model_dump() for entry in payload.root]