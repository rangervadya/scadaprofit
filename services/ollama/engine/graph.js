export function validateInputGraph(data) {
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, warnings: ['Корень входного JSON должен быть объектом.'] };
  }
  if (!Array.isArray(data.points)) warnings.push('Вход: points должен быть массивом.');
  if (!Array.isArray(data.lines)) warnings.push('Вход: lines должен быть массивом.');
  const points = Array.isArray(data.points) ? data.points : [];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const ids = new Set();
  for (const [index, point] of points.entries()) {
    if (!point || typeof point.id !== 'string' || !point.id.trim()) {
      warnings.push(`Вход: точка №${index + 1} имеет пустой или нестроковый id.`);
      continue;
    }
    if (ids.has(point.id)) warnings.push(`Вход: повторяется id ${point.id}.`);
    ids.add(point.id);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      warnings.push(`Вход: ${point.id} имеет некорректные координаты.`);
    } else if (point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 650) {
      warnings.push(`Вход: ${point.id} вне холста 1000×650.`);
    }
  }
  const edgeSet = new Set();
  for (const [index, line] of lines.entries()) {
    if (!line || typeof line.from !== 'string' || typeof line.to !== 'string') {
      warnings.push(`Вход: линия №${index + 1} должна иметь строковые from и to.`);
      continue;
    }
    if (!ids.has(line.from) || !ids.has(line.to)) {
      warnings.push(`Вход: связь ${line.from}→${line.to} ссылается на неизвестную точку.`);
    }
    if (line.from === line.to) warnings.push(`Вход: самосвязь ${line.from} запрещена.`);
    const key = `${line.from}\u0000${line.to}`;
    if (edgeSet.has(key)) warnings.push(`Вход: связь ${line.from}→${line.to} повторяется.`);
    edgeSet.add(key);
  }
  return {
    valid: warnings.length === 0,
    warnings,
    pointCount: points.length,
    lineCount: lines.length,
    pointIds: [...ids],
  };
}

export function countDirectedPaths(graph, startId, endId, limit = 2) {
  if (!graph || !Array.isArray(graph.points) || !Array.isArray(graph.lines) || !startId || !endId) return null;
  const ids = new Set(graph.points.map(point => point?.id).filter(id => typeof id === 'string'));
  if (!ids.has(startId) || !ids.has(endId)) return 0;
  const adjacency = new Map([...ids].map(id => [id, []]));
  for (const line of graph.lines) {
    if (line && ids.has(line.from) && ids.has(line.to) && line.from !== line.to) {
      adjacency.get(line.from).push(line.to);
    }
  }
  let count = 0;
  const visited = new Set([startId]);
  function walk(current) {
    if (count >= limit) return;
    if (current === endId) { count += 1; return; }
    for (const next of adjacency.get(current) || []) {
      if (visited.has(next)) continue;
      visited.add(next);
      walk(next);
      visited.delete(next);
      if (count >= limit) return;
    }
  }
  walk(startId);
  return count;
}

export function validateRouteOutput(data, inputGraph, requestedStart = '', requestedEnd = '') {
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, warnings: ['Корень ответа Qwen должен быть JSON-объектом.'] };
  }
  const allowedKeys = new Set(['status', 'points', 'lines', 'path', 'total_length', 'warnings']);
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) warnings.push(`Лишний ключ «${key}» не разрешён форматом.`);
  }
  if (!['ok', 'needs_review', 'impossible'].includes(data.status)) {
    warnings.push('status должен быть ok, needs_review или impossible.');
  }
  if (!Array.isArray(data.points)) warnings.push('points должен быть массивом.');
  if (!Array.isArray(data.lines)) warnings.push('lines должен быть массивом.');
  if (!Array.isArray(data.path)) warnings.push('path должен быть массивом.');
  if (!Array.isArray(data.warnings)) warnings.push('warnings должен быть массивом.');
  if (!Number.isFinite(data.total_length)) warnings.push('total_length должен быть конечным числом.');

  const inputCheck = validateInputGraph(inputGraph);
  if (!inputCheck.valid) warnings.push(...inputCheck.warnings.map(message => `Входной граф: ${message}`));
  const sourceIds = new Set((Array.isArray(inputGraph?.points) ? inputGraph.points : []).map(point => point?.id));
  if (requestedStart && !sourceIds.has(requestedStart)) warnings.push(`START_ID ${requestedStart} отсутствует во входном графе.`);
  if (requestedEnd && !sourceIds.has(requestedEnd)) warnings.push(`END_ID ${requestedEnd} отсутствует во входном графе.`);
  if (requestedStart && requestedEnd && requestedStart === requestedEnd) warnings.push('START_ID и END_ID должны быть разными точками.');

  const points = Array.isArray(data.points) ? data.points : [];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const pathIds = Array.isArray(data.path) ? data.path : [];
  const sourcePoints = new Map((Array.isArray(inputGraph?.points) ? inputGraph.points : []).map(point => [point?.id, point]));
  const sourceEdges = new Set((Array.isArray(inputGraph?.lines) ? inputGraph.lines : []).map(line => `${line?.from}\u0000${line?.to}`));
  const byId = new Map();

  for (const point of points) {
    if (!point || typeof point.id !== 'string' || !point.id.trim()) {
      warnings.push('Ответ: точка имеет пустой или нестроковый id.');
      continue;
    }
    if (byId.has(point.id)) warnings.push(`Ответ: повторяется id ${point.id}.`);
    byId.set(point.id, point);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      warnings.push(`Ответ: координаты точки ${point.id} должны быть конечными числами.`);
    }
    const original = sourcePoints.get(point.id);
    if (!original) warnings.push(`Ответ: точка ${point.id} отсутствует во входном JSON.`);
    else if (point.x !== original.x || point.y !== original.y) {
      warnings.push(`Ответ: координаты точки ${point.id} отличаются от исходных (${original.x}, ${original.y}).`);
    }
  }

  const seenEdges = new Set();
  for (const line of lines) {
    if (!line || typeof line.from !== 'string' || typeof line.to !== 'string') {
      warnings.push('Ответ: линия должна содержать строковые from и to.');
      continue;
    }
    if (!byId.has(line.from) || !byId.has(line.to)) warnings.push(`Ответ: линия ${line.from}→${line.to} ссылается на отсутствующую точку.`);
    if (line.from === line.to) warnings.push(`Ответ: самосвязь ${line.from}→${line.to} запрещена.`);
    const key = `${line.from}\u0000${line.to}`;
    if (seenEdges.has(key)) warnings.push(`Ответ: дублируется линия ${line.from}→${line.to}.`);
    seenEdges.add(key);
    if (!sourceEdges.has(key)) warnings.push(`Ответ: связь ${line.from}→${line.to} отсутствует во входном графе или изменено направление.`);
  }

  if (data.status === 'ok') {
    if (pathIds.length < 2) warnings.push('Для status=ok path должен содержать минимум две точки.');
    if (points.length !== pathIds.length) warnings.push('Количество points не совпадает с количеством id в path.');
    if (requestedStart && pathIds[0] !== requestedStart) warnings.push(`Путь должен начинаться в ${requestedStart}.`);
    if (requestedEnd && pathIds.at(-1) !== requestedEnd) warnings.push(`Путь должен заканчиваться в ${requestedEnd}.`);
    if (new Set(pathIds).size !== pathIds.length) warnings.push('В path повторяется id; циклические маршруты запрещены этим режимом.');
    if (points.length === pathIds.length && points.some((point, index) => point?.id !== pathIds[index])) {
      warnings.push('Порядок points не совпадает с последовательностью path.');
    }
    if (pathIds.some(id => !sourcePoints.has(id))) warnings.push('path содержит точку, отсутствующую во входном графе.');
    if (lines.length !== Math.max(0, pathIds.length - 1)) warnings.push('Количество lines должно быть равно path.length − 1.');
    for (let index = 0; index < pathIds.length - 1; index += 1) {
      const from = pathIds[index];
      const to = pathIds[index + 1];
      if (!sourceEdges.has(`${from}\u0000${to}`)) warnings.push(`Шаг ${index + 1}: во входном графе нет направленной связи ${from}→${to}.`);
      if (lines[index]?.from !== from || lines[index]?.to !== to) warnings.push(`Шаг ${index + 1}: lines не совпадает с соседней парой path ${from}→${to}.`);
    }
  }

  if (data.status === 'needs_review' || data.status === 'impossible') {
    if (points.length || lines.length || pathIds.length) warnings.push(`При status=${data.status} points, lines и path должны быть пустыми.`);
    if (data.total_length !== 0) warnings.push(`При status=${data.status} total_length должен быть 0.`);
  }

  let computedLength = 0;
  if (data.status === 'ok' && pathIds.length > 1) {
    for (let index = 0; index < pathIds.length - 1; index += 1) {
      const a = sourcePoints.get(pathIds[index]);
      const b = sourcePoints.get(pathIds[index + 1]);
      if (a && b && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y)) {
        computedLength += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
    if (Number.isFinite(data.total_length) && Math.abs(data.total_length - computedLength) > 1e-6) {
      warnings.push(`total_length модели ${data.total_length}; независимый пересчёт ${computedLength}.`);
    }
  }

  const sourcePathCount = requestedStart && requestedEnd
    ? countDirectedPaths(inputGraph, requestedStart, requestedEnd)
    : null;
  if (data.status === 'ok' && sourcePathCount === 0) warnings.push('Во входном графе нет пути от START_ID к END_ID.');
  if (data.status === 'ok' && sourcePathCount > 1) warnings.push('Во входном графе найдено больше одного пути; выбор неоднозначен.');
  if (data.status === 'impossible' && sourcePathCount > 0) warnings.push('Модель вернула impossible, хотя путь существует во входном графе.');

  const uniqueWarnings = [...new Set(warnings)];
  return {
    valid: uniqueWarnings.length === 0,
    warnings: uniqueWarnings,
    computedLength,
    modelLength: Number.isFinite(data.total_length) ? data.total_length : null,
    lengthDelta: Number.isFinite(data.total_length) ? Number((data.total_length - computedLength).toFixed(9)) : null,
    sourcePathCount,
  };
}
