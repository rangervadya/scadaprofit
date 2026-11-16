"""Post-layout quality checks for the printable CAD sheet.

This is a drafting/readability report, not an engineering approval. It never
changes geometry or upgrades an unverified object to a confirmed state.
"""
from __future__ import annotations

from typing import Any


def _overlaps(a: dict[str, Any], b: dict[str, Any], gap: float = 1.5) -> bool:
    try:
        ax, ay, aw, ah = (float(a[k]) for k in ("x", "y", "w", "h"))
        bx, by, bw, bh = (float(b[k]) for k in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return False
    return not (ax + aw + gap <= bx or bx + bw + gap <= ax or
                ay + ah + gap <= by or by + bh + gap <= ay)


def validate_clean_layout(layout: dict[str, Any], engineering_report: dict[str, Any] | None = None) -> dict[str, Any]:
    pipes = list(layout.get("pipes") or [])
    review_pipes = list(layout.get("reviewPipes") or [])
    symbols = list(layout.get("symbols") or [])
    dimensions = list(layout.get("dimensions") or [])
    labels = list(layout.get("labels") or [])
    tags = list(layout.get("sectionTags") or [])
    findings: list[dict[str, Any]] = []

    def add(code: str, severity: str, message: str, target_ids: list[str] | None = None) -> None:
        findings.append({"id": f"DQ{len(findings) + 1}", "code": code, "severity": severity,
                         "message": message, "targetIds": target_ids or []})

    if not pipes:
        add("no_primary_pipe_geometry", "error", "В чистовой модели нет подтверждённых трубных маршрутов.")
    if review_pipes:
        add("review_geometry_present", "review", f"На слое проверки остаётся {len(review_pipes)} неподтверждённых трасс.")

    unknown_symbols = [item for item in symbols if not item.get("type")]
    if unknown_symbols:
        add("unclassified_symbols", "review", f"Не классифицировано условных обозначений: {len(unknown_symbols)}.",
            [str(item.get("id") or "") for item in unknown_symbols[:50]])

    unassigned_dimensions = [item for item in dimensions if not item.get("targetId")]
    if unassigned_dimensions:
        add("unassigned_dimensions", "review", f"Размеров без привязки к объекту: {len(unassigned_dimensions)}.",
            [str(item.get("id") or "") for item in unassigned_dimensions[:50]])
    dimensions_without_graphic = [item for item in dimensions if item.get("targetId") and not item.get("graphic")]
    if dimensions_without_graphic:
        add("dimension_graphic_missing", "warning", f"Для {len(dimensions_without_graphic)} размеров не построена размерная линия; оставлена только подпись.",
            [str(item.get("id") or "") for item in dimensions_without_graphic[:50]])

    boxes: list[tuple[str, dict[str, Any]]] = []
    for item in labels:
        if isinstance(item.get("layoutBBox"), dict):
            boxes.append((str(item.get("id") or "label"), item["layoutBBox"]))
    for item in dimensions:
        if isinstance(item.get("layoutBBox"), dict):
            boxes.append((str(item.get("id") or "dimension"), item["layoutBBox"]))
    for item in tags:
        if isinstance(item.get("bbox"), dict):
            boxes.append((str(item.get("id") or "section-tag"), item["bbox"]))

    collisions: list[tuple[str, str]] = []
    for index, (left_id, left_box) in enumerate(boxes):
        for right_id, right_box in boxes[index + 1:]:
            if _overlaps(left_box, right_box):
                collisions.append((left_id, right_id))
    if collisions:
        add("annotation_collisions", "warning",
            f"Обнаружено возможное наложение текстовых блоков или номеров: {len(collisions)} пар.",
            [value for pair in collisions[:25] for value in pair])

    generated_tags = [item for item in tags if item.get("requiresConfirmation")]
    if generated_tags:
        add("provisional_section_numbers", "review",
            f"Автоматически предложено номеров участков: {len(generated_tags)}. Подтвердите последовательность.",
            [str(item.get("id") or "") for item in generated_tags[:50]])

    calibration = layout.get("scaleCalibration") or {}
    if calibration.get("status") == "conflicting_dimensions":
        add("conflicting_scale_dimensions", "review", "Подтверждённые размеры противоречат друг другу; единый масштаб не назначен.")
    elif calibration.get("status") == "single_dimension_reference":
        add("single_reference_scale", "review", "Масштаб рассчитан по одному размеру; проверьте его по независимому измерению.")
    elif calibration.get("status") == "not_calibrated":
        add("scale_not_calibrated", "warning", "Физический масштаб не установлен: на листе сохраняется схематическое масштабирование.")

    area = layout.get("drawingArea") or {}
    overflow = []
    try:
        left, top = float(area["x"]), float(area["y"])
        right, bottom = left + float(area["w"]), top + float(area["h"])
        for pipe in pipes:
            for point in pipe.get("geometry") or []:
                if float(point[0]) < left - 0.5 or float(point[0]) > right + 0.5 or float(point[1]) < top - 0.5 or float(point[1]) > bottom + 0.5:
                    overflow.append(str(pipe.get("id") or ""))
                    break
    except (KeyError, TypeError, ValueError):
        pass
    if overflow:
        add("geometry_outside_drawing_area", "error", "Часть основной геометрии выходит за рабочую область листа.", list(dict.fromkeys(overflow)))

    engineering = engineering_report or {}
    engineering_counts = engineering.get("counts") or {}
    engineering_errors = int(engineering_counts.get("error", 0) or 0)
    engineering_reviews = int(engineering_counts.get("review", 0) or 0)
    engineering_warnings = int(engineering_counts.get("warning", 0) or 0)
    if engineering_errors or engineering_reviews or engineering_warnings:
        add("engineering_validation_findings", "review",
            f"Инженерная проверка: ошибок {engineering_errors}, замечаний {engineering_reviews}, предупреждений {engineering_warnings}.")

    counts = {
        "primaryPipes": len(pipes), "reviewPipes": len(review_pipes),
        "symbols": len(symbols), "unclassifiedSymbols": len(unknown_symbols),
        "dimensions": len(dimensions), "unassignedDimensions": len(unassigned_dimensions),
        "labels": len(labels), "sectionTags": len(tags),
        "provisionalSectionTags": len(generated_tags), "annotationCollisions": len(collisions),
        "geometryOverflow": len(overflow),
    }
    has_errors = any(item["severity"] == "error" for item in findings)
    has_review = any(item["severity"] in {"review", "warning"} for item in findings)
    status = "blocked" if has_errors else ("needs_review" if has_review or layout.get("reviewOnly") else "draft_ready")
    return {
        "schema": "cad-drawing-quality/1.0", "status": status,
        "engineeringApproval": "required",
        "message": "Статус оценивает оформление листа и полноту данных; он не является допуском к эксплуатации или инженерным согласованием.",
        "counts": counts, "findings": findings,
        "automatedChangesToGeometry": 0,
    }
