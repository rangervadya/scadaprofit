#!/usr/bin/env python3
"""Run a compact, repeatable quality audit over handwritten example sheets."""
from __future__ import annotations

import json
import os
from pathlib import Path

import processor


ROOT = Path(__file__).resolve().parent
EXAMPLES = ROOT / 'examples'
OUTPUT = ROOT / 'evaluation-results'
REFERENCE_NAME = 'photo_2026-11-05_19-00-31.jpg'


def main() -> None:
    os.environ.setdefault('OLLAMA_CHAT_URL', 'http://127.0.0.1:9/api/chat')
    os.environ.setdefault('QWEN_OCR_TILE_GRID', '1')
    os.environ.setdefault('QWEN_PIPE_TILE_GRID', '1')
    os.environ.setdefault('QWEN_OCR_TIMEOUT', '20')
    os.environ.setdefault('QWEN_PIPE_TRACE_TIMEOUT', '20')
    OUTPUT.mkdir(exist_ok=True)
    results = []
    for source in sorted(EXAMPLES.glob('*.jpg')):
        if source.name == REFERENCE_NAME:
            continue
        target = OUTPUT / source.stem.replace(' ', '-').replace('(', '').replace(')', '')
        graph = processor.analyze(str(source), str(target))
        summary, diagnostics = graph.get('summary') or {}, graph.get('diagnostics') or {}
        segments = int(summary.get('segment_candidates', 0) or 0)
        open_nodes = int(summary.get('open_terminal_nodes', 0) or 0)
        crossings = int(summary.get('crossings_to_review', 0) or 0)
        results.append({
            'file': source.name, 'status': diagnostics.get('status'),
            'segments': segments, 'primaryEdges': int(summary.get('cad_primary_edges', 0) or 0),
            'openEndpoints': open_nodes, 'crossings': crossings,
            'labels': int(summary.get('ocr_annotations', 0) or 0),
            'symbolCandidates': len(graph.get('documentModel', {}).get('symbols', [])),
            'reviewTasks': diagnostics.get('stages', {}).get('review', {}).get('openTasks', 0),
            'blockingGates': diagnostics.get('blockingGates', []),
            'qualityFlags': [
                *(['excessive-open-endpoints'] if segments and open_nodes / segments > 0.70 else []),
                *(['excessive-crossings'] if segments and crossings / segments > 0.12 else []),
                *(['no-text-recognition'] if not graph.get('ocr', {}).get('qwen', {}).get('available') and not graph.get('ocr', {}).get('tesseract', {}).get('available') else []),
            ],
        })
    aggregate = {
        'schema': 'cad-example-evaluation/1.0', 'referenceFile': REFERENCE_NAME,
        'inputCount': len(results), 'readyCount': sum(1 for item in results if item['status'] == 'ready'),
        'blockedCount': sum(1 for item in results if item['status'] == 'blocked'),
        'results': results,
    }
    (OUTPUT / 'evaluation-summary.json').write_text(json.dumps(aggregate, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(aggregate, ensure_ascii=False))


if __name__ == '__main__':
    main()
