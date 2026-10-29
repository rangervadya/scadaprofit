#!/usr/bin/env python3
"""Render a Qwen-extracted schematic specification to clean SVG, PNG and DXF.

Coordinates in the specification are normalized to a 1000x1000 image-relative drawing area.
This is an approximate reconstruction aid, not an engineering-authoritative CAD model.
"""
from __future__ import annotations
import json, math, sys, traceback
from pathlib import Path
import cairosvg
import ezdxf
from ezdxf import units

SVG_W, SVG_H = 1400.0, 1000.0
# Drawing viewport is fitted to the source photo's aspect ratio to avoid squeezing/stretching geometry.
MAX_DRAW_W, MAX_DRAW_H = 1280.0, 630.0
DRAW_X, DRAW_Y, DRAW_W, DRAW_H = 60.0, 145.0, 1280.0, 630.0
SCALE_X, SCALE_Y = DRAW_W / 1000.0, DRAW_H / 1000.0

def safe_text(value, max_len=160):
    if value is None:
        return ''
    text = ' '.join(str(value).replace('\x00', '').split())
    return text[:max_len]

def n(value, default=0.0, low=-10000.0, high=10000.0):
    try:
        result = float(value)
        if not math.isfinite(result):
            return default
        return min(high, max(low, result))
    except (TypeError, ValueError):
        return default

def xy(x, y):
    return DRAW_X + n(x, low=0, high=1000) * SCALE_X, DRAW_Y + n(y, low=0, high=1000) * SCALE_Y

def esc(s):
    return (safe_text(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;'))

def path_d(points):
    coords = [xy(p[0], p[1]) for p in points if isinstance(p, (list, tuple)) and len(p) >= 2]
    if len(coords) < 2:
        return ''
    return 'M ' + ' L '.join(f'{x:.2f} {y:.2f}' for x, y in coords)

def add_dxf_text(msp, text, x, y, height_px, angle=0, layer='ANNOTATIONS', align='LEFT'):
    text = safe_text(text, 160)
    if not text:
        return
    x_mm = x * 420.0 / SVG_W
    y_mm = (SVG_H - y) * 297.0 / SVG_H
    h_mm = max(1.3, height_px * 297.0 / SVG_H)
    ent = msp.add_text(text, dxfattribs={'height': h_mm, 'rotation': -n(angle), 'layer': layer, 'style': 'Standard'})
    ent.set_placement((x_mm, y_mm), align={'LEFT': ezdxf.enums.TextEntityAlignment.LEFT, 'CENTER': ezdxf.enums.TextEntityAlignment.CENTER, 'RIGHT': ezdxf.enums.TextEntityAlignment.RIGHT}.get(align, ezdxf.enums.TextEntityAlignment.LEFT))

def main(spec_path: Path, out_dir: Path):
    global DRAW_X, DRAW_Y, DRAW_W, DRAW_H, SCALE_X, SCALE_Y
    spec = json.loads(spec_path.read_text(encoding='utf-8'))
    out_dir.mkdir(parents=True, exist_ok=True)
    source_aspect = n(spec.get('sourceAspect'), 1.42, 0.4, 2.5)
    # Preserve relative geometry from the source instead of stretching every drawing to one wide viewport.
    DRAW_W = min(MAX_DRAW_W, MAX_DRAW_H * source_aspect)
    DRAW_H = DRAW_W / source_aspect
    if DRAW_H > MAX_DRAW_H:
        DRAW_H = MAX_DRAW_H
        DRAW_W = DRAW_H * source_aspect
    DRAW_X = (SVG_W - DRAW_W) / 2.0
    DRAW_Y = 145.0 + (MAX_DRAW_H - DRAW_H) / 2.0
    SCALE_X, SCALE_Y = DRAW_W / 1000.0, DRAW_H / 1000.0
    title = safe_text(spec.get('title') or 'СХЕМА ТРУБОПРОВОДА', 100)
    subtitle = safe_text(spec.get('subtitle') or 'Перерисовка по исходному эскизу', 180)
    routes = spec.get('routes') if isinstance(spec.get('routes'), list) else []
    labels = spec.get('labels') if isinstance(spec.get('labels'), list) else []
    symbols = spec.get('symbols') if isinstance(spec.get('symbols'), list) else []
    dimensions = spec.get('dimensions') if isinstance(spec.get('dimensions'), list) else []
    legend = spec.get('legend') if isinstance(spec.get('legend'), list) else []
    if not routes or not any(isinstance(r, dict) and isinstance(r.get('points'), list) and len(r['points']) >= 2 for r in routes):
        raise ValueError('Qwen не описал ни одной линии схемы. Попробуйте режим очистки или повторите с более чётким фото.')
    routes, labels, symbols, dimensions, legend = routes[:400], labels[:160], symbols[:120], dimensions[:120], legend[:8]

    svg = [f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 {SVG_W:.0f} {SVG_H:.0f}">
<rect width="100%" height="100%" fill="#ffffff"/>
<rect x="14" y="14" width="1372" height="972" fill="none" stroke="#000" stroke-width="1.5"/>
<g font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="#000" stroke-linecap="round" stroke-linejoin="round">
<text x="42" y="44" font-size="15" font-weight="bold">{esc(title)}</text>
<text x="42" y="69" font-size="11">{esc(subtitle)}</text>
<line x1="30" y1="91" x2="1370" y2="91" stroke-width="1.1"/>
<rect x="1040" y="25" width="330" height="54" fill="none" stroke-width="1"/>
<text x="1052" y="45" font-size="11">CAD SKETCH CONVERTER · ОФЛАЙН</text>
<text x="1052" y="64" font-size="10">Схема требует инженерной проверки</text>
</g>
<g id="routes" fill="none" stroke="#000" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">''']
    # Routes are drawn as straight-segment polylines; aspect-ratio fitting avoids stretching the source layout.
    dxf = ezdxf.new('R2010')
    dxf.units = units.MM
    dxf.header['$INSUNITS'] = 4
    dxf.header['$MEASUREMENT'] = 1
    dxf.layers.new('PIPE_MAIN', dxfattribs={'color': 7, 'lineweight': 25})
    dxf.layers.new('PIPE_BRANCH', dxfattribs={'color': 7, 'lineweight': 18})
    dxf.layers.new('SYMBOLS', dxfattribs={'color': 7, 'lineweight': 18})
    dxf.layers.new('DIMENSIONS', dxfattribs={'color': 7, 'lineweight': 13})
    dxf.layers.new('ANNOTATIONS', dxfattribs={'color': 7, 'lineweight': 13})
    dxf.layers.new('SHEET', dxfattribs={'color': 7, 'lineweight': 13})
    msp = dxf.modelspace()
    def to_dxf(xp, yp):
        return (xp * 420.0 / SVG_W, (SVG_H - yp) * 297.0 / SVG_H)
    # border + title structures in DXF
    border = [(14,14),(1386,14),(1386,986),(14,986)]
    msp.add_lwpolyline([to_dxf(x,y) for x,y in border], close=True, dxfattribs={'layer':'SHEET'})
    msp.add_line(to_dxf(30,91), to_dxf(1370,91), dxfattribs={'layer':'SHEET'})
    msp.add_lwpolyline([to_dxf(x,y) for x,y in [(1040,25),(1370,25),(1370,79),(1040,79)]], close=True, dxfattribs={'layer':'SHEET'})
    add_dxf_text(msp, title, 42, 44, 15, layer='ANNOTATIONS')
    add_dxf_text(msp, subtitle, 42, 69, 11, layer='ANNOTATIONS')
    add_dxf_text(msp, 'CAD SKETCH CONVERTER - OFFLINE', 1052, 45, 11, layer='ANNOTATIONS')
    add_dxf_text(msp, 'Engineering review required', 1052, 64, 10, layer='ANNOTATIONS')

    for route in routes:
        if not isinstance(route, dict): continue
        points = route.get('points')
        if not isinstance(points, list): continue
        valid = [xy(p[0], p[1]) for p in points if isinstance(p, (list,tuple)) and len(p)>=2]
        if len(valid) < 2: continue
        kind = safe_text(route.get('kind', 'main'), 20).lower()
        width = 2.15 if kind in ('main', 'trunk', 'основная') else 1.45
        layer = 'PIPE_MAIN' if width > 2 else 'PIPE_BRANCH'
        svg.append(f'<polyline points="{" ".join(f"{x:.2f},{y:.2f}" for x,y in valid)}" fill="none" stroke="#000" stroke-width="{width}"/>')
        msp.add_lwpolyline([to_dxf(x,y) for x,y in valid], dxfattribs={'layer':layer})
        rlabel = safe_text(route.get('label'), 40)  # Do not print internal IDs as drawing annotations.
        if rlabel and len(valid) > 2:
            mid = valid[len(valid)//2]
            # route identifier in an outlined label, like a technical drawing callout
            svg.append(f'<circle cx="{mid[0]:.2f}" cy="{mid[1]:.2f}" r="11" fill="#fff" stroke="#000" stroke-width="1.1"/>')
            svg.append(f'<text x="{mid[0]:.2f}" y="{mid[1]+3.8:.2f}" text-anchor="middle" fill="#000" stroke="none" font-family="Arial, DejaVu Sans, sans-serif" font-size="10">{esc(rlabel)}</text>')
            add_dxf_text(msp, rlabel, mid[0], mid[1]-2, 10, layer='ANNOTATIONS', align='CENTER')

    for dim in dimensions:
        if not isinstance(dim, dict): continue
        x1=n(dim.get('x1'),low=0,high=1000); y1=n(dim.get('y1'),low=0,high=1000)
        x2=n(dim.get('x2'),low=0,high=1000); y2=n(dim.get('y2'),low=0,high=1000)
        a=xy(x1,y1); b=xy(x2,y2)
        txt=safe_text(dim.get('text'),40)
        svg.append(f'<g fill="none" stroke="#000" stroke-width="0.75"><line x1="{a[0]:.2f}" y1="{a[1]:.2f}" x2="{b[0]:.2f}" y2="{b[1]:.2f}"/><line x1="{a[0]-3:.2f}" y1="{a[1]-4:.2f}" x2="{a[0]+3:.2f}" y2="{a[1]+4:.2f}"/><line x1="{b[0]-3:.2f}" y1="{b[1]-4:.2f}" x2="{b[0]+3:.2f}" y2="{b[1]+4:.2f}"/></g>')
        if txt:
            mx=(a[0]+b[0])/2; my=(a[1]+b[1])/2-5
            svg.append(f'<text x="{mx:.2f}" y="{my:.2f}" text-anchor="middle" fill="#000" stroke="none" font-family="Arial, DejaVu Sans, sans-serif" font-size="10">{esc(txt)}</text>')
            add_dxf_text(msp, txt, mx, my, 10, layer='DIMENSIONS', align='CENTER')
        msp.add_line(to_dxf(*a), to_dxf(*b), dxfattribs={'layer':'DIMENSIONS'})

    for sym in symbols:
        if not isinstance(sym, dict): continue
        x,y=xy(sym.get('x'),sym.get('y'))
        typ=safe_text(sym.get('type','junction'),20).lower()
        label=safe_text(sym.get('label') or sym.get('id'),32)
        if typ in ('valve','клапан','задвижка'):
            pts=[(x-8,y),(x,y-6),(x+8,y),(x,y+6)]
            svg.append(f'<polygon points="{" ".join(f"{px:.2f},{py:.2f}" for px,py in pts)}" fill="#fff" stroke="#000" stroke-width="1.2"/>')
            msp.add_lwpolyline([to_dxf(*p) for p in pts], close=True, dxfattribs={'layer':'SYMBOLS'})
        elif typ in ('pump','насос'):
            svg.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="9" fill="#fff" stroke="#000" stroke-width="1.2"/><path d="M {x-3:.2f} {y-5:.2f} L {x+5:.2f} {y:.2f} L {x-3:.2f} {y+5:.2f} Z" fill="#fff" stroke="#000" stroke-width="1"/>')
            msp.add_circle(to_dxf(x,y), radius=9*420/SVG_W, dxfattribs={'layer':'SYMBOLS'})
            msp.add_lwpolyline([to_dxf(x-3,y-5),to_dxf(x+5,y),to_dxf(x-3,y+5)], close=True, dxfattribs={'layer':'SYMBOLS'})
        elif typ in ('end','конец','terminal'):
            svg.append(f'<line x1="{x-5:.2f}" y1="{y-8:.2f}" x2="{x+5:.2f}" y2="{y+8:.2f}" stroke="#000" stroke-width="1.5"/>')
            msp.add_line(to_dxf(x-5,y-8),to_dxf(x+5,y+8),dxfattribs={'layer':'SYMBOLS'})
        elif typ in ('tank','резервуар','box'):
            svg.append(f'<rect x="{x-8:.2f}" y="{y-6:.2f}" width="16" height="12" fill="#fff" stroke="#000" stroke-width="1.2"/>')
            msp.add_lwpolyline([to_dxf(x-8,y-6),to_dxf(x+8,y-6),to_dxf(x+8,y+6),to_dxf(x-8,y+6)],close=True,dxfattribs={'layer':'SYMBOLS'})
        else:
            svg.append(f'<circle cx="{x:.2f}" cy="{y:.2f}" r="7" fill="#fff" stroke="#000" stroke-width="1.1"/><circle cx="{x:.2f}" cy="{y:.2f}" r="2" fill="#000" stroke="none"/>')
            msp.add_circle(to_dxf(x,y), radius=7*420/SVG_W, dxfattribs={'layer':'SYMBOLS'})
        if label:
            tx,ty=x+12,y-8
            svg.append(f'<text x="{tx:.2f}" y="{ty:.2f}" font-size="10" fill="#000" stroke="none" font-family="Arial, DejaVu Sans, sans-serif">{esc(label)}</text>')
            add_dxf_text(msp,label,tx,ty,10,layer='ANNOTATIONS')

    for item in labels:
        if not isinstance(item, dict): continue
        x,y=xy(item.get('x'),item.get('y'))
        text=safe_text(item.get('text'),160)
        if not text: continue
        angle=n(item.get('angle'),0,-90,90)
        size=n(item.get('size'),10,6,18)
        kind=safe_text(item.get('kind','note'),20).lower()
        if kind in ('node','узел'):
            svg.append(f'<circle cx="{x:.2f}" cy="{y-3:.2f}" r="9" fill="#fff" stroke="#000" stroke-width="1.1"/>')
            svg.append(f'<text x="{x:.2f}" y="{y+0.5:.2f}" font-size="9" text-anchor="middle" fill="#000" stroke="none" font-family="Arial, DejaVu Sans, sans-serif">{esc(text)}</text>')
            add_dxf_text(msp,text,x,y-1,9,layer='ANNOTATIONS',align='CENTER')
        else:
            svg.append(f'<text x="{x:.2f}" y="{y:.2f}" font-size="{size:.1f}" fill="#000" stroke="none" font-family="Arial, DejaVu Sans, sans-serif" transform="rotate({angle:.1f} {x:.2f} {y:.2f})">{esc(text)}</text>')
            add_dxf_text(msp,text,x,y,size,angle,layer='DIMENSIONS' if kind in ('dimension','размер') else 'ANNOTATIONS')

    # Legend block and drawing-note box: makes the output look like a plotted CAD sheet.
    legend_y = 854.0
    svg.append('<g fill="none" stroke="#000" stroke-width="0.8"><rect x="36" y="805" width="900" height="150"/><line x1="36" y1="830" x2="936" y2="830"/></g>')
    svg.append('<text x="48" y="822" font-size="11" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none" font-weight="bold">УСЛОВНЫЕ ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ</text>')
    add_dxf_text(msp,'УСЛОВНЫЕ ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ',48,822,11,layer='ANNOTATIONS')
    if not legend:
        legend = ["Чертёж восстановлен приблизительно по изображению.", "Числовые значения и расположение соединений требуют проверки."]
    for i, item in enumerate(legend[:6]):
        txt = safe_text(item.get('text') if isinstance(item,dict) else item,150)
        yy = legend_y + i*18
        svg.append(f'<text x="52" y="{yy:.2f}" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none">{i+1}. {esc(txt)}</text>')
        add_dxf_text(msp,f'{i+1}. {txt}',52,yy,10,layer='ANNOTATIONS')
    svg.append('<rect x="962" y="805" width="405" height="150" fill="none" stroke="#000" stroke-width="0.8"/>')
    svg.append('<text x="980" y="828" font-size="11" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none" font-weight="bold">ОСНОВНАЯ НАДПИСЬ</text>')
    svg.append('<line x1="962" y1="837" x2="1367" y2="837" stroke="#000" stroke-width="0.8"/>')
    svg.append(f'<text x="980" y="862" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none">Наименование: {esc(title[:48])}</text>')
    svg.append('<text x="980" y="885" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none">Формат: A3 · Единицы: мм (условные)</text>')
    svg.append('<text x="980" y="908" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none">Источник: фотография/скан эскиза</text>')
    svg.append('<text x="980" y="931" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#000" stroke="none">Проверить: геометрию, узлы, размеры, подписи</text>')
    for yy, txt in [(828,'ОСНОВНАЯ НАДПИСЬ'),(862,'Наименование: '+title[:48]),(885,'Формат: A3 | Единицы: мм (условные)'),(908,'Источник: фото/скан эскиза'),(931,'Проверить: геометрию, узлы, размеры')]:
        add_dxf_text(msp,txt,980,yy,10 if yy!=828 else 11,layer='ANNOTATIONS')

    svg.append('</g></svg>')
    svg_text='\n'.join(svg)
    svg_path=out_dir/'cad-redraw.svg'
    png_path=out_dir/'cad-redraw.png'
    dxf_path=out_dir/'cad-redraw.dxf'
    svg_path.write_text(svg_text,encoding='utf-8')
    cairosvg.svg2png(bytestring=svg_text.encode('utf-8'),write_to=str(png_path),output_width=1960,output_height=1400)
    dxf.saveas(dxf_path)
    return {'title': title, 'routes': len(routes), 'symbols': len(symbols), 'labels': len(labels), 'dimensions': len(dimensions), 'sheet': 'A3 · CAD-реконструкция (приблизительная)', 'width':1960,'height':1400}

if __name__=='__main__':
    try:
        if len(sys.argv)!=3:
            print('Usage: cad_renderer.py spec.json OUTPUT_DIR',file=sys.stderr); sys.exit(2)
        result=main(Path(sys.argv[1]),Path(sys.argv[2]))
        print(json.dumps({'ok':True,**result},ensure_ascii=False))
    except Exception as exc:
        print(f'CAD renderer error: {exc}',file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
