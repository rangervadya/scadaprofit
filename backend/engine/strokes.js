/** Convert Qwen candidate polylines into a graph without guessing cross-stroke junctions. */
export function strokesToGraph(payload) {
  const warnings = Array.isArray(payload?.warnings) ? payload.warnings.filter(x => typeof x === 'string') : [];
  const strokes = Array.isArray(payload?.strokes) ? payload.strokes : [];
  const points = [];
  const lines = [];
  let strokeCount = 0;
  let skippedStrokes = 0;

  strokes.forEach((stroke, strokeIndex) => {
    const raw = Array.isArray(stroke?.points) ? stroke.points : [];
    const clean = [];
    for (const point of raw) {
      if (!point || !Number.isInteger(point.x) || !Number.isInteger(point.y) ||
          point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 650) continue;
      const previous = clean.at(-1);
      if (previous && previous.x === point.x && previous.y === point.y) continue;
      clean.push({ x: point.x, y: point.y });
    }
    if (clean.length < 2) {
      skippedStrokes += 1;
      return;
    }
    strokeCount += 1;
    const prefix = `S${strokeIndex + 1}`;
    clean.forEach((point, pointIndex) => {
      const id = `${prefix}_P${pointIndex + 1}`;
      points.push({ id, x: point.x, y: point.y });
      if (pointIndex > 0) {
        lines.push({ from: `${prefix}_P${pointIndex}`, to: id });
      }
    });
  });

  if (skippedStrokes) warnings.push(`${skippedStrokes} полилиний пропущено: менее двух корректных координат.`);
  if (strokeCount) warnings.push('Связи созданы только между соседними точками каждого отдельного штриха. Разные штрихи и пересечения автоматически не объединялись.');
  if (!strokeCount) warnings.push('Не удалось получить ни одной полилинии минимум из двух координат.');

  return { points, lines, warnings, strokeCount, skippedStrokes };
}
