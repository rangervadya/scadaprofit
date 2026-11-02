#!/usr/bin/env python3
"""CAD Reconstruction Engine: non-destructive candidate geometry extraction.

Geometry and OCR are parallel channels. OCR boxes are NEVER subtracted from the
geometry image, because doing so can sever a pipe under a handwritten label.
Detected segments are candidates; ambiguous joins remain review items.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import re
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps


def load_image(path: str) -> np.ndarray:
    pil = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def normalize_document(bgr: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    """Flatten uneven paper lighting; do not crop or warp content."""
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # Background estimate larger than text/pipe widths.
    k = max(31, (min(h, w) // 12) | 1)
    bg = cv2.medianBlur(gray, k)
    norm = cv2.divide(gray, np.maximum(bg, 1), scale=245)
    norm = np.clip(norm, 0, 255).astype(np.uint8)
    # Mild contrast stretch, not hard binarization.
    p1, p99 = np.percentile(norm, [1, 99])
    if p99 > p1 + 10:
        norm = np.clip((norm.astype(np.float32) - p1) * (255.0 / (p99 - p1)), 0, 255).astype(np.uint8)
    return norm, {"background_kernel": int(k), "contrast_p01": float(p1), "contrast_p99": float(p99)}


def make_ink_mask(bgr: np.ndarray, norm_gray: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    # Blue / violet pen plus dark pencil / black ink. Keep separate categories only
    # as a union; do not classify OCR regions as non-geometry.
    blue = ((h >= 82) & (h <= 155) & (s >= 22) & (v <= 252)).astype(np.uint8) * 255
    dark = (norm_gray < 158).astype(np.uint8) * 255
    combined = cv2.bitwise_or(blue, dark)
    # Remove isolated sensor speckles while retaining thin strokes.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(combined, 8)
    out = np.zeros_like(combined)
    min_area = 2 if combined.size < 2_000_000 else 3
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            out[labels == i] = 255
    return out


def ocr_annotations(image_path: str, gray: np.ndarray) -> list[dict[str, Any]]:
    try:
        import pytesseract
        from pytesseract import Output
        # Tesseract remains advisory. The boxes do not modify the geometry mask.
        data = pytesseract.image_to_data(
            Image.fromarray(gray), lang='rus+eng', config='--oem 1 --psm 11', output_type=Output.DICT
        )
        items = []
        for i, raw in enumerate(data.get('text', [])):
            text = re.sub(r'\s+', ' ', str(raw)).strip()
            try: conf = float(data['conf'][i])
            except Exception: conf = -1
            if not text or conf < 20:
                continue
            x, y = int(data['left'][i]), int(data['top'][i])
            w, h = int(data['width'][i]), int(data['height'][i])
            if w < 2 or h < 2: continue
            items.append({"id": f"T{len(items)+1}", "text": text, "confidence": round(conf, 1),
                          "bbox": {"x": x, "y": y, "w": w, "h": h}, "verified": False,
                          "source": "tesseract"})
        return items
    except Exception as e:
        return [{"id": "OCR_WARNING", "text": "", "confidence": 0,
                 "warning": f"OCR не запущен: {str(e)[:180]}", "verified": False}]


def angle_deg(seg: tuple[float,float,float,float]) -> float:
    x1,y1,x2,y2 = seg
    return math.degrees(math.atan2(y2-y1, x2-x1)) % 180


def seg_length(seg: tuple[float,float,float,float]) -> float:
    return math.hypot(seg[2]-seg[0], seg[3]-seg[1])


def extract_segments(gray: np.ndarray, ink: np.ndarray, annotations: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    h, w = gray.shape[:2]
    # Work at native resolution. LSD detects hand-drawn straight pipe portions;
    # Hough is a secondary source. Keep a broad candidate set for user review.
    lsd_img = cv2.GaussianBlur(gray, (3,3), 0.65)
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    lines = detector.detect(lsd_img)[0]
    raw: list[tuple[float,float,float,float,str,float]] = []
    if lines is not None:
        for row in lines.reshape(-1,4):
            x1,y1,x2,y2 = map(float, row)
            s = (x1,y1,x2,y2); length = seg_length(s)
            if length >= max(18.0, min(w,h)*0.018):
                raw.append((x1,y1,x2,y2,'LSD',length))
    # Hough on the ink mask catches hand-drawn sections missed by LSD.
    min_len = max(24, int(min(w,h)*0.025))
    hp = cv2.HoughLinesP(ink, 1, np.pi/180, threshold=max(18, int(min(w,h)*0.024)),
                         minLineLength=min_len, maxLineGap=max(5, int(min(w,h)*0.010)))
    if hp is not None:
        for row in hp.reshape(-1,4):
            x1,y1,x2,y2 = map(float, row)
            s = (x1,y1,x2,y2); length = seg_length(s)
            if length >= min_len:
                raw.append((x1,y1,x2,y2,'HOUGH',length))

    # Reject candidates which do not pass through enough dark/ink pixels.
    candidates = []
    for x1,y1,x2,y2,source,length in raw:
        n = max(8, int(length/3))
        xs = np.clip(np.rint(np.linspace(x1,x2,n)).astype(int),0,w-1)
        ys = np.clip(np.rint(np.linspace(y1,y2,n)).astype(int),0,h-1)
        support = float(np.mean(ink[ys,xs] > 0))
        if support < 0.18: continue
        overlap = 0.0
        boxes = [a.get('bbox') for a in (annotations or []) if a.get('bbox')]
        for t in np.linspace(0.1, 0.9, 9):
            px = x1 + (x2-x1)*t; py = y1 + (y2-y1)*t
            if any(b['x'] <= px <= b['x']+b['w'] and b['y'] <= py <= b['y']+b['h'] for b in boxes):
                overlap += 1/9
        candidates.append({"x1":x1,"y1":y1,"x2":x2,"y2":y2,"source":source,
                           "length":length,"support":support,"angle":angle_deg((x1,y1,x2,y2)),
                           "ocr_overlap":round(overlap,2),
                           "suggested_role":"text_or_dimension" if overlap >= 0.45 else "line_candidate"})

    # Deduplicate similar/overlapping detections. Prefer higher support and LSD.
    candidates.sort(key=lambda q: (q['support'], q['length'], q['source']=='LSD'), reverse=True)
    kept: list[dict[str,Any]] = []
    for c in candidates:
        duplicate = False
        for k in kept:
            if abs(((c['angle']-k['angle']+90)%180)-90) > 5.0: continue
            # Approximate endpoint-to-segment distance both ways.
            def pseg(px,py,a):
                ax,ay,bx,by=a['x1'],a['y1'],a['x2'],a['y2']; dx=bx-ax; dy=by-ay
                den=dx*dx+dy*dy or 1
                t=max(0,min(1,((px-ax)*dx+(py-ay)*dy)/den))
                return math.hypot(px-(ax+t*dx),py-(ay+t*dy))
            # Compare both line offset and overlap of projected intervals. This
            # removes LSD/Hough duplicates without erasing adjacent pipe sections.
            d0=max(pseg(c['x1'],c['y1'],k),pseg(c['x2'],c['y2'],k))
            d1=max(pseg(k['x1'],k['y1'],c),pseg(k['x2'],k['y2'],c))
            dx=k['x2']-k['x1']; dy=k['y2']-k['y1']; den=math.hypot(dx,dy) or 1
            ux,uy=dx/den,dy/den
            pc=[(c['x1']-k['x1'])*ux+(c['y1']-k['y1'])*uy,
                (c['x2']-k['x1'])*ux+(c['y2']-k['y1'])*uy]
            ov=max(0.0,min(den,max(pc))-max(0.0,min(pc)))
            overlap_ratio=ov/max(1.0,min(c['length'],k['length']))
            if d0 < 4.5 and d1 < 4.5 and overlap_ratio > 0.52:
                duplicate=True; break
        if not duplicate: kept.append(c)
    # Limit runaway text fragments, but prefer long coherent elements.
    kept.sort(key=lambda q:q['length'], reverse=True)
    return kept[:1800]


def endpoint_clusters(segments: list[dict[str,Any]], radius: float = 4.5):
    endpoints=[]
    for i,s in enumerate(segments):
        endpoints.append((i,0,s['x1'],s['y1']))
        endpoints.append((i,1,s['x2'],s['y2']))
    parent=list(range(len(endpoints)))
    def find(a):
        while parent[a]!=a:
            parent[a]=parent[parent[a]]; a=parent[a]
        return a
    def union(a,b):
        ra,rb=find(a),find(b)
        if ra!=rb: parent[rb]=ra
    # Spatial buckets avoid O(n^2) across a noisy page.
    cell=max(1,int(radius))
    buckets={}
    for idx,(_,_,x,y) in enumerate(endpoints):
        key=(int(x//cell),int(y//cell))
        for bx in range(key[0]-1,key[0]+2):
          for by in range(key[1]-1,key[1]+2):
            for j in buckets.get((bx,by),[]):
              _,_,xx,yy=endpoints[j]
              if math.hypot(x-xx,y-yy)<=radius: union(idx,j)
        buckets.setdefault(key,[]).append(idx)
    groups={}
    for i,ep in enumerate(endpoints): groups.setdefault(find(i),[]).append(ep)
    nodes=[]; ep_to_node={}
    for gi,items in enumerate(groups.values()):
        x=float(np.mean([e[2] for e in items])); y=float(np.mean([e[3] for e in items]))
        nid=f"N{gi+1}"
        nodes.append({"id":nid,"x":round(x,2),"y":round(y,2),"degree":len(items),"review":len(items)==1})
        for ep in items:
            ep_to_node[(ep[0],ep[1])]=nid
    edges=[]
    node_by_id = {n['id']: n for n in nodes}
    for i,s in enumerate(segments):
        a=ep_to_node[(i,0)]; b=ep_to_node[(i,1)]
        if a==b: continue
        snapped = [[node_by_id[a]['x'], node_by_id[a]['y']], [node_by_id[b]['x'], node_by_id[b]['y']]]
        raw_geometry = [[round(s['x1'],2),round(s['y1'],2)],[round(s['x2'],2),round(s['y2'],2)]]
        edges.append({"id":f"E{len(edges)+1}","from":a,"to":b,
                      "source":"candidate","confidence":round(min(0.99,0.45+0.45*s['support']+min(s['length']/800,0.12)),2),
                      "geometry":snapped,"raw_geometry":raw_geometry,
                      "review":True,"detector":s['source'],"source_segment_index":i,
                      "ocr_overlap":s.get('ocr_overlap',0.0),
                      "suggested_role":s.get('suggested_role','line_candidate')})
    # Group connected candidate segments. Long, dense components dominated by OCR
    # boxes are marked as annotation clusters, not silently deleted.
    adjacency = {}
    for idx,e in enumerate(edges):
        adjacency.setdefault(e['from'],[]).append(idx)
        adjacency.setdefault(e['to'],[]).append(idx)
    seen=set(); component_summaries=[]
    for seed in range(len(edges)):
        if seed in seen: continue
        stack=[seed]; indices=[]; node_ids=set()
        while stack:
            idx=stack.pop()
            if idx in seen: continue
            seen.add(idx); indices.append(idx)
            e=edges[idx]
            for nid in (e['from'],e['to']):
                node_ids.add(nid)
                stack.extend(j for j in adjacency.get(nid,[]) if j not in seen)
        comp_edges=[edges[i] for i in indices]
        pts=[p for e in comp_edges for p in e['geometry']]
        xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
        dx=max(xs)-min(xs) if xs else 0; dy=max(ys)-min(ys) if ys else 0
        extent=max(dx,dy); total=sum(math.dist(*e['geometry']) for e in comp_edges)
        overlap_len=sum(math.dist(*e['geometry'])*float(e.get('ocr_overlap',0)) for e in comp_edges)
        overlap_ratio=overlap_len/max(total,1)
        if len(comp_edges)>=3 and extent>=65 and overlap_ratio>=0.48:
            role='text_or_annotation'
        elif len(comp_edges)>=3 and extent>=55 and total>=120 and overlap_ratio<0.42:
            role='line_structure'
        else:
            role='ambiguous'
        cid=f"C{len(component_summaries)+1}"
        for e in comp_edges: e['component_id']=cid; e['component_role']=role
        component_summaries.append({"id":cid,"role":role,"edge_count":len(comp_edges),
                                    "total_length":round(total,1),"bbox":{"x":round(min(xs),1) if xs else 0,"y":round(min(ys),1) if ys else 0,"w":round(dx,1),"h":round(dy,1)},
                                    "ocr_overlap_ratio":round(overlap_ratio,2)})
    return nodes,edges,component_summaries


def detect_crossings(segments: list[dict[str,Any]], max_crossings=250):
    crossings=[]
    def cross(a,b):
        x1,y1,x2,y2=a['x1'],a['y1'],a['x2'],a['y2']; x3,y3,x4,y4=b['x1'],b['y1'],b['x2'],b['y2']
        den=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4)
        if abs(den)<1e-6:return None
        t=((x1-x3)*(y3-y4)-(y1-y3)*(x3-x4))/den
        u=-((x1-x2)*(y1-y3)-(y1-y2)*(x1-x3))/den
        if 0.03<t<0.97 and 0.03<u<0.97:
            return (x1+t*(x2-x1), y1+t*(y2-y1))
        return None
    # spatially broad but bounded pair list
    for i,a in enumerate(segments):
        if len(crossings)>=max_crossings: break
        for j in range(i+1,min(len(segments),i+100)):
            b=segments[j]
            if abs(((a['angle']-b['angle']+90)%180)-90)<18: continue
            p=cross(a,b)
            if p: crossings.append({"id":f"X{len(crossings)+1}","x":round(p[0],1),"y":round(p[1],1),
                                    "segments":[i+1,j+1],"status":"needs_review",
                                    "message":"Пересечение не считается соединением автоматически"})
    return crossings


def build_clean_svg(width:int,height:int,edges:list[dict],annotations:list[dict],title='Трубопроводная схема') -> str:
    # Technical sheet with uniform line widths. Coordinates remain in image space
    # in the graph JSON; SVG uses a viewBox and fit-to-page transform.
    margin=70; pagew=1200; pageh=850
    scale=min((pagew-2*margin)/max(width,1),(pageh-2*margin-100)/max(height,1))
    tx=(pagew-width*scale)/2; ty=65+(pageh-130-height*scale)/2
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{pagew}mm" height="{pageh}mm" viewBox="0 0 {pagew} {pageh}">',
         '<rect width="1200" height="850" fill="white"/>','<rect x="24" y="24" width="1152" height="802" fill="none" stroke="#111" stroke-width="1.2"/>',
         '<g transform="translate(%.3f %.3f) scale(%.6f)" fill="none" stroke="#111" stroke-width="%.3f" stroke-linecap="round" stroke-linejoin="round">'%(tx,ty,scale,max(1.1/scale,0.45))]
    for e in edges:
        geo=e.get('geometry') or []
        if e.get('component_role') != 'line_structure' or len(geo)<2 or math.dist(*geo)<28:
            continue
        pts=' '.join(f'{float(p[0]):.2f},{float(p[1]):.2f}' for p in geo)
        out.append(f'<polyline points="{pts}"/>')
    out.append('</g>')
    # OCR annotations are separate and editable: only print when verified.
    for a in annotations:
        if not a.get('verified') or not a.get('text'): continue
        b=a.get('bbox',{}); x=tx+(b.get('x',0)+b.get('w',0)/2)*scale; y=ty+(b.get('y',0)+b.get('h',0)/2)*scale
        out.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="Arial,sans-serif" font-size="8" text-anchor="middle" fill="#111">{xml_escape(a["text"])}</text>')
    out += [f'<text x="38" y="48" font-family="Arial,sans-serif" font-size="14" font-weight="bold">{xml_escape(title)}</text>',
            '<path d="M 24 760 H 1176 M 830 760 V 826" fill="none" stroke="#111" stroke-width="0.8"/>',
            '<text x="40" y="783" font-family="Arial,sans-serif" font-size="8">СХЕМА ВЕКТОРИЗОВАНА ИЗ РУКОПИСНОГО ЭСКИЗА — ТРЕБУЕТ ПРОВЕРКИ ТОПОЛОГИИ И РАЗМЕРОВ</text>',
            '<text x="845" y="783" font-family="Arial,sans-serif" font-size="8">CAD RECONSTRUCTION ENGINE</text>', '</svg>']
    return '\n'.join(out)


def xml_escape(s:str)->str:
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')


def build_dxf(width:int,height:int,edges:list[dict],annotations:list[dict]) -> str:
    d=['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','0','ENDSEC','0','SECTION','2','ENTITIES']
    for e in edges:
        geo=e.get('geometry') or []
        if e.get('component_role') != 'line_structure' or len(geo)<2 or math.dist(*geo)<28: continue
        d += ['0','LWPOLYLINE','8','PIPE_CANDIDATES','90',str(len(geo)),'70','0']
        for x,y in geo: d += ['10',f'{x:.3f}','20',f'{height-y:.3f}']
    for a in annotations:
        if not a.get('verified') or not a.get('text'): continue
        b=a.get('bbox',{}); x=b.get('x',0); y=height-(b.get('y',0)+b.get('h',0))
        d += ['0','TEXT','8','VERIFIED_TEXT','10',str(x),'20',str(y),'40','8','1',str(a['text'])]
    d += ['0','ENDSEC','0','EOF']
    return '\n'.join(d)+'\n'


def analyze(input_path:str,out_dir:str) -> dict[str,Any]:
    Path(out_dir).mkdir(parents=True,exist_ok=True)
    bgr=load_image(input_path); h,w=bgr.shape[:2]
    gray,prep=normalize_document(bgr)
    ink=make_ink_mask(bgr,gray)
    annotations=ocr_annotations(input_path,gray)
    segments=extract_segments(gray,ink,annotations)
    nodes,edges,components=endpoint_clusters(segments)
    # OCR-overlap and component role are metadata only. No candidate is removed.
    for edge in edges:
        edge['visible'] = True
    crossings=detect_crossings(segments)
    # A white canvas preview with candidate line segments in red/amber.
    overlay=bgr.copy()
    for i,s in enumerate(segments):
        if s.get('ocr_overlap', 0) >= 0.45:
            col=(155,155,155)
        else:
            col=(30,130,240) if s['source']=='LSD' else (40,180,80)
        cv2.line(overlay,(int(s['x1']),int(s['y1'])),(int(s['x2']),int(s['y2'])),col,2,cv2.LINE_AA)
    for n in nodes:
        if n['degree'] >= 3:
            cv2.circle(overlay,(int(n['x']),int(n['y'])),4,(0,0,255),-1,cv2.LINE_AA)
    overlay_path=str(Path(out_dir)/'overlay.png'); cv2.imwrite(overlay_path,overlay)
    ink_path=str(Path(out_dir)/'ink-mask.png'); cv2.imwrite(ink_path,ink)
    svg=build_clean_svg(w,h,edges,annotations)
    Path(out_dir,'clean.svg').write_text(svg,encoding='utf-8')
    Path(out_dir,'drawing.dxf').write_text(build_dxf(w,h,edges,annotations),encoding='utf-8')
    # Open-end gap candidates are suggestions only; no geometry is connected automatically.
    node_map = {n['id']: n for n in nodes}
    edge_at = {}
    for e in edges:
        for nid in (e['from'], e['to']): edge_at.setdefault(nid, e)
    open_nodes = [n for n in nodes if n['degree'] == 1 and n['id'] in edge_at]
    joins=[]
    for i, a in enumerate(open_nodes):
        ea=edge_at[a['id']]
        if ea.get('component_role') != 'line_structure' or math.dist(*ea['geometry']) < 25: continue
        ga=ea['geometry']; other_a=ga[-1] if ea['from']==a['id'] else ga[0]
        va=np.array([other_a[0]-a['x'], other_a[1]-a['y']], dtype=float); na=np.linalg.norm(va)
        if na<1: continue
        va/=na
        for b in open_nodes[i+1:]:
            eb=edge_at[b['id']]
            if eb.get('component_role') != 'line_structure' or math.dist(*eb['geometry']) < 25: continue
            dist=math.hypot(a['x']-b['x'],a['y']-b['y'])
            if dist<7 or dist>28: continue
            gb=eb['geometry']; other_b=gb[-1] if eb['from']==b['id'] else gb[0]
            vb=np.array([other_b[0]-b['x'], other_b[1]-b['y']], dtype=float); nb=np.linalg.norm(vb)
            if nb<1: continue
            vb/=nb
            if float(np.dot(va,vb)) < -0.91:
                joins.append({"id":f"J{len(joins)+1}","from":a['id'],"to":b['id'],"distance":round(dist,1),"status":"needs_review","message":"Почти соосные окончания — подтвердить вручную"})
                if len(joins)>=200: break
        if len(joins)>=200: break
    graph={"schema":"cad-reconstruction-graph/1.0","status":"needs_review","image":{"width":w,"height":h},
           "nodes":nodes,"edges":edges,"components":components,"crossings":crossings,"joinCandidates":joins,"annotations":annotations,
           "rules":{"ocr_does_not_erase_geometry":True,"crossings_auto_joined":False,"endpoint_cluster_radius_px":4.5},
           "summary":{"segment_candidates":len(segments),"nodes":len(nodes),"edges":len(edges),"crossings_to_review":len(crossings),
                      "ocr_annotations":len([a for a in annotations if a.get('source')=='tesseract']),
                      "text_overlap_edges":sum(1 for e in edges if e.get('suggested_role')=='text_or_dimension'),
                      "open_end_join_candidates":len(joins),
                      "components":len(components),
                      "line_components":sum(1 for c in components if c['role']=='line_structure'),
                      "annotation_components":sum(1 for c in components if c['role']=='text_or_annotation'),
                      "ambiguous_components":sum(1 for c in components if c['role']=='ambiguous'),
                      "ink_pixels":int(np.count_nonzero(ink)),"preprocessing":prep},
           "warnings":["Линии являются кандидатами детектора, а не подтверждёнными трубами.",
                       "Пересечения не объединяются автоматически.",
                       "Компоненты, похожие на текстовые блоки, скрываются только в режиме «Основные»; они сохранены в полном графе.",
                       "Размеры и подписи OCR необходимо проверить вручную."]}
    Path(out_dir,'graph.json').write_text(json.dumps(graph,ensure_ascii=False,indent=2),encoding='utf-8')
    return graph


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--out',required=True)
    args=ap.parse_args(); result=analyze(args.input,args.out); print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__': main()
