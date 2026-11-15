#!/usr/bin/env python3
"""CAD Reconstruction Engine: non-destructive candidate geometry extraction.

Geometry and OCR are parallel channels. OCR boxes are NEVER subtracted from the
geometry image, because doing so can sever a pipe under a handwritten label.
Detected segments are candidates; ambiguous joins remain review items.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps  # noqa: F401  (Image is a patch target for OCR tests)

# CAD export moved to cad_export.py (P2-1); re-exported so existing imports of
# `processor.build_clean_svg` and the tests that patch `processor.*` keep working.
from engine.core.analysis_state import set_analysis_hard_deadline
from engine.core.centerline_vectorization import build_centerline_trace
from engine.core.geometry import (  # noqa: F401
    _confirmed_text_boxes,
    _expanded_text_box,
    _merge_aligned_duplicate,
    _same_ink_band,
    _sample_line_support,
    _segment_inside_text_box,
    _segment_text_box_metrics,
    _segment_text_mask_metrics,
    _text_region_mask,
    endpoint_clusters,
    extract_segments,
)

# Pen-colour evidence moved to core/ink.py (P2-1); re-exported so existing
# `processor._annotate_edge_ink_color` call sites and tests keep working.
from engine.core.ink import _annotate_edge_ink_color  # noqa: F401
from engine.core.logging_setup import configure_logging, get_logger
from engine.core.reference_vectorization import build_reference_trace
from engine.core.runtime import _atomic_write_text, _progress
from engine.export.cad_export import (  # noqa: F401
    _annotation_export_kind,
    _cad_edge_chains,
    _clean_cad_points,
    _primary_semantic_chains,
    _semantic_route_chains,
    _sheet_layout,
    build_clean_svg,
    build_dxf,
)
from engine.export.cad_graph import (  # noqa: F401
    _build_join_candidates,
    _point_to_segment_distance,
    detect_crossings,
    select_primary_cad_edges,
    validate_primary_semantic_routes,
)
from engine.export.cad_overlay import render_cad_alignment_overlay
from engine.export.clean_export import build_layout_dxf, build_layout_svg
from engine.export.topology_reconstruction import attach_pipes_to_symbols, split_segments_at_endpoint_junctions
from engine.model.clean_layout import build_clean_layout
from engine.model.drawing_quality import validate_clean_layout
from engine.model.drawing_template import build_drawing_template
from engine.model.engineering_validation import validate_engineering_model
from engine.model.pipeline_diagnostics import build_pipeline_diagnostics
from engine.model.structured_model import build_document_model
from engine.ocr.handwriting import (  # noqa: F401
    _candidate_handwritten_text_blocks,
    _detect_handwritten_row_bands,
    _run_handwritten_block_ocr,
    _run_numbered_row_ocr,
)
from engine.ocr.image_preprocess import (  # noqa: F401
    _detect_page_quad,
    _detect_text_rotation,
    _detect_text_rotation_fallback,
    _estimate_document_skew,
    _order_quad,
    _rotate_expand,
    _warp_page,
    load_image,
    make_ink_layers,
    make_ink_mask,
    normalize_document,
    prepare_document_image,
)

# OCR pipeline moved to ocr/pipeline.py (P2-1); re-exported so `processor.*`
# call sites and the tests that patch them keep working.
from engine.ocr.pipeline import (  # noqa: F401
    _boxes_overlap,
    _qwen_annotations,
    _qwen_stage_is_complete,
    _tesseract_failed_ocr_tiles,
    ocr_annotations,
)
from engine.ocr.qwen_client import (  # noqa: F401
    CHECKPOINT_VERSION,
    _analysis_has_qwen_budget,
    _annotation_items_from_response,
    _clip_polyline_to_rect,
    _clip_segment_to_rect,
    _is_retryable_qwen_error,
    _load_tile_checkpoint,
    _parse_json_object,
    _qwen_attempt_worst_case_seconds,
    _qwen_call,
    _qwen_call_with_retry,
    _save_tile_checkpoint,
    _sha256_file,
    _tile_checkpoint_path,
    _tile_checkpoint_signature,
)
from engine.ocr.schemas import (  # noqa: F401
    OCR_BLOCK_RESPONSE_SCHEMA,
    OCR_RESPONSE_SCHEMA,
    OCR_ROW_RESPONSE_SCHEMA,
    OCR_ROWS_RESPONSE_SCHEMA,
)

# Handwritten-note response schemas moved to ocr/schemas.py (P2-1); re-exported
# so the OCR call sites and tests that reference `processor.*_SCHEMA` keep working.
# Semantic pipe-route tracing moved to routing/semantic.py (P2-1); re-exported
# so `processor._qwen_semantic_routes` and the tests that patch it keep working.
from engine.routing.semantic import PIPE_RESPONSE_SCHEMA, _qwen_semantic_routes, _semantic_error_hint  # noqa: F401
from engine.symbols.annotation_linking import link_annotations
from engine.symbols.cad_symbols import catalog_manifest
from engine.symbols.recognition_channels import split_recognition_channels

configure_logging()
log = get_logger('processor')


def analyze(input_path: str, out_dir: str, template_path: str | None = None, rotation_degrees: int | None = None) -> dict[str, Any]:
    job_started = time.perf_counter()
    configured_job_ms = max(60_000.0, float(os.getenv('PYTHON_JOB_TIMEOUT_MS', '5400000')))
    set_analysis_hard_deadline(time.monotonic() + configured_job_ms / 1000.0)
    timings_ms: dict[str, float] = {}
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    _progress('JOB', 'Image preprocessing started')
    stage_started = time.perf_counter()
    source_bgr = load_image(input_path)
    bgr, preparation = prepare_document_image(source_bgr, rotation_degrees=rotation_degrees)
    h, w = bgr.shape[:2]
    prepared_input_path = str(Path(out_dir) / 'prepared-input.png')
    cv2.imwrite(prepared_input_path, bgr)
    gray, prep = normalize_document(bgr)
    prep.update(preparation)
    ink_layers = make_ink_layers(bgr, gray)
    ink = ink_layers['combined']
    timings_ms['preprocessing'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress('JOB', f'Image preprocessing completed: {w}x{h}; {timings_ms["preprocessing"]:.1f} ms')
    _progress('OCR', 'OCR pipeline started')
    stage_started = time.perf_counter()
    checkpoint_dir = Path(out_dir) / '.checkpoints'
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    annotations, ocr_status = ocr_annotations(prepared_input_path, gray, checkpoint_dir=checkpoint_dir)
    timings_ms['ocr'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress(
        'OCR',
        f'OCR pipeline completed: annotations={len(annotations)}; local Qwen={ocr_status.get("qwen", {}).get("successful_tiles", 0)}/{ocr_status.get("qwen", {}).get("tiles", 0)}; Tesseract={ocr_status.get("tesseract", {}).get("annotations", 0)}; {timings_ms["ocr"]:.1f} ms',
    )
    qwen_ocr_complete = _qwen_stage_is_complete(ocr_status.get('qwen'))
    # OCR and pipe tracing are independent vision tasks. A missing OCR tile
    # must never suppress the geometry pass: Tesseract and OpenCV remain useful
    # even when the local VL model times out on handwriting.
    tesseract_available = bool(ocr_status.get('tesseract', {}).get('available'))
    ocr_complete = qwen_ocr_complete or tesseract_available
    stage_started = time.perf_counter()
    _progress('PIPE', 'Local Ollama Qwen pipe-route trace started independently of OCR completeness')
    semantic_routes, route_status = _qwen_semantic_routes(prepared_input_path, w, h, checkpoint_dir=checkpoint_dir)
    route_status['provider'] = 'ollama-qwen'
    _progress(
        'PIPE',
        f'Local Qwen pipe-route trace completed: routes={len(semantic_routes)}; tiles={route_status.get("successful_tiles", 0)}/{route_status.get("tiles", 0)}',
    )
    timings_ms['semantic_pipe_trace'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    timings_ms['qwen_pipe_trace'] = timings_ms['semantic_pipe_trace']
    pipe_complete = _qwen_stage_is_complete(route_status) and bool(semantic_routes)
    processing_complete = qwen_ocr_complete and pipe_complete
    incomplete_reasons = []
    if not qwen_ocr_complete:
        provider_status = ocr_status.get('qwen', {})
        if provider_status.get('error') or provider_status.get('incomplete_reason'):
            incomplete_reasons.append(
                'локальный Qwen OCR: ' + str(provider_status.get('incomplete_reason') or provider_status.get('error'))[:240]
            )
        if not incomplete_reasons:
            incomplete_reasons.append('Локальный Qwen OCR не завершил полный проход.')
    if not pipe_complete:
        incomplete_reasons.append(
            route_status.get('incomplete_reason') or route_status.get('error') or 'Трассировка труб не обработала все необходимые участки.'
        )
    if processing_complete:
        _progress(
            'JOB', f'Analysis completed; OCR provider=local Qwen + Tesseract; PIPE provider={route_status.get("provider", "local Qwen")}'
        )
    else:
        active_ocr_status = ocr_status.get('qwen', {})
        _progress(
            'JOB',
            f'Analysis incomplete; OCR provider={active_ocr_status.get("provider", "local Qwen")}; OCR={active_ocr_status.get("successful_tiles", 0)}/{active_ocr_status.get("tiles", 0)}; PIPE={route_status.get("successful_tiles", 0)}/{route_status.get("tiles", 0)}; checkpoints saved for retry',
        )
    _progress('CAD', 'Graph construction started')
    stage_started = time.perf_counter()
    # The selected OpenCV graph remains the detector backbone. Only Qwen routes
    # that pass source-ink and OCR-mask validation are added as complementary
    # primary CAD geometry; sparse or invalid model output cannot erase OpenCV.
    segments = extract_segments(gray, ink, annotations)
    text_mask = _text_region_mask(gray.shape[:2], annotations)
    segments, t_junction_diagnostics = split_segments_at_endpoint_junctions(
        segments,
        ink,
        text_mask,
        max_distance_px=float(os.getenv('T_JUNCTION_MAX_GAP_PX', '3.5')),
        minimum_branch_length_px=float(os.getenv('T_JUNCTION_MIN_BRANCH_PX', '14')),
    )
    nodes, edges, components = endpoint_clusters(segments, ink=ink, text_mask=text_mask)
    ink_color_diagnostics = _annotate_edge_ink_color(edges, ink_layers['blue'], ink_layers['dark'])
    cad_selection = select_primary_cad_edges(nodes, edges, min(w, h), image_size=(w, h))
    primary_opencv_edges = [edge for edge in edges if edge.get('cad_include')]
    primary_semantic_routes, semantic_validation = validate_primary_semantic_routes(
        semantic_routes, ink, text_mask, primary_opencv_edges, min(w, h)
    )
    _progress('CAD', f'Graph construction in progress: segments={len(segments)} nodes={len(nodes)} edges={len(edges)}')
    primary_semantic_ids = {str(route.get('id')) for route in primary_semantic_routes}
    for route in semantic_routes:
        route['primary_validated'] = str(route.get('id')) in primary_semantic_ids
    for route in primary_semantic_routes:
        route['primary_validated'] = True
    # OCR overlap is now a real exclusion signal, not merely a note. Confirmed
    # continuous routes crossing a text box are retained by the two-sided ink test.
    for edge in edges:
        edge['visible'] = True
    crossings = detect_crossings(segments)
    ink_in_text_regions = cv2.bitwise_and(ink, text_mask)
    geometry_ink = cv2.bitwise_and(ink, cv2.bitwise_not(text_mask))
    timings_ms['opencv_geometry_and_topology'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress(
        'CAD',
        f'Graph construction completed: segments={len(segments)} nodes={len(nodes)} edges={len(edges)} crossings={len(crossings)}; {timings_ms["opencv_geometry_and_topology"]:.1f} ms',
    )
    stage_started = time.perf_counter()

    # The candidate overlay remains available for audit; the primary overlay
    # makes it immediately visible what will actually enter PIPE_MAIN.
    overlay = bgr.copy()
    primary_overlay = bgr.copy()
    for segment in segments:
        col = (
            (155, 155, 155) if segment.get('ocr_overlap', 0) >= 0.16 else ((30, 130, 240) if segment['source'] == 'LSD' else (40, 180, 80))
        )
        cv2.line(overlay, (int(segment['x1']), int(segment['y1'])), (int(segment['x2']), int(segment['y2'])), col, 2, cv2.LINE_AA)
    edge_by_index = {int(edge.get('source_segment_index', -1)): edge for edge in edges}
    for segment_index, segment in enumerate(segments):
        edge = edge_by_index.get(segment_index)
        if edge and edge.get('cad_include'):
            color = (40, 190, 95)
            thickness = 3
        else:
            color = (150, 150, 150)
            thickness = 1
        cv2.line(
            primary_overlay,
            (int(segment['x1']), int(segment['y1'])),
            (int(segment['x2']), int(segment['y2'])),
            color,
            thickness,
            cv2.LINE_AA,
        )
    for route in primary_semantic_routes:
        pts = np.array([[int(round(p[0])), int(round(p[1]))] for p in route['points']], dtype=np.int32)
        if len(pts) >= 2:
            cv2.polylines(primary_overlay, [pts], False, (255, 170, 20), 3, cv2.LINE_AA)
    for node in nodes:
        if node['degree'] >= 3:
            cv2.circle(overlay, (int(node['x']), int(node['y'])), 4, (0, 0, 255), -1, cv2.LINE_AA)
    overlay_path = str(Path(out_dir) / 'overlay.png')
    cv2.imwrite(overlay_path, overlay)
    cv2.imwrite(str(Path(out_dir) / 'primary-overlay.png'), primary_overlay)
    cv2.imwrite(str(Path(out_dir) / 'text-region-mask.png'), text_mask)
    cv2.imwrite(str(Path(out_dir) / 'ink-without-text-boxes.png'), geometry_ink)
    cv2.imwrite(str(Path(out_dir) / 'ink-inside-text-boxes.png'), ink_in_text_regions)
    # Visual audit of the independent dense-note detector and its row-OCR pass.
    note_overlay = bgr.copy()
    for block_index, diag in enumerate(ocr_status.get('qwen', {}).get('block_diagnostics', []), 1):
        box = diag.get('bbox') or {}
        try:
            x1, y1 = int(box['x']), int(box['y'])
            x2, y2 = x1 + int(box['w']), y1 + int(box['h'])
        except (KeyError, TypeError, ValueError):
            continue
        cv2.rectangle(note_overlay, (x1, y1), (x2, y2), (200, 40, 210), 2, cv2.LINE_AA)
        label = f'NOTE {block_index}: {diag.get("accepted_lines", 0)} rows'
        cv2.putText(note_overlay, label, (x1, max(18, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (200, 40, 210), 1, cv2.LINE_AA)
        for row_diag in diag.get('row_diagnostics', []):
            row_box = row_diag.get('bbox') or {}
            try:
                rx, ry = int(row_box['x']), int(row_box['y'])
                rw, rh = int(row_box['w']), int(row_box['h'])
            except (KeyError, TypeError, ValueError):
                continue
            cv2.rectangle(note_overlay, (rx, ry), (rx + rw, ry + rh), (255, 145, 20), 1, cv2.LINE_AA)
            cv2.putText(
                note_overlay,
                str(row_diag.get('row', '?')),
                (rx, max(12, ry - 2)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.34,
                (255, 145, 20),
                1,
                cv2.LINE_AA,
            )
    cv2.imwrite(str(Path(out_dir) / 'handwritten-text-blocks.png'), note_overlay)
    ink_path = str(Path(out_dir) / 'ink-mask.png')
    cv2.imwrite(ink_path, ink)
    cv2.imwrite(str(Path(out_dir) / 'blue-ink-mask.png'), ink_layers['blue'])
    cv2.imwrite(str(Path(out_dir) / 'dark-ink-mask.png'), ink_layers['dark'])
    cv2.imwrite(str(Path(out_dir) / 'faint-ink-mask.png'), ink_layers['faint'])
    # Preserve the original contour facsimile for exact ink-shape editing, but
    # also export a true one-pixel centreline version as open CAD polylines.
    # This avoids the thousands of closed contour loops that look like dots in
    # CAD viewers when a thin engineering drawing is imported.
    try:
        reference_trace = build_reference_trace(ink, source_name=Path(input_path).name)
        Path(out_dir, 'reference-trace.svg').write_text(reference_trace.svg, encoding='utf-8')
        Path(out_dir, 'reference-trace.dxf').write_text(reference_trace.dxf, encoding='utf-8')
        reference_trace_meta = {
            'available': True,
            'svg': 'reference-trace.svg',
            'dxf': 'reference-trace.dxf',
            'components': reference_trace.components,
            'contours': reference_trace.contours,
            'vertices': reference_trace.vertices,
            'pageWidthMm': reference_trace.page_width_mm,
            'pageHeightMm': reference_trace.page_height_mm,
            'semantic': False,
            'description': 'Source-faithful closed ink contours; not a verified pipe centre-line graph.',
        }
        _progress(
            'REFERENCE',
            f'Source contour trace exported: components={reference_trace.components}; contours={reference_trace.contours}; vertices={reference_trace.vertices}',
        )
    except Exception as trace_error:
        reference_trace_meta = {'available': False, 'error': str(trace_error)[:300], 'semantic': False}
        _progress('REFERENCE', f'Source contour trace failed: {str(trace_error)[:220]}')

    try:
        centerline_trace = build_centerline_trace(ink, source_name=Path(input_path).name)
        Path(out_dir, 'centerline-trace.svg').write_text(centerline_trace.svg, encoding='utf-8')
        Path(out_dir, 'centerline-trace.dxf').write_text(centerline_trace.dxf, encoding='utf-8')
        centerline_trace_meta = {
            'available': True,
            'svg': 'centerline-trace.svg',
            'dxf': 'centerline-trace.dxf',
            'components': centerline_trace.components,
            'paths': centerline_trace.paths,
            'vertices': centerline_trace.vertices,
            'skeletonPixels': centerline_trace.skeleton_pixels,
            'lengthPx': round(centerline_trace.length_px, 2),
            'pageWidthMm': centerline_trace.page_width_mm,
            'pageHeightMm': centerline_trace.page_height_mm,
            'semantic': False,
            'description': 'Open source-ink centerline polylines; faithful linework, not verified semantic pipe topology.',
        }
        _progress(
            'CENTERLINE',
            f'Open polylines exported: components={centerline_trace.components}; paths={centerline_trace.paths}; vertices={centerline_trace.vertices}; skeleton_pixels={centerline_trace.skeleton_pixels}',
        )
    except Exception as trace_error:
        centerline_trace_meta = {'available': False, 'error': str(trace_error)[:300], 'semantic': False}
        _progress('CENTERLINE', f'Open polyline tracing failed: {str(trace_error)[:220]}')
    _progress('EXPORT', 'SVG and DXF export started')
    svg = build_clean_svg(
        w,
        h,
        edges,
        annotations,
        semantic_routes=semantic_routes,
        semantic_status=route_status,
        primary_semantic_routes=primary_semantic_routes,
    )
    Path(out_dir, 'clean.svg').write_text(svg, encoding='utf-8')
    Path(out_dir, 'drawing.dxf').write_text(
        build_dxf(w, h, edges, annotations, semantic_routes=semantic_routes, primary_semantic_routes=primary_semantic_routes),
        encoding='utf-8',
    )
    _progress('EXPORT', 'SVG and DXF written')
    # Candidate joins are diagnostic only. The graph's ink-supported endpoint
    # clustering performs conservative auto-joins; this list must not invent
    # same-edge, endpoint-to-interior, or laterally displaced connections.
    joins = _build_join_candidates(nodes, edges, image_size=(w, h))
    _progress(
        'CAD',
        f'Endpoint continuation candidates: total={len(joins)} high={sum(1 for item in joins if item.get("priority") == "high")} review={sum(1 for item in joins if item.get("priority") != "high")}',
    )
    timings_ms['drawing_export_and_candidates'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    timings_ms['total_before_graph_json_write'] = round((time.perf_counter() - job_started) * 1000.0, 1)
    recognition_channels = split_recognition_channels(w, h, components, edges, annotations, ink_mask=ink)
    document_model = build_document_model(
        w, h, nodes, edges, annotations, crossings, joins, recognition_channels, semantic_routes=primary_semantic_routes
    )
    document_model, topology_diagnostics = attach_pipes_to_symbols(document_model)
    document_model, annotation_linking_diagnostics = link_annotations(document_model)
    document_model, engineering_validation = validate_engineering_model(document_model)
    drawing_template = build_drawing_template(reference_path=template_path)
    clean_layout, clean_layout_diagnostics = build_clean_layout(
        document_model, template=drawing_template, review_only=not processing_complete
    )
    drawing_quality = validate_clean_layout(clean_layout, engineering_validation)
    clean_layout_diagnostics['drawingQuality'] = drawing_quality
    cad_alignment_overlay = {'available': False, 'error': 'not-generated'}
    try:
        cad_alignment_overlay = render_cad_alignment_overlay(bgr, document_model, Path(out_dir, 'cad-alignment-overlay.png'))
        _progress('CAD', 'Source-photo / CAD alignment overlay written')
    except Exception as overlay_error:
        cad_alignment_overlay = {'available': False, 'error': str(overlay_error)[:220]}
        _progress('CAD', f'Source-photo / CAD overlay failed: {str(overlay_error)[:180]}')
    cad_draft_svg = build_layout_svg(clean_layout)
    cad_draft_dxf = build_layout_dxf(clean_layout)
    Path(out_dir, 'clean.svg').write_text(cad_draft_svg, encoding='utf-8')
    Path(out_dir, 'drawing.dxf').write_text(cad_draft_dxf, encoding='utf-8')
    Path(out_dir, 'cad-draft.svg').write_text(cad_draft_svg, encoding='utf-8')
    Path(out_dir, 'cad-draft.dxf').write_text(cad_draft_dxf, encoding='utf-8')
    graph = {
        'schema': 'cad-reconstruction-graph/1.2',
        'status': 'needs_review',
        'analysisStatus': 'complete' if processing_complete else 'incomplete',
        'complete': processing_complete,
        'incompleteReasons': incomplete_reasons,
        'checkpointing': {
            'enabled': True,
            'directory': '.checkpoints',
            'resumeBehavior': 'successful OCR/PIPE tiles are restored; failed tiles are retried on the next analysis run',
        },
        'exportPolicy': {
            'processingComplete': bool(processing_complete),
            'partialExports': 'review-only-watermarked',
            'referenceTrace': 'editable-source-contours-not-semantic-pipes',
            'centerlineTrace': 'editable-open-source-ink-polylines-not-semantic-pipes',
            'cadDraft': 'structured-review-draft-until-engineering-validation',
            'engineeringApprovalRequired': True,
        },
        'image': {'width': w, 'height': h},
        'documentModel': document_model,
        'recognitionChannels': recognition_channels,
        'symbolCatalog': catalog_manifest(),
        'topologyDiagnostics': {**topology_diagnostics, 'tJunctions': t_junction_diagnostics},
        'annotationLinkingDiagnostics': annotation_linking_diagnostics,
        'engineeringValidation': engineering_validation,
        'drawingQuality': drawing_quality,
        'cadAlignmentOverlay': cad_alignment_overlay,
        'cleanLayout': clean_layout,
        'cleanLayoutDiagnostics': clean_layout_diagnostics,
        'referenceTrace': reference_trace_meta,
        'centerlineTrace': centerline_trace_meta,
        'drawingTemplate': drawing_template,
        'nodes': nodes,
        'edges': edges,
        'components': components,
        'crossings': crossings,
        'joinCandidates': joins,
        'annotations': annotations,
        'ocr': ocr_status,
        'semanticRoutes': semantic_routes,
        'primarySemanticRoutes': primary_semantic_routes,
        'semanticValidation': semantic_validation,
        'semanticTrace': route_status,
        'timings_ms': timings_ms,
        'rules': {
            'ocr_boxes_mask_geometry_even_when_text_unverified': True,
            'text_overlap_affects_component_classification': True,
            'continuous_lines_through_text_are_preserved_only_with_two_sided_ink_support': True,
            'crossings_auto_joined': False,
            'endpoint_cluster_radius_px': 4.5,
            'collinear_gap_join_max_px': 28,
            'ambiguous_and_text_like_components_are_review_only': True,
            'clean_export_uses_selected_opencv_and_validated_qwen_routes': True,
            'qwen_routes_are_ink_validated_before_primary_export': True,
            'unselected_pixel_candidates_are_review_only': True,
            'short_symbol_stubs_go_to_review_layer': True,
            'ink_colour_is_advisory_only': True,
            'unknown_symbols_require_confirmation': True,
            'polyline_merge_preserves_source_geometry': True,
            'ambiguous_junctions_are_not_merged': True,
            't_junctions_only_join_supported_endpoint_to_interior_contacts': True,
            'symbol_template_matches_require_engineer_confirmation': True,
            'adaptive_faint_ink_is_reviewed_with_source_support': True,
            'join_candidates_include_ambiguous_components_for_manual_review': True,
            'join_candidates_allow_short_fragments_for_manual_review': True,
            'join_candidate_gap_px': [4.5, 45.0],
            'join_candidate_lateral_tolerance_px': 8.0,
            'join_candidate_min_edge_length_px': 8.0,
            'join_candidate_min_endpoint_facing': 0.82,
            'join_candidate_min_tangent_alignment': 0.85,
            'join_candidates_auto_applied': False,
            'topology_network_candidate_min_edges': 8,
            'topology_network_candidate_min_length_px': 135,
            'topology_network_candidate_max_degree': 8,
            'topology_network_candidate_max_edge_density': 5.6,
            'topology_network_candidate_max_turn_density': 1.35,
        },
        'summary': {
            'analysis_complete': processing_complete,
            'ocr_tiles_complete': qwen_ocr_complete,
            'ocr_text_available': ocr_complete,
            'pipe_tiles_complete': pipe_complete,
            'ocr_tiles_successful': ocr_status.get('qwen', {}).get('successful_tiles', 0),
            'ocr_tiles_total': ocr_status.get('qwen', {}).get('tiles', 0),
            'pipe_tiles_successful': route_status.get('successful_tiles', 0),
            'pipe_tiles_total': route_status.get('tiles', 0),
            'segment_candidates': len(segments),
            'nodes': len(nodes),
            'edges': len(edges),
            'crossings_to_review': len(crossings),
            'ocr_annotations': len(annotations),
            'reference_trace_components': reference_trace_meta.get('components', 0),
            'reference_trace_contours': reference_trace_meta.get('contours', 0),
            'reference_trace_vertices': reference_trace_meta.get('vertices', 0),
            'centerline_trace_paths': centerline_trace_meta.get('paths', 0),
            'centerline_trace_vertices': centerline_trace_meta.get('vertices', 0),
            'centerline_trace_skeleton_pixels': centerline_trace_meta.get('skeletonPixels', 0),
            'semantic_routes': len(semantic_routes),
            'qwen_review_routes': len(_semantic_route_chains(semantic_routes)),
            'cad_primary_chains': len(_cad_edge_chains(edges)),
            'cad_primary_qwen_routes': len(primary_semantic_routes),
            'document_model_qwen_routes': sum(1 for pipe in document_model.get('pipes', []) if pipe.get('source') == 'qwen3-vl-validated'),
            'ink_color_classification': ink_color_diagnostics,
            't_junctions_added': t_junction_diagnostics.get('tJunctionsAdded', 0),
            't_junction_segments_created': t_junction_diagnostics.get('segmentsCreated', 0),
            'cad_primary_total_paths': len(_cad_edge_chains(edges)) + len(primary_semantic_routes),
            'semantic_validation': semantic_validation,
            'primary_geometry_source': 'opencv-selected-graph+ink-validated-local-qwen',
            'qwen_annotations': len([a for a in annotations if a.get('source') == 'qwen3-vl']),
            'geometry_excluded_text_regions': len(_confirmed_text_boxes(annotations)),
            'tesseract_annotations': len([a for a in annotations if a.get('source') == 'tesseract']),
            'verified_annotations': len([a for a in annotations if a.get('verified') and a.get('text')]),
            'text_review_annotations': len([a for a in annotations if _annotation_export_kind(a) == 'TEXT_REVIEW']),
            'text_block_annotations': len([a for a in annotations if a.get('source') == 'qwen3-vl-block']),
            'text_block_rows_detected': sum(
                int(item.get('rows_detected', 0) or 0) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])
            ),
            'text_block_rows_returned': sum(
                int(item.get('rows_returned', 0) or 0) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])
            ),
            'text_block_rows_verified': sum(
                sum(1 for row in item.get('row_diagnostics', []) if row.get('accepted') and float(row.get('confidence', 0) or 0) >= 58)
                for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])
            ),
            'qwen_verified_annotations': len([a for a in annotations if a.get('source') == 'qwen3-vl' and a.get('verified')]),
            'tesseract_verified_annotations': len([a for a in annotations if a.get('source') == 'tesseract' and a.get('verified')]),
            'review_annotations': len([a for a in annotations if not a.get('verified') and a.get('text')]),
            'text_overlap_edges': sum(1 for e in edges if e.get('suggested_role') == 'text_or_dimension'),
            'text_regions_used_for_geometry_mask': len(_confirmed_text_boxes(annotations)),
            'ink_pixels_inside_text_regions': int(np.count_nonzero(ink_in_text_regions)),
            'auto_joined_collinear_gaps': len({(edge['from'], edge['to']) for edge in edges if edge.get('auto_joined_gap')}),
            'text_or_annotation_components': sum(1 for c in components if c['role'] == 'text_or_annotation'),
            'review_only_ambiguous_components': sum(1 for c in components if c['role'] == 'ambiguous'),
            'topology_network_candidate_components': sum(1 for c in components if c.get('topology_network_candidate')),
            'topology_network_primary_edges': sum(1 for e in edges if e.get('topology_network_candidate') and e.get('cad_include')),
            'structured_route_components': sum(
                1
                for c in components
                if c.get('connected_line_candidate') or c.get('elbow_route_candidate') or c.get('topology_network_candidate')
            ),
            'dense_route_exempted_components': sum(1 for c in components if c.get('dense_route_exemption')),
            'primary_edge_count_by_detector': {
                name: sum(1 for e in edges if e.get('cad_include') and e.get('detector') == name) for name in ('LSD', 'HOUGH')
            },
            'isolated_strokes_kept_for_review': sum(1 for e in edges if e.get('cad_reason') == 'isolated-stroke-review'),
            'geometry_candidates_preserved': len(segments),
            'open_end_join_candidates': len(joins),
            'join_candidates_high_priority': sum(1 for item in joins if item.get('priority') == 'high'),
            'join_candidates_needing_review': sum(1 for item in joins if item.get('priority') != 'high'),
            'join_candidates_with_alternatives': sum(1 for item in joins if item.get('has_alternatives')),
            'open_terminal_nodes': sum(1 for node in nodes if int(node.get('degree', 0)) == 1),
            'components': len(components),
            **cad_selection,
            'line_components': sum(1 for c in components if c['role'] == 'line_structure'),
            'annotation_components': sum(1 for c in components if c['role'] == 'text_or_annotation'),
            'ambiguous_components': sum(1 for c in components if c['role'] == 'ambiguous'),
            'ink_pixels': int(np.count_nonzero(ink)),
            'faint_ink_pixels': int(np.count_nonzero(ink_layers['faint'])),
            'preprocessing': prep,
        },
        'warnings': [
            'PIPE_MAIN использует только связные многосегментные маршруты с геометрическими признаками труб. Одиночные длинные штрихи, размерные линии и неоднозначные группы остаются в DETAIL_REVIEW.',
            'В 4.3.9 сложные многоветвевые компоненты дополнительно проверяются по топологии, длине, плотности, поворотам, чернилам и OCR; сильные чернила сами по себе не являются основанием для включения.',
            'Qwen-маршруты проходят проверку по исходным пикселям и добавляются в PIPE_MAIN только при подтверждении чернилами; остальные остаются в QWEN_REVIEW.',
            'Неотобранные LSD/Hough-отрезки сохранены на замороженном DETAIL_REVIEW.',
            'X-пересечения не объединяются автоматически; Т-подключения распознаются только при подтверждённом контакте окончания с внутренней частью штриха и достаточной поддержке исходными чернилами.',
            'OCR-рамки участвуют в маске геометрии даже при низкой уверенности текста; непрерывная труба через рамку сохраняется при подтверждении с обеих сторон.',
            'Подтверждённые подписи экспортируются как VERIFIED_TEXT; сомнительные OCR-чтения выводятся отдельно на замороженный TEXT_REVIEW.',
            'Плотные рукописные заметки повторно читаются построчно отдельным OCR-проходом.',
            'Проверьте трассы, повороты, размеры и подписи по оригиналу до использования чертежа.',
        ],
    }
    if not processing_complete:
        graph['warnings'].append(
            'CAD-РЕКОНСТРУКЦИЯ НЕПОЛНАЯ: не завершён полный проход Qwen OCR и/или трассировки труб. Файлы cad-draft.svg/dxf являются проверочным черновиком, а не готовым техническим документом. Файлы centerline-trace.svg/dxf сохраняют открытые осевые линии видимых исходных штрихов, а reference-trace.svg/dxf — их замкнутые контуры; ни один из этих вариантов не подтверждает инженерные соединения или типы оборудования. Успешные Qwen-плитки сохранены в .checkpoints; повторный запуск задания повторит незавершённые этапы.'
        )
        graph['warnings'].extend(str(reason) for reason in incomplete_reasons if reason)
    if not ocr_status.get('qwen', {}).get('available'):
        graph['warnings'].append(
            'Локальный Qwen OCR недоступен. Tesseract может дополнить чтение текста, но не заменяет Qwen для структурного распознавания и трассировки труб. Проверьте Ollama и модель Qwen3-VL.'
        )
    if not route_status.get('available') or not semantic_routes:
        graph['warnings'].append(
            'Локальный Qwen не предоставил пригодные маршруты. Основной PIPE_MAIN строится из подтверждённых геометрических путей OpenCV; сомнительные фрагменты остаются на проверке. Причина: '
            + str(route_status.get('error') or 'маршруты отсутствуют')
            + ' Действие: '
            + str(route_status.get('hint') or 'проверьте доступность Ollama и установленную модель Qwen3-VL.')
        )
    if not _cad_edge_chains(edges):
        graph['warnings'].append(
            'В графе OpenCV не осталось выбранных основных CAD-путей. Проверьте исходное изображение и слой DETAIL_REVIEW.'
        )
    if len(segments) >= 80 and (cad_selection.get('cad_primary_edges', 0) + len(primary_semantic_routes)) < max(
        12, int(len(segments) * 0.12)
    ):
        graph['warnings'].append(
            'Основная геометрия получилась разреженной: большинство штрихов оставлено на проверку. Не считайте чертёж полным; проверьте primary-overlay.png и text-region-mask.png.'
        )
    # Write the graph once before collecting artifact diagnostics so graph.json
    # is not incorrectly reported as missing, then persist diagnostics in both files.
    _atomic_write_text(Path(out_dir, 'graph.json'), json.dumps(graph, ensure_ascii=False, indent=2))
    diagnostics = build_pipeline_diagnostics(input_path, out_dir, graph)
    graph['diagnostics'] = diagnostics
    _atomic_write_text(Path(out_dir, 'diagnostics.json'), json.dumps(diagnostics, ensure_ascii=False, indent=2))
    _atomic_write_text(Path(out_dir, 'graph.json'), json.dumps(graph, ensure_ascii=False, indent=2))
    _progress('EXPORT', 'graph.json written; intermediate checkpoints retained')
    if processing_complete:
        _progress('JOB', 'Analysis completed successfully; selected OCR and pipe-tracing providers completed')
    else:
        _progress(
            'JOB', 'Analysis INCOMPLETE; partial exports are review-only. Re-run this job to retry incomplete local Qwen checkpoints.'
        )
    return graph


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--template', default=None, help='Optional reference sheet file; raster is used for page profile only')
    ap.add_argument(
        '--rotation',
        type=int,
        choices=[0, 90, 180, 270],
        default=None,
        help='Explicit clockwise page rotation in degrees; overrides unreliable handwriting orientation detection',
    )
    args = ap.parse_args()
    log.info(
        'Processor started',
        extra={
            'input': os.path.basename(args.input),
            'out': os.path.basename(args.out.rstrip('/')),
            'hasTemplate': bool(args.template),
            'rotation': args.rotation,
            'logLevel': os.getenv('LOG_LEVEL', 'INFO'),
        },
    )
    result = analyze(args.input, args.out, template_path=args.template, rotation_degrees=args.rotation)
    summary = result.get('summary') if isinstance(result, dict) else None
    log.info(
        'Processor finished',
        extra={
            'segments': (summary or {}).get('segment_candidates'),
            'edges': (summary or {}).get('cad_primary_edges'),
            'reviewEdges': (summary or {}).get('cad_review_edges'),
            'complete': (result or {}).get('complete') if isinstance(result, dict) else None,
            'timings': (result or {}).get('timings_ms') if isinstance(result, dict) else None,
        },
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
