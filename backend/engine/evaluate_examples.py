#!/usr/bin/env python3
"""Run isolated CAD benchmarks with optional manually verified references."""
from __future__ import annotations

import argparse
from collections import Counter
import json
import math
import os
from pathlib import Path
import time

VARIANTS = {
    'baseline': None,
    'ocr-normalized': ('QWEN_OCR_NORMALIZED_COORDS', '1'),
    'pipe-normalized': ('QWEN_PIPE_NORMALIZED_COORDS', '1'),
    'keep-alive': ('QWEN_KEEP_ALIVE', '30m'),
    'batch': ('QWEN_NUM_BATCH', '256'),
    'threads': ('QWEN_NUM_THREADS', '4'),
    'clahe': ('CAD_CLAHE', '1'),
    'bilateral': ('CAD_BILATERAL', '1'),
}
FLAGS = ('QWEN_OCR_NORMALIZED_COORDS', 'QWEN_PIPE_NORMALIZED_COORDS', 'CAD_CLAHE', 'CAD_BILATERAL')


def distance(first, second):
    row = list(range(len(second) + 1))
    for i, a in enumerate(first, 1):
        next_row = [i]
        for j, b in enumerate(second, 1):
            next_row.append(min(row[j] + 1, next_row[-1] + 1, row[j - 1] + (a != b)))
        row = next_row
    return row[-1]


def match_points(predicted, expected, tolerance):
    candidates = []
    for aid, a in predicted.items():
        for bid, b in expected.items():
            gap = math.dist(a, b)
            if gap <= tolerance:
                candidates.append((gap, aid, bid))
    matched, used = {}, set()
    for _, aid, bid in sorted(candidates):
        if aid not in matched and bid not in used:
            matched[aid] = bid
            used.add(bid)
    return matched


def rates(tp, predicted, expected):
    return {
        'tp': tp, 'fp': predicted - tp, 'fn': expected - tp,
        'precision': tp / predicted if predicted else None,
        'recall': tp / expected if expected else None,
        'f1': 2 * tp / (predicted + expected) if predicted + expected else None,
    }


def quality(graph, reference, tolerance=8):
    import cv2
    import numpy as np

    model = graph['documentModel']
    if graph['image'] != reference['image']:
        raise ValueError('Reference must use the prepared image dimensions')
    truth = reference['documentModel']
    actual_pipes = [p for p in model['pipes'] if p.get('state') == 'primary']
    truth_pipes = truth['pipes']

    def mask(pipes):
        size = graph['image']
        raster = np.zeros((size['height'], size['width']), dtype=np.uint8)
        for pipe in pipes:
            points = np.rint(pipe['geometry']).astype(np.int32)
            cv2.polylines(raster, [points], False, 1, thickness=3)
        return raster.astype(bool)

    actual_mask, truth_mask = mask(actual_pipes), mask(truth_pipes)
    overlap = int((actual_mask & truth_mask).sum())
    geometry = rates(overlap, int(actual_mask.sum()), int(truth_mask.sum()))
    union = int((actual_mask | truth_mask).sum())
    geometry['stroke_iou'] = overlap / union if union else None

    def nodes(pipes, node_list):
        connected = {pipe[key] for pipe in pipes for key in ('fromNode', 'toNode')}
        return {n['id']: n['position'] for n in node_list if n['id'] in connected}

    actual_nodes = nodes(actual_pipes, model['nodes'])
    truth_nodes = nodes(truth_pipes, truth['nodes'])
    node_map = match_points(actual_nodes, truth_nodes, tolerance)

    def connections(pipes, mapping):
        return Counter(tuple(sorted([mapping[p['fromNode']], mapping[p['toNode']]]))
                       for p in pipes if p['fromNode'] in mapping and p['toNode'] in mapping)

    actual_links = connections(actual_pipes, node_map)
    truth_links = connections(truth_pipes, {n: n for n in truth_nodes})

    def centers(items):
        return {k: (v['bbox']['x'] + v['bbox']['w'] / 2, v['bbox']['y'] + v['bbox']['h'] / 2)
                for k, v in items.items() if v.get('bbox')}

    actual_labels = {v['id']: v for v in model['labels'] if v.get('state') == 'primary'}
    truth_labels = {v['id']: v for v in truth['labels']}
    label_map = match_points(centers(actual_labels), centers(truth_labels), tolerance)
    reverse = {v: k for k, v in label_map.items()}
    transcriptions = [(actual_labels[reverse[k]]['text'] if k in reverse else '', v['text'])
                      for k, v in truth_labels.items()]
    transcriptions.extend((v['text'], '') for k, v in actual_labels.items() if k not in label_map)
    chars = sum(len(b) for _, b in transcriptions)
    words = sum(len(b.split()) for _, b in transcriptions)
    actual_symbols = {v['id']: v for v in model['symbols']}
    truth_symbols = {v['id']: v for v in truth['symbols']}
    symbol_map = match_points(centers(actual_symbols), centers(truth_symbols), tolerance)
    def symbol_type(symbol):
        suggestions = symbol.get('suggestedTypes') or []
        return symbol.get('kind') or (suggestions[0].get('type') if suggestions else None)

    symbol_tp = sum(symbol_type(actual_symbols[k]) == symbol_type(truth_symbols[v])
                    and bool(symbol_type(truth_symbols[v])) for k, v in symbol_map.items())
    target_map = node_map | symbol_map
    truth_pipe_ids = {}
    for pipe in truth_pipes:
        key = tuple(sorted((pipe['fromNode'], pipe['toNode'])))
        if truth_links[key] == 1:
            truth_pipe_ids[key] = pipe['id']
    for pipe in actual_pipes:
        a, b = node_map.get(pipe['fromNode']), node_map.get(pipe['toNode'])
        if a is not None and b is not None:
            key = tuple(sorted((a, b)))
            if key in truth_pipe_ids and actual_links[key] == 1:
                target_map[pipe['id']] = truth_pipe_ids[key]
    comparable_truth = set(truth_nodes) | set(truth_symbols) | {p['id'] for p in truth_pipes}
    comparable_actual = set(actual_nodes) | set(actual_symbols) | {p['id'] for p in actual_pipes}
    linked = sum(target_map.get(actual_labels[k].get('targetId')) == truth_labels[v].get('targetId')
                 and truth_labels[v].get('targetId') in comparable_truth for k, v in label_map.items())
    return {
        'ocr': {'cer': sum(distance(a, b) for a, b in transcriptions) / chars if chars else None,
                'wer': sum(distance(a.split(), b.split()) for a, b in transcriptions) / words if words else None,
                'label_detection': rates(len(label_map), len(actual_labels), len(truth_labels))},
        'geometry': geometry,
        'topology': {'nodes': rates(len(node_map), len(actual_nodes), len(truth_nodes)),
                     'connections': rates(sum((actual_links & truth_links).values()), len(actual_pipes), len(truth_pipes))},
        'semantics': {'symbols': rates(symbol_tp, len(actual_symbols), len(truth_symbols)),
                      'label_links': rates(linked,
                                           sum(v.get('targetId') in comparable_actual for v in actual_labels.values()),
                                           sum(v.get('targetId') in comparable_truth for v in truth_labels.values()))},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path, help='New directory, so tile checkpoints are isolated')
    parser.add_argument('--variant', choices=VARIANTS, default='baseline')
    parser.add_argument('--split', choices=('train', 'test'), default='test')
    args = parser.parse_args()
    cases = json.loads(args.manifest.read_text(encoding='utf-8'))
    selected = [case for case in cases if case['split'] == args.split]
    if not selected:
        parser.error('The selected split is empty')
    for flag in FLAGS:
        os.environ[flag] = '0'
    if setting := VARIANTS[args.variant]:
        os.environ[setting[0]] = setting[1]

    import processor

    args.output.mkdir(parents=True, exist_ok=False)
    report = {
        'variant': args.variant, 'split': args.split,
        'configuration': {key: value for key, value in sorted(os.environ.items())
                          if key.startswith('QWEN_') or key in FLAGS},
        'cases': [],
    }
    for index, case in enumerate(selected, 1):
        result = {'image': case['image'], 'address': case['address']}
        report['cases'].append(result)
        started = time.perf_counter()
        try:
            graph = processor.analyze(str(args.manifest.parent / case['image']), str(args.output / str(index)))
            result.update({
                'complete': graph['complete'],
                'prepared_size': graph['image'],
                'timings_ms': graph['timings_ms'],
                'qwen': graph['qwenAudit'],
                'pipe_out_of_bounds': graph['semanticTrace'].get('rejected_out_of_bounds_routes', 0),
                'ocr_out_of_bounds': sum(t.get('rejected_out_of_crop_boxes', 0)
                                         for t in graph['ocr']['qwen'].get('tile_diagnostics', ())),
            })
            if case.get('reference'):
                reference = json.loads((args.manifest.parent / case['reference']).read_text(encoding='utf-8'))
                result['quality'] = quality(graph, reference)
        except Exception as error:
            result['error'] = str(error)
        result['wall_ms'] = round((time.perf_counter() - started) * 1000, 1)
        (args.output / 'report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return int(any('error' in case for case in report['cases']))


if __name__ == '__main__':
    raise SystemExit(main())
