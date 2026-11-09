"""Compact, machine-readable diagnostics for every reconstruction stage."""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


def build_pipeline_diagnostics(input_path: str, out_dir: str, graph: dict[str, Any]) -> dict[str, Any]:
    source = Path(input_path)
    digest = hashlib.sha256(source.read_bytes()).hexdigest() if source.exists() else None
    summary, model = graph.get('summary') or {}, graph.get('documentModel') or {}
    tasks, findings = model.get('reviewTasks') or [], model.get('validationFindings') or []
    dimensions, symbols = model.get('dimensions') or [], model.get('symbols') or []
    primary_pipes = [item for item in model.get('pipes', []) if item.get('state') == 'primary']
    open_tasks = [item for item in tasks if item.get('status') == 'open']
    open_findings = [item for item in findings if item.get('status') == 'open']
    names = ['prepared-input.png','ink-mask.png','blue-ink-mask.png','dark-ink-mask.png',
             'primary-overlay.png','text-region-mask.png','handwritten-text-blocks.png',
             'clean.svg','drawing.dxf','cad-draft.svg','cad-draft.dxf',
             'reference-trace.svg','reference-trace.dxf','graph.json','progress.log']
    artifacts = []
    for name in names:
        path = Path(out_dir, name)
        artifacts.append({'name': name, 'exists': path.exists(), 'bytes': path.stat().st_size if path.exists() else 0})
    segment_count = int(summary.get('segment_candidates', 0) or 0)
    primary_edge_count = int(summary.get('cad_primary_edges', len(primary_pipes)) or 0)
    open_endpoint_count = int(summary.get('open_terminal_nodes', 0) or 0)
    crossing_count = int(summary.get('crossings_to_review', 0) or 0)
    has_reference_trace = bool((graph.get('referenceTrace') or {}).get('available'))
    required_exports = ({'reference-trace.svg', 'reference-trace.dxf', 'cad-draft.svg', 'cad-draft.dxf'}
                        if has_reference_trace else {'clean.svg', 'drawing.dxf'})
    gates = [
        {'id':'source-readable','passed':source.exists() and bool(digest),'value':source.stat().st_size if source.exists() else 0},
        {'id':'text-recognition-available','passed':bool(graph.get('ocr',{}).get('qwen',{}).get('available') or graph.get('ocr',{}).get('tesseract',{}).get('available')),
         'value':{'qwen':bool(graph.get('ocr',{}).get('qwen',{}).get('available')),'tesseract':bool(graph.get('ocr',{}).get('tesseract',{}).get('available'))}},
        {'id':'primary-geometry-present','passed':len(primary_pipes)>0,'value':len(primary_pipes)},
        {'id':'primary-selection-not-sparse','passed':segment_count<20 or primary_edge_count>=max(3,int(segment_count*.12)),
         'value':{'segments':segment_count,'primaryEdges':primary_edge_count}},
        {'id':'topology-fragmentation-controlled','passed':segment_count<20 or open_endpoint_count/segment_count<=0.70,
         'value':{'segments':segment_count,'openEndpoints':open_endpoint_count,'maximumRatio':0.70}},
        {'id':'crossing-density-controlled','passed':segment_count<20 or crossing_count/segment_count<=0.12,
         'value':{'segments':segment_count,'crossings':crossing_count,'maximumRatio':0.12}},
        {'id':'no-engineering-errors','passed':not any(item.get('severity')=='error' for item in open_findings),
         'value':sum(1 for item in open_findings if item.get('severity')=='error')},
        {'id':'exports-created','passed':all(next((item['exists'] and item['bytes']>0 for item in artifacts if item['name']==name), False) for name in required_exports),
         'value':{item['name']:item['bytes'] for item in artifacts if item['name'] in required_exports}},
    ]
    processing_complete = graph.get('complete') is not False and graph.get('analysisStatus') != 'incomplete'
    if not processing_complete:
        gates.append({
            'id': 'all-qwen-tiles-complete', 'passed': False,
            'value': {
                'ocr': graph.get('ocr', {}).get('qwen', {}).get('successful_tiles', 0),
                'ocrTiles': graph.get('ocr', {}).get('qwen', {}).get('tiles', 0),
                'pipe': graph.get('semanticTrace', {}).get('successful_tiles', 0),
                'pipeTiles': graph.get('semanticTrace', {}).get('tiles', 0),
            },
        })
    blocking_ids = {'source-readable', 'text-recognition-available', 'exports-created'}
    blocking = [item['id'] for item in gates if item['id'] in blocking_ids and not item['passed']]
    advisory = [item['id'] for item in gates if item['id'] not in blocking_ids and not item['passed']]
    stages = {
        'geometry':{'segments':segment_count,'primaryPipes':len(primary_pipes),'nodes':len(model.get('nodes') or [])},
        'recognition':{'labels':len(model.get('labels') or []),'symbols':len(symbols),
                       'classifiedSymbols':sum(1 for item in symbols if item.get('type')),
                       'dimensions':len(dimensions),'assignedDimensions':sum(1 for item in dimensions if item.get('targetId'))},
        'review':{'openTasks':len(open_tasks),'openFindings':len(open_findings)},
    }
    return {'schema':'cad-pipeline-diagnostics/1.0',
            'status':'blocked' if blocking else ('needs_review' if advisory or open_tasks or open_findings else 'ready'),
            'source':{'name':source.name,'bytes':source.stat().st_size if source.exists() else 0,'sha256':digest},
            'timingsMs':graph.get('timings_ms') or {},'stages':stages,'qualityGates':gates,
            'blockingGates':blocking,'advisoryGates':advisory,'artifacts':artifacts,'warnings':list(graph.get('warnings') or [])}
