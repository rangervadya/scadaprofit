from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, quote
from pathlib import Path
from email.parser import BytesParser
from email.policy import default
import pymupdf as fitz
import os, json, math, re, shutil, threading, webbrowser, html as htmlmod, tempfile, uuid, subprocess, sys, base64
from datetime import datetime
from pdf_to_docx_editable import pdf_to_docx_editable
from PIL import Image, ImageOps
from database import init_database, database_status, recent_reports, record_generation
from io import BytesIO

APP_RELEASE = '4.5.11'
BACKEND_IMAGE_VERSION = '5.3.9'
BASE = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE / 'template'
TEMPLATE = TEMPLATE_DIR / '905_З(2).pdf'
# Robust fallback for deployments that mangle Cyrillic ZIP/Git filenames.
# The VDGO backend package is expected to contain exactly one source PDF template.
if not TEMPLATE.is_file():
    _template_candidates = sorted(p for p in TEMPLATE_DIR.glob('*.pdf') if p.is_file())
    if len(_template_candidates) == 1:
        TEMPLATE = _template_candidates[0]
OUTPUT = BASE / 'output'
UPLOADS = BASE / 'uploads'
FONT_DIR = Path(os.environ.get('VDGO_FONT_DIR', '/usr/share/fonts/truetype/crosextra'))
if not (FONT_DIR / 'Carlito-Regular.ttf').exists() and Path('/usr/share/fonts/google-carlito-fonts/Carlito-Regular.ttf').exists():
    FONT_DIR = Path('/usr/share/fonts/google-carlito-fonts')
FONT = FONT_DIR / 'Carlito-Regular.ttf'
FONT_BOLD = FONT_DIR / 'Carlito-Bold.ttf'
FONT_ITALIC = FONT_DIR / 'Carlito-Italic.ttf'
FONT_BOLD_ITALIC = FONT_DIR / 'Carlito-BoldItalic.ttf'
OUTPUT.mkdir(exist_ok=True)
UPLOADS.mkdir(exist_ok=True)

DEFECTS = [
    {'id':'1.1','location':'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 1, 6, 9, 10.','defect':'Нарушение технологии заделки футляра (СП 42-101-2003 (п.6.7)).','recommendation':'Пространство между газопроводом и футляром на всю его длину необходимо заделывать просмоленной паклей, резиновыми втулками или другим эластичными материалами.'},
    {'id':'1.2','location':'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 3, 4, 7, 8, 10.','defect':'Техническое обслуживание запорной арматуры не проведено (Постановление Правительства РФ от 14 мая 2013 г. N 410 ).','recommendation':'Провести техническое обслуживание запорной арматуры.'},
    {'id':'1.3','location':'Подъезд №1, условный проход Ду25, смотри схему контроля, фото 4, 7.','defect':'Касание газопровода со строительной конструкцией (СП 42-101-2003 (п.6.7)).','recommendation':'При прокладке газопроводов через конструкции зданий и сооружений газопроводы следует заключать в футляр. Края футляров должны быть на одном уровне с поверхностями пересекаемых конструкций.'},
    {'id':'1.4','location':'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 1-5, 7.','defect':'Провода и кабели вблизи газопровода (СП 42-101-2003 (п.6.6); ПУЭ (п.2.1.56, п.2.1.57)).','recommendation':'При пересечении незащищенных и защищенных проводов и кабелей с трубопроводами расстояния между ними в свету должны быть не менее 50 мм, а с трубопроводами, содержащими горючие или легковоспламеняющиеся жидкости и газы, — не менее 100 мм.'},
    {'id':'1.5','location':'Подъезд №1, условный проход Ду25, смотри схему контроля, фото 7.','defect':'Касание газопровода со строительной конструкцией СП 42-101-2003 (п.10.216).','recommendation':'Обеспечить расстояние между газопроводом и строительной конструкцией не менее радиуса трубы.'},
    {'id':'1.6','location':'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 2, 5.','defect':'Газопровод вблизи строительной конструкции СП 42-101-2003 (п.10.216).','recommendation':'Обеспечить расстояние между газопроводом и строительной конструкцией не менее радиуса трубы.'},
    {'id':'1.7','location':'Подъезд №2, условный проход Ду32, смотри схему контроля, фото 12, 15.','defect':'Нарушение технологии заделки футляра (СП 42-101-2003 (п.6.7)).','recommendation':'Пространство между газопроводом и футляром на всю его длину необходимо заделывать просмоленной паклей, резиновыми втулками или другим эластичными материалами.'},
    {'id':'1.8','location':'Подъезд №2, условный проход Ду25, смотри схему контроля, фото 11, 13, 14, 17.','defect':'Техническое обслуживание запорной арматуры не проведено (Постановление Правительства РФ от 14 мая 2013 г. N 410 ).','recommendation':'Провести техническое обслуживание запорной арматуры.'},
    {'id':'1.9','location':'Подъезд №2, условный проход Ду32, 25, смотри схему контроля, фото 13, 14, 17, 18, 19.','defect':'Касание газопровода со строительной конструкцией (СП 42-101-2003 (п.6.7)).','recommendation':'При прокладке газопроводов через конструкции зданий и сооружений газопроводы следует заключать в футляр. Края футляров должны быть на одном уровне с поверхностями пересекаемых конструкций.'},
    {'id':'1.10','location':'Подъезд №2, условный проход Ду32, 25, смотри схему контроля, фото 11, 14, 16, 19, 20.','defect':'Провода и кабели вблизи газопровода (СП 42-101-2003 (п.6.6); ПУЭ (п.2.1.56, п.2.1.57)).','recommendation':'При пересечении незащищенных и защищенных проводов и кабелей с трубопроводами расстояния между ними в свету должны быть не менее 50 мм, а с трубопроводами, содержащими горючие или легковоспламеняющиеся жидкости и газы, — не менее 100 мм.'},
    {'id':'1.11','location':'Подъезд №2, условный проход Ду32, 25, смотри схему контроля, фото 16, 17, 20.','defect':'Газопровод вблизи строительной конструкции СП 42-101-2003 (п.10.216).','recommendation':'Обеспечить расстояние между газопроводом и строительной конструкцией не менее радиуса трубы.'},
]

PHOTO_SLOTS=[]
# 20 photo positions: two per page, matching the existing template layout.
for n in range(1,21):
    # Image rectangles measured from the original PDF. PDF page indexes are zero-based:
    # page 18 (index 17) starts at x=123.35; page 19 (index 18) at x=165.85; then repeats.
    page=17+(n-1)//2
    top=(n%2)==1
    x0,x1 = (123.35,430.95) if page % 2 == 1 else (165.85,473.45)
    y0,y1 = (102.05,409.65) if top else (448.694,756.294)
    PHOTO_SLOTS.append((n,page,fitz.Rect(x0,y0,x1,y1)))

# Листы Приложения 2 — необязательные вложения. Шаблонные схемы относятся к демонстрационному объекту и не переносятся автоматически.
MATERIAL_PAGES = {
    # Source diagrams in the example PDF belong to a different object. App. 2 is
    # therefore optional and is included only when the user supplies a current sheet.
    16: {'title': 'Приложение 2. Схема неразрушающего контроля — подъезд 1', 'description': 'Схема Приложения 2, подъезд 1 (необязательно)', 'optional': True},
    17: {'title': 'Приложение 2. Схема неразрушающего контроля — подъезд 2', 'description': 'Схема Приложения 2, подъезд 2 (необязательно)', 'optional': True},
    31: {'title': 'Приложение 6. Протокол контроля влажности', 'description': 'Актуальный протокол контроля влажности'},
    32: {'title': 'Приложение 7. Протокол контроля контакта «труба-футляр»', 'description': 'Актуальный протокол контроля контакта'},
    33: {'title': 'Приложение 8. Визуальный и измерительный контроль (лист 1)', 'description': 'Актуальный протокол ВИК — лист 1'},
    34: {'title': 'Приложение 8. Визуальный и измерительный контроль (лист 2)', 'description': 'Актуальный протокол ВИК — лист 2'},
    35: {'title': 'Приложение 9. Протокол контроля на герметичность', 'description': 'Актуальный протокол контроля герметичности'},
    36: {'title': 'Приложение 10. Акт пневматического испытания газопровода', 'description': 'Актуальный акт пневматического испытания'},
    41: {'title': 'Приложение 13. Копии удостоверений специалистов и ответственных лиц', 'description': 'Удостоверения действующих специалистов'},
    42: {'title': 'Приложение 13. Продолжение. Документы о квалификации', 'description': 'Продолжение документов о квалификации'},
    43: {'title': 'Приложение 13. Продолжение. Дополнительные документы', 'description': 'Дополнительный документ о квалификации'},
    44: {'title': 'Приложение 14. Лист учёта толщины стенки при УЗТ', 'description': 'Актуальный лист учёта толщины стенки'},
    45: {'title': 'Приложение 15. Акт отсутствия доступа (лист 1)', 'description': 'Актуальный акт отсутствия доступа'},
    46: {'title': 'Приложение 16. Лист учёта толщины стенки при УЗТ', 'description': 'Актуальный лист учёта толщины стенки'},
    47: {'title': 'Приложение 17. Акт отсутствия доступа (лист 2)', 'description': 'Актуальный акт отсутствия доступа'},
}

# Источник содержит данные демонстрационного отчёта. Они используются только
# для поиска/очистки исходных надписей, но НИКОГДА не подставляются как значения по умолчанию.
SOURCE_VALUES={
'report_number':'905/2025','report_date':'21.03.2025','address':'Республика Татарстан, г. Казань, ул. Юлиуса Фучика, д. 105','report_year':'2025','next_diagnostic':'марта 2028 года','pipe_length':'381,85','pressure':'0,003','min_thickness':'2,4','max_thickness':'3,2',
'customer':'ООО «АДС Приволжский»','customer_legal_name':'Общество с ограниченной ответственностью «АДС Приволжский»','customer_address':'420141, Республика Татарстан, г. Казань, ул. Комиссара Габишева, д. 39, помещ. 2','customer_phone':'+7 843 202-30-29','customer_director':'А.М. Васильев','executor':'ООО «Профит»','executor_legal_name':'Общество с ограниченной ответственностью «Профит»','executor_address':'420133, Республика Татарстан, г. Казань, ул. Аделя Кутуя, д. 110Д','executor_phone':'+7 (917) 879-86-96','general_director':'В.А. Палагин','general_director_full':'Палагин Виталий Александрович','specialist':'А.А. Козлов','specialist_full':'Козлов Александр Александрович','technician':'Э.Ф. Валиуллин','technician_full':'Валиуллин Эдуард Фардинантович',
'test_pressure':'500 мм вод.ст.',
'test_result':'Проверка газопровода на герметичность не проводилась в связи с отсутствием технической возможности её проведения по причине отсутствия доступа во все жилые помещения при первичном обходе и по причине необслуженной запорной арматуры (Подъезд № 1-2, кран на стояк № 1-8, кран на вводе № 1).'}
# All data-bearing inputs start empty; generation must not reuse example values.
DEFAULTS={k:'' for k in SOURCE_VALUES}
DEFAULTS.update({'finding_status':'','template_review_confirm':''})


def val(form,key,default=''):
    # Preserve an explicitly submitted empty string: blank means 'do not copy source data'.
    if key in form:
        return str(form.get(key) or '').strip()
    return str(default or '').strip()

def erase_text(page, rect):
    # Transparent redaction removes the original glyphs without painting a visible white box.
    try:
        page.add_redact_annot(fitz.Rect(rect), fill=None)
    except Exception:
        pass

def apply_redactions(doc):
    for p in doc:
        try: p.apply_redactions(images=0, graphics=0, text=0)
        except TypeError: p.apply_redactions()

# All inserted text is stored as real PDF text objects with embedded Carlito fonts.
# Pillow is used only for raster photographs, never for rendering document typography.
_FONT_SPECS = {
    (False, False): ('CarlitoRegular', FONT),
    (True, False): ('CarlitoBold', FONT_BOLD),
    (False, True): ('CarlitoItalic', FONT_ITALIC),
    (True, True): ('CarlitoBoldItalic', FONT_BOLD_ITALIC),
}
_FITZ_FONT_CACHE = {}


def _get_pdf_font(bold=False, italic=False):
    key = (bool(bold), bool(italic))
    if key not in _FITZ_FONT_CACHE:
        alias, font_path = _FONT_SPECS[key]
        _FITZ_FONT_CACHE[key] = (alias, fitz.Font(fontfile=str(font_path)), font_path)
    return _FITZ_FONT_CACHE[key]


def _wrap_text_for_pdf(text, font, size, max_width):
    """Wrap text using the actual embedded PDF font metrics, not bitmap metrics."""
    lines = []
    for paragraph in str(text).split('\n'):
        if not paragraph:
            lines.append('')
            continue
        current = ''
        for word in paragraph.split():
            candidate = word if not current else current + ' ' + word
            if font.text_length(candidate, fontsize=size) <= max_width:
                current = candidate
                continue
            if current:
                lines.append(current)
                current = ''
            if font.text_length(word, fontsize=size) <= max_width:
                current = word
                continue
            # Break long tokens only when a single word cannot fit in the fixed cell.
            chunk = ''
            for char in word:
                candidate = chunk + char
                if chunk and font.text_length(candidate, fontsize=size) > max_width:
                    lines.append(chunk)
                    chunk = char
                else:
                    chunk = candidate
            current = chunk
        if current:
            lines.append(current)
    return lines or ['']


def put(page, rect, text, size=8.5, align=0, lineheight=1.15, bold=False, italic=False):
    """Insert selectable, searchable native PDF text using the requested point size.

    The function returns remaining vertical space, or a negative value if the content
    cannot fit. Callers may then reduce the font size. Unlike the previous implementation,
    the letters are not converted to PNG images, so PDF zoom/selection/search stay crisp.
    """
    if text is None:
        text = ''
    text = str(text)
    if not text:
        return max(0.1, fitz.Rect(rect).height)
    rect = fitz.Rect(rect)
    if rect.width <= 0 or rect.height <= 0 or size <= 0:
        return -1

    font_alias, font, font_path = _get_pdf_font(bold, italic)
    inset = 0.8
    max_width = max(1, rect.width - 2 * inset)
    lines = _wrap_text_for_pdf(text, font, float(size), max_width)
    # Position glyphs close to the top of the field. The typographic ascender is the
    # baseline offset; the descender supplies bottom clearance for Cyrillic letters.
    # Font metric boxes include leading that does not correspond to visible ink. Use
    # a visual cap/descender envelope so 20 pt cover lines fit into the original 24–25 pt rows.
    asc = 0.82
    desc = 0.18
    advance = max(float(size) * float(lineheight), float(size))
    first_baseline = rect.y0 + float(size) * asc
    content_height = float(size) * (asc + desc) + max(0, len(lines) - 1) * advance
    if content_height > rect.height + 0.15:
        return rect.height - content_height

    # Pre-check widths before changing the page so a failed fit attempt leaves no text behind.
    for line in lines:
        if line and font.text_length(line, fontsize=size) > max_width + 0.01:
            return -1

    for index, line in enumerate(lines):
        if not line:
            continue
        width = font.text_length(line, fontsize=size)
        if align == 1:
            x = rect.x0 + (rect.width - width) / 2
        elif align == 2:
            x = rect.x1 - inset - width
        else:
            x = rect.x0 + inset
        baseline = first_baseline + index * advance
        page.insert_text(
            (x, baseline), line,
            fontname=font_alias, fontfile=str(font_path),
            fontsize=float(size), color=(0, 0, 0), overlay=True,
        )
    return max(0.1, rect.height - content_height)


def infer_pdf_style(page, rects, fallback_size=8.5):
    """Infer native font size/weight from text in or immediately around a PDF field.

    This makes substitutions follow the original line typography instead of inheriting
    arbitrary small defaults from call sites. The fallback is used only where the source
    contains no selectable text (for example, a scanned cell).
    """
    rects = [fitz.Rect(r) for r in rects]
    candidates = []
    nearby = []
    try:
        blocks = page.get_text('dict').get('blocks', [])
    except Exception:
        blocks = []
    for block in blocks:
        for line in block.get('lines', []):
            for span in line.get('spans', []):
                text = str(span.get('text') or '')
                if not text.strip():
                    continue
                sr = fitz.Rect(span.get('bbox', (0, 0, 0, 0)))
                size = float(span.get('size') or fallback_size)
                overlap = 0.0
                for rect in rects:
                    inter = sr & rect
                    if not inter.is_empty:
                        overlap += max(0.0, inter.width) * max(0.0, inter.height)
                if overlap > 0:
                    candidates.append((overlap, span, size))
                else:
                    # Same-row neighbour or nearby line is a useful fallback after a field
                    # was cleared but a sibling cell still has the source font.
                    distance_y = min(abs(sr.y0-r.y1) if sr.y0 > r.y1 else abs(r.y0-sr.y1) if r.y0 > sr.y1 else 0 for r in rects)
                    distance_x = min(abs(sr.x0-r.x1) if sr.x0 > r.x1 else abs(r.x0-sr.x1) if r.x0 > sr.x1 else 0 for r in rects)
                    if distance_y <= max(12.0, size * 1.5) and distance_x <= 18.0:
                        nearby.append((distance_y + distance_x * 0.15, span, size))
    picked = candidates
    if not picked and nearby:
        picked = [(1.0/(1.0+d), span, size) for d, span, size in sorted(nearby, key=lambda x: x[0])[:6]]
    if not picked:
        return {'size': float(fallback_size), 'bold': False, 'italic': False, 'inferred': False}
    sizes = sorted(size for _weight, _span, size in picked if 3.0 <= size <= 36.0)
    if not sizes:
        chosen_size = float(fallback_size)
    else:
        chosen_size = sizes[len(sizes)//2]
    weight_total = sum(max(0.01, w) for w, _span, _size in picked)
    bold_weight = sum(max(0.01, w) for w, span, _size in picked if (int(span.get('flags',0)) & 16) or 'bold' in str(span.get('font','')).casefold())
    italic_weight = sum(max(0.01, w) for w, span, _size in picked if (int(span.get('flags',0)) & 2) or 'italic' in str(span.get('font','')).casefold())
    return {'size': chosen_size, 'bold': bold_weight > weight_total * 0.5,
            'italic': italic_weight > weight_total * 0.5, 'inferred': bool(candidates)}


def remove_raster_overlays(page, regions, force=False):
    """Compatibility shim: inserted text is native PDF text and is removed by redaction."""
    return None


def add_searchable_text_layer(doc):
    """Compatibility shim. Visible native PDF text is already searchable/selectable."""
    return None

def _group_search_rect_groups(rects, old):
    """Group line fragments that make one searched phrase, retaining their exact boxes."""
    if not rects:
        return []
    ordered=sorted((fitz.Rect(r) for r in rects), key=lambda r:(round(r.y0,1),r.x0))
    if len(old)<24 and ' ' not in old.strip():
        return [[r] for r in ordered]
    groups=[]; current=[]
    long_paragraph=len(old)>=100
    multiline_value=len(old)>=24
    for r in ordered:
        if not current:
            current=[r]; continue
        prev=current[-1]
        vgap=r.y0-prev.y1
        overlap_y=min(prev.y1,r.y1)-max(prev.y0,r.y0)
        hgap=r.x0-prev.x1
        same_line=overlap_y>0 and hgap<8
        adjacent_line=(vgap <= (18.5 if long_paragraph else 33) and (long_paragraph or multiline_value))
        if same_line or adjacent_line:
            current.append(r)
        else:
            groups.append(current); current=[r]
    if current: groups.append(current)
    return groups

def _group_search_rects(rects, old):
    groups=_group_search_rect_groups(rects,old)
    return [fitz.Rect(min(r.x0 for r in g),min(r.y0 for r in g),max(r.x1 for r in g),max(r.y1 for r in g)) for g in groups]

def replace_all(doc, old, new, size=8.5, min_size=5.5, skip_pages=None, preserve_prefix=False):
    if not old or old == new:
        return
    skip_pages=set(skip_pages or [])
    for page_index,page in enumerate(doc):
        if page_index in skip_pages:
            continue
        raw_rects=page.search_for(old)
        groups=_group_search_rect_groups(raw_rects,old) if preserve_prefix else [[r] for r in _group_search_rects(raw_rects,old)]
        if not groups:
            continue
        inferred_styles = [infer_pdf_style(page, g, size) for g in groups]
        for g in groups:
            remove_raster_overlays(page,g)
            # In preserve-prefix mode, redact only the glyph boxes returned for the matched phrase.
            # A single bounding rectangle could also erase words to the left on a wrapped line.
            for r in g:
                page.add_redact_annot(r, fill=None)
        try:
            page.apply_redactions(images=0, graphics=0, text=0)
        except TypeError:
            page.apply_redactions()
        if not new:
            continue
        for group_index, g in enumerate(groups):
            style = inferred_styles[group_index]
            base_size = style['size'] if style.get('inferred') else size
            min_allowed = max(min_size, base_size * 0.88)
            if preserve_prefix:
                first=min(g,key=lambda r:(round(r.y0,1),r.x0))
                bottom=max(r.y1 for r in g)
                target=fitz.Rect(first.x0,first.y0-.7,page.rect.width-26,min(page.rect.height-28,bottom+9))
                align=1 if abs((first.x0+max(r.x1 for r in g))/2-page.rect.width/2)<32 and len(old)>24 else 0
                fs=base_size
                while fs>=min_allowed:
                    if put(page,target,new,fs,align,1.05,style['bold'],style['italic'])>=0:
                        break
                    fs-=.25
            else:
                r=g[0]
                # Use the original field's font size/weight. Previously this branch
                # accidentally used the small fallback argument even when a 12 pt
                # source run had been detected, which made every substituted value tiny.
                width=max(r.width, min(500, len(new)*base_size*0.48))
                x1=min(page.rect.width-26, max(r.x1, r.x0+width))
                needs_extra_line = len(new) > max(len(old) + 5, int(r.width / max(1.0, base_size*0.48)))
                extra_h = max(1.5, base_size*1.10) if needs_extra_line else 1.0
                y1=min(page.rect.height-28, r.y1 + extra_h)
                fs=base_size
                align=1 if abs((r.x0+r.x1)/2-page.rect.width/2)<32 and len(old)>24 else 0
                while fs>=min_allowed-0.001:
                    rc=put(page,(r.x0,r.y0-.7,x1,y1),new,fs,align,1.05,style['bold'],style['italic'])
                    if rc>=0:
                        break
                    fs-=.25

def replace_on_page(doc, page_index, old, new, size=8.5, min_size=5.5):
    if not old:
        return
    page = doc[page_index]
    rects = _group_search_rects(page.search_for(old), old)
    if not rects:
        return
    inferred_styles = [infer_pdf_style(page, [rect], size) for rect in rects]
    remove_raster_overlays(page,rects)
    for rect in rects:
        page.add_redact_annot(rect, fill=None)
    try:
        page.apply_redactions(images=0, graphics=0, text=0)
    except TypeError:
        page.apply_redactions()
    if not new:
        return
    for rect, style in zip(rects, inferred_styles):
        base_size = style['size'] if style.get('inferred') else size
        min_allowed = max(min_size, base_size * 0.88)
        fs = base_size
        longer = len(new) > len(old) + 3
        extra_h = max(1.0, base_size * 1.05) if longer else 1.0
        target = (rect.x0, rect.y0-.7,
                  min(page.rect.width-26, rect.x1+max(0,len(new)-len(old))*max(1.5,base_size*0.38)),
                  min(page.rect.height-28, rect.y1+extra_h))
        while fs >= min_allowed-0.001:
            rc = put(page, target, new, fs, 0, 1.05, style['bold'], style['italic'])
            if rc >= 0:
                break
            fs -= .25

def replace_group_on_page(doc,page_index,old,new,size=8.5,min_size=5.5,rect_override=None,align=None):
    page=doc[page_index]
    rects=_group_search_rects(page.search_for(old),old)
    if not rects:return
    style=infer_pdf_style(page,rects,size)
    base_size=style['size'] if style.get('inferred') else size
    min_allowed=max(min_size,base_size*0.88)
    remove_raster_overlays(page,rects)
    for r in rects: page.add_redact_annot(r,fill=None)
    try: page.apply_redactions(images=0,graphics=0,text=0)
    except TypeError: page.apply_redactions()
    if new:
        for r in rects:
            target=fitz.Rect(rect_override) if rect_override is not None else fitz.Rect(r.x0,r.y0-.7,min(page.rect.width-26,max(r.x1,r.x0+len(new)*4.7)),min(page.rect.height-28,r.y1+8))
            al=align if align is not None else (1 if abs((r.x0+r.x1)/2-page.rect.width/2)<32 and len(old)>24 else 0)
            fs=base_size
            while fs>=min_allowed:
                if put(page,target,new,fs,al,1.08,style['bold'],style['italic'])>=0:break
                fs-=.25

def overlay_defects(doc, defects):
    """Write defect rows using the source row's typography, not a tiny fixed font."""
    p=doc[9]
    row_bounds=[(138.0,183.62),(183.62,247.10),(247.10,295.01),(295.01,342.89),(342.89,390.77),(390.77,438.77),(438.77,486.67),(486.67,550.15),(550.15,598.03),(598.03,645.94),(645.94,693.94)]
    cell_styles={}
    pending=[]
    for i,(y0,y1) in enumerate(row_bounds):
        regs=[fitz.Rect(87,y0+1,304.4,y1-1),fitz.Rect(305.1,y0+1,517,y1-1)]
        for c,reg in enumerate(regs):
            cell_styles[(i,c)]=infer_pdf_style(p,[reg],9.5)
            for w in p.get_text('words'):
                rr=fitz.Rect(w[:4])
                if reg.intersects(rr): pending.append(rr)
    remove_raster_overlays(p,pending)
    for r in pending: p.add_redact_annot(r,fill=None)
    try: p.apply_redactions(images=0,graphics=0,text=0)
    except TypeError: p.apply_redactions()
    for i,(d,(y0,y1)) in enumerate(zip(defects,row_bounds)):
        if not d['enabled']:
            continue
        for col,text,rect in (
            (0,d['location'],(92,y0+4.25,300,y1-3)),
            (1,d['defect'],(309,y0+4.25,514,y1-3)),
        ):
            style=cell_styles[(i,col)]
            base=max(9.0,style['size']) if style.get('inferred') else 9.5
            minimum=max(8.0,base*0.82)
            size=base
            placed=False
            while size>=minimum-0.001:
                if put(p,rect,text,size,1,1.02,style['bold'],style['italic'])>=0:
                    placed=True
                    break
                size-=0.25
            if text and not placed:
                raise ValueError(f'Текст раздела 6.1 не помещается в ячейку: {d["id"]}, поле «{"место расположения" if col==0 else "наименование неисправности"}». Сократите только необязательные слова, сохранив фактические сведения.')

    # The recommendation continuation pages use the font extracted from their own cells.
    page_rows={38:[(253.1,341.45),(341.93,415.25),(415.73,503.59),(504.08,621.34),(621.82,680.38),(680.98,739.54)],39:[(71.04,159.02),(159.5,232.70),(233.19,321.17),(321.65,438.77),(439.37,497.95)]}
    idx=0
    for pno in [38,39]:
        p=doc[pno]; pending=[]; cell_styles={}
        for row,(y0,y1) in enumerate(page_rows[pno]):
            # Use the actual PDF grid boundaries. Page 39 has columns at x=111.9/347.5;
            # page 40 uses x=69.3/304.9. The previous wider rectangles crossed the
            # vertical rules and let text from the location column spill into recommendations.
            regs = ([fitz.Rect(115, y0+1, 344, y1-1), fitz.Rect(351, y0+1, 556, y1-1)]
                    if pno == 38 else
                    [fitz.Rect(73, y0+1, 301, y1-1), fitz.Rect(309, y0+1, 514, y1-1)])
            for c,reg in enumerate(regs):
                cell_styles[(row,c)]=infer_pdf_style(p,[reg],8.8 if c==0 else 8.2)
                for w in p.get_text('words'):
                    rr=fitz.Rect(w[:4])
                    if reg.intersects(rr): pending.append(rr)
        remove_raster_overlays(p,pending)
        for r in pending: p.add_redact_annot(r,fill=None)
        try: p.apply_redactions(images=0,graphics=0,text=0)
        except TypeError: p.apply_redactions()
        for row,(y0,y1) in enumerate(page_rows[pno]):
            d=defects[idx]; idx+=1
            if not d['enabled']:
                continue
            if pno==38:
                specs=[(0,d['location']+'\n'+d['defect'],(115,y0+3,344,y1-3)),(1,d['recommendation'],(351,y0+3,556,y1-3))]
            else:
                specs=[(0,d['location']+'\n'+d['defect'],(73,y0+3,301,y1-3)),(1,d['recommendation'],(309,y0+3,514,y1-3))]
            for c,text,rect in specs:
                style=cell_styles[(row,c)]
                default=8.8 if c==0 else 8.2
                base=max(default,style['size']) if style.get('inferred') else default
                minimum=max(7.6,base*0.82)
                size=base
                while size>=minimum-0.001:
                    if put(p,rect,text,size,1,1.0,style['bold'],style['italic'])>=0:
                        break
                    size-=0.25

def remove_embedded_images(page, fill=(1, 1, 1)):
    """Physically remove placed image objects using redaction.

    PyMuPDF's delete_image replaces image xrefs with a tiny placeholder image; depending
    on renderer that placeholder may display as a black rectangle. Redacting each image
    placement removes it cleanly while preserving vector lines and text outside the box.
    """
    try:
        image_rects = []
        for block in page.get_text('dict').get('blocks', []):
            if block.get('type') == 1 and block.get('bbox'):
                rect = fitz.Rect(block['bbox'])
                if not rect.is_empty and rect.width > 0 and rect.height > 0:
                    image_rects.append(rect)
        if not image_rects:
            return
        for rect in image_rects:
            page.add_redact_annot(rect, fill=fill)
        page.apply_redactions(images=2, graphics=0, text=0)
    except Exception as exc:
        raise RuntimeError(f'Не удалось очистить старые изображения на странице {page.number+1}: {exc}')

def _ordered_uploaded_photos(photo_paths):
    """Return photo uploads in numeric UI order, ignoring non-photo attachments."""
    pairs=[]
    for key,path in photo_paths.items():
        match=re.fullmatch(r'photo_(\d+)', str(key))
        if match and path and Path(path).exists():
            pairs.append((int(match.group(1)), str(path)))
    pairs.sort(key=lambda item:item[0])
    return [path for _,path in pairs]


def _make_square_photo(path, temp_photos):
    cropped=OUTPUT/f'_photo_{uuid.uuid4().hex}.jpg'
    with Image.open(path) as source:
        fitted=ImageOps.fit(
            ImageOps.exif_transpose(source).convert('RGB'), (1200,1200),
            method=Image.Resampling.LANCZOS, centering=(0.5,0.5)
        )
        fitted.save(cropped, format='JPEG', quality=94, optimize=True)
    temp_photos.append(cropped)
    return cropped


def place_photos(doc, photo_paths):
    """Fill uploaded images, mark completely empty photo sheets for removal.

    The source PDF contains example photos and their labels. Images are removed from
    every original photo sheet; sheets with no uploaded photo are deleted at the end of
    PDF assembly, and the label for an unused second slot is removed on partially filled
    sheets. Deletion is deferred so other source-page coordinates remain stable.
    """
    temp_photos=[]
    ordered=_ordered_uploaded_photos(photo_paths)
    slots_by_page={}
    for n,page_no,rect in PHOTO_SLOTS:
        slots_by_page.setdefault(page_no,[]).append((n,rect))
    pages_to_remove=[]
    for page_no, slots in sorted(slots_by_page.items()):
        p=doc[page_no]
        remove_embedded_images(p)
        used_count=0
        for n,rect in slots:
            p.draw_rect(rect, color=None, fill=(1,1,1), overlay=True)
            if n <= len(ordered):
                cropped=None
                try:
                    cropped=_make_square_photo(ordered[n-1],temp_photos)
                    p.draw_rect(rect, color=None, fill=(1,1,1), overlay=True)
                    p.insert_image(rect, filename=str(cropped), keep_proportion=False, overlay=True)
                    used_count += 1
                except Exception as exc:
                    if cropped is not None:
                        try: cropped.unlink(missing_ok=True)
                        except Exception: pass
                    raise ValueError(f'Не удалось обработать фотографию № {n}: {exc}')
            else:
                # Remove the label too, so an unused slot never says "Фото N" above
                # an empty white rectangle.
                label_rects=p.search_for(f'Фото {n}')
                for label_rect in label_rects:
                    p.add_redact_annot(label_rect, fill=(1,1,1))
                if label_rects:
                    try: p.apply_redactions(images=0, graphics=0, text=0)
                    except TypeError: p.apply_redactions()
        if used_count == 0:
            pages_to_remove.append(page_no)
    return temp_photos, ordered[len(PHOTO_SLOTS):], pages_to_remove


def append_extra_photo_pages(doc, extra_photo_paths, form):
    """Append two native photo objects per additional photo sheet after the 49 base pages."""
    if not extra_photo_paths:
        return []
    temp_photos=[]
    page_width, page_height = 595.32, 841.92
    report_no=val(form,'report_number')
    address=val(form,'address')
    for offset in range(0, len(extra_photo_paths), 2):
        page=doc.new_page(width=page_width, height=page_height)
        put(page,(38,12,557,25),f'Заключение № {report_no} по результатам технического диагностирования внутридомового газового оборудования.',7.8,1,1.0)
        header_size=7.8
        while header_size >= 6.8:
            if put(page,(38,26,557,39),'Адрес объекта: '+address,header_size,1,1.0)>=0:
                break
            header_size-=0.25
        sheet_number = 1 + offset // 2
        put(page,(45,47,550,64),f'Приложение 3. Фото дефектного участка (продолжение, лист {sheet_number})',11.5,1,1.0,True)
        layouts=[(145,81,450,386),(145,420,450,725)]
        for sub,rect in enumerate(layouts):
            idx=offset+sub
            if idx>=len(extra_photo_paths):
                continue
            photo_number=len(PHOTO_SLOTS)+idx+1
            path=extra_photo_paths[idx]
            p_rect=fitz.Rect(rect)
            page.draw_rect(p_rect,color=(0.70,0.74,0.80),fill=(1,1,1),width=0.6,overlay=True)
            put(page,(52,p_rect.y0-15,540,p_rect.y0-2),f'Фото {photo_number}',8.5,0,1.0,True)
            try:
                cropped=_make_square_photo(path,temp_photos)
                page.insert_image(p_rect,filename=str(cropped),keep_proportion=False,overlay=True)
            except Exception as exc:
                raise ValueError(f'Не удалось разместить дополнительную фотографию № {photo_number}: {exc}')
    return temp_photos

def place_material_pages(doc, form, files):
    # Replace scanned appendices with user-provided current documents. Optional pages
    # (App. 2 schemes) are omitted when no file was selected; no sample diagram survives.
    temp_files=[]
    pages_to_remove=[]
    target = fitz.Rect(43, 99, 552, 752)
    for page_number, meta in MATERIAL_PAGES.items():
        page=doc[page_number-1]
        remove_raster_overlays(page,[fitz.Rect(0,0,page.rect.width,760)],force=True)
        remove_embedded_images(page)
        body = fitz.Rect(20, 10, 575, 760)
        page.add_redact_annot(body, fill=(1, 1, 1))
        try:
            page.apply_redactions(images=2, graphics=2, text=0)
        except TypeError:
            page.apply_redactions()
        path=files.get(f'material_page_{page_number}')
        excluded=val(form,f'exclude_material_page_{page_number}')=='1'
        if meta.get('optional') and (not path or not Path(path).exists()):
            # Optional schemes are never inherited from the demonstration template.
            # A missing upload (whether or not exclusion was ticked) removes the page.
            pages_to_remove.append(page_number-1)
            continue
        put(page,(42,14,553,28),'Заключение № '+val(form,'report_number')+' по результатам технического диагностирования внутридомового газового оборудования.',8.0,1,1.0)
        header_size = 8.0
        while header_size >= 7.0:
            if put(page,(42,29,553,42),'Адрес объекта: '+val(form,'address'),header_size,1,1.0) >= 0:
                break
            header_size -= 0.25
        put(page, (37, 59, 558, 91), meta['title'], 12.0, 1, 1.0)
        if path and Path(path).exists():
            rendered_path=OUTPUT/f'_material_{uuid.uuid4().hex}.png'
            try:
                q=Path(path)
                if q.suffix.lower()=='.pdf':
                    with fitz.open(q) as src:
                        if len(src)!=1:
                            raise ValueError(f'Вложение для страницы {page_number} должно содержать ровно одну страницу PDF.')
                        pix=src[0].get_pixmap(matrix=fitz.Matrix(1.8,1.8), alpha=False)
                        pix.save(str(rendered_path))
                else:
                    with Image.open(q) as im:
                        normalized=ImageOps.exif_transpose(im).convert('RGB')
                        normalized.save(rendered_path,format='PNG',optimize=True)
                canvas_size=(1200,1530)
                with Image.open(rendered_path) as im:
                    im=ImageOps.exif_transpose(im).convert('RGB')
                    im.thumbnail((1120,1450),Image.Resampling.LANCZOS)
                    canvas=Image.new('RGB',canvas_size,'white')
                    canvas.paste(im,((canvas_size[0]-im.width)//2,(canvas_size[1]-im.height)//2))
                canvas.save(rendered_path,format='PNG',optimize=True)
                page.insert_image(target,filename=str(rendered_path),keep_proportion=False,overlay=True)
                temp_files.append(rendered_path)
            except Exception as exc:
                try: rendered_path.unlink(missing_ok=True)
                except Exception: pass
                raise ValueError(f'Не удалось вставить материал для страницы {page_number}: {exc}')
        elif excluded:
            put(page,(65,300,530,385),'МАТЕРИАЛ НЕ ВКЛЮЧЁН',16,1,1.0)
            put(page,(80,395,515,457),'Исходный демонстрационный материал удалён, чтобы исключить перенос чужих данных. Страница исключена по решению составителя.',10,1,1.15)
        else:
            put(page,(65,300,530,385),'АКТУАЛЬНЫЙ МАТЕРИАЛ НЕ ПРИЛОЖЕН',13,1,1.0)
            put(page,(80,395,515,457),'Загрузите текущий документ в веб-форме или явно отметьте страницу как не включаемую.',10,1,1.15)
    return temp_files, pages_to_remove


def clear_words_in_regions(page, regions):
    remove_raster_overlays(page,regions)
    pending=[]
    for word in page.get_text('words'):
        wr=fitz.Rect(word[:4])
        if any(reg.intersects(wr) for reg in regions):pending.append(wr)
    for wr in pending:page.add_redact_annot(wr,fill=None)
    if pending:
        try:page.apply_redactions(images=0,graphics=0,text=0)
        except TypeError:page.apply_redactions()


def white_redact_region(page, rect, remove_graphics=False):
    """Remove old text in a fixed field and paint a clean white background over the whole region."""
    rect = fitz.Rect(rect)
    remove_raster_overlays(page, [rect])
    page.add_redact_annot(rect, fill=(1, 1, 1))
    try:
        page.apply_redactions(images=0, graphics=(1 if remove_graphics else 0), text=0)
    except TypeError:
        page.apply_redactions()
    # Keep the visual background solid even for unusual source drawing order.
    page.draw_rect(rect, color=None, fill=(1, 1, 1), overlay=True)

def overlay_valve_table(doc, form):
    # Page 9 (zero-based 8): clear sample rows but preserve the source cell font size.
    page=doc[8]
    row_bounds=[(189.5,231.5),(231.5,272.5),(272.5,355.0)]
    cols=[(75,145),(145,174),(174,239),(239,293),(293,361),(361,428),(428,490),(490,562)]
    keys=['location','diameter','type','surface','outer','inner','function','conclusion']
    cells={}
    regions=[]
    for row,(y0,y1) in enumerate(row_bounds,1):
        for col,(x0,x1) in enumerate(cols):
            rect=fitz.Rect(x0+1,y0+1,x1-1,y1-1)
            cells[(row,col)]=infer_pdf_style(page,[rect],7.2)
            regions.append(rect)
    clear_words_in_regions(page,regions)
    for i,(y0,y1) in enumerate(row_bounds,1):
        if val(form,f'valve_{i}_enabled')!='1':continue
        for col,(key,(x0,x1)) in enumerate(zip(keys,cols)):
            text=val(form,f'valve_{i}_{key}')
            if not text:continue
            style=cells[(i,col)]
            size=max(9.5,style['size']) if style.get('inferred') else 10.0
            minimum=max(9.0,size*0.86)
            while size>=minimum-0.001:
                if put(page,(x0+1,y0+2,x1-1,y1-2),text,size,1,1.0,style['bold'],style['italic'])>=0:
                    break
                size-=0.2
            else:
                raise ValueError(f'Значение в строке арматуры {i}, поле {key} не помещается без чрезмерного уменьшения шрифта. Сократите запись, сохранив фактический смысл.')

def rebuild_leak_table(doc, form):
    """Rebuild the entire leak table; do not depend on old row text or line positions."""
    page = doc[8]
    table = fitz.Rect(77.5, 443.2, 559.0, 475.3)
    x0, x1, x2, x3 = 77.9, 151.1, 354.8, 558.5
    header_sizes = [
        infer_pdf_style(page, [fitz.Rect(x0, 445, x1, 459)], 8.0),
        infer_pdf_style(page, [fitz.Rect(x1, 445, x2, 459)], 8.0),
        infer_pdf_style(page, [fitz.Rect(x2, 445, x3, 459)], 8.0),
    ]
    result_sizes = [
        infer_pdf_style(page, [fitz.Rect(x1, 459, x2, 475)], 8.0),
        infer_pdf_style(page, [fitz.Rect(x2, 459, x3, 475)], 8.0),
    ]
    white_redact_region(page, table, remove_graphics=True)

    y0, y1, y2 = 443.83, 459.19, 474.55
    for y in (y0, y1, y2):
        page.draw_line(fitz.Point(x0, y), fitz.Point(x3, y), color=(0, 0, 0), width=0.55, overlay=True)
    for x in (x0, x1, x2, x3):
        page.draw_line(fitz.Point(x, y0), fitz.Point(x, y2), color=(0, 0, 0), width=0.55, overlay=True)

    # Header row: explicit columns and vertical alignment ensure the heading is never blank.
    hsize=[max(10.0,x['size']) if x.get('inferred') else 10.0 for x in header_sizes]
    rsize=[max(10.0,x['size']) if x.get('inferred') else 10.0 for x in result_sizes]
    put(page, (x0 + 1, 445.8, x1 - 1, 458.1), '№ п/п', hsize[0], 1, 1.0, header_sizes[0]['bold'])
    put(page, (x1 + 2, 445.8, x2 - 2, 458.1), 'Местоположение утечки', hsize[1], 1, 1.0, header_sizes[1]['bold'])
    put(page, (x2 + 2, 445.8, x3 - 2, 458.1), 'Ф.И.О. собственника', hsize[2], 1, 1.0, header_sizes[2]['bold'])

    status = val(form, 'leak_status')
    if status == 'not_detected':
        put(page, (x1 + 2, 461.0, x2 - 2, 473.3), 'Не выявлено', rsize[0], 1, 1.0, result_sizes[0]['bold'])
        put(page, (x2 + 2, 461.0, x3 - 2, 473.3), '—', rsize[1], 1, 1.0, result_sizes[1]['bold'])
    elif status == 'detected':
        put(page, (x0 + 1, 461.0, x1 - 1, 473.3), '1', max(rsize[0],9.0), 1, 1.0)
        put(page, (x1 + 3, 461.0, x2 - 3, 473.3), val(form, 'leak_location'), max(9.0,rsize[0]), 1, 1.0)
        put(page, (x2 + 3, 461.0, x3 - 3, 473.3), val(form, 'leak_owner'), max(9.0,rsize[1]), 1, 1.0)
    elif status == 'not_checked':
        put(page, (x1 + 2, 461.0, x2 - 2, 473.3), 'Проверка не проводилась', max(9.0,rsize[0]), 1, 1.0)
        put(page, (x2 + 2, 461.0, x3 - 2, 473.3), '—', rsize[1], 1, 1.0)


def format_years_value(raw):
    value=str(raw or '').strip()
    match=re.search(r'\d+(?:[,.]\d+)?',value)
    if not match:
        return value
    number_text=match.group(0).replace(',','.')
    try:
        number=float(number_text)
    except ValueError:
        return value
    if not number.is_integer():
        word='года'
        shown=number_text.replace('.',',')
    else:
        n=int(number)
        shown=str(n)
        if 11 <= n % 100 <= 14: word='лет'
        elif n % 10 == 1: word='год'
        elif 2 <= n % 10 <= 4: word='года'
        else: word='лет'
    return f'{shown} {word}'

def overlay_findings_line(doc, form):
    page = doc[8]
    status = val(form, 'gas_status')
    mapped = {
        'not_detected': 'не обнаружено',
        'detected': 'обнаружено',
        'not_checked': 'проверка не проводилась',
    }
    # The original heading uses 12 pt text. Rebuild the complete line instead of
    # replacing only the last phrase with an undersized 7 pt overlay.
    if status in mapped:
        white_redact_region(page, fitz.Rect(103, 400, 565, 420), remove_graphics=False)
        put(page, (106, 402, 562, 419),
            f'5.5.1. Наличие загазованности помещений – {mapped[status]}.',
            12.0, 0, 1.0)

    years = format_years_value(val(form, 'remaining_life_years'))
    if years:
        # Rebuild all three lines at the original 12 pt size so the resource value
        # has exactly the same typographic scale as the surrounding sentence.
        white_redact_region(page, fitz.Rect(75, 548, 565, 594), remove_graphics=False)
        paragraph = (
            'На основании проведённого расчёта (см. Приложение 11) срок возможного\n'
            f'дальнейшего использования ВДГО составляет {years}. Указанный срок не является\n'
            'предельным сроком эксплуатации газопровода.'
        )
        put(page, (78, 550, 563, 593), paragraph, 12.0, 0, 1.22)

def overlay_uzt_tables(doc,form):
    # Capture each source cell's font size before clearing the demonstration values.
    p=doc[27]
    shared_cells={}
    for i in range(1,25):
        row=(i-1)%12; left=i<=12
        base_y=407.4+row*27.84
        xnum=(49,119) if left else (306,374)
        xdia=(120,224) if left else (374,458)
        xthk=(224,286) if left else (458,511)
        fields=[('segment',xnum,(base_y+3,base_y+18)),('diameter',xdia,(base_y-1,base_y+14)),('thickness',xthk,(base_y-1,base_y+14))]
        for key,(x0,x1),(y0,y1) in fields:
            shared_cells[(i,key)]=infer_pdf_style(p,[fitz.Rect(x0+1,y0,x1-1,y1)],10.0)
    clear_words_in_regions(p,[fitz.Rect(48,395,286,740),fitz.Rect(305,395,519,740)])
    for i in range(1,25):
        row=(i-1)%12; left=i<=12
        base_y=407.4+row*27.84
        xnum=(49,119) if left else (306,374)
        xdia=(120,224) if left else (374,458)
        xthk=(224,286) if left else (458,511)
        fields=[('segment',xnum,(base_y+3,base_y+18)),('diameter',xdia,(base_y-1,base_y+14)),('thickness',xthk,(base_y-1,base_y+14))]
        for key,(x0,x1),(y0,y1) in fields:
            text=val(form,f'uzt_shared_{i}_{key}')
            if text:
                style=shared_cells[(i,key)]
                size=max(9.5,style['size']) if style.get('inferred') else 10.0
                minimum=max(9.0,size*0.88)
                while size >= minimum - 0.001:
                    if put(p,(x0+1,y0,x1-1,y1),text,size,1,1.0,style['bold'],style['italic']) >= 0:
                        break
                    size-=0.25
                else:
                    raise ValueError(f'Значение УЗТ для общего участка {i} ({key}) не помещается в ячейку при читаемом размере шрифта. Сократите значение, сохранив фактический смысл.')

    # Apartment measurements table (page 29). The source grid is preserved and values are editable text.
    p=doc[28]
    left_cols=[(100,160),(160,216),(216,270),(270,338)]
    right_cols=[(340,394),(394,459),(459,519),(519,558)]
    keys=['apartment','du25','du20','du15']
    flat_cells={}
    for i in range(1,43):
        row=(i-1)%21; left=i<=21; cols=left_cols if left else right_cols
        y0=120.0+row*14.64-1; y1=y0+13.0
        for key,(x0,x1) in zip(keys,cols):
            flat_cells[(i,key)]=infer_pdf_style(p,[fitz.Rect(x0+1,y0,x1-1,y1)],10.0)
    clear_words_in_regions(p,[fitz.Rect(99,117,338,428),fitz.Rect(340,117,558,428)])
    for i in range(1,43):
        row=(i-1)%21; left=i<=21; cols=left_cols if left else right_cols
        y0=120.0+row*14.64-1; y1=y0+13.0
        for key,(x0,x1) in zip(keys,cols):
            text=val(form,f'uzt_flat_{i}_{key}')
            if text:
                style=flat_cells[(i,key)]
                size=max(9.5,style['size']) if style.get('inferred') else 10.0
                minimum=max(9.0,size*0.88)
                while size >= minimum - 0.001:
                    if put(p,(x0+1,y0,x1-1,y1),text,size,1,1.0,style['bold'],style['italic']) >= 0:
                        break
                    size-=0.25
                else:
                    raise ValueError(f'Значение УЗТ для квартиры/строки {i} ({key}) не помещается в ячейку при читаемом размере шрифта. Проверьте значение и сократите его при необходимости.')

def replace_wall_thickness_values(doc, form):
    """Write top-level Smin/Smax values into the exact value cells on page 7 at 12 pt.

    This geometry-based replacement is more reliable than searching for the sample
    number (2,4 / 3,2), which may already have been changed, split by the PDF font map,
    or formatted differently in an exported copy.
    """
    page=doc[6]
    specs=[
        ('min_thickness', fitz.Rect(400, 608.2, 482, 623.2), fitz.Rect(369.2, 609.75, 495.7, 622.0)),
        ('max_thickness', fitz.Rect(400, 623.3, 482, 638.2), fitz.Rect(369.2, 624.85, 495.7, 637.1)),
    ]
    for key,clear_rect,text_rect in specs:
        clear_words_in_regions(page,[clear_rect])
        text=val(form,key)
        if text:
            if put(page,text_rect,text,12.0,1,1.0,False,False)<0:
                raise ValueError(f'Значение «{key}» не помещается в ячейку толщины стенки. Проверьте значение.')


def redraw_section_6_1_grid(doc):
    """Restore the original 6.1 grid, including the merged parent-cell row."""
    page=doc[9]
    xs=[35.40,86.42,304.75,517.44]
    ys=[100.22,117.86,135.98,183.86,247.34,295.25,343.13,391.01,439.01,486.91,550.39,598.27,646.18,694.18]
    # In the original PDF, the parent row "1. Внутренний газопровод" is merged
    # vertically with the location cell underneath it. Therefore its lower rule is
    # intentionally drawn only in the first and third columns (not through column 2).
    for y in ys:
        if abs(y-135.98)<0.1:
            segments=((xs[0],xs[1]),(xs[2],xs[3]))
        else:
            segments=((xs[0],xs[-1]),)
        for x0,x1 in segments:
            page.draw_line(fitz.Point(x0,y),fitz.Point(x1,y),color=(0,0,0),width=0.48,overlay=True)
    for x in xs:
        page.draw_line(fitz.Point(x,ys[0]),fitz.Point(x,ys[-1]),color=(0,0,0),width=0.48,overlay=True)


def replace_resource_address_sentence(doc,form):
    # The original paragraph is Calibri 12 pt. Rebuild it with the same point size;
    # a previous hard-coded 8 pt value caused a visibly undersized address.
    page=doc[36]
    sentence='установленного по адресу: '+val(form,'address')+','
    clear_words_in_regions(page,[fitz.Rect(76,201,558,220)])
    size=12.0
    while size >= 10.6:
        if put(page,(78,201,558,222),sentence,size,0,1.0) >= 0:
            break
        size-=0.25

def overlay_resource_table(doc,form):
    # Appendix 11 / page 38: never inherit the calculation numbers from the example.
    page=doc[37]
    columns=[(297,334),(337,374),(377,414),(417,454)]
    rows={
        'resource_section':(108,124),
        'resource_kz':(145,163),
        'resource_thickness':(187,204),
        'resource_base_velocity':(229,246),
        'resource_k1':(257,273),
        'resource_k2':(284,301),
        'resource_factor':(319,335),
        'resource_velocity':(360,377),
        'resource_years':(402,419),
    }
    cell_styles={}
    for key,(y0,y1) in rows.items():
        for i,(x0,x1) in enumerate(columns,1):
            cell_styles[(key,i)]=infer_pdf_style(page,[fitz.Rect(x0+1,y0,x1-1,y1)],9.5)
    clear_words_in_regions(page,[fitz.Rect(x0,y0,x1,y1) for y0,y1 in rows.values() for x0,x1 in columns])
    for key,(y0,y1) in rows.items():
        for i,(x0,x1) in enumerate(columns,1):
            text=val(form,f'{key}_{i}')
            if text:
                style=cell_styles[(key,i)]
                size=max(9.0,style['size']) if style.get('inferred') else 9.5
                minimum=max(8.8,size*0.88)
                while size >= minimum - 0.001:
                    if put(page,(x0+1,y0,x1-1,y1),text,size,1,1.0,style['bold'],style['italic']) >= 0:
                        break
                    size-=0.25
                else:
                    raise ValueError(f'Значение Приложения 11 ({key}, позиция {i}) не помещается в ячейку. Проверьте исходные данные и сократите обозначение, сохранив смысл.')

def replace_work_group_sentence(doc, form):
    # The original sentence mixes the date and company name in one fixed line;
    # replace the entire paragraph so longer customer-specific names cannot overlap.
    page=doc[4]
    clear_words_in_regions(page,[fitz.Rect(75,350,562,390)])
    text=(f"Для выполнения работ по техническому диагностированию объекта "
          f"приказом № {val(form,'work_group_order_number')} от {val(form,'work_group_order_date')} г. "
          f"директора {val(form,'executor')} назначена рабочая группа:")
    size=12.0
    while size>=10.5:
        if put(page,(78,350,558,389),text,size,0,1.12)>=0:
            break
        size-=0.25

def replace_specialist_credential_cell(doc, form):
    """Rebuild the credential column in the working-group table without stale/duplicate text."""
    page=doc[4]
    # The first person's right cell has two independently editable certificate blocks;
    # the next row belongs only to the gas technician. Clear all of them before writing.
    clear_words_in_regions(page,[fitz.Rect(171,406,558,495), fitz.Rect(171,495,558,534)])

    def put_fit(text, rect, start_size=11.5, min_size=8.5, label='данные удостоверения'):
        text=str(text or '').strip()
        if not text:
            return
        size=start_size
        while size >= min_size - 0.001:
            if put(page,rect,text,size,0,1.0)>=0:
                return
            size-=0.25
        raise ValueError(f'Поле «{label}» слишком длинное для таблицы состава рабочей группы. Сократите только лишние пояснения, сохранив номер, вид, дату и выдавшую организацию.')

    put_fit(val(form,'specialist_certificate'),(179,408,554,450),11.5,8.5,'удостоверение специалиста II уровня')
    put_fit(val(form,'specialist_additional_certificate'),(179,452,554,493.5),11.5,8.5,'дополнительная квалификация специалиста')
    put_fit('Слесарь по эксплуатации и ремонту газового оборудования,',(179,497,554,510.5),11.0,9.5,'наименование профессии слесаря')
    put_fit(val(form,'technician_certificate'),(179,511,554,532),10.5,8.0,'документ о квалификации слесаря')


def replace_resource_summary(doc, form):
    # Rewrite the whole summary sentence, not just the numeric phrase in a narrow box.
    page=doc[37]
    clear_words_in_regions(page,[fitz.Rect(31,459,558,505)])
    years=format_years_value(val(form,'remaining_life_years'))
    text=('Минимальное из полученных значений срока возможного дальнейшего использования '
          f"ВДГО составляет {years}. Указанный срок не является "
          'предельным сроком эксплуатации газопровода.')
    size=12.0
    while size>=10.6:
        if put(page,(35,459,558,504),text,size,0,1.08)>=0:
            break
        size-=0.25

def rebuild_cover(doc, form):
    """Rebuild the cover to match the original Calibri hierarchy and measured spacing."""
    page = doc[0]
    regions = [
        fitz.Rect(55, 8, 425, 96),
        fitz.Rect(388, 95, 585, 198),
        fitz.Rect(35, 292, 560, 466),
        fitz.Rect(62, 635, 400, 678),
        fitz.Rect(210, 716, 390, 756),
    ]
    for rect in regions:
        page.add_redact_annot(rect, fill=(1, 1, 1))
    try:
        page.apply_redactions(images=2, graphics=2, text=0)
    except TypeError:
        page.apply_redactions()

    executor_legal = val(form, 'executor_legal_name')
    executor = val(form, 'executor')
    director = val(form, 'general_director')
    report_no = val(form, 'report_number')
    date = val(form, 'report_date')
    address = val(form, 'address')
    customer = val(form, 'customer')
    year = val(form, 'report_year')

    # The original cover uses three centered, bold company lines at approximately 20 pt.
    # Force the legal-form break used by the original instead of shrinking the whole title.
    company = executor_legal.strip()
    company = re.sub(r'(?i)^общество с ограниченной ответственностью\s*',
                     'Общество с ограниченной\nответственностью\n', company)
    if company and '\n' not in company and len(company) > 30:
        words = company.split()
        lines, line = [], ''
        for word in words:
            candidate = word if not line else line + ' ' + word
            if _get_pdf_font(True, False)[1].text_length(candidate, fontsize=20.0) <= 300:
                line = candidate
            else:
                if line: lines.append(line)
                line = word
        if line: lines.append(line)
        company = '\n'.join(lines[:3])
    put(page, (105, 14, 475, 94), company, 20.04, 1, 1.40, True)

    # Approval block: original body is 12 pt, with the date below the underline.
    put(page, (395, 98, 558, 114), 'УТВЕРЖДАЮ', 12.0, 1, 1.0)
    put(page, (395, 113, 558, 130), 'Генеральный директор', 12.0, 1, 1.0)
    put(page, (395, 128, 558, 145), executor, 12.0, 1, 1.0)
    put(page, (395, 162, 558, 178), director, 12.0, 1, 1.0, True)
    page.draw_line(fitz.Point(410, 177), fitz.Point(560, 177), color=(0, 0, 0), width=0.6, overlay=True)
    put(page, (405, 180, 510, 196), date + ' г.' if date else '', 12.0, 1, 1.0)

    # Four title lines follow the source PDF's Calibri-Bold 20.04 pt rhythm.
    put(page, (35, 298, 560, 322), 'Заключение № ' + report_no, 20.04, 1, 1.0, True)
    put(page, (35, 326, 560, 351), 'по результатам технического диагностирования', 20.04, 1, 1.0, True)
    put(page, (35, 354, 560, 379), 'внутридомового газового оборудования,', 20.04, 1, 1.0, True)
    put(page, (35, 382, 560, 407), 'установленного по адресу:', 20.04, 1, 1.0, True)
    # Keep the address line break and rhythm from the original cover; long variants wrap safely.
    cover_address = re.sub(r",\s*(ул\.|улица)\s*", lambda match: ',\n' + match.group(1) + ' ', address, count=1, flags=re.I)
    put(page, (35, 410, 560, 468), cover_address, 20.04, 1, 1.40, True)
    put(page, (76, 644, 405, 662), 'Заказчик: ' + customer if customer else '', 12.0, 0, 1.0, True)
    put(page, (255, 727, 365, 745), year + 'г.' if year else '', 12.0, 1, 1.0, True)


def rebuild_scheme_addresses(doc, form):
    """Update address captions embedded in the two scanned schematics without removing the schemes."""
    address = val(form, 'address')
    if not address:
        return
    for page_index, entrance in ((15, 'подъезд 1'), (16, 'подъезд 2')):
        page = doc[page_index]
        # The scheme heading and its address are baked into the illustration. Clear the full
        # caption strip so no fragments of the old address remain, then rebuild four aligned lines.
        white_redact_region(page, fitz.Rect(58, 63, 548, 115), remove_graphics=False)
        for text, y0, y1, size in (
            ('Схема', 64, 75, 8.6),
            ('неразрушающего контроля', 75, 86, 8.6),
            ('внутридомового газового оборудования', 86, 97, 8.6),
        ):
            put(page, (58, y0, 548, y1), text, size, 1, 1.0, False, True)
        caption = f'по адресу: {address} ({entrance})'
        size = 8.1
        while size >= 6.2:
            if put(page, (58, 99, 548, 113), caption, size, 1, 1.0, False, True) >= 0:
                break
            size -= 0.2

def rebuild_running_headers(doc, form):
    """Rebuild repeated report headers so the dynamic address cannot disappear or leave fragments."""
    title = 'Заключение по результатам технического диагностирования внутридомового газового оборудования.'
    address = val(form, 'address')
    material_indices = {n - 1 for n in MATERIAL_PAGES}
    # Page 1 is the dedicated cover; page 2 is an intentionally sparse copyright leaf.
    for index in range(2, len(doc)):
        if index in material_indices:
            continue  # Replaced later by place_material_pages().
        page = doc[index]
        clear_words_in_regions(page, [fitz.Rect(18, 12, 578, 44)])
        put(page, (22, 15, 573, 29), title, 8.0, 1, 1.0)
        if address:
            size = 8.0
            while size >= 7.0:
                if put(page, (22, 29, 573, 43.5), 'Адрес объекта: ' + address, size, 1, 1.0) >= 0:
                    break
                size -= 0.25


def rewrite_next_diagnostic_line(doc, form):
    """Rewrite the entire next-diagnostic bullet line, including old punctuation."""
    page = doc[10]
    region = fitz.Rect(75, 341, 560, 359)
    clear_words_in_regions(page, [region])
    # The source has a drawn underline under the old date; text redaction alone leaves it behind.
    page.draw_rect(region, color=None, fill=(1, 1, 1), overlay=True)
    date_text = val(form, 'next_diagnostic')
    if not date_text:
        return
    phrase = 'провести не позднее ' + date_text.rstrip(' ;,.') + ';'
    size = 12.0
    while size >= 10.0:
        if put(page, (78, 342, 558, 359), phrase, size, 0, 1.0) >= 0:
            break
        size -= 0.4


def rebuild_copyright_footer(doc, form):
    """Rebuild page 2's footer inside one opaque, redacted region."""
    page = doc[1]
    white_redact_region(page, fitz.Rect(25, 697, 568, 736), remove_graphics=True)
    company = val(form, 'executor_legal_name')
    year = val(form, 'report_year')
    if not company or not year:
        return
    text = f'© {company}, {year}'
    size = 12.0
    while size >= 10.5:
        if put(page, (34, 703, 560, 729), text, size, 0, 1.0, True) >= 0:
            break
        size -= 0.25


def compact_specialist_certificate(raw):
    """Return a short number/method/date label for narrow sign-off rows.

    The full certification body belongs in the main working-group and conclusion
    blocks. Protocol footers have room only for the identifying number, method and date.
    """
    text = str(raw or '').strip()
    if not text:
        return ''
    # Do not let accreditation body / organisation text flow into the protocol table.
    prefix = re.split(r'(?i)\b(?:Независимый орган аттестации|ООО\s*[«"]|АНО\s+ДПО|образовательн(?:ая|ой) организац)', text)[0].strip(' ,;')
    m = re.search(r'№\s*([A-Za-zА-ЯЁа-яё0-9./-]+)(?:\s*\(([^)]*)\))?(?:\s+от\s+(\d{1,2}[./]\d{1,2}[./]\d{2,4})\s*(г\.?)?)?', prefix, re.I)
    if not m:
        # Keep a bounded meaningful fragment if the source uses a different format.
        return prefix[:100].rstrip(' ,;')
    number = m.group(1)
    methods = (m.group(2) or '').strip()
    if not methods:
        before = prefix[:m.start()]
        method_match = re.search(r'((?:[А-ЯЁA-Z]{2,8})(?:\s*,\s*[А-ЯЁA-Z]{2,8})*)\s*$', before)
        if method_match:
            methods = method_match.group(1).strip()
    date = m.group(3)
    label = f'№ {number}'
    if methods:
        label += f' ({methods})'
    if date:
        label += f' от {date} г.'
    return label


def rebuild_signoff_block(doc, form, page_index, page40=False):
    """Recreate the complete signature/qualification block so stale numbers cannot remain."""
    page = doc[page_index]
    region = fitz.Rect(28, 546, 562, 663) if page40 else fitz.Rect(72, 460, 562, 610)
    white_redact_region(page, region, remove_graphics=True)
    cert = val(form, 'specialist_certificate')
    specialist = val(form, 'specialist') or val(form, 'specialist_full')
    customer = val(form, 'customer')
    director = val(form, 'customer_director')

    if page40:
        put(page, (40, 550, 320, 564), 'Специалист II-го уровня квалификации', 12.0, 0, 1.0)
        put(page, (40, 565, 398, 577), 'Квалификационное удостоверение:', 12.0, 0, 1.0)
        size = 12.0
        placed_cert = False
        while size >= 8.0:
            if put(page, (40, 578, 398, 596.5), cert, size, 0, 1.0) >= 0:
                placed_cert = True
                break
            size -= 0.25
        if cert and not placed_cert:
            raise ValueError('Данные удостоверения специалиста II уровня слишком длинные для строки подписи. Сократите только оформление записи, не удаляя номер, вид или дату удостоверения.')
        size = 12.0
        placed_name = False
        while size >= 8.0:
            if put(page, (405, 578, 520, 596.5), specialist, size, 1, 1.0) >= 0:
                placed_name = True
                break
            size -= 0.25
        if specialist and not placed_name:
            raise ValueError('ФИО специалиста не помещается в поле подписи. Проверьте инициалы и фамилию.')
        page.draw_line(fitz.Point(282, 598), fitz.Point(383, 598), color=(0,0,0), width=0.55, overlay=True)
        page.draw_line(fitz.Point(404, 598), fitz.Point(520, 598), color=(0,0,0), width=0.55, overlay=True)
        put(page, (300, 600, 365, 612), 'Подпись', 8.0, 1, 1.0)
        put(page, (425, 600, 497, 612), 'Ф.И.О.', 8.0, 1, 1.0)
        put(page, (40, 613, 180, 626), 'Директор', 12.0, 0, 1.0)
        size = 11.0
        while size >= 8.0:
            if put(page, (40, 627, 285, 642), customer, size, 0, 1.0) >= 0:
                break
            size -= 0.4
        size = 11.0
        while size >= 8.0:
            if put(page, (405, 627, 520, 642), director, size, 1, 1.0) >= 0:
                break
            size -= 0.4
        page.draw_line(fitz.Point(282, 645), fitz.Point(383, 645), color=(0,0,0), width=0.55, overlay=True)
        page.draw_line(fitz.Point(404, 645), fitz.Point(520, 645), color=(0,0,0), width=0.55, overlay=True)
        put(page, (300, 647, 365, 659), 'Подпись', 8.0, 1, 1.0)
        put(page, (425, 647, 497, 659), 'Ф.И.О.', 8.0, 1, 1.0)
    else:
        put(page, (83, 462, 355, 476), 'Специалист II-го уровня квалификации', 12.0, 0, 1.0)
        put(page, (83, 477, 420, 490), 'Квалификационное удостоверение:', 12.0, 0, 1.0)
        size = 12.0
        placed_cert = False
        while size >= 8.0:
            if put(page, (83, 492, 420, 519.5), cert, size, 0, 1.03) >= 0:
                placed_cert = True
                break
            size -= 0.25
        if cert and not placed_cert:
            raise ValueError('Данные удостоверения специалиста II уровня слишком длинные для подписи на странице заключительной части. Сократите формат записи, сохранив номер, вид и дату.')
        size = 12.0
        placed_name = False
        while size >= 8.0:
            if put(page, (438, 493, 560, 519.5), specialist, size, 1, 1.0) >= 0:
                placed_name = True
                break
            size -= 0.25
        if specialist and not placed_name:
            raise ValueError('ФИО специалиста не помещается в поле подписи. Проверьте инициалы и фамилию.')
        page.draw_line(fitz.Point(323, 523), fitz.Point(420, 523), color=(0,0,0), width=0.55, overlay=True)
        page.draw_line(fitz.Point(439, 523), fitz.Point(560, 523), color=(0,0,0), width=0.55, overlay=True)
        put(page, (337, 525, 407, 537), 'Подпись', 8.0, 1, 1.0)
        put(page, (462, 525, 535, 537), 'Ф.И.О.', 8.0, 1, 1.0)
        put(page, (83, 544, 300, 558), 'С результатами ознакомлен:', 11.2, 0, 1.0)
        put(page, (83, 559, 180, 572), 'Директор', 11.2, 0, 1.0)
        size = 11.0
        while size >= 8.0:
            if put(page, (83, 573, 310, 588), customer, size, 0, 1.0) >= 0:
                break
            size -= 0.4
        size = 11.0
        while size >= 8.0:
            if put(page, (438, 559, 560, 577), director, size, 1, 1.0) >= 0:
                break
            size -= 0.4
        page.draw_line(fitz.Point(323, 589), fitz.Point(420, 589), color=(0,0,0), width=0.55, overlay=True)
        page.draw_line(fitz.Point(439, 589), fitz.Point(560, 589), color=(0,0,0), width=0.55, overlay=True)
        put(page, (337, 591, 407, 603), 'Подпись', 8.0, 1, 1.0)
        put(page, (462, 591, 535, 603), 'Ф.И.О.', 8.0, 1, 1.0)


def replace_test_result_block(doc, form):
    """Replace the whole explanatory result beneath the leak table."""
    page = doc[8]
    area = fitz.Rect(75, 475.0, 562, 532.8)
    # Infer 12 pt Calibri from the original paragraph before removing it.
    style = infer_pdf_style(page, [fitz.Rect(78, 477, 559, 530.5)], 12.0)
    white_redact_region(page, area, remove_graphics=False)
    text = val(form, 'test_result')
    if not text:
        return
    size = max(10.6, style['size']) if style.get('inferred') else 12.0
    while size >= 10.5:
        if put(page, (78, 484, 559, 532.6), text, size, 0, 1.05, style['bold'], style['italic']) >= 0:
            break
        size -= 0.25


def rebuild_toc_protocol_rows(doc, form):
    """Rebuild appendix protocol captions in the contents table within their cells.

    A generic replacement made a long conclusion number expand past the number field
    and overlap the following caption. Rewrite each entire caption inside the title column.
    """
    page=doc[2]
    number=val(form, 'report_number')
    entries=[
        (fitz.Rect(140, 610.0, 524.0, 637.4), f'Приложение 4 Протокол № {number} по результатам ультразвуковой толщинометрии (УЗТ)'),
        (fitz.Rect(140, 640.8, 524.0, 668.2), f'Приложение 5 Протокол № {number} по результатам ультразвукового контроля (УК) сварных соединений'),
        (fitz.Rect(140, 671.1, 524.0, 698.6), f'Приложение 6 Протокол № {number} по результатам контроля влажности'),
    ]
    for rect, text in entries:
        # Leave the table grid visible; erase only within the text column with a narrow inset.
        page.add_redact_annot(fitz.Rect(rect.x0+1, rect.y0, rect.x1-2, rect.y1), fill=(1,1,1))
    try: page.apply_redactions(images=0, graphics=0, text=0)
    except TypeError: page.apply_redactions()
    for rect,text in entries:
        size=10.8
        while size>=8.5:
            if put(page,(rect.x0+2,rect.y0+0.4,rect.x1-2.5,rect.y1-0.4),text,size,0,1.0)>=0:
                break
            size-=0.25
        else:
            raise ValueError('Не удалось разместить строку Приложения 4–6 в содержании. Проверьте номер заключения.')


def update_optional_appendix_contents(doc, include_schemes, include_photos):
    """Remove TOC entries and in-body claims for optional appendices that are absent."""
    edits = {}
    # These two contents rows are fixed in the source template and can be split into
    # text fragments, so search_for(full_phrase) is unreliable. Redact only their rows.
    if not include_schemes:
        edits.setdefault(2, []).append(fitz.Rect(136, 577.8, 555, 592.0))
        # Section 5.1.3 otherwise claims a diagram is attached when it is not.
        edits.setdefault(6, []).append(fitz.Rect(76, 435.0, 526, 468.0))
    if not include_photos:
        edits.setdefault(2, []).append(fitz.Rect(136, 594.0, 555, 608.2))
    for page_index, rects in edits.items():
        page=doc[page_index]
        for rect in rects:
            page.add_redact_annot(rect, fill=(1,1,1))
        try: page.apply_redactions(images=0, graphics=0, text=0)
        except TypeError: page.apply_redactions()


def renumber_document_pages(doc):
    """Renumber footers after optional appendix and photo pages are removed."""
    for page_index,page in enumerate(doc):
        if page_index == 0:  # Original cover intentionally has no footer number.
            continue
        spans=[]
        for block in page.get_text('dict').get('blocks',[]):
            if block.get('type') != 0:
                continue
            for line in block.get('lines',[]):
                for span in line.get('spans',[]):
                    text=str(span.get('text') or '').strip()
                    rect=fitz.Rect(span.get('bbox',(0,0,0,0)))
                    if rect.y0 >= 785 and rect.y1 <= page.rect.height-15 and re.fullmatch(r'\d+',text):
                        spans.append((rect,text))
        # Keep the template's own horizontal alignment per page; supplemental photo
        # sheets have no pre-existing number and use the page center.
        if spans:
            centers=[(r.x0+r.x1)/2 for r,_ in spans]
            center_x=sum(centers)/len(centers)
            for rect,_text in spans:
                page.add_redact_annot(rect,fill=(1,1,1))
            try: page.apply_redactions(images=0,graphics=0,text=0)
            except TypeError: page.apply_redactions()
        else:
            center_x=page.rect.width/2
        label=str(page_index+1)
        font=fitz.Font('tiro')
        width=font.text_length(label,fontsize=11.04)
        page.insert_text((center_x-width/2,805.0),label,fontname='tiro',fontsize=11.04,color=(0,0,0),overlay=True)


def delete_optional_pages(doc, page_indices):
    """Delete original page indexes in descending order after all page-specific edits."""
    for page_index in sorted(set(page_indices), reverse=True):
        if 0 <= page_index < len(doc):
            doc.delete_page(page_index)


def prepare_workforce_schemes(form, files):
    """Decode selected CAD previews passed by the authenticated parent page.

    The browser rasterizes the current SVG preview to PNG. This keeps the VDGO
    generator independent from the Node workforce storage and ensures that the
    exact checked CAD version is embedded in both PDF and DOCX exports.
    """
    raw = str(form.get('workforce_schemes_json') or '').strip()
    if not raw:
        return []
    if len(raw.encode('utf-8')) > MAX_WORKFORCE_SCHEMES_JSON_BYTES:
        raise ValueError('Общий размер выбранных CAD-схем превышает 180 МБ. Уменьшите количество схем и повторите экспорт.')
    try:
        entries = json.loads(raw)
    except Exception as exc:
        raise ValueError('Не удалось прочитать список CAD-схем для пункта 7. Обновите страницу заключения и повторите экспорт.') from exc
    if not isinstance(entries, list):
        raise ValueError('Список CAD-схем пункта 7 имеет неверный формат.')
    if len(entries) > 40:
        raise ValueError('За один раз можно включить не более 40 схем в пункт 7.')

    prepared = []
    total_bytes = 0
    for index, entry in enumerate(entries, 1):
        if not isinstance(entry, dict):
            raise ValueError(f'Схема № {index}: неверная запись вложения.')
        encoded = str(entry.get('pngBase64') or '')
        if not encoded or len(encoded) > 16 * 1024 * 1024:
            raise ValueError(f'Схема № {index}: PNG пустой или превышает 12 МБ.')
        try:
            payload = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise ValueError(f'Схема № {index}: повреждённые данные изображения.') from exc
        total_bytes += len(payload)
        if len(payload) > 12 * 1024 * 1024 or total_bytes > 128 * 1024 * 1024:
            raise ValueError('Общий размер CAD-вложений пункта 7 превышает допустимый лимит.')
        target = UPLOADS / f'workforce_scheme_{uuid.uuid4().hex}.png'
        try:
            target.write_bytes(payload)
            with Image.open(target) as image:
                if image.format != 'PNG' or image.width < 150 or image.height < 150:
                    raise ValueError(f'Схема № {index}: изображение должно быть PNG не менее 150×150 пикселей.')
                if image.width > 12000 or image.height > 12000:
                    raise ValueError(f'Схема № {index}: слишком большое разрешение изображения.')
                image.verify()
        except ValueError:
            target.unlink(missing_ok=True)
            raise
        except Exception as exc:
            target.unlink(missing_ok=True)
            raise ValueError(f'Схема № {index}: не удалось проверить PNG-вложение.') from exc

        def safe_meta(key, limit=180):
            value = str(entry.get(key) or '').replace('\x00', ' ')
            return re.sub(r'\s+', ' ', value).strip()[:limit]

        name = f'workforce_scheme_{index}'
        files[name] = str(target)
        prepared.append({
            'path': str(target),
            'street': safe_meta('street', 160),
            'address': safe_meta('address', 80),
            'userName': safe_meta('userName', 120),
            'submittedAt': safe_meta('submittedAt', 40),
            'reportId': safe_meta('id', 80),
            'status': safe_meta('status', 32),
        })
    return prepared


def append_workforce_scheme_pages(doc, schemes, form):
    """Insert every selected field scheme into section 7 of the final document."""
    if not schemes:
        return
    # Page 31 is the first attachment sheet (Appendix 6) in the source template.
    # Insert the field-generated schemes immediately before that block so they
    # physically belong to Section 7, not as unrelated pages after signatures.
    insertion_index = next(
        (index for index, page in enumerate(doc) if 'Приложение 6' in page.get_text()),
        min(30, len(doc))
    )
    report_number = val(form, 'report_number')
    report_address = val(form, 'address')
    page_width, page_height = 595.32, 841.92
    for offset, scheme in enumerate(schemes):
        page = doc.new_page(pno=insertion_index + offset, width=page_width, height=page_height)
        page.draw_rect(page.rect, color=None, fill=(1, 1, 1), overlay=True)
        put(page, (42, 18, 553, 32),
            f'Заключение № {report_number} по результатам технического диагностирования внутридомового газового оборудования.',
            8.0, 1, 1.0)
        put(page, (42, 34, 553, 48), 'Адрес объекта: ' + report_address, 8.0, 1, 1.0)
        heading = '7. Актуальные схемы, удостоверения и акты' if offset == 0 else '7. Актуальные схемы, удостоверения и акты (продолжение)'
        put(page, (42, 61, 553, 84), heading, 14.0, 1, 1.0, True)
        street = scheme.get('street') or 'Улица не указана'
        house = scheme.get('address') or '—'
        put(page, (42, 91, 553, 112), f'Схема по адресу: {street}, дом {house}', 12.0, 1, 1.0, True)
        details = []
        if scheme.get('userName'):
            details.append('Слесарь: ' + scheme['userName'])
        if scheme.get('submittedAt'):
            details.append('Отчёт отправлен: ' + scheme['submittedAt'])
        if scheme.get('status') == 'accepted':
            details.append('Статус: принята приёмщиком')
        if details:
            put(page, (42, 116, 553, 134), ' · '.join(details), 8.5, 0, 1.0)
        image_path = Path(scheme['path'])
        try:
            with Image.open(image_path) as image:
                image_width, image_height = image.size
        except Exception as exc:
            raise ValueError(f'Не удалось прочитать CAD-схему {street}, дом {house}: {exc}') from exc
        image_bounds = fitz.Rect(44, 145, 551, 770)
        scale = min(image_bounds.width / image_width, image_bounds.height / image_height)
        draw_width, draw_height = image_width * scale, image_height * scale
        image_rect = fitz.Rect(
            image_bounds.x0 + (image_bounds.width - draw_width) / 2,
            image_bounds.y0 + (image_bounds.height - draw_height) / 2,
            image_bounds.x0 + (image_bounds.width + draw_width) / 2,
            image_bounds.y0 + (image_bounds.height + draw_height) / 2,
        )
        page.draw_rect(image_bounds, color=(0.72, 0.77, 0.83), width=0.7, overlay=True)
        page.insert_image(image_rect, filename=str(image_path), keep_proportion=False, overlay=True)


def build_pdf(form, photo_paths, workforce_schemes=None):
    # Text is written directly as embedded PDF text objects; no raster text queues exist.
    _FITZ_FONT_CACHE.clear()
    work=OUTPUT/'_work.pdf'; shutil.copy2(TEMPLATE,work); doc=fitz.open(work)
    # Explicit source-to-form mapping. Blank form values erase sample values.
    # Cover page uses larger centered typography than running headers/protocol tables.
    replace_all(doc,SOURCE_VALUES['report_number'],val(form,'report_number'),8,5,skip_pages={0,2})
    replace_all(doc,SOURCE_VALUES['report_date'],val(form,'report_date'),8,5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['address'],val(form,'address'),8,5,skip_pages={0},preserve_prefix=True)
    replace_resource_address_sentence(doc,form)
    replace_on_page(doc,36,'2025 г.',val(form,'measurement_year')+' г.',10.0,8.8)
    # Project-specific entries previously embedded in the source report's working-group page.
    replace_on_page(doc,4,'г. Владимир','',6.8,5.0)
    replace_all(doc,'удостоверение № 826 от 06.02.2025 г., АНО ДПО УТЦ «Профессионал»,',val(form,'technician_certificate'),9.5,7.5,skip_pages={4})
    for key in ('customer','customer_legal_name','customer_director','general_director','specialist','technician'):
        replace_all(doc,SOURCE_VALUES[key],val(form,key),10.5,7.5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['executor'],val(form,'executor'),9.5,7.5,skip_pages={0})
    # The company block on the cover is three centered lines; do not squeeze it into one tiny line.
    replace_all(doc,SOURCE_VALUES['executor_legal_name'],val(form,'executor_legal_name'),10.0,7.5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['customer_address'],val(form,'customer_address'),9.0,7.0,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['customer_phone'],val(form,'customer_phone'),10.0,7.5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['executor_address'],val(form,'executor_address'),9.0,7.0,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['executor_phone'],val(form,'executor_phone'),10.0,7.5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['general_director_full'],val(form,'general_director_full'),10.5,7.5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['specialist_full'],val(form,'specialist_full'),10.5,7.5,skip_pages={0})
    replace_all(doc,SOURCE_VALUES['technician_full'],val(form,'technician_full'),10.5,7.5,skip_pages={0})
    replace_all(doc,'2025г.',(val(form,'report_year')+'г.') if val(form,'report_year') else '',8,5,skip_pages={0})
    # Numeric values are replaced only on the page/field where they belong; never across the entire document.
    replace_on_page(doc,5,SOURCE_VALUES['pipe_length'],val(form,'pipe_length'),8,5)
    replace_on_page(doc,5,SOURCE_VALUES['pressure'],val(form,'pressure'),8,5)
    # The next-diagnostic bullet is rewritten as a complete line to remove old punctuation.
    replace_all(doc,SOURCE_VALUES['test_pressure'],val(form,'test_pressure'),9.5,7.5)
    # The note below the leak table is rewritten within a single page-local region below.
    # Fields on the UZT protocol cover must never retain example instrument metadata.
    replace_group_on_page(doc,27,'ТУЗ-2',val(form,'uzt_device_model'),10.0,8.8,fitz.Rect(411,269,463,289),1)
    replace_group_on_page(doc,27,'5950',val(form,'uzt_device_serial'),10.0,8.8,fitz.Rect(249,299,303,319),1)
    replace_group_on_page(doc,27,'13.10.2024 г.',val(form,'uzt_calibration_date'),10.0,8.8,fitz.Rect(429,299,527,319),1)
    # Appendix 5 has a separate flaw detector. These fields are independent from UZT.
    uk_page=doc[29]
    uk_meta_rects = {
        'uk_device_model': fitz.Rect(397,282,523,304),
        'uk_device_serial': fitz.Rect(238,312,295,334),
        'uk_calibration_date': fitz.Rect(434,312,515,334),
    }
    uk_meta_styles = {key: infer_pdf_style(uk_page, [rect], 10.5) for key, rect in uk_meta_rects.items()}
    uk_table_fields = [
        ('uk_joint_number',(39,408.9,121,421.3),8.5),
        ('uk_material_description',(123,408.9,243,421.3),8.0),
        ('uk_sensitivity',(245,408.9,321,421.3),8.0),
        ('uk_defect_description',(323,408.9,450,421.3),7.8),
        ('uk_result',(454,408.9,514,421.3),8.0),
    ]
    uk_table_styles = {field: infer_pdf_style(uk_page, [fitz.Rect(rect)], size)
                       for field, rect, size in uk_table_fields}
    clear_words_in_regions(uk_page,[
        fitz.Rect(397,282,523,304), fitz.Rect(238,312,295,334), fitz.Rect(434,312,515,334),
        # Editable example protocol result row and its footnote.
        fitz.Rect(38,408,122,426), fitz.Rect(122,408,244,426), fitz.Rect(244,408,322,426),
        fitz.Rect(321,408,452,426), fitz.Rect(452,408,516,426), fitz.Rect(34,425,230,440)
    ])
    for key, rect in uk_meta_rects.items():
        style = uk_meta_styles[key]
        base = style['size'] if style.get('inferred') else 10.5
        minimum = max(9.3, base * 0.88)
        size_try = base
        while size_try >= minimum:
            if put(uk_page, rect, val(form, key), size_try, 1, 1.0, style['bold'], style['italic']) >= 0:
                break
            size_try -= 0.25
    # These sample results are editable fields; keep their font close to the original
    # 11 pt table text. If a very long value is provided, only modest shrinking is allowed.
    for field,rect,default_size in uk_table_fields:
        inferred = uk_table_styles[field]
        size_try = max(9.5, inferred['size']) if inferred.get('inferred') else max(9.5, default_size)
        minimum_size = max(9.0, size_try * 0.88)
        while size_try >= minimum_size - 0.001:
            if put(uk_page,rect,val(form,field),size_try,1,1.0,inferred['bold'],inferred['italic'])>=0:
                break
            size_try-=0.25
    accessibility=val(form,'uk_accessibility_percent')
    footnote=(f'Доступность контроля сварного соединения — {accessibility}%.') if accessibility else ''
    put(uk_page,(35,427,410,439),footnote,8.0,0,1.0)
    # Compact protocol signature rows must never receive the full accreditation sentence:
    # it is too long and was previously spilling over table/body content on printed pages 15,
    # 29 and 30. The full certificate is written only in the dedicated blocks below.
    short_certificate = compact_specialist_certificate(val(form, 'specialist_certificate'))
    for old_credential in ('№ 0039-11-28361 (УК, ВИК) от 07.07.2023 г.','№ 0039-11-28361 от 07.07.2023 г.'):
        replace_all(doc,old_credential,short_certificate,9.0,7.2,skip_pages={4,10,39})
    replace_work_group_sentence(doc,form)
    rewrite_next_diagnostic_line(doc,form)
    replace_specialist_credential_cell(doc,form)
    overlay_uzt_tables(doc,form)
    defects=[]
    for i,d in enumerate(DEFECTS,1):
        defects.append({'id':d['id'],'enabled':val(form,f'defect_{i}_enabled','')=='1','location':val(form,f'defect_{i}_location'),'defect':val(form,f'defect_{i}_text'),'recommendation':val(form,f'defect_{i}_recommendation')})
    overlay_defects(doc,defects)
    redraw_section_6_1_grid(doc)
    overlay_valve_table(doc,form)
    rebuild_leak_table(doc,form)
    replace_test_result_block(doc,form)
    overlay_findings_line(doc,form)
    overlay_resource_table(doc,form)
    replace_resource_summary(doc,form)
    replace_wall_thickness_values(doc,form)
    # Appendix 11 includes two free-text facts outside its editable calculation table.
    replace_on_page(doc,36,'0,03 кгс/см2',val(form,'resource_working_pressure')+' кгс/см²',10.0,8.8)
    replace_on_page(doc,37,'А.Д. Степанов',val(form,'resource_calculated_by'),10.0,8.8)
    # Section 5.4 has a conclusion for the valve inspection. Rebuild the full paragraph
    # area and add an explicit prefix; do not place an ambiguous "overall conclusion" here.
    p=doc[8]
    # The original 5.4 table ends at y≈355 pt. Keep the result paragraph wholly below
    # that border and above section 5.5; never let a long conclusion write over the grid.
    white_redact_region(p,fitz.Rect(75,358,562,389),remove_graphics=False)
    valve_conclusion=val(form,'conclusion_text')
    if valve_conclusion:
        text='Вывод: '+valve_conclusion
        placed=False
        size=12.0
        # Use the original readable size where possible. Only a small reduction is allowed
        # in the fixed 5.4 note area; longer text is moved intact to a continuation page.
        while size>=9.0-0.001:
            if put(p,(78,360,559,388.5),text,size,0,1.0)>=0:
                placed=True
                break
            size-=0.25
        if not placed:
            extra=doc.new_page(width=595.32,height=841.92)
            put(extra,(42,35,553,58),'Раздел 5.4. Продолжение вывода по результатам обследования арматуры',12,1,1.0,True)
            rc=put(extra,(42,72,553,790),text,11.5,0,1.15)
            if rc<0:
                raise ValueError('Не удалось разместить текст вывода по арматуре даже на отдельной странице.')
    rebuild_cover(doc,form)
    rebuild_running_headers(doc,form)
    rebuild_copyright_footer(doc,form)
    rebuild_signoff_block(doc,form,10,page40=False)
    rebuild_signoff_block(doc,form,39,page40=True)
    temp_photos, extra_photo_paths, photo_pages_to_remove=place_photos(doc,photo_paths)
    temp_materials, material_pages_to_remove=place_material_pages(doc,form,photo_paths)
    temp_extra_photos=append_extra_photo_pages(doc,extra_photo_paths,form)
    has_scheme=any(bool(photo_paths.get(f'material_page_{n}')) for n in (16,17))
    has_photos=bool(_ordered_uploaded_photos(photo_paths))
    rebuild_toc_protocol_rows(doc,form)
    update_optional_appendix_contents(doc,has_scheme,has_photos)
    delete_optional_pages(doc,photo_pages_to_remove + material_pages_to_remove)
    append_workforce_scheme_pages(doc, workforce_schemes or [], form)
    renumber_document_pages(doc)
    add_searchable_text_layer(doc)
    out=OUTPUT/'generated.pdf'
    doc.save(out,garbage=4,deflate=True); doc.close()
    _FITZ_FONT_CACHE.clear()
    for temp_photo in temp_photos + temp_materials + temp_extra_photos:
        try: temp_photo.unlink(missing_ok=True)
        except Exception: pass
    try: work.unlink()
    except: pass
    return out

# These fields carry structured attachment data, not user-entered prose. They have
# their own strict schema, image-size, and total-request limits in
# prepare_workforce_schemes()/parse_form(); the ordinary 500-character text-field
# limit must never be applied to their JSON/base64 payload.
STRUCTURED_PAYLOAD_FIELDS = frozenset({'workforce_schemes_json'})
MAX_WORKFORCE_SCHEMES_JSON_BYTES = 180 * 1024 * 1024


def is_structured_payload_field(key):
    """Recognize the CAD JSON field despite harmless multipart naming variations."""
    normalized = str(key or '').strip().casefold()
    # Some form serializers append [] to array-like hidden inputs. Remove only
    # that conventional suffix; do not broadly exempt similarly named fields.
    while normalized.endswith('[]'):
        normalized = normalized[:-2].rstrip()
    # Accept a wrapper prefix such as form[workforce_schemes_json], while still
    # requiring the exact field token at the end of the name.
    normalized = re.sub(r'^.*\[([^\[\]]+)\]$', r'\1', normalized)
    return normalized in STRUCTURED_PAYLOAD_FIELDS


def normalize_structured_form_field_names(form):
    """Canonicalize recognized structured field aliases before all downstream handling."""
    aliases = [key for key in list(form) if is_structured_payload_field(key) and key != 'workforce_schemes_json']
    for key in aliases:
        if 'workforce_schemes_json' not in form:
            form['workforce_schemes_json'] = form[key]
        del form[key]
    return form


def form_field_length_issues(form):
    """Return excessive free-text fields while ignoring bounded structured payloads."""
    issues = []
    for key, value in form.items():
        if is_structured_payload_field(key):
            continue
        text = str(value or '').strip()
        limit = 700 if key == 'conclusion_text' else (450 if key == 'test_result' else (900 if '_text' in key or '_recommendation' in key else 500))
        if len(text) > limit:
            issues.append(f'Поле «{key}» слишком длинное (максимум {limit} символов)')
    return issues


def validate_form(form, files):
    corrupted=[key for key,value in form.items() if isinstance(value,str) and '\ufffd' in value]
    if corrupted:
        raise ValueError('Обнаружены повреждённые символы кодировки в полях: '+', '.join(corrupted[:12])+'. Исправьте текст непосредственно в форме, не вставляйте данные из повреждённого PDF.')
    labels = {
        'report_number':'Номер заключения','report_date':'Дата заключения','report_year':'Год отчёта',
        'address':'Адрес объекта','customer':'Заказчик','customer_legal_name':'Полное наименование заказчика','customer_address':'Адрес заказчика',
        'customer_phone':'Телефон заказчика','customer_director':'Директор заказчика',
        'executor':'Исполнитель','executor_legal_name':'Полное наименование исполнителя',
        'executor_address':'Юридический адрес исполнителя','executor_phone':'Телефон исполнителя',
        'general_director':'Инициалы генерального директора','general_director_full':'ФИО генерального директора',
        'specialist':'Инициалы специалиста','specialist_full':'ФИО специалиста',
        'technician':'Инициалы слесаря','technician_full':'ФИО слесаря',
        'pipe_length':'Протяжённость газопровода','pressure':'Разрешённое давление',
        'min_thickness':'Минимальная толщина стенки','max_thickness':'Максимальная толщина стенки',
        'next_diagnostic':'Дата следующего диагностирования','test_result':'Результат проверки герметичности',
        'test_pressure':'Испытательное давление','remaining_life_years':'Остаточный ресурс','gas_status':'Результат проверки загазованности помещений','leak_status':'Результат проверки утечек',
        'conclusion_text':'Итоговый вывод по результатам проверки (вручную)','uzt_device_model':'Тип/модель толщиномера УЗТ','uzt_device_serial':'Заводской номер толщиномера УЗТ','uzt_calibration_date':'Дата поверки толщиномера УЗТ','specialist_certificate':'Данные действующего удостоверения специалиста (номер, вид, дата)',
        'work_group_order_date':'Дата приказа о назначении рабочей группы','work_group_order_number':'Номер приказа о назначении рабочей группы','technician_certificate':'Документ о квалификации слесаря (номер, дата, учебный центр)','specialist_additional_certificate':'Дополнительная квалификация в строке специалиста (или явно «не относится»)','resource_working_pressure':'Рабочее давление в расчёте Приложения 11','resource_calculated_by':'ФИО лица, выполнившего расчёт остаточного ресурса',
        'uk_device_model':'Тип/модель дефектоскопа (Приложение 5)',
        'uk_device_serial':'Заводской номер дефектоскопа (Приложение 5)',
        'uk_calibration_date':'Дата поверки дефектоскопа (Приложение 5)',
        'uk_joint_number':'Номер сварного соединения / участка контроля (Приложение 5)',
        'uk_material_description':'Материал, диаметр и толщина стыкуемых элементов (Приложение 5)',
        'uk_sensitivity':'Предельная чувствительность контроля (Приложение 5)',
        'uk_defect_description':'Описание обнаруженных дефектов / фактический результат (Приложение 5)',
        'uk_result':'Оценка результатов контроля (Приложение 5)',
        'uk_accessibility_percent':'Доступность контроля сварного соединения, % (Приложение 5)'
    }
    labels['measurement_year']='Год проведения замеров толщины стенок'
    resource_names={'resource_section':'Номер участка для расчёта','resource_kz':'Коэффициент запаса','resource_thickness':'Минимальная толщина стенки для расчёта','resource_base_velocity':'Базовая скорость коррозии','resource_k1':'Коэффициент К1','resource_k2':'Коэффициент К2','resource_factor':'Коэффициент условий эксплуатации Ку.з.','resource_velocity':'Условная скорость коррозии','resource_years':'Расчётный остаточный ресурс по участку'}
    for i in range(1,5):
        for key,label in resource_names.items(): labels[f'{key}_{i}']=f'Приложение 11, позиция {i}: {label}'
    labels['template_review_confirm']='Подтверждение проверки итогового документа и неизменяемых разделов'
    labels['photo_content_confirm']='Подтверждение: в фотослоты загружены только разрешённые фото объекта, без SCADA/экранов, удостоверений и актов'
    missing = [label for key,label in labels.items() if not val(form,key)]
    # Prevent obvious throwaway placeholders from being printed as formal company/certificate data.
    meaningful_text_fields = [
        ('customer', 'Заказчик (краткое наименование)', 4),
        ('customer_legal_name', 'Полное наименование заказчика', 8),
        ('executor', 'Исполнитель (краткое наименование)', 4),
        ('executor_legal_name', 'Полное наименование исполнителя', 8),
        ('specialist_full', 'ФИО специалиста', 5),
        ('customer_director', 'Директор заказчика', 5),
        ('general_director_full', 'ФИО генерального директора', 5),
        ('technician_full', 'ФИО слесаря', 5),
    ]
    for key, label, minimum in meaningful_text_fields:
        text = re.sub(r'\s+', ' ', val(form, key)).strip()
        if text and (len(text) < minimum or not re.search(r'[A-Za-zА-Яа-яЁё]', text)):
            missing.append(f'Поле «{label}» выглядит незаполненным или содержит тестовый текст. Укажите фактические данные.')
    # Server-side checkbox validation is stricter than merely receiving a non-empty value.
    for check_key, check_label in [('template_review_confirm', labels['template_review_confirm']), ('photo_content_confirm', labels['photo_content_confirm'])]:
        if val(form,check_key) != '1' and check_label not in missing:
            missing.append(check_label)
    for page_number, meta in MATERIAL_PAGES.items():
        has_file=bool(files.get(f'material_page_{page_number}'))
        excluded=val(form,f'exclude_material_page_{page_number}')=='1'
        if has_file and excluded:
            missing.append(f'Страница {page_number}: либо загрузите актуальный документ, либо отметьте «Не включать», но не оба варианта')
        elif not has_file and not excluded and not meta.get('optional'):
            missing.append(f'Страница {page_number} ({meta["description"]}): загрузите актуальный документ или явно отметьте «Не включать»')
    allowed_choices={'finding_status':{'defects','none'},'gas_status':{'not_detected','detected','not_checked'},'leak_status':{'not_detected','detected','not_checked'}}
    for key,allowed in allowed_choices.items():
        if val(form,key) and val(form,key) not in allowed:
            missing.append(f'Недопустимое значение в поле «{labels.get(key,key)}»')
    # Reject oversized free text: PDF fields have fixed geometry and must remain readable.
    # Binary/structured attachment JSON is validated separately by prepare_workforce_schemes.
    missing.extend(form_field_length_issues(form))
    if not val(form,'finding_status'):
        missing.append('Вывод по результатам обследования (выберите явно)')
    # Narrative and credential fields must contain real-world data, not one-word test strings.
    short_result = re.sub(r'\s+', ' ', val(form, 'test_result')).strip().casefold()
    accepted_short_results = {
        'не выявлено', 'утечек не выявлено', 'проверка не проводилась',
        'не проводилась', 'проверка не выполнялась', 'не применимо'
    }
    if short_result and len(short_result) < 18 and short_result not in accepted_short_results:
        missing.append('Результат проверки герметичности: вместо короткой тестовой строки введите фактическое предложение (например, «Проверка не проводилась по причине отсутствия доступа») или выберите подходящую стандартную формулировку.')
    placeholder_markers = ('тестовый вывод', 'перед использованием подтвердить', 'пример текста', 'введите текст', 'заполните поле', 'lorem ipsum', 'ываыва', 'пвап')
    for key, label in [('test_result', 'Результат проверки герметичности'), ('conclusion_text', 'Вывод по результатам обследования арматуры'), ('executor_legal_name', 'Полное наименование исполнителя'), ('customer_legal_name', 'Полное наименование заказчика')]:
        text = re.sub(r'\s+', ' ', val(form, key)).strip().casefold()
        if any(marker in text for marker in placeholder_markers):
            missing.append(f'Поле «{label}» содержит тестовый или шаблонный текст. Замените его фактическими данными перед формированием PDF.')
    valve_conclusion = re.sub(r'\s+', ' ', val(form, 'conclusion_text')).strip()
    if valve_conclusion and len(valve_conclusion) < 24:
        missing.append('Вывод по обследованию арматуры (раздел 5.4) слишком короткий. Укажите подтверждённую формулировку или фактическое отсутствие замечаний.')
    for key, label, minimum in [
        ('specialist_certificate', 'Удостоверение специалиста II уровня', 18),
        ('technician_certificate', 'Документ о квалификации слесаря', 14),
    ]:
        text = re.sub(r'\s+', ' ', val(form, key)).strip()
        if text and len(text) < minimum:
            missing.append(f'{label}: слишком короткое значение. Укажите данные документа (вид/номер/дата и организация, если применимо), а не тестовый номер.')
    additional = re.sub(r'\s+', ' ', val(form, 'specialist_additional_certificate')).strip().casefold()
    if additional and additional not in {'не относится', 'не применимо', 'н.д.', 'н.д', 'н/д'} and len(additional) < 18:
        missing.append('Дополнительная квалификация специалиста: укажите полные данные документа или явно напишите «не относится».')
    shared_any=False
    for i in range(1,25):
        segment=val(form,f'uzt_shared_{i}_segment'); diameter=val(form,f'uzt_shared_{i}_diameter'); thickness=val(form,f'uzt_shared_{i}_thickness')
        if segment or diameter or thickness:
            shared_any=True
            if not segment: missing.append(f'УЗТ, общий участок {i}: укажите номер/обозначение участка')
            if not diameter: missing.append(f'УЗТ, общий участок {i}: укажите Ду или «н.д.»')
            if not thickness: missing.append(f'УЗТ, общий участок {i}: укажите фактическую толщину или «н.д.»')
    flat_any=False
    for i in range(1,43):
        apt=val(form,f'uzt_flat_{i}_apartment'); measures=[val(form,f'uzt_flat_{i}_{k}') for k in ('du25','du20','du15')]
        if apt or any(measures):
            flat_any=True
            if not apt: missing.append(f'УЗТ по квартирам, строка {i}: укажите номер квартиры')
            if not any(measures): missing.append(f'Квартира {apt}: заполните замеры или укажите «н.д.» в колонках')
    if not shared_any: missing.append('Заполните таблицу УЗТ общих участков (или укажите «н.д.» в фактических полях)')
    if not flat_any: missing.append('Заполните таблицу УЗТ жилых помещений (или укажите «н.д.» в фактических полях)')
    enabled=[]
    for i in range(1,len(DEFECTS)+1):
        if val(form,f'defect_{i}_enabled')=='1':
            enabled.append(i)
            for key,label in [('location','место расположения'),('text','наименование неисправности'),('recommendation','рекомендация')]:
                if not val(form,f'defect_{i}_{key}'):
                    missing.append(f'Дефект {i}: заполните поле «{label}»')
    for i in range(1,4):
        if val(form,f'valve_{i}_enabled')=='1':
            for key,label in [('location','место установки'),('diameter','условный проход'),('type','тип арматуры'),('surface','состояние поверхности'),('outer','наружная герметичность'),('inner','внутренняя герметичность'),('function','работоспособность'),('conclusion','заключение')]:
                if not val(form,f'valve_{i}_{key}'):
                    missing.append(f'Арматура, строка {i}: заполните поле «{label}»')
    if val(form,'leak_status')=='detected' and (not val(form,'leak_location') or not val(form,'leak_owner')):
        missing.append('При выявленной утечке укажите место утечки и ФИО/помещение')
    if val(form,'leak_status')=='detected':
        if len(val(form,'leak_location')) > 34:
            missing.append('Место утечки слишком длинное для строки таблицы. Укажите краткое обозначение участка; подробности внесите в пояснение.')
        if len(val(form,'leak_owner')) > 34:
            missing.append('Ф.И.О. собственника/помещение слишком длинное для строки таблицы. Укажите краткую идентификацию из акта.')
    status=val(form,'finding_status')
    if val(form,'gas_status')=='detected' and status!='defects':
        missing.append('Загазованность отмечена как обнаруженная: итоговая классификация должна учитывать выявленную опасность')
    if val(form,'leak_status')=='detected' and status!='defects':
        missing.append('Утечка отмечена как выявленная: итоговая классификация должна учитывать выявленную неисправность')
    if status=='defects' and not enabled:
        missing.append('Выбран вывод «дефекты выявлены», но не отмечен ни один дефект')
    if status=='none' and enabled:
        missing.append('Выбран вывод «дефекты не выявлены», но отмечены дефекты')
    date_value=val(form,'report_date')
    try:
        parsed_date=datetime.strptime(date_value,'%d.%m.%Y')
        if parsed_date.strftime('%d.%m.%Y')!=date_value: raise ValueError
    except ValueError:
        missing.append('Дата заключения должна быть реальной календарной датой в формате ДД.ММ.ГГГГ')
        parsed_date=None
    if not re.fullmatch(r'\d{4}',val(form,'report_year')):
        missing.append('Год отчёта укажите четырьмя цифрами')
    elif parsed_date and int(val(form,'report_year'))!=parsed_date.year:
        missing.append('Год отчёта должен совпадать с годом даты заключения')
    if not re.fullmatch(r'\d{4}',val(form,'measurement_year')):
        missing.append('Год фактических замеров толщины стенок укажите четырьмя цифрами')
    uzt_cal = val(form, 'uzt_calibration_date').strip()
    if uzt_cal.casefold() not in {'н.д.', 'н.д', 'н/д', 'не применялся', 'не применялась', 'не требуется'}:
        try:
            if datetime.strptime(uzt_cal, '%d.%m.%Y').strftime('%d.%m.%Y') != uzt_cal:
                raise ValueError
        except ValueError:
            missing.append('Дата поверки толщиномера УЗТ должна быть выбрана в календаре либо отмечена как «н.д.»')
    uk_cal=val(form,'uk_calibration_date').strip()
    if uk_cal.casefold() not in {'н.д.','н.д','н/д','не применялся','не применялась','не требуется'}:
        try:
            if datetime.strptime(uk_cal,'%d.%m.%Y').strftime('%d.%m.%Y') != uk_cal: raise ValueError
        except ValueError:
            missing.append('Дата поверки дефектоскопа должна быть в формате ДД.ММ.ГГГГ либо явно отмечена как «не применялся» / «н.д.»')
    try:
        accessibility=float(val(form,'uk_accessibility_percent').replace(',','.'))
        if not math.isfinite(accessibility) or not 0 <= accessibility <= 100:
            missing.append('Доступность контроля сварного соединения должна быть от 0 до 100 процентов')
    except ValueError:
        missing.append('Доступность контроля сварного соединения укажите числом от 0 до 100')
    # Do not impose arbitrary character limits on factual Appendix 5 values.
    # Layout code wraps/shrinks text to the available cell area instead.
    try:
        if datetime.strptime(val(form,'work_group_order_date'),'%d.%m.%Y').strftime('%d.%m.%Y') != val(form,'work_group_order_date'):
            raise ValueError
    except ValueError:
        missing.append('Дата приказа о назначении рабочей группы должна быть реальной датой в формате ДД.ММ.ГГГГ')
    try:
        wp=float(val(form,'resource_working_pressure').replace(',','.'))
        if not math.isfinite(wp) or wp<=0: missing.append('Рабочее давление в расчёте Приложения 11 должно быть числом больше нуля')
    except ValueError:
        missing.append('Рабочее давление в расчёте Приложения 11 укажите числом, например 0,03')
    try:
        length=float(val(form,'pipe_length').replace(',','.')); pressure=float(val(form,'pressure').replace(',','.'))
        if not math.isfinite(length) or length<=0: missing.append('Протяжённость газопровода должна быть конечным числом больше нуля')
        if not math.isfinite(pressure) or pressure<=0: missing.append('Разрешённое давление должно быть конечным числом больше нуля')
    except ValueError:
        missing.append('Протяжённость и давление укажите числами')
    try:
        a=float(val(form,'min_thickness').replace(',','.')); b=float(val(form,'max_thickness').replace(',','.'))
        if not math.isfinite(a) or not math.isfinite(b) or a<=0 or b<=0 or a>b: missing.append('Проверьте толщину стенки: значения должны быть конечными и положительными, минимум не больше максимума')
    except ValueError:
        missing.append('Толщину стенки укажите числами (можно с запятой)')
    resource_year_values=[]
    for i in range(1,5):
        if not val(form,f'resource_section_{i}'):
            missing.append(f'Приложение 11, позиция {i}: укажите номер расчётного участка')
        for key,label in [('resource_kz','коэффициент запаса'),('resource_thickness','толщина стенки'),('resource_base_velocity','базовая скорость коррозии'),('resource_k1','коэффициент К1'),('resource_k2','коэффициент К2'),('resource_factor','коэффициент условий эксплуатации'),('resource_velocity','условная скорость коррозии'),('resource_years','расчётный ресурс')]:
            raw=val(form,f'{key}_{i}').replace(',','.')
            try:
                number=float(raw)
                if not math.isfinite(number) or number<=0: missing.append(f'Приложение 11, позиция {i}: {label} должен быть числом больше нуля')
                elif key=='resource_years': resource_year_values.append(number)
            except ValueError:
                missing.append(f'Приложение 11, позиция {i}: {label} укажите числом')
    # The template reports whole remaining years by truncating the lowest calculated value
    # (e.g. 3.5 years is reported as 3). Flag a mismatch rather than silently fixing it.
    if len(resource_year_values)==4:
        expected_whole_years=math.floor(min(resource_year_values))
        match=re.search(r'\d+(?:[,.]\d+)?',val(form,'remaining_life_years'))
        if match:
            try:
                reported=float(match.group(0).replace(',','.'))
                def year_unit(n):
                    n=int(n)
                    if 11 <= n % 100 <= 14: return 'лет'
                    if n % 10 == 1: return 'год'
                    if 2 <= n % 10 <= 4: return 'года'
                    return 'лет'
                expected_unit=year_unit(expected_whole_years)
                calculated_text=f'{min(resource_year_values):g} {year_unit(math.floor(min(resource_year_values)))}'
                if not math.isfinite(reported) or reported!=expected_whole_years:
                    missing.append(f'Несоответствие Приложения 11: минимальный ресурс среди четырёх участков составляет {calculated_text}, а в итоговом поле нужно указать {expected_whole_years} {expected_unit} (по принятому в исходном бланке округлению вниз). Проверьте расчёт и методику.')
            except ValueError:
                pass
    # Measurement cells accept positive numeric readings or an explicit 'н.д.' only.
    def validate_measurement(value, label):
        raw=str(value or '').strip()
        if not raw: return
        if raw.casefold() in {'н.д.','н.д','н/д','нет данных'}: return
        try:
            number=float(raw.replace(',','.'))
            if not math.isfinite(number) or number<=0:
                missing.append(f'{label}: значение должно быть числом больше нуля или «н.д.»')
        except ValueError:
            missing.append(f'{label}: допустимо число или «н.д.»')
    for i in range(1,201):
        validate_measurement(val(form,f'uzt_shared_{i}_diameter'),f'УЗТ, общий участок {i}, Ду')
        validate_measurement(val(form,f'uzt_shared_{i}_thickness'),f'УЗТ, общий участок {i}, толщина')
    for i in range(1,201):
        for key in ('du25','du20','du15'):
            validate_measurement(val(form,f'uzt_flat_{i}_{key}'),f'УЗТ, квартира {val(form,f"uzt_flat_{i}_apartment") or i}, {key}')
    # A not-performed check cannot support a clean-result classification.
    if status=='none' and (val(form,'gas_status')=='not_checked' or val(form,'leak_status')=='not_checked'):
        missing.append('Нельзя указать «неисправности не выявлены», если проверка загазованности или утечек не проводилась. Выполните проверку либо отразите выявленные неисправности и обоснуйте итоговый вывод.')
    # Basic semantic checks for the most common failed-valve wording.
    if status=='none':
        bad_words=('негерметич','не герметич','неисправ','не работает','не допускается','не соответствует')
        for i in range(1,4):
            if val(form,f'valve_{i}_enabled')=='1':
                for key in ('outer','inner','function','conclusion','surface'):
                    candidate=val(form,f'valve_{i}_{key}').casefold()
                    if any(word in candidate for word in bad_words):
                        missing.append(f'Арматура, строка {i}: текст поля «{key}» указывает на возможную неисправность, но выбрано «неисправности не выявлены». Проверьте классификацию.')
                        break
    # Validate uploads by actual file content, not just the filename extension.
    for name,path in files.items():
        q=Path(path)
        is_material=bool(re.fullmatch(r'material_page_\d+',name))
        try:
            max_bytes=20*1024*1024 if is_material else 15*1024*1024
            if q.stat().st_size > max_bytes:
                missing.append(f'{name}: файл больше {max_bytes//(1024*1024)} МБ')
                continue
            if is_material and q.suffix.lower()=='.pdf':
                with fitz.open(q) as src:
                    if not src.is_pdf or len(src)!=1:
                        missing.append(f'{name}: приложите одностраничный PDF или изображение')
                    elif src[0].rect.width<100 or src[0].rect.height<100:
                        missing.append(f'{name}: страница PDF слишком мала')
            else:
                with Image.open(q) as im:
                    if im.format not in ('JPEG','PNG','WEBP'):
                        missing.append(f'{name}: разрешены только JPEG, PNG, WEBP' + (' или одностраничный PDF' if is_material else ''))
                    if im.width<150 or im.height<150:
                        missing.append(f'{name}: слишком маленькое изображение (минимум 150×150)')
            # Catch obvious disallowed uploads by filename as an extra guard. Visual confirmation
            # remains mandatory because arbitrary camera filenames cannot reveal image content.
            if name.startswith(('photo_','material_page_')) and re.search(r'scada|скада|асу[ _-]*тп|телеметр',q.name,re.I):
                missing.append(f'{name}: файл по имени похож на SCADA/АСУ ТП/телеметрию и не будет приложен. Используйте только актуальную схему, удостоверение, измерительный лист или акт в соответствующем поле.')
            elif name.startswith('photo_') and re.search(r'скрин|монитор|экран|screenshot|screen',q.name,re.I):
                missing.append(f'{name}: экраны и скриншоты нельзя загружать в фотослоты. Используйте только фото физического оборудования, труб и фактических дефектов.')
        except Exception:
            missing.append(f'{name}: файл не удалось прочитать как допустимое изображение или PDF')
    if missing:
        raise ValueError('Перед формированием исправьте:\n• '+'\n• '.join(missing))

def render_page():
    s=(BASE/'templates'/'index.html').read_text(encoding='utf-8')
    blocks=[]
    for i,d in enumerate(DEFECTS,1):
        blocks.append(f'''<div class="defect" id="defectbox_{i}"><div class="defect-head"><input class="check" type="checkbox" id="defect_{i}_enabled" name="defect_{i}_enabled" value="1" onchange="toggleDefect({i})"><label style="margin:0" for="defect_{i}_enabled"><b>{d['id']}</b></label><span class="muted">Заполните фактические данные при наличии дефекта</span></div><div class="grid"><div><label>Место расположения</label><textarea name="defect_{i}_location" placeholder="Например: подъезд, участок, диаметр, ссылка на фото"></textarea></div><div><label>Наименование неисправности</label><textarea name="defect_{i}_text" placeholder="Укажите только фактически установленную неисправность"></textarea></div></div><div style="margin-top:10px"><label>Рекомендации по устранению</label><textarea name="defect_{i}_recommendation" placeholder="Введите согласованную рекомендацию"></textarea></div></div>''')
    valve_blocks=[]
    valve_fields=[('location','Место установки','Например, подъезд № 1'),('diameter','Условный проход Ду, мм','32'),('type','Тип запорной арматуры','Кран шаровый'),('surface','Состояние поверхности','Удовлетворительно / неудовлетворительно'),('outer','Наружная герметичность','Герметична / негерметична / нет данных'),('inner','Внутренняя герметичность','Герметична / негерметична / нет данных'),('function','Проверка работоспособности','Исправна / неисправна / нет данных'),('conclusion','Заключение','Допускается / не допускается / обслуживание')]
    for i in range(1,4):
        parts=[f'''<div class="defect off" id="valvebox_{i}"><div class="defect-head"><input class="check" type="checkbox" id="valve_{i}_enabled" name="valve_{i}_enabled" value="1" onchange="toggleValve({i})"><label style="margin:0" for="valve_{i}_enabled"><b>Строка {i}</b></label><span class="muted">Включить только при наличии фактических данных</span></div><div class="grid3">''']
        for key,label,placeholder in valve_fields:
            parts.append(f'''<div><label>{label}</label><input name="valve_{i}_{key}" value="" placeholder="{htmlmod.escape(placeholder)}"></div>''')
        parts.append('</div></div>')
        valve_blocks.append(''.join(parts))
    uzt_parts=[]
    uzt_parts.append('<details><summary>Таблица УЗТ: общие участки (24 строки)</summary><p class="muted">Значения из демонстрационного файла очищаются. Для каждой используемой строки заполните обозначение, Ду и фактическую толщину. Для отсутствующих данных введите «н.д.».</p><div class="measure-grid">')
    for i in range(1,25):
        uzt_parts.append(f'''<div class="measure-row"><b>Участок {i}</b><input name="uzt_shared_{i}_segment" value="" placeholder="№ участка"><input name="uzt_shared_{i}_diameter" value="" placeholder="Ду, мм"><input name="uzt_shared_{i}_thickness" value="" placeholder="Толщина, мм"></div>''')
    uzt_parts.append('</div><button type="button" class="secondary" onclick="addUztSharedRow()">＋ Добавить участок</button></details>')
    uzt_parts.append('<details><summary>Таблица УЗТ: жилые помещения (42 строки)</summary><p class="muted">Введите номера квартир и замеры по Ду25, Ду20 и Ду15. Пустые ячейки останутся пустыми; для известного отсутствия данных используйте «н.д.».</p><div class="measure-grid">')
    for i in range(1,43):
        uzt_parts.append(f'''<div class="measure-row flat-row"><b>Строка {i}</b><input name="uzt_flat_{i}_apartment" value="" placeholder="№ квартиры"><input name="uzt_flat_{i}_du25" value="" placeholder="Ду25"><input name="uzt_flat_{i}_du20" value="" placeholder="Ду20"><input name="uzt_flat_{i}_du15" value="" placeholder="Ду15"></div>''')
    uzt_parts.append('</div><button type="button" class="secondary" onclick="addUztFlatRow()">＋ Добавить квартиру</button></details>')
    uzt_html=''.join(uzt_parts)
    resource_labels=[('section','Участок для расчёта','Например: 1'),('kz','Коэффициент запаса Кз','0,45'),('thickness','Минимальная толщина стенки, мм','Фактический замер'),('base_velocity','Базовая скорость коррозии, мм/год','Значение из методики'),('k1','Коэффициент К1','Расчётное значение'),('k2','Коэффициент К2','Расчётное значение'),('factor','Ку.з. — коэффициент условий эксплуатации','Результат расчёта'),('velocity','Vу.к. — условная скорость коррозии','Результат расчёта'),('years','Т — ресурс по участку, лет','Результат расчёта')]
    resource_blocks=['<details><summary>Приложение 11: таблица расчёта остаточного ресурса (4 участка)</summary><p class="muted">Исходные коэффициенты и результаты примера очищаются. Внесите значения из утверждённого расчёта для каждого выбранного участка. Приложение ничего не вычисляет и не подставляет числа автоматически.</p><div class="grid">']
    for i in range(1,5):
        resource_blocks.append(f'<div class="defect"><h3>Расчётная позиция {i}</h3><div class="grid3">')
        for key,label,placeholder in resource_labels:
            resource_blocks.append(f'<div><label>{label}</label><input name="resource_{key}_{i}" value="" placeholder="{htmlmod.escape(placeholder)}" required></div>')
        resource_blocks.append('</div></div>')
    resource_blocks.append('</div><div class="grid"><div><label>Рабочее давление в расчёте, кгс/см²</label><input name="resource_working_pressure" value="" placeholder="Фактическое значение из утверждённого расчёта" required></div><div><label>Расчёт произвёл (ФИО)</label><input name="resource_calculated_by" value="" placeholder="ФИО ответственного специалиста" required></div></div></details>')
    resource_html=''.join(resource_blocks)
    # The form starts with one picker. Frontend code appends another picker after each
    # selection, so there is no fixed count of photo inputs.
    photos=['''<div class="photo-slot" id="photo_slot_1"><div class="photo-title"><b>Фото 1</b><span id="photo_name_1">не выбрано</span></div><input type="file" id="photo_1" name="photo_1" accept="image/jpeg,image/png,image/webp" onchange="photoSelected(1,this)"><button type="button" class="remove-photo" onclick="removePhotoRow(1)">Убрать</button></div>''']
    materials=[]
    for page_number, meta in MATERIAL_PAGES.items():
        optional_note = '<p class="muted">Необязательно: если файл не выбран, лист автоматически удаляется из итогового PDF; пример из шаблона не используется.</p>' if meta.get('optional') else ''
        required_marker = '' if meta.get('optional') else ' data-material-required'
        materials.append(f'''<div class="attachment-slot"{required_marker}><div class="attachment-head"><b>Страница {page_number} — {htmlmod.escape(meta['description'])}</b><span id="material_name_{page_number}">файл не выбран</span></div>{optional_note}<input id="material_file_{page_number}" type="file" name="material_page_{page_number}" accept="image/jpeg,image/png,image/webp,application/pdf,.pdf" onchange="toggleMaterialExclusion({page_number},this)"><label class="confirm-row"><input class="check" id="exclude_material_{page_number}" type="checkbox" name="exclude_material_page_{page_number}" value="1" onchange="toggleMaterialFile({page_number},this)"> Не включать эту страницу в текущий отчёт — исходный образец не будет сохранён</label></div>''')
    return s.replace('{{DEFECTS}}',''.join(blocks)).replace('{{VALVES}}',''.join(valve_blocks)).replace('{{UZT_TABLES}}',uzt_html).replace('{{RESOURCE_TABLE}}',resource_html).replace('{{PHOTOS}}',''.join(photos)).replace('{{MATERIAL_PAGES}}',''.join(materials))
PAGE=render_page()

def cleanup_uploaded_files(files):
    for path in files.values():
        try: Path(path).unlink(missing_ok=True)
        except Exception: pass

RU_MONTH_GENITIVE = (
    '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'
)


def _parse_date_input(raw):
    """Accept ISO date-picker values and legacy DD.MM.YYYY JSON values."""
    raw = str(raw or '').strip()
    if not raw:
        return None
    for fmt in ('%Y-%m-%d', '%d.%m.%Y'):
        try:
            parsed = datetime.strptime(raw, fmt)
            if parsed.strftime(fmt) == raw:
                return parsed
        except ValueError:
            pass
    raise ValueError(f'Некорректная дата «{raw}». Выберите дату в календаре.')


def normalize_form_dates(form):
    """Normalize browser date inputs to the Russian format used by the PDF template."""
    for key in ('report_date', 'work_group_order_date', 'uzt_calibration_date', 'uk_calibration_date'):
        if form.get(key + '_nd') == '1':
            form[key] = 'н.д.'
            continue
        raw = str(form.get(key, '') or '').strip()
        if raw in {'н.д.', 'н.д', 'н/д', 'не применялся', 'не применялась', 'не требуется'}:
            form[key] = 'н.д.'
            continue
        if raw:
            parsed = _parse_date_input(raw)
            form[key] = parsed.strftime('%d.%m.%Y')
    next_raw = str(form.get('next_diagnostic', '') or '').strip()
    if next_raw:
        try:
            parsed = _parse_date_input(next_raw)
            form['next_diagnostic'] = f'{parsed.day} {RU_MONTH_GENITIVE[parsed.month]} {parsed.year} года'
        except ValueError:
            # Keep legacy saved JSON compatible when it already contains a Russian date phrase.
            if not re.fullmatch(r'(?:(?:0?[1-9]|[12]\d|3[01])\s+)?(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря) \d{4} года', next_raw.casefold()):
                raise
    return form


def _download_disposition(form: dict[str, str], extension: str) -> str:
    """Build a safe, useful filename for a browser attachment response."""
    def clean(value: object, fallback: str) -> str:
        raw = re.sub(r"[^0-9A-Za-zА-Яа-яЁё._-]+", "_", str(value or "").strip()).strip("._-")
        return raw[:48] or fallback

    report_number = clean(val(form, "report_number"), "bez_nomera")
    report_date = clean(val(form, "report_date"), "bez_daty")
    filename = f"Заключение_{report_number}_{report_date}.{extension}"
    # ASCII fallback is for older clients; filename* preserves Cyrillic safely.
    ascii_number = re.sub(r"[^A-Za-z0-9._-]+", "_", report_number)
    ascii_date = re.sub(r"[^A-Za-z0-9._-]+", "_", report_date)
    fallback = f"Zaklyuchenie_{ascii_number}_{ascii_date}.{extension}"
    return f'attachment; filename="{fallback}"; filename*=UTF-8\'\'{quote(filename, safe="")}'

class Handler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        data=json.dumps(payload,ensure_ascii=False,default=str).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8')
        self.send_header('Content-Length',str(len(data)))
        self.end_headers(); self.wfile.write(data)

    def do_GET(self):
        if self.path in ('/','/index.html','/legacy','/legacy/'):
            data=PAGE.encode('utf-8'); self.send_response(200); self.send_header('Content-Type','text/html; charset=utf-8'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data); return
        if self.path=='/health':
            data=b'{"ok":true,"release":"4.5.11","backendVersion":"5.3.9"}'; self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data); return
        if self.path=='/api/health':
            self._send_json(200, {'status':'ok','backend':'ok','database':database_status(),'version':BACKEND_IMAGE_VERSION,'release':APP_RELEASE})
            return
        if self.path=='/api/reports':
            try:
                self._send_json(200, {'items':recent_reports(limit=12)})
            except Exception as exc:
                self._send_json(503, {'error':'Не удалось прочитать журнал формирования документов', 'detail':str(exc)})
            return
        self.send_error(404)
    def parse_form(self):
        n=int(self.headers.get('Content-Length','0'))
        if n>512*1024*1024:
            raise ValueError('Общий размер запроса превышает 512 МБ. Уменьшите размер изображений и повторите попытку.')
        raw=self.rfile.read(n); ctype=self.headers.get('Content-Type','')
        form={}; files={}
        if ctype.startswith('multipart/form-data'):
            msg=BytesParser(policy=default).parsebytes(b'Content-Type: '+ctype.encode()+b'\r\nMIME-Version: 1.0\r\n\r\n'+raw)
            for part in msg.iter_parts():
                name=part.get_param('name',header='content-disposition')
                if not name: continue
                if is_structured_payload_field(name):
                    name = 'workforce_schemes_json'
                filename=part.get_filename()
                if filename:
                    data=part.get_payload(decode=True) or b''
                    if not data: continue
                    safe=re.sub(r'[^A-Za-z0-9._-]+','_',Path(filename).name)
                    dst=UPLOADS/(uuid.uuid4().hex+'_'+safe); dst.write_bytes(data); files[name]=str(dst)
                else:
                    # Multipart text fields from browsers often omit an explicit charset.
                    # Decode UTF-8 explicitly so Cyrillic values are never silently replaced by ��.
                    payload=part.get_payload(decode=True) or b''
                    charset=part.get_content_charset() or 'utf-8'
                    try:
                        form[name]=payload.decode(charset)
                    except (LookupError, UnicodeDecodeError):
                        form[name]=payload.decode('utf-8',errors='replace')
        else:
            form={k:v[0] for k,v in parse_qs(raw.decode('utf-8'),keep_blank_values=True).items()}
        normalize_structured_form_field_names(form)
        normalize_form_dates(form)
        return form,files
    def do_POST(self):
        if self.path not in ('/generate','/generate_docx','/preview'):
            self.send_error(404); return
        files={}
        try:
            form,files=self.parse_form()
            workforce_schemes=prepare_workforce_schemes(form,files)
            validate_form(form,files)
            if self.path == '/generate_docx':
                pdf_path=build_pdf(form,files,workforce_schemes=workforce_schemes)
                # DOCX export uses normal editable Word paragraphs and tables. Photographs,
                # schematics and authentic scans remain separate image objects in Word.
                out=OUTPUT/'Заключение_редактируемый_текст.docx'
                page_count=pdf_to_docx_editable(pdf_path,out)
                output_format='docx-editable'
                payload=out.read_bytes()
                content_type='application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                disposition=_download_disposition(form, 'docx')
            else:
                out=build_pdf(form,files,workforce_schemes=workforce_schemes); payload=out.read_bytes()
                with fitz.open(out) as generated_doc:
                    page_count=len(generated_doc)
                content_type='application/pdf'
                disposition='inline; filename="preview.pdf"' if self.path=='/preview' else _download_disposition(form, 'pdf')
                output_format='preview' if self.path=='/preview' else 'pdf'
            try:
                record_generation(val(form,'report_number'),val(form,'report_date'),output_format,page_count,out.name)
            except Exception as db_exc:
                print(f'ПРЕДУПРЕЖДЕНИЕ: не удалось записать событие в PostgreSQL: {db_exc}', flush=True)
            self.send_response(200)
            self.send_header('Content-Type',content_type)
            self.send_header('Content-Disposition',disposition)
            self.send_header('Cache-Control','no-store, no-cache, must-revalidate')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Length',str(len(payload)))
            self.end_headers(); self.wfile.write(payload)
        except Exception as e:
            msg=json.dumps({'error':str(e)},ensure_ascii=False).encode('utf-8')
            self.send_response(400 if isinstance(e, ValueError) else 500); self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(msg))); self.end_headers(); self.wfile.write(msg)
        finally:
            cleanup_uploaded_files(files)
    def log_message(self,*args): pass

def create_local_server():
    """Start on a free loopback port. Port 5000 is often occupied by macOS AirPlay or another local service."""
    preferred = int(os.environ.get('VDGO_PORT', '8765'))
    candidates = [preferred] + [p for p in range(preferred + 1, preferred + 31) if p != preferred]
    last_error = None
    for port in candidates:
        try:
            host = os.environ.get('VDGO_HOST', '127.0.0.1')
            server = HTTPServer((host, port), Handler)
            return server, port
        except OSError as exc:
            last_error = exc
    raise OSError(f'Не удалось открыть локальный порт в диапазоне {preferred}–{preferred + 30}. '
                  f'Закройте другой экземпляр приложения или задайте переменную VDGO_PORT. Детали: {last_error}')

if __name__=='__main__':
    if os.environ.get('DATABASE_URL'):
        try:
            init_database(wait_seconds=int(os.environ.get('DB_WAIT_SECONDS', '45')))
        except Exception as exc:
            print(f'ОШИБКА ПОДКЛЮЧЕНИЯ К БАЗЕ ДАННЫХ: {exc}', flush=True)
            if os.environ.get('DB_REQUIRED', '0') == '1':
                raise SystemExit(2)
    try:
        server, port = create_local_server()
    except OSError as exc:
        print(f'ОШИБКА ЗАПУСКА: {exc}')
        input('Нажмите Enter для выхода...')
        raise SystemExit(1)
    docker_mode = os.environ.get('VDGO_DOCKER', '0') == '1'
    no_browser = os.environ.get('VDGO_NO_BROWSER', '0') == '1'
    print('Backend ВДГО запущен.')
    print(f'Внутренний адрес backend: http://127.0.0.1:{port}/health')
    if docker_mode:
        print('Интерфейс ВДГО доступен через общий frontend ScadaProfit: http://localhost:3001/vdgo/.')
    elif no_browser:
        print('React-интерфейс запускается из общего frontend workspace проекта (Vite dev server).')
    else:
        print(f'Адрес приложения: http://127.0.0.1:{port}/')
    print('Не закрывайте это окно, пока работает приложение. Для остановки нажмите Ctrl+C.')
    if not docker_mode and not no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(f'http://127.0.0.1:{port}/')).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('Остановка приложения...')
    finally:
        server.server_close()
