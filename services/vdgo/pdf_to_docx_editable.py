# -*- coding: utf-8 -*-
"""Create a reflowable Word report with native editable text and tables.

Unlike the layout-preserving exporter, this module does NOT insert each page as a
background screenshot. It reconstructs PDF text as regular Word paragraphs/runs,
ruled tables as native Word tables, and keeps actual photos/scans/schematics as
separate pictures that can be moved/replaced. True scanned text inside a picture
is naturally still an image and must be replaced or OCRed separately.
"""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
from statistics import median
import re
import pymupdf as fitz
from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT, WD_CELL_VERTICAL_ALIGNMENT

from logging_setup import get_logger

log = get_logger('vdgo.docx')
from docx.oxml import OxmlElement
from docx.oxml.ns import qn

EMU_PER_PT = 12700

# Table conversion needs source text positions repeatedly. Re-reading the full PDF
# text dictionary for every cell is both wasteful and can stall large exports when
# this module is invoked from a long-lived backend process. Cache text-only blocks
# once per opened document/page; clear the cache at each conversion boundary.
_TEXT_BLOCK_CACHE: dict[tuple[int, int], list[dict]] = {}


def _text_blocks(page: fitz.Page) -> list[dict]:
    key = (id(page.parent), page.number)
    blocks = _TEXT_BLOCK_CACHE.get(key)
    if blocks is None:
        blocks = [block for block in page.get_text("dict").get("blocks", []) if block.get("type") == 0]
        _TEXT_BLOCK_CACHE[key] = blocks
    return blocks


def _font_name(pdf_name: str) -> str:
    name = (pdf_name or 'Carlito').casefold()
    if 'carlito' in name or 'calibri' in name:
        return 'Carlito'
    if 'times' in name or 'serif' in name:
        return 'Times New Roman'
    if 'courier' in name or 'mono' in name:
        return 'Courier New'
    if 'arial' in name or 'helvetica' in name or 'liberation sans' in name:
        return 'Arial'
    return 'Carlito'


def _set_cell_shading(cell, fill: str):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn('w:shd'))
    if shd is None:
        shd = OxmlElement('w:shd')
        tc_pr.append(shd)
    shd.set(qn('w:fill'), fill)


def _set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement('w:tblHeader')
    tbl_header.set(qn('w:val'), 'true')
    tr_pr.append(tbl_header)


def _set_cant_split_row(row):
    """Keep a table row intact when Word paginates a long report."""
    tr_pr = row._tr.get_or_add_trPr()
    cant_split = OxmlElement('w:cantSplit')
    tr_pr.append(cant_split)


def _set_table_borders(table, value='nil'):
    tbl_pr = table._tbl.tblPr
    old = tbl_pr.find(qn('w:tblBorders'))
    if old is not None:
        tbl_pr.remove(old)
    borders = OxmlElement('w:tblBorders')
    for edge in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        el = OxmlElement('w:' + edge)
        el.set(qn('w:val'), value)
        borders.append(el)
    tbl_pr.append(borders)


def _add_compact_signature_block(doc, page: fitz.Page, page_idx: int):
    """Rebuild absolute-positioned PDF signature blocks as editable aligned Word rows.

    Each signature value occupies its own row above the corresponding signature labels.
    This keeps the label/name baselines aligned even when the certificate needs several
    wrapped lines in the left cell.
    """
    if page_idx == 10:
        top_band, bottom_band = (455, 520), (540, 590)
        left_limit = 420
        table_widths = (355, 155)
    else:  # page_idx == 39, the final page of Appendix 12
        top_band, bottom_band = (545, 597), (610, 641)
        left_limit = 400
        table_widths = (365, 145)

    def collect(y_band, left_side):
        found = []
        for block in page.get_text('dict', sort=True).get('blocks', []):
            if block.get('type') != 0:
                continue
            for line in block.get('lines', []):
                rect = fitz.Rect(line.get('bbox', (0, 0, 0, 0)))
                if not (y_band[0] <= rect.y0 < y_band[1]):
                    continue
                text = ''.join(str(sp.get('text') or '') for sp in line.get('spans', [])).strip()
                if not text or text in ('Подпись', 'Ф.И.О.'):
                    continue
                if left_side and rect.x0 < left_limit:
                    found.append((rect.y0, text))
                elif not left_side and rect.x0 >= left_limit:
                    found.append((rect.y0, text))
        return [text for _y, text in sorted(found)]

    left_top = collect(top_band, True)
    right_top = collect(top_band, False)
    left_bottom = collect(bottom_band, True)
    right_bottom = collect(bottom_band, False)

    table = doc.add_table(rows=4, cols=2)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    _set_table_borders(table, 'nil')
    for ci, width in enumerate(table_widths):
        table.columns[ci].width = Pt(width)
        for ri in range(4):
            table.cell(ri, ci).width = Pt(width)
            table.cell(ri, ci).vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.TOP

    def estimated_lines(lines, width_pt):
        # Approximate line wrapping at the intended 9.5 pt font. The wider left
        # column often contains a long certificate that wraps while the right
        # column contains only a name; pad the right cell so signature rules
        # start on the same baseline in Word/LibreOffice.
        chars_per_line = max(12, int(width_pt / (9.5 * 0.49)))
        total = 0
        for line in lines:
            words = line.split()
            if not words:
                continue
            current = 0
            line_count = 1
            for word in words:
                extra = len(word) + (1 if current else 0)
                if current and current + extra > chars_per_line:
                    line_count += 1
                    current = len(word)
                else:
                    current += extra
            total += line_count
        return max(1, total)

    def fill_value(cell, lines, spacer_before=0, width_pt=300, pad_to_lines=None):
        cell.text = ''
        cleaned = [line for line in lines if line.strip()]
        for i, line in enumerate(cleaned):
            para = cell.paragraphs[0] if i == 0 else cell.add_paragraph()
            para.paragraph_format.space_before = Pt(spacer_before if i == 0 else 0)
            para.paragraph_format.space_after = Pt(0)
            para.paragraph_format.line_spacing = 1.0
            run = para.add_run(line)
            run.font.name = 'Carlito'
            run.font.size = Pt(9.5)
        if not cleaned:
            cell.paragraphs[0].paragraph_format.space_after = Pt(0)
        if pad_to_lines is not None:
            missing = max(0, pad_to_lines - estimated_lines(cleaned, width_pt))
            for _ in range(missing):
                para = cell.add_paragraph()
                para.paragraph_format.space_before = Pt(0)
                para.paragraph_format.space_after = Pt(0)
                para.paragraph_format.line_spacing = 1.0
                run = para.add_run('\u00a0')
                run.font.name = 'Carlito'
                run.font.size = Pt(9.5)

    def fill_signature(cell, label, gap_after=0):
        cell.text = ''
        p1 = cell.paragraphs[0]
        p1.paragraph_format.space_before = Pt(0)
        p1.paragraph_format.space_after = Pt(0)
        p1.paragraph_format.line_spacing = 1.0
        r1 = p1.add_run('________________________')
        r1.font.name = 'Carlito'; r1.font.size = Pt(8.2)
        p2 = cell.add_paragraph()
        p2.paragraph_format.space_before = Pt(0)
        p2.paragraph_format.space_after = Pt(gap_after)
        p2.paragraph_format.line_spacing = 1.0
        r2 = p2.add_run(label)
        r2.font.name = 'Carlito'; r2.font.size = Pt(8.2)

    left_top_lines = estimated_lines(left_top, table_widths[0])
    left_bottom_lines = estimated_lines(left_bottom, table_widths[0])
    fill_value(table.cell(0, 0), left_top, width_pt=table_widths[0])
    fill_value(table.cell(0, 1), right_top, width_pt=table_widths[1], pad_to_lines=left_top_lines)
    fill_signature(table.cell(1, 0), 'Подпись', gap_after=6)
    fill_signature(table.cell(1, 1), 'Ф.И.О.', gap_after=6)
    fill_value(table.cell(2, 0), left_bottom, width_pt=table_widths[0])
    fill_value(table.cell(2, 1), right_bottom, width_pt=table_widths[1], pad_to_lines=left_bottom_lines)
    fill_signature(table.cell(3, 0), 'Подпись')
    fill_signature(table.cell(3, 1), 'Ф.И.О.')

    for row in table.rows:
        _set_cant_split_row(row)
        for cell in row.cells:
            for para in cell.paragraphs:
                para.paragraph_format.keep_together = True
    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.space_after = Pt(0)
    spacer.paragraph_format.line_spacing = Pt(2)
    return table


def _set_run_from_span(run, span: dict):
    run.font.name = _font_name(str(span.get('font') or 'Carlito'))
    size = float(span.get('size') or 9.5)
    # Preserve the source font size. Clamp only malformed/absurd metadata.
    run.font.size = Pt(min(36.0, max(5.0, size)))
    flags = int(span.get('flags') or 0)
    font_label = str(span.get('font') or '').casefold()
    run.bold = bool(flags & 16 or 'bold' in font_label)
    run.italic = bool(flags & 2 or 'italic' in font_label)
    color = int(span.get('color') or 0)
    run.font.color.rgb = RGBColor((color >> 16) & 255, (color >> 8) & 255, color & 255)


def _append_line_paragraph(doc: Document, page_rect: fitz.Rect, line: dict,
                           previous_y: float | None = None):
    spans = [s for s in line.get('spans', []) if str(s.get('text') or '')]
    text = ''.join(str(s.get('text') or '') for s in spans)
    if not text.strip():
        return None
    bbox = fitz.Rect(line.get('bbox', (0, 0, 0, 0)))
    direction = line.get('dir', (1.0, 0.0))
    # Text that was rotated in a narrow PDF table header is converted to a normal
    # editable horizontal label in the reflowable version, avoiding overlapping letters.
    size = max((float(s.get('size') or 9.5) for s in spans), default=9.5)
    is_bold = any(int(s.get('flags') or 0) & 16 or 'bold' in str(s.get('font') or '').casefold() for s in spans)
    clean = text.strip()
    looks_like_heading = (size >= 15 or bool(re.match(r'^(Приложение\s+\d+|\d+(?:\.\d+)*\.?\s+[А-ЯЁ])', clean)))
    if looks_like_heading:
        p = doc.add_paragraph(style='Heading 1' if size >= 16 else 'Heading 2')
        p.paragraph_format.keep_with_next = True
    else:
        p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(2 if size < 13 else 4)
    p.paragraph_format.space_before = Pt(0)
    p.paragraph_format.line_spacing = 1.0
    center_x = (bbox.x0 + bbox.x1) / 2
    if abs(center_x - page_rect.width / 2) < 22 and (bbox.width > page_rect.width * 0.28 or size >= 14):
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    elif bbox.x0 > page_rect.width * 0.64:
        p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    else:
        p.alignment = WD_ALIGN_PARAGRAPH.LEFT
        # Retain a moderate indentation cue without carrying the fixed PDF coordinate
        # into Word as an enormous empty leading space.
        source_left_margin = 30.0
        indent_pt = max(0.0, min(190.0, bbox.x0 - source_left_margin))
        if indent_pt:
            p.paragraph_format.left_indent = Pt(indent_pt)
    for idx, span in enumerate(spans):
        run = p.add_run(str(span.get('text') or ''))
        _set_run_from_span(run, span)
    return p


def _page_tables(page: fitz.Page):
    try:
        found = page.find_tables(strategy='lines')
        return list(found.tables)
    except Exception as exc:
        # Ruled-line detection is the primary strategy; a page without ruling
        # falls back to the default detector. Losing every table silently would
        # silently flatten the report, so the fallback is recorded.
        log.debug('Ruled-table detection failed; using default detector', extra={'err': str(exc)})
        try:
            return list(page.find_tables().tables)
        except Exception as fallback_exc:
            log.warning('Table detection failed; page kept as text only', extra={'err': str(fallback_exc)})
            return []


def _line_inside_tables(line: dict, table_boxes: list[fitz.Rect]) -> bool:
    rect = fitz.Rect(line.get('bbox', (0, 0, 0, 0)))
    if rect.is_empty:
        return False
    area = max(0.01, rect.width * rect.height)
    for box in table_boxes:
        inter = rect & box
        if inter.is_empty:
            continue
        ratio = (inter.width * inter.height) / area
        cx, cy = (rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2
        if ratio >= 0.45 or box.contains(fitz.Point(cx, cy)):
            return True
    return False


def _span_style_for_rect(page: fitz.Page, rect: fitz.Rect | None, fallback_size: float):
    """Read the actual source typography for a Word table cell."""
    if rect is None:
        return {"size": float(fallback_size), "bold": False, "italic": False}
    candidates = []
    for block in _text_blocks(page):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not str(span.get("text") or "").strip():
                    continue
                sr = fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
                center = fitz.Point((sr.x0 + sr.x1) / 2, (sr.y0 + sr.y1) / 2)
                if rect.contains(center):
                    candidates.append(span)
    if not candidates:
        return {"size": float(fallback_size), "bold": False, "italic": False}
    sizes = sorted(float(sp.get("size") or fallback_size) for sp in candidates)
    weights = [sp for sp in candidates if int(sp.get("flags") or 0) & 16 or "bold" in str(sp.get("font") or "").casefold()]
    italics = [sp for sp in candidates if int(sp.get("flags") or 0) & 2 or "italic" in str(sp.get("font") or "").casefold()]
    return {
        "size": sizes[len(sizes) // 2],
        "bold": len(weights) > len(candidates) / 2,
        "italic": len(italics) > len(candidates) / 2,
    }


def _rebuild_missing_table_cell_text(page: fitz.Page, rect: fitz.Rect) -> str:
    """Recover selectable PDF text for cells the line-based extractor leaves empty.

    Complex PDF headers often use rotated labels and merged cells. The grid detector
    identifies the cell but its table extraction may report None. Those labels are
    recovered from the native text layer, never OCRed or converted into screenshots.
    """
    lines = []
    for block in _text_blocks(page):
        for line in block.get("lines", []):
            parts = []
            for span in line.get("spans", []):
                text = str(span.get("text") or "")
                if not text:
                    continue
                sr = fitz.Rect(span.get("bbox", (0, 0, 0, 0)))
                center = fitz.Point((sr.x0 + sr.x1) / 2, (sr.y0 + sr.y1) / 2)
                if rect.contains(center):
                    parts.append((sr.x0, text))
            if parts:
                parts.sort(key=lambda item: item[0])
                combined = "".join(text for _x, text in parts).strip()
                if combined:
                    lr = fitz.Rect(line.get("bbox", (0, 0, 0, 0)))
                    lines.append((round(lr.y0, 1), round(lr.x0, 1), combined))
    lines.sort()
    result = []
    for _y, _x, text in lines:
        if not result or result[-1] != text:
            result.append(text)
    # Rotated labels are often split into multiple spans/lines; join them as a normal
    # Word heading. A native editable Word table is more useful than reproducing rotation.
    return " ".join(result).strip()


def _table_to_word(doc: Document, page: fitz.Page, table_source, page_width: float, font_size: float):
    try:
        extracted = table_source.extract() or []
    except Exception as exc:
        # An unreadable table would otherwise become an empty Word table with no
        # trace: the operator sees missing content and no explanation.
        log.warning('Table content could not be extracted', extra={'err': str(exc), 'rows': len(getattr(table_source, 'rows', []) or [])})
        extracted = []
    raw_rows = [[str(v or '').replace('\x00', '').strip() for v in row] for row in extracted]
    source_cells = [list(getattr(row, 'cells', []) or []) for row in table_source.rows]
    row_count = max(len(raw_rows), len(source_cells))
    col_count = max(
        max((len(row) for row in raw_rows), default=0),
        max((len(row) for row in source_cells), default=0),
    )
    if not row_count or not col_count:
        return None

    # Pad extraction to a rectangular grid.
    while len(raw_rows) < row_count:
        raw_rows.append([])
    contents = [[raw_rows[ri][ci] if ci < len(raw_rows[ri]) else '' for ci in range(col_count)]
                for ri in range(row_count)]
    cell_rects = [[fitz.Rect(cell) if cell is not None else None
                   for cell in (source_cells[ri] + [None] * (col_count-len(source_cells[ri])))]
                  for ri in range(row_count)]

    # On the leak-results page, line detection sometimes incorrectly includes the explanatory
    # paragraph below the 2-row grid as a third table row. Preserve it as normal Word text.
    detached_paragraph = ''
    is_leak_table = (page.number == 8 and len(table_source.bbox) == 4
                     and float(table_source.bbox[1]) > 400
                     and any('Местоположение утечки' in cell for row in contents for cell in row))
    if is_leak_table and row_count >= 3:
        detached_paragraph = ' '.join(contents[2]).strip()
        row_count = 2
        contents = contents[:row_count]
        cell_rects = cell_rects[:row_count]
        # PyMuPDF's grid extractor occasionally attaches the result dash to the header cell.
        contents[0][2] = contents[0][2].replace('\n—', '').strip().rstrip('—').strip()
        if col_count > 2 and not contents[1][2].strip():
            contents[1][2] = '—'

    # Restore rotated/omitted labels where the PDF grid detector reports an empty cell.
    for ri in range(row_count):
        for ci in range(col_count):
            rect = cell_rects[ri][ci]
            if rect is not None and not contents[ri][ci].strip():
                contents[ri][ci] = _rebuild_missing_table_cell_text(page, rect)

    # Appendix 12's top metadata grid is visually a simple 3x2 table (label/value),
    # but some PDF grid detectors split the value cell into many false columns.
    # Rebuild that one known table explicitly so text is never squeezed into tiny columns.
    box = fitz.Rect(table_source.bbox)
    is_appendix12_metadata = (
        page.number == 38 and row_count == 3 and col_count >= 3
        and box.y0 < 180 and box.height < 70 and box.width > 400
    )
    if is_appendix12_metadata:
        meta = doc.add_table(rows=3, cols=2)
        meta.style = 'Table Grid'
        meta.alignment = WD_TABLE_ALIGNMENT.CENTER
        meta.autofit = False
        widths = (75.0, 435.0)
        for ci, width in enumerate(widths):
            meta.columns[ci].width = Pt(width)
            for ri in range(3):
                meta.cell(ri, ci).width = Pt(width)
                meta.cell(ri, ci).vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        labels = ('Заказчик', 'Адрес', 'Объект')
        y_bounds = []
        for ri in range(3):
            base = next((r for r in cell_rects[ri] if r is not None), None)
            if base is None:
                y_bounds.append((box.y0 + ri * box.height / 3, box.y0 + (ri + 1) * box.height / 3))
            else:
                y_bounds.append((base.y0, base.y1))
        for ri, label in enumerate(labels):
            y0, y1 = y_bounds[ri]
            left_rect = fitz.Rect(box.x0, y0, min(box.x0 + 72, box.x1), y1)
            value_rect = fitz.Rect(box.x0 + 72, y0, box.x1, y1)
            value = _rebuild_missing_table_cell_text(page, value_rect)
            if not value:
                vals = []
                for val in contents[ri][1:]:
                    val = str(val or '').strip()
                    if val and val not in vals and val != label:
                        vals.append(val)
                value = ' '.join(vals)
            for ci, text in enumerate((label, value)):
                cell = meta.cell(ri, ci)
                cell.text = text
                for para in cell.paragraphs:
                    para.paragraph_format.space_before = Pt(0)
                    para.paragraph_format.space_after = Pt(0)
                    para.paragraph_format.line_spacing = 1.0
                    para.alignment = WD_ALIGN_PARAGRAPH.LEFT if ci == 0 else WD_ALIGN_PARAGRAPH.CENTER
                    for run in para.runs:
                        run.font.name = 'Carlito'
                        run.font.size = Pt(9.8)
            for cell in meta.rows[ri].cells:
                cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            _set_cant_split_row(meta.rows[ri])
        spacer = doc.add_paragraph()
        spacer.paragraph_format.space_before = Pt(0)
        spacer.paragraph_format.space_after = Pt(0)
        spacer.paragraph_format.line_spacing = Pt(2)
        return meta

    tbl = doc.add_table(rows=row_count, cols=col_count)
    tbl.style = 'Table Grid'
    tbl.alignment = WD_TABLE_ALIGNMENT.CENTER
    tbl.autofit = True
    cell_styles = {}
    for ri in range(row_count):
        for ci in range(col_count):
            cell = tbl.cell(ri, ci)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            cell.text = contents[ri][ci]
            style = _span_style_for_rect(page, cell_rects[ri][ci], font_size)
            cell_styles[(ri, ci)] = style
            for para in cell.paragraphs:
                para.paragraph_format.space_before = Pt(0)
                para.paragraph_format.space_after = Pt(0)
                para.paragraph_format.line_spacing = 1.0
                for run in para.runs:
                    run.font.name = 'Carlito'
                    # Preserve the actual source cell size. The previous global clamp to
                    # 10.5 pt made inserted numbers and labels smaller than adjacent text.
                    run.font.size = Pt(min(36.0, max(5.0, style['size'])))
                    run.bold = bool(style['bold'] or ri == 0)
                    run.italic = bool(style['italic'])

    # Generic native Word tables should retain the source column proportions. Auto-fit
    # could expand one column to its longest text and force another over the page edge.
    # Use median non-merged cell widths from the measured PDF grid, scaled to the 510 pt
    # printable width of the DOCX page.
    tbl.autofit = False
    table_box = fitz.Rect(table_source.bbox)
    measured_widths = []
    for ci in range(col_count):
        samples = [cell_rects[ri][ci].width for ri in range(row_count)
                   if cell_rects[ri][ci] is not None and cell_rects[ri][ci].width > 1.0]
        # A merged header can span several columns, so a median is more robust than using
        # just the first row's cell width.
        measured_widths.append(float(median(samples)) if samples else 0.0)
    if not any(width > 0 for width in measured_widths):
        measured_widths = [1.0] * col_count
    else:
        fallback = median([w for w in measured_widths if w > 0])
        measured_widths = [w if w > 0 else fallback for w in measured_widths]
    total_width = sum(measured_widths) or float(col_count)
    target_width = 510.0
    widths_pt = [target_width * width / total_width for width in measured_widths]
    # Keep width rounding deterministic and ensure the table sums to exactly the printable width.
    if widths_pt:
        widths_pt[-1] = target_width - sum(widths_pt[:-1])
    for ci, width_pt in enumerate(widths_pt):
        tbl.columns[ci].width = Pt(width_pt)
        for ri in range(row_count):
            tbl.cell(ri, ci).width = Pt(width_pt)
    for row in tbl.rows:
        _set_cant_split_row(row)

    # The 5.4 valve table has a genuine two-row header: four subcolumns belong to the
    # "Parameters" heading, while first/second-level headings span two rows. Apply only
    # these source-confirmed merges (not a generic merge across every missing cell).
    is_valve_table = (
        page.number == 8 and row_count == 5 and col_count == 8
        and contents[0][0].strip().casefold() == 'место установки'
        and 'Параметры' in contents[0][3]
    )
    if is_valve_table:
        try:
            # Source columns have materially different widths. Equal-width Word columns
            # force the final heading "Заключение" to break and make adjacent headers
            # wrap awkwardly. Use measured, reader-friendly widths while preserving the
            # overall printable width of an A4 page with 1.5 cm margins.
            valve_widths_pt = [58, 54, 58, 63, 67, 67, 80, 63]  # total 510 pt
            tbl.autofit = False
            for ci, width_pt in enumerate(valve_widths_pt):
                tbl.columns[ci].width = Pt(width_pt)
                for ri in range(row_count):
                    tbl.cell(ri, ci).width = Pt(width_pt)
            # Canonical labels repair line breaks introduced by the PDF's vertical
            # text extraction. They remain editable native Word text, not images.
            canonical = {
                (0, 0): 'Место установки',
                (0, 1): 'Условный проход Ду, мм',
                (0, 2): 'Тип запорной арматуры',
                (0, 3): 'Параметры, подлежащие контролю',
                (0, 7): 'Заключение',
                (1, 3): 'Состояние наружной поверхности',
                (1, 4): 'Наружная герметичность',
                (1, 5): 'Внутренняя герметичность',
                (1, 6): 'Проверка работоспособности',
            }
            for (ri, ci), label in canonical.items():
                tbl.cell(ri, ci).text = label
                for para in tbl.cell(ri, ci).paragraphs:
                    para.paragraph_format.space_before = Pt(0)
                    para.paragraph_format.space_after = Pt(0)
                    for run in para.runs:
                        run.font.name = 'Carlito'
                        # Vertical PDF column headings become normal editable horizontal
                        # labels in Word. Use 9 pt for subcolumns and 9.5 pt for main
                        # headings so complete words fit instead of breaking mid-word.
                        if (ri, ci) == (0, 3):
                            run.font.size = Pt(10.2)
                        elif ri == 0:
                            run.font.size = Pt(9.5)
                        else:
                            run.font.size = Pt(8.2)
                        run.bold = True
            tbl.cell(0, 3).merge(tbl.cell(0, 6))
            for col in (0, 1, 2, 7):
                tbl.cell(0, col).merge(tbl.cell(1, col))
            p = tbl.cell(0, 3).paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        except Exception as exc:
            # Keep the editable rectangular table if a Word engine rejects a merge.
            log.debug('Word rejected a header merge; keeping the rectangular grid', extra={'err': str(exc)})

    # Keep the detected native grid rectangular. PyMuPDF can return None both for merged
    # source cells and for line-detection gaps; merging every None placeholder can collapse
    # unrelated rows into one large Word cell. The grid remains fully editable and avoids
    # destructive false merges. Cell text and per-cell source typography are preserved above.

    # Repeat Appendix 12's two-line table header if Word needs to paginate the table.
    if page.number in (38, 39) and row_count >= 2 and col_count == 3:
        _set_repeat_table_header(tbl.rows[0])
        _set_repeat_table_header(tbl.rows[1])

    if detached_paragraph:
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Pt(18)
        p.paragraph_format.right_indent = Pt(4)
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.space_after = Pt(5)
        p.paragraph_format.line_spacing = 1.0
        run = p.add_run(detached_paragraph)
        run.font.name = 'Carlito'
        # This paragraph is 12 pt in the source PDF; keep it at a readable body size.
        run.font.size = Pt(12.0)

    spacer = doc.add_paragraph()
    spacer.paragraph_format.space_after = Pt(2)
    spacer.paragraph_format.space_before = Pt(0)
    spacer.paragraph_format.line_spacing = Pt(2)
    return tbl


def _add_image(doc: Document, image_block: dict, temp_dir: Path, page_num: int, img_index: int):
    blob = image_block.get('image')
    if not blob:
        return
    ext = re.sub(r'[^a-zA-Z0-9]', '', str(image_block.get('ext') or 'png')).lower() or 'png'
    path = temp_dir / f'p{page_num:02d}_image{img_index:03d}.{ext}'
    path.write_bytes(blob)
    rect = fitz.Rect(image_block.get('bbox', (0, 0, 300, 200)))
    # Preserve small photos as pictures but cap large scanned sheets to printable width.
    width_cm = min(16.5, max(3.0, rect.width / 72.0 * 2.54))
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER if rect.width > 250 else WD_ALIGN_PARAGRAPH.LEFT
    p.paragraph_format.space_before = Pt(3)
    p.paragraph_format.space_after = Pt(6)
    run = p.add_run()
    try:
        run.add_picture(str(path), width=Cm(width_cm))
    except Exception as exc:
        # Unsupported/invalid image blocks should not make the entire report fail,
        # but dropping a photo without a trace hides real document loss.
        log.warning('Image could not be embedded; paragraph removed', extra={'err': str(exc), 'file': Path(str(path)).name[:180]})
        p._element.getparent().remove(p._element)


def pdf_to_docx_editable(pdf_path, docx_path):
    """Build a semantic Word document with regular editable paragraphs/tables."""
    pdf_path, docx_path = Path(pdf_path), Path(docx_path)
    docx_path.parent.mkdir(parents=True, exist_ok=True)
    _TEXT_BLOCK_CACHE.clear()
    with fitz.open(pdf_path) as src, __import__('tempfile').TemporaryDirectory(prefix='vdgo_word_native_') as tmp:
        doc = Document()
        sec = doc.sections[0]
        sec.page_width = Cm(21.0)
        sec.page_height = Cm(29.7)
        sec.top_margin = Cm(1.5)
        sec.bottom_margin = Cm(1.5)
        sec.left_margin = Cm(1.5)
        sec.right_margin = Cm(1.5)
        normal = doc.styles['Normal']
        normal.font.name = 'Carlito'
        normal.font.size = Pt(10)
        normal.paragraph_format.space_after = Pt(2)
        normal.paragraph_format.line_spacing = 1.0
        for style_name in ('Heading 1', 'Heading 2'):
            style = doc.styles[style_name]
            style.font.name = 'Carlito'
            style.font.color.rgb = RGBColor(31, 55, 82)
        doc.core_properties.title = 'Заключение ВДГО — полностью редактируемый Word'
        doc.core_properties.subject = 'Текст и табличные значения преобразованы в редактируемые элементы Word; изображения вложены отдельно'
        doc.core_properties.author = 'Конструктор заключения ВДГО'
        doc.core_properties.comments = (
            'Редактируемая версия: текст и таблицы доступны для обычного редактирования. '
            'Фотографии, схемы и подлинные сканы остаются отдельными изображениями. '
            'Вёрстка и количество страниц могут отличаться от исходного PDF.'
        )
        tmp_path = Path(tmp)
        page_count = len(src)
        for page_idx, page in enumerate(src):
            if page_idx:
                doc.add_page_break()
            page_dict = page.get_text('dict', sort=True)
            page_rect = page.rect
            source_blocks = page_dict.get('blocks', [])
            images = [b for b in source_blocks if b.get('type') == 1 and b.get('image')]
            tables = _page_tables(page)
            # The cover's director approval block can resemble a 2x3 table to line
            # detection, but it is a signature area, not a real tabular structure.
            if page_idx == 0:
                tables = []
            else:
                filtered_tables = []
                for candidate in tables:
                    box = fitz.Rect(candidate.bbox)
                    try:
                        raw_rows = candidate.extract() or []
                        max_cols = max((len(row or []) for row in raw_rows), default=0)
                        nonempty = sum(1 for row in raw_rows for value in (row or []) if str(value or '').strip())
                    except Exception as exc:
                        log.debug('Table candidate could not be inspected', extra={'err': str(exc)})
                        max_cols, nonempty = 0, 0
                    # Discard spurious detections that are only a few underline segments.
                    if box.width >= 100 and box.height >= 18 and len(raw_rows) >= 2 and max_cols >= 2 and nonempty >= 4:
                        filtered_tables.append(candidate)
                tables = filtered_tables
            table_boxes = [fitz.Rect(t.bbox) for t in tables]
            items = []
            # Appendix 12's two source lines form one continuous heading. In Word,
            # preserving them as separate paragraphs can strand the word "при" on
            # its own line, so rebuild them as one centered native paragraph.
            if page_idx == 38:
                items.append((62.0, 0.0, 'appendix12_heading',
                              'Согласованные мероприятия по устранению неисправностей, выявленных при проведении технического диагностирования',
                              12.0, 0))
            # Add native Word tables, not flattened table screenshots.
            for ti, table in enumerate(tables):
                bbox = fitz.Rect(table.bbox)
                try:
                    extracted = table.extract() or []
                    cells = [str(v or '') for row in extracted for v in row]
                    text_sizes = []
                    for block in source_blocks:
                        if block.get('type') != 0:
                            continue
                        br = fitz.Rect(block.get('bbox', (0, 0, 0, 0)))
                        if br.intersects(bbox):
                            for ln in block.get('lines', []):
                                for sp in ln.get('spans', []):
                                    if sp.get('text'):
                                        text_sizes.append(float(sp.get('size') or 8.0))
                    fsize = sorted(text_sizes)[len(text_sizes)//2] if text_sizes else 8.2
                except Exception as exc:
                    log.debug('Font size detection failed; using default', extra={'err': str(exc)})
                    fsize = 8.2
                items.append((bbox.y0, bbox.x0, 'table', table, fsize, ti))
            # Signatures are absolute-positioned two-column blocks in the PDF. Rebuild them
            # as an editable Word table rather than flowing every label/name into separate lines.
            signoff_band = (455, 625) if page_idx == 10 else ((540, 665) if page_idx == 39 else None)
            if signoff_band:
                items.append((signoff_band[0], 0, 'signoff', page, 0, page_idx))
            # Native text lines outside detected grid tables remain ordinary Word paragraphs.
            for block in source_blocks:
                if block.get('type') != 0 or 'lines' not in block:
                    continue
                for line in block.get('lines', []):
                    spans = [sp for sp in line.get('spans', []) if str(sp.get('text') or '')]
                    if not spans or not ''.join(str(sp.get('text') or '') for sp in spans).strip():
                        continue
                    if _line_inside_tables(line, table_boxes):
                        continue
                    lr = fitz.Rect(line.get('bbox', (0, 0, 0, 0)))
                    line_text = ''.join(str(sp.get('text') or '') for sp in spans).strip()
                    if page_idx == 38 and (line_text.startswith('Согласованные мероприятия по устранению неисправностей, выявленных при') or line_text.startswith('проведении технического диагностирования')):
                        continue
                    if signoff_band and signoff_band[0] <= lr.y0 < signoff_band[1]:
                        continue
                    # Avoid duplicating OCR text that is already baked into a scanned picture.
                    if any((ir := fitz.Rect(im.get('bbox', (0, 0, 0, 0)))).contains(fitz.Point((lr.x0+lr.x1)/2, (lr.y0+lr.y1)/2)) for im in images):
                        continue
                    items.append((lr.y0, lr.x0, 'line', line, 0, 0))
            # Embedded images/photos/scans remain independent Word image objects, not full-page snapshots.
            for im_idx, image in enumerate(images):
                ir = fitz.Rect(image.get('bbox', (0, 0, 0, 0)))
                items.append((ir.y0, ir.x0, 'image', image, 0, im_idx))
            items.sort(key=lambda it: (round(it[0], 1), round(it[1], 1), {'line': 0, 'table': 1, 'image': 2}.get(it[2], 3)))
            for _y, _x, kind, payload, fsize, ix in items:
                if kind == 'line':
                    _append_line_paragraph(doc, page_rect, payload)
                elif kind == 'table':
                    _table_to_word(doc, page, payload, page_rect.width, fsize)
                elif kind == 'image':
                    _add_image(doc, payload, tmp_path, page_idx + 1, ix)
                elif kind == 'signoff':
                    _add_compact_signature_block(doc, payload, ix)
                elif kind == 'appendix12_heading':
                    p = doc.add_paragraph()
                    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                    p.paragraph_format.space_before = Pt(2)
                    p.paragraph_format.space_after = Pt(4)
                    p.paragraph_format.line_spacing = 1.0
                    p.paragraph_format.keep_with_next = True
                    run = p.add_run(payload)
                    run.font.name = 'Carlito'
                    run.font.size = Pt(12.0)
                    run.bold = True
        doc.save(docx_path)
    return page_count


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='PDF → редактируемый текст/таблицы Word')
    parser.add_argument('pdf')
    parser.add_argument('docx')
    args = parser.parse_args()
    print(f'Обработано страниц: {pdf_to_docx_editable(args.pdf, args.docx)}')
