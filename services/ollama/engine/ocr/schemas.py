"""JSON response schemas for the local Qwen3-VL OCR calls.

`format_schema` is passed to Ollama's structured-output field, so these double
as a contract: the parser and the tests both rely on these exact shapes.
"""

from __future__ import annotations

from typing import Any

OCR_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'annotations': {
            'type': 'array',
            'maxItems': 64,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    # Compact [x1, y1, x2, y2] form cuts response tokens;
                    # the OCR parser maps it back to the same source-pixel box.
                    'bbox': {
                        'type': 'array',
                        'minItems': 4,
                        'maxItems': 4,
                        'items': {'type': 'number'},
                    },
                    'confidence': {'type': 'number'},
                },
                'required': ['text', 'bbox'],
            },
        },
    },
    'required': ['annotations'],
}

OCR_BLOCK_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'annotations': {
            'type': 'array',
            'maxItems': 32,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    # Compact [x1, y1, x2, y2] form cuts response tokens;
                    # the OCR parser maps it back to the same source-pixel box.
                    'bbox': {
                        'type': 'array',
                        'minItems': 4,
                        'maxItems': 4,
                        'items': {'type': 'number'},
                    },
                    'confidence': {'type': 'number'},
                },
                'required': ['text', 'bbox'],
            },
        },
    },
    'required': ['annotations'],
}

OCR_ROW_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'text': {'type': 'string'},
        'confidence': {'type': 'number'},
        'cells': {
            'type': 'array',
            'maxItems': 16,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    'bbox': {'type': 'array', 'minItems': 4, 'maxItems': 4, 'items': {'type': 'number'}},
                    'confidence': {'type': 'number'},
                },
                'required': ['text', 'bbox'],
            },
        },
    },
    'required': ['text', 'confidence'],
}

OCR_ROWS_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'rows': {
            'type': 'array',
            'minItems': 2,
            'maxItems': 2,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    'confidence': {'type': 'number'},
                    # Optional cell boxes are used for compact handwritten
                    # tables. Coordinates refer to the exact image sent for
                    # the paired-row request, not to the original page.
                    'cells': {
                        'type': 'array',
                        'maxItems': 16,
                        'items': {
                            'type': 'object',
                            'properties': {
                                'text': {'type': 'string'},
                                'bbox': {
                                    'type': 'array',
                                    'minItems': 4,
                                    'maxItems': 4,
                                    'items': {'type': 'number'},
                                },
                                'confidence': {'type': 'number'},
                            },
                            'required': ['text', 'bbox'],
                        },
                    },
                },
                'required': ['text', 'confidence'],
            },
        },
    },
    'required': ['rows'],
}
