const EPS = 1e-7;

function distance(a, b) { return Math.hypot(Number(a?.[0]) - Number(b?.[0]), Number(a?.[1]) - Number(b?.[1])); }
function pointSegmentDistance(point, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1], lengthSq = dx * dx + dy * dy;
  if (lengthSq <= EPS) return distance(point, start);
  const t = Math.max(0, Math.min(1, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq));
  return distance(point, [start[0] + t * dx, start[1] + t * dy]);
}
function properIntersection(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= EPS) return null;
  const qx = c[0] - a[0], qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / denominator, u = (qx * ry - qy * rx) / denominator;
  return t > 0.025 && t < 0.975 && u > 0.025 && u < 0.975 ? [a[0] + t * rx, a[1] + t * ry] : null;
}
function lineRectIntersects(a, b, rect) {
  const minX = rect.x, minY = rect.y, maxX = rect.x + rect.w, maxY = rect.y + rect.h;
  const inside = p => p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY;
  if (inside(a) || inside(b)) return true;
  const edges = [
    [[minX, minY], [maxX, minY]], [[maxX, minY], [maxX, maxY]],
    [[maxX, maxY], [minX, maxY]], [[minX, maxY], [minX, minY]]
  ];
  return edges.some(([c, d]) => properIntersection(a, b, c, d) !== null);
}
function labelRect(label, position = null) {
  const x = Number(position?.x ?? label.x), y = Number(position?.y ?? label.y);
  const font = Math.max(6, Math.min(120, Number(label.size) || 18));
  const width = Math.max(font, String(label.text || '').length * font * 0.58);
  const height = font * 1.25;
  const anchor = label.anchor === 'middle' ? 0.5 : label.anchor === 'end' ? 1 : 0;
  const rotation = (Number(label.rotation) || 0) * Math.PI / 180;
  const cx = x - width * anchor + width / 2, cy = y - height / 2;
  const rotatedW = Math.abs(Math.cos(rotation)) * width + Math.abs(Math.sin(rotation)) * height;
  const rotatedH = Math.abs(Math.sin(rotation)) * width + Math.abs(Math.cos(rotation)) * height;
  return { x: cx - rotatedW / 2, y: cy - rotatedH / 2, w: rotatedW, h: rotatedH };
}
function rectsOverlap(a, b, padding = 0) {
  return a.x < b.x + b.w + padding && a.x + a.w + padding > b.x &&
    a.y < b.y + b.h + padding && a.y + a.h + padding > b.y;
}
function pipeCrossesRect(pipe, rect) {
  for (let i = 1; i < (pipe.points || []).length; i += 1) {
    if (lineRectIntersects(pipe.points[i - 1], pipe.points[i], rect)) return true;
  }
  return false;
}
function pipeMidpointDistance(point, pipe) {
  let best = Infinity;
  for (let i = 1; i < (pipe.points || []).length; i += 1) best = Math.min(best, pointSegmentDistance(point, pipe.points[i - 1], pipe.points[i]));
  return best;
}

export function suggestManualCadLabelPlacements(project, label, otherLabels = null) {
  const candidates = [[0, -28], [0, 28], [42, 0], [-42, 0], [42, -28], [-42, -28], [42, 28], [-42, 28], [0, -48], [0, 48]];
  const labels = otherLabels || (project.labels || []).filter(item => item.id !== label.id);
  const pipes = (project.pipes || []).filter(pipe => pipe.reviewOnly !== true && pipe.visible !== false);
  const symbols = (project.symbols || []).filter(symbol => symbol.reviewOnly !== true);
  const base = labelRect(label);
  const score = rect => {
    let value = 0;
    for (const other of labels) if (rectsOverlap(rect, labelRect(other), 4)) value += 100;
    for (const symbol of symbols) {
      const size = 20 * (Number(symbol.scale) || 1);
      if (rectsOverlap(rect, { x: Number(symbol.x) - size, y: Number(symbol.y) - size, w: size * 2, h: size * 2 }, 5)) value += 70;
    }
    for (const pipe of pipes) if (pipeCrossesRect(pipe, rect)) value += 35;
    return value;
  };
  const initialScore = score(base);
  return candidates.map(([dx, dy]) => {
    const position = { x: Math.max(0, Math.min(Number(project.width) || 30000, Number(label.x) + dx)),
      y: Math.max(0, Math.min(Number(project.height) || 30000, Number(label.y) + dy)) };
    const candidateScore = score(labelRect(label, position));
    return { ...position, score: candidateScore, improvement: initialScore - candidateScore };
  }).sort((a, b) => b.improvement - a.improvement || a.score - b.score).slice(0, 3);
}

export function analyzeManualCadQuality(project) {
  const findings = [];
  const add = (code, severity, targetIds, message, details = {}) => findings.push({
    id: `Q${findings.length + 1}`, code, severity,
    targetIds: (targetIds || []).filter(Boolean).map(String), message, ...details
  });
  const pipes = (project.pipes || []).filter(pipe => pipe.reviewOnly !== true && pipe.visible !== false);
  const symbols = (project.symbols || []).filter(symbol => symbol.reviewOnly !== true);
  const labels = (project.labels || []).filter(label => label.reviewOnly !== true);
  const dimensions = project.dimensions || [];
  const ids = new Map();
  for (const [kind, collection] of [['pipe', pipes], ['symbol', symbols], ['label', labels], ['dimension', dimensions]]) {
    for (const item of collection) {
      const id = String(item.id || '');
      if (ids.has(id)) add('duplicate_object_id', 'error', [ids.get(id), id], `Повторяется идентификатор объекта ${id}.`);
      else ids.set(id, `${kind}:${id}`);
    }
  }
  const exactRoutes = new Map();
  for (const pipe of pipes) {
    const pts = pipe.points || [];
    if (pts.length < 2) { add('invalid_pipe', 'error', [pipe.id], 'Участок содержит меньше двух точек.'); continue; }
    const direct = pts.map(p => `${Number(p[0]).toFixed(1)},${Number(p[1]).toFixed(1)}`).join('|');
    const reverse = [...pts].reverse().map(p => `${Number(p[0]).toFixed(1)},${Number(p[1]).toFixed(1)}`).join('|');
    const key = direct < reverse ? direct : reverse;
    if (exactRoutes.has(key)) add('duplicate_route', 'warning', [exactRoutes.get(key), pipe.id], 'Две трубы имеют совпадающую геометрию.');
    else exactRoutes.set(key, pipe.id);
    const bboxOutside = pts.some(p => p[0] < -2 || p[1] < -2 || p[0] > (Number(project.width) || Infinity) + 2 || p[1] > (Number(project.height) || Infinity) + 2);
    if (bboxOutside) add('pipe_outside_sheet', 'review', [pipe.id], 'Часть трубы выходит за границы листа.');
  }
  const crossings = [];
  const pipeBoxes = new Map(pipes.map(pipe => {
    const points = pipe.points || [];
    return [String(pipe.id), points.length ? {
      minX: Math.min(...points.map(point => Number(point[0]))),
      minY: Math.min(...points.map(point => Number(point[1]))),
      maxX: Math.max(...points.map(point => Number(point[0]))),
      maxY: Math.max(...points.map(point => Number(point[1])))
    } : null];
  }));
  for (let i = 0; i < pipes.length; i += 1) {
    for (let j = i + 1; j < pipes.length; j += 1) {
      const a = pipes[i], b = pipes[j];
      const boxA = pipeBoxes.get(String(a.id)), boxB = pipeBoxes.get(String(b.id));
      if (!boxA || !boxB || boxA.maxX < boxB.minX || boxB.maxX < boxA.minX || boxA.maxY < boxB.minY || boxB.maxY < boxA.minY) continue;
      let crossing = null;
      for (let ai = 1; ai < (a.points || []).length && !crossing; ai += 1) {
        for (let bi = 1; bi < (b.points || []).length && !crossing; bi += 1) {
          crossing = properIntersection(a.points[ai - 1], a.points[ai], b.points[bi - 1], b.points[bi]);
        }
      }
      if (!crossing) continue;
      const explicit = (project.junctions || []).some(junction => {
        const ids = new Set((junction.pipeIds || []).map(String));
        return ids.has(String(a.id)) && ids.has(String(b.id)) && distance(crossing, [junction.x, junction.y]) <= 10;
      });
      if (!explicit) {
        crossings.push({ pipeIds: [String(a.id), String(b.id)], point: crossing });
        add('unresolved_crossing', 'review', [a.id, b.id], 'Трубы пересекаются без явного узла. Проверьте: соединение это или переход без соединения.', { point: crossing });
      }
    }
  }
  for (const symbol of symbols) {
    const ports = Array.isArray(symbol.connections) ? symbol.connections : [];
    const missing = ports.filter(port => port.state !== 'connected' || !port.pipeId);
    if (missing.length) add('symbol_ports_unconnected', 'review', [symbol.id], `Условное обозначение имеет ${missing.length} неподключённых порт(а).`, { missingPortIds: missing.map(port => port.portId) });
  }
  const pipeIds = new Set(pipes.map(pipe => String(pipe.id)));
  for (const dimension of dimensions) {
    if (!dimension.targetPipeId || !pipeIds.has(String(dimension.targetPipeId))) {
      add(dimension.linkStatus === 'ambiguous' ? 'dimension_ambiguous' : 'dimension_unassigned', 'review', [dimension.id], 'Размер не привязан однозначно к подтверждённой трубе.', { candidatePipeIds: dimension.candidatePipeIds || [] });
    }
    if (dimension.valueMm && (!Number.isFinite(Number(dimension.valueMm)) || Number(dimension.valueMm) <= 0)) {
      add('invalid_dimension_value', 'error', [dimension.id], 'Размер должен иметь положительное числовое значение.');
    }
  }
  const labelRects = labels.map(label => ({ label, rect: labelRect(label) })).sort((a, b) => a.rect.x - b.rect.x);
  const suggestionCache = new Map();
  const suggestionsFor = label => {
    const key = String(label.id);
    if (!suggestionCache.has(key)) suggestionCache.set(key, suggestManualCadLabelPlacements(project, label));
    return suggestionCache.get(key);
  };
  for (let i = 0; i < labelRects.length; i += 1) {
    for (let j = i + 1; j < labelRects.length; j += 1) {
      if (labelRects[j].rect.x > labelRects[i].rect.x + labelRects[i].rect.w + 2) break;
      if (rectsOverlap(labelRects[i].rect, labelRects[j].rect, 2)) {
        add('label_overlap', 'warning', [labelRects[i].label.id, labelRects[j].label.id], 'Текстовые подписи перекрываются.', {
          suggestions: suggestionsFor(labelRects[i].label)
        });
      }
    }
    const { label, rect } = labelRects[i];
    const collisions = pipes.filter(pipe => pipeCrossesRect(pipe, rect));
    if (collisions.length) add('label_over_pipe', 'warning', [label.id, ...collisions.map(pipe => pipe.id)], 'Линия трубопровода проходит через область текстовой подписи.', {
      suggestions: suggestionsFor(label)
    });
    const symbolCollisions = symbols.filter(symbol => {
      const size = 20 * (Number(symbol.scale) || 1);
      return rectsOverlap(rect, { x: Number(symbol.x) - size, y: Number(symbol.y) - size, w: size * 2, h: size * 2 }, 2);
    });
    if (symbolCollisions.length) add('label_over_symbol', 'warning', [label.id, ...symbolCollisions.map(symbol => symbol.id)], 'Текстовая подпись перекрывает условное обозначение.', {
      suggestions: suggestionsFor(label)
    });
  }
  const counts = Object.fromEntries(['error', 'warning', 'review'].map(severity => [severity, findings.filter(item => item.severity === severity).length]));
  return { status: counts.error ? 'failed' : findings.length ? 'needs_review' : 'passed', counts, total: findings.length,
    checked: { pipes: pipes.length, symbols: symbols.length, labels: labels.length, dimensions: dimensions.length }, findings, crossings };
}

function normalizeGeometry(points) {
  return (points || []).map(point => [Math.round(Number(point[0]) * 10) / 10, Math.round(Number(point[1]) * 10) / 10]);
}
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

export function compareManualCadProjects(before, after) {
  const sections = ['pipes', 'symbols', 'labels', 'dimensions', 'junctions'];
  const changes = {};
  for (const section of sections) {
    const previous = new Map((before?.[section] || []).map(item => [String(item.id), item]));
    const current = new Map((after?.[section] || []).map(item => [String(item.id), item]));
    const added = [], removed = [], modified = [];
    for (const [id, item] of current) {
      if (!previous.has(id)) { added.push(id); continue; }
      const old = previous.get(id);
      const normalized = value => section === 'pipes' ? {
        name: value.name, diameter: value.diameter, kind: value.kind, reviewOnly: value.reviewOnly,
        points: normalizeGeometry(value.points)
      } : section === 'symbols' ? { type: value.type, x: value.x, y: value.y, rotation: value.rotation, label: value.label, reviewOnly: value.reviewOnly }
        : section === 'labels' ? { text: value.text, x: value.x, y: value.y, rotation: value.rotation, size: value.size }
          : section === 'dimensions' ? { a: normalizeGeometry([value.a])[0], b: normalizeGeometry([value.b])[0], text: value.text, targetPipeId: value.targetPipeId }
            : { x: Math.round(Number(value.x) * 10) / 10, y: Math.round(Number(value.y) * 10) / 10,
              pipeIds: [...(value.pipeIds || [])].map(String).sort() };
      if (!sameJson(normalized(old), normalized(item))) modified.push(id);
    }
    for (const id of previous.keys()) if (!current.has(id)) removed.push(id);
    changes[section] = { added, removed, modified, counts: { added: added.length, removed: removed.length, modified: modified.length } };
  }
  const currentQuality = analyzeManualCadQuality(after);
  const previousQuality = analyzeManualCadQuality(before);
  const previousFindingKeys = new Set(previousQuality.findings.map(item => `${item.code}:${[...item.targetIds].sort().join(',')}`));
  const newFindings = currentQuality.findings.filter(item => !previousFindingKeys.has(`${item.code}:${[...item.targetIds].sort().join(',')}`));
  return { beforeRevision: Number(before?.manualEditRevision || 0), afterRevision: Number(after?.manualEditRevision || 0),
    changes, newQualityFindings: newFindings, quality: currentQuality,
    hasChanges: sections.some(section => Object.values(changes[section].counts).some(Boolean)) || newFindings.length > 0 };
}
