# -*- coding: utf-8 -*-
"""Convert generated PDF to an editable, page-faithful DOCX.

Text from PDF text objects is rebuilt as editable Word text boxes. Images are
reinserted as separate floating Word pictures; vector artwork/table rules remain
in a per-page background image with text and embedded images removed. Therefore
the DOCX is not a stack of screenshots: regular PDF text is editable in Word.
Text inside genuinely scanned source images remains part of that scan and needs
OCR/replacement if it must be edited.
"""
from __future__ import annotations

from pathlib import Path
import tempfile
import pymupdf as fitz
from docx import Document
from docx.shared import Cm, Pt
from docx.oxml import OxmlElement
from docx.oxml.ns import qn, nsmap

EMU_PER_PT = 12700
VML_NS = 'urn:schemas-microsoft-com:vml'
OFFICE_NS = 'urn:schemas-microsoft-com:office:office'
# python-docx knows the standard Word namespaces; add VML namespaces for editable textboxes.
nsmap['v'] = VML_NS
nsmap['o'] = OFFICE_NS


def _shape_id(i: int) -> str:
    return f'VDGO_Text_{i:05d}'


def _anchor_picture(run, x_pt: float, y_pt: float, *, width_pt: float, height_pt: float,
                    behind: bool = False, relative_height: int = 251657000):
    """Convert python-docx's inline picture to a page-positioned DrawingML anchor."""
    drawing = run._r.find(qn('w:drawing'))
    if drawing is None:
        return
    inline = drawing.find(qn('wp:inline'))
    if inline is None:
        return
    anchor = OxmlElement('wp:anchor')
    attrs = {
        'distT': '0', 'distB': '0', 'distL': '0', 'distR': '0',
        'simplePos': '0', 'relativeHeight': str(0 if behind else relative_height),
        'behindDoc': '1' if behind else '0', 'locked': '0',
        'layoutInCell': '1', 'allowOverlap': '1',
    }
    for key, value in attrs.items():
        anchor.set(key, value)

    simple = OxmlElement('wp:simplePos')
    simple.set('x', '0'); simple.set('y', '0')
    anchor.append(simple)
    for tag, offset in (('wp:positionH', x_pt), ('wp:positionV', y_pt)):
        pos = OxmlElement(tag)
        pos.set('relativeFrom', 'page')
        pos_offset = OxmlElement('wp:posOffset')
        pos_offset.text = str(int(offset * EMU_PER_PT))
        pos.append(pos_offset)
        anchor.append(pos)

    extent = OxmlElement('wp:extent')
    extent.set('cx', str(int(width_pt * EMU_PER_PT)))
    extent.set('cy', str(int(height_pt * EMU_PER_PT)))
    anchor.append(extent)
    effect = OxmlElement('wp:effectExtent')
    for side in ('l', 't', 'r', 'b'):
        effect.set(side, '0')
    anchor.append(effect)
    anchor.append(OxmlElement('wp:wrapNone'))

    # Keep existing docPr and graphic frame settings; the graphic relation remains valid.
    docpr = inline.find(qn('wp:docPr'))
    if docpr is not None:
        anchor.append(docpr)
    frame = inline.find(qn('wp:cNvGraphicFramePr'))
    if frame is not None:
        anchor.append(frame)
    graphic = inline.find(qn('a:graphic'))
    if graphic is not None:
        anchor.append(graphic)
    drawing.replace(inline, anchor)


def _font_family(span: dict) -> str:
    name = str(span.get('font') or 'Arial')
    low = name.casefold()
    if 'carlito' in low or 'calibri' in low:
        return 'Carlito'
    if 'arial' in low or 'liberation sans' in low or 'helvetica' in low:
        return 'Arial'
    if 'times' in low or 'serif' in low:
        return 'Times New Roman'
    if 'courier' in low or 'mono' in low:
        return 'Courier New'
    return name.split(',')[0][:48] or 'Arial'


def _append_editable_textbox(run, shape_number: int, x: float, y: float, width: float,
                             height: float, spans: list[dict], rotation: int = 0):
    """Append an absolutely-positioned VML textbox containing real w:r/w:t text runs."""
    pict = OxmlElement('w:pict')
    shape_type = OxmlElement('v:shapetype')
    shape_type.set('id', '_x0000_t202')
    shape_type.set('coordsize', '21600,21600')
    shape_type.set(qn('o:spt'), '202')
    shape_type.set('path', 'm,l,21600r21600,l21600,xe')
    stroke = OxmlElement('v:stroke'); stroke.set('joinstyle', 'miter'); shape_type.append(stroke)
    path = OxmlElement('v:path'); path.set('gradientshapeok', 't'); path.set(qn('o:connecttype'), 'rect'); shape_type.append(path)
    pict.append(shape_type)
    shape = OxmlElement('v:shape')
    shape.set('id', _shape_id(shape_number))
    shape.set('type', '#_x0000_t202')
    # PDF bbox describes the final visible bounds. For rotated VML shapes, Word
    # rotates around the shape centre, so swap dimensions and re-centre the box.
    # This keeps vertical table headers readable/editable instead of stacking every
    # character on top of the next one.
    if rotation:
        visible_w, visible_h = float(width), float(height)
        center_x, center_y = float(x) + visible_w / 2, float(y) + visible_h / 2
        width, height = visible_h, visible_w
        x, y = center_x - width / 2, center_y - height / 2
    rotation_style = f'rotation:{int(rotation)};' if rotation else ''
    shape.set('style',
        f'position:absolute;margin-left:{x:.3f}pt;margin-top:{y:.3f}pt;'
        f'width:{max(1.0, width):.3f}pt;height:{max(1.0, height):.3f}pt;'
        f'{rotation_style}'
        'z-index:251658240;mso-wrap-style:none;'
        'mso-position-horizontal-relative:page;mso-position-vertical-relative:page')
    shape.set('filled', 'f'); shape.set('stroked', 'f')

    textbox = OxmlElement('v:textbox')
    textbox.set('inset', '0,0,0,0')
    content = OxmlElement('w:txbxContent')
    paragraph = OxmlElement('w:p')
    ppr = OxmlElement('w:pPr')
    spacing = OxmlElement('w:spacing')
    spacing.set(qn('w:before'), '0'); spacing.set(qn('w:after'), '0')
    spacing.set(qn('w:line'), '100'); spacing.set(qn('w:lineRule'), 'exact')
    ppr.append(spacing)
    paragraph.append(ppr)

    previous = None
    for span in spans:
        text = str(span.get('text') or '')
        if not text:
            continue
        # PDF spans sometimes split runs by font. Preserve word gaps between adjacent styled runs.
        if previous is not None:
            prev_text, prev_box, prev_size = previous
            curr_box = fitz.Rect(span['bbox'])
            gap = curr_box.x0 - prev_box.x1
            if (gap > max(0.6, prev_size * 0.12)
                    and not prev_text[-1:].isspace() and not text[:1].isspace()):
                space_run = OxmlElement('w:r')
                srpr = OxmlElement('w:rPr')
                fonts = OxmlElement('w:rFonts')
                font = _font_family(span)
                for attr in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
                    fonts.set(qn('w:' + attr), font)
                srpr.append(fonts)
                sz = OxmlElement('w:sz'); sz.set(qn('w:val'), str(max(2, int(round(float(span.get('size', 8)) * 2)))))
                srpr.append(sz); space_run.append(srpr)
                space = OxmlElement('w:t'); space.text = ' '; space.set(qn('xml:space'), 'preserve')
                space_run.append(space); paragraph.append(space_run)

        r = OxmlElement('w:r')
        rpr = OxmlElement('w:rPr')
        font = _font_family(span)
        fonts = OxmlElement('w:rFonts')
        for attr in ('ascii', 'hAnsi', 'eastAsia', 'cs'):
            fonts.set(qn('w:' + attr), font)
        rpr.append(fonts)
        font_size = max(1, int(round(float(span.get('size', 8.0)) * 2)))
        for tag in ('w:sz', 'w:szCs'):
            el = OxmlElement(tag); el.set(qn('w:val'), str(font_size)); rpr.append(el)
        flags = int(span.get('flags', 0))
        font_name = str(span.get('font') or '')
        if flags & 16 or 'Bold' in font_name or 'bold' in font_name.casefold():
            rpr.append(OxmlElement('w:b'))
        if flags & 2 or 'Italic' in font_name or 'italic' in font_name.casefold():
            rpr.append(OxmlElement('w:i'))
        color = int(span.get('color', 0))
        color_el = OxmlElement('w:color')
        color_el.set(qn('w:val'), f'{(color >> 16) & 255:02X}{(color >> 8) & 255:02X}{color & 255:02X}')
        rpr.append(color_el)
        r.append(rpr)
        t = OxmlElement('w:t')
        t.text = text
        if text[:1].isspace() or text[-1:].isspace():
            t.set(qn('xml:space'), 'preserve')
        r.append(t)
        paragraph.append(r)
        previous = (text, fitz.Rect(span['bbox']), float(span.get('size', 8.0)))

    content.append(paragraph)
    textbox.append(content)
    shape.append(textbox)
    pict.append(shape)
    run._r.append(pict)


def _text_lines(page_dict: dict):
    lines = []
    for block in page_dict.get('blocks', []):
        if block.get('type') != 0 or 'lines' not in block:
            continue
        for line in block.get('lines', []):
            spans = [dict(s) for s in line.get('spans', []) if str(s.get('text') or '')]
            if not spans or not ''.join(s['text'] for s in spans).strip():
                continue
            rect = fitz.Rect(line['bbox'])
            direction = line.get('dir', (1.0, 0.0))
            dx, dy = float(direction[0]), float(direction[1])
            # Rotated PDF column headings are still regular, editable text in Word.
            # Convert their direction into a rotated textbox instead of allowing the
            # narrow original bbox to wrap every character onto a separate line.
            if abs(dx) < abs(dy):
                rotation = 270 if dy < 0 else 90
            else:
                rotation = 0
            lines.append((rect, spans, rotation))
    lines.sort(key=lambda item: (round(item[0].y0, 2), round(item[0].x0, 2)))
    return lines


def _image_blocks(page_dict: dict):
    images = []
    for block in page_dict.get('blocks', []):
        if block.get('type') != 1 or not block.get('image'):
            continue
        item = dict(block)
        item['bbox_rect'] = fitz.Rect(block['bbox'])
        images.append(item)
    images.sort(key=lambda b: (round(b['bbox_rect'].y0, 2), round(b['bbox_rect'].x0, 2)))
    return images


def _create_graphics_background(src: fitz.Document, index: int, lines, images, out_path: Path, dpi: int):
    """Render only vector artwork/background; all extractable text and image objects are removed."""
    bg_doc = fitz.open()
    bg_doc.insert_pdf(src, from_page=index, to_page=index)
    page = bg_doc[0]
    for rect, _spans, rotation in lines:
        # Every selectable text line, including vertical/rotated table labels, is removed
        # from the artwork layer and rebuilt as an editable Word textbox.
        # Small padding removes the glyph antialiasing halo while leaving vector rules intact.
        red = fitz.Rect(max(0, rect.x0 - 0.45), max(0, rect.y0 - 0.25),
                        min(page.rect.width, rect.x1 + 0.45), min(page.rect.height, rect.y1 + 0.35))
        page.add_redact_annot(red, fill=None)
    for block in images:
        rect = block['bbox_rect']
        page.add_redact_annot(rect, fill=None)
    # Preserve vector drawings. Image blocks are separately reinserted as independent DOCX pictures.
    page.apply_redactions(images=2, graphics=0, text=0)
    pix = page.get_pixmap(matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0), alpha=False)
    pix.save(str(out_path))
    bg_doc.close()


def pdf_to_docx(pdf_path, docx_path, dpi=144):
    """Create Word with editable text boxes and individually replaceable image objects.

    Text is not rasterized into page screenshots. Only original PDF vector artwork is used
    as a page background; extracted text spans become editable Word text boxes and source
    images are inserted as separate positioned pictures. Scanned text already baked into
    a source image remains image content, as it does in the source PDF.
    """
    pdf_path = Path(pdf_path)
    docx_path = Path(docx_path)
    docx_path.parent.mkdir(parents=True, exist_ok=True)
    src = fitz.open(pdf_path)
    if len(src) == 0:
        raise ValueError('В исходном PDF нет страниц')

    doc = Document()
    sec = doc.sections[0]
    page_rect = src[0].rect
    page_w_pt, page_h_pt = page_rect.width, page_rect.height
    sec.page_width = Cm(page_w_pt / 72 * 2.54)
    sec.page_height = Cm(page_h_pt / 72 * 2.54)
    sec.left_margin = Cm(0); sec.right_margin = Cm(0)
    sec.top_margin = Cm(0); sec.bottom_margin = Cm(0)
    sec.header_distance = Cm(0); sec.footer_distance = Cm(0)

    normal = doc.styles['Normal']
    normal.font.name = 'Carlito'
    normal.font.size = Pt(1)
    normal.paragraph_format.space_before = Pt(0)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = Pt(1)

    shape_counter = 0
    image_counter = 0
    with tempfile.TemporaryDirectory(prefix='vdgo_editable_docx_') as tmp_dir:
        tmp = Path(tmp_dir)
        for page_index, pdf_page in enumerate(src):
            data = pdf_page.get_text('dict')
            lines = _text_lines(data)
            images = _image_blocks(data)
            bg_path = tmp / f'page_{page_index + 1:02d}_graphics.png'
            _create_graphics_background(src, page_index, lines, images, bg_path, dpi)

            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            p.paragraph_format.line_spacing = Pt(1)
            p.paragraph_format.keep_together = True
            p.paragraph_format.page_break_before = page_index > 0

            # Graphics-only background anchored to the page; it no longer contains extractable text.
            run = p.add_run()
            run.add_picture(str(bg_path), width=Cm(page_w_pt / 72 * 2.54), height=Cm(page_h_pt / 72 * 2.54))
            _anchor_picture(run, 0, 0, width_pt=page_w_pt, height_pt=page_h_pt, behind=True, relative_height=0)

            # Source photos, scans and schematics remain separate replaceable/movable pictures.
            for block in images:
                img_path = tmp / f'img_{page_index + 1:02d}_{image_counter:05d}.{block.get("ext") or "bin"}'
                img_path.write_bytes(block['image'])
                rect = block['bbox_rect']
                irun = p.add_run()
                irun.add_picture(str(img_path), width=Cm(rect.width / 72 * 2.54), height=Cm(rect.height / 72 * 2.54))
                _anchor_picture(irun, rect.x0, rect.y0, width_pt=rect.width, height_pt=rect.height,
                                behind=False, relative_height=251657000 + image_counter)
                image_counter += 1

            # Text lines become independently editable Word text boxes with preserved runs/styles.
            # This includes vertical column headings; they are not left baked into the page art.
            for rect, spans, rotation in lines:
                nonlocal_size = max(float(s.get('size', 8.0)) for s in spans)
                x = max(0.0, rect.x0)
                y = max(0.0, rect.y0 - 0.4)
                width = max(1.0, min(page_w_pt - x, rect.width + 4.0))
                height = max(rect.height + 3.0, nonlocal_size * 1.45)
                if rotation:
                    # The source bbox is the rotated visible bounds. Preserve its centre.
                    width = max(rect.width, nonlocal_size * 1.2)
                    height = max(rect.height, nonlocal_size * len(''.join(s.get('text','') for s in spans)) * 0.5)
                run = p.add_run()
                _append_editable_textbox(run, shape_counter, x, y, width, height, spans, rotation=rotation)
                shape_counter += 1

    doc.core_properties.title = 'Заключение ВДГО — редактируемый Word-документ'
    doc.core_properties.subject = 'Текстовые элементы доступны для редактирования; фотографии и сканы являются отдельными изображениями'
    doc.core_properties.author = 'Конструктор заключения ВДГО'
    doc.core_properties.comments = 'Автоматически сформировано из PDF. Текст, извлекаемый из PDF, перенесён в редактируемые текстовые поля Word.'
    doc.save(docx_path)
    page_count = len(src)
    src.close()
    return page_count


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Преобразовать PDF в редактируемый Word')
    parser.add_argument('pdf')
    parser.add_argument('docx')
    parser.add_argument('--dpi', type=int, default=144)
    args = parser.parse_args()
    count = pdf_to_docx(args.pdf, args.docx, dpi=args.dpi)
    print(f'Создан редактируемый Word: {args.docx} ({count} страниц; текстовые поля доступны для редактирования)')
