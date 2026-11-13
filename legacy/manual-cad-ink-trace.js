'use strict';

const DIRECTIONS = [
  [1, 0, 1], [1, 1, Math.SQRT2], [0, 1, 1], [-1, 1, Math.SQRT2],
  [-1, 0, 1], [-1, -1, Math.SQRT2], [0, -1, 1], [1, -1, Math.SQRT2]
];

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(state, priority) {
    let index = this.items.length;
    this.items.push({ state, priority });
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (this.items[parent].priority <= priority) break;
      this.items[index] = this.items[parent]; index = parent;
    }
    this.items[index] = { state, priority };
  }
  pop() {
    const items = this.items;
    if (!items.length) return null;
    const first = items[0], last = items.pop();
    if (items.length && last) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        if (left >= items.length) break;
        let child = left;
        if (right < items.length && items[right].priority < items[left].priority) child = right;
        if (items[child].priority >= last.priority) break;
        items[index] = items[child]; index = child;
      }
      items[index] = last;
    }
    return first;
  }
}

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function buildCostMap(rgba, width, height, step) {
  const gridWidth = Math.ceil(width / step), gridHeight = Math.ceil(height / step);
  const raw = new Float32Array(gridWidth * gridHeight);
  const cost = new Float32Array(gridWidth * gridHeight);
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      let strongest = 0;
      const y0 = gy * step, x0 = gx * step;
      for (let oy = 0; oy < step && y0 + oy < height; oy += 1) {
        for (let ox = 0; ox < step && x0 + ox < width; ox += 1) {
          const offset = ((y0 + oy) * width + x0 + ox) * 4;
          const red = rgba[offset], green = rgba[offset + 1], blue = rgba[offset + 2];
          const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
          const darkness = clamp((232 - luminance) / 132, 0, 1);
          const blueInk = blue > red * 1.12 && blue > green * 1.02 && blue - red > 18
            ? clamp((blue - red - 10) / 75, 0, 0.96) : 0;
          strongest = Math.max(strongest, darkness, blueInk);
        }
      }
      raw[gy * gridWidth + gx] = strongest;
    }
  }
  // Small soft halo reconnects gaps from uneven pen pressure without flooding
  // neighboring table rows or parallel lines.
  for (let gy = 0; gy < gridHeight; gy += 1) {
    for (let gx = 0; gx < gridWidth; gx += 1) {
      const index = gy * gridWidth + gx;
      let halo = raw[index];
      for (let oy = -1; oy <= 1; oy += 1) for (let ox = -1; ox <= 1; ox += 1) {
        if (!ox && !oy) continue;
        const xx = gx + ox, yy = gy + oy;
        if (xx < 0 || yy < 0 || xx >= gridWidth || yy >= gridHeight) continue;
        halo = Math.max(halo, raw[yy * gridWidth + xx] * 0.62);
      }
      const strength = Math.max(raw[index], halo * 0.70);
      cost[index] = 1.15 + (1 - strength) * 15.5;
    }
  }
  return { cost, strength: raw, width: gridWidth, height: gridHeight, step, sourceWidth: width, sourceHeight: height };
}

export function prepareInkTrace({ data, width, height, step = 2, maxDimension = 1500 }) {
  if (!data || !Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2 || data.length < width * height * 4) {
    throw new Error('Подложка недоступна для анализа пикселей.');
  }
  const scale = Math.min(1, maxDimension / Math.max(width, height));
  if (scale < 1) {
    const nextWidth = Math.max(2, Math.round(width * scale));
    const nextHeight = Math.max(2, Math.round(height * scale));
    const resized = new Uint8ClampedArray(nextWidth * nextHeight * 4);
    for (let y = 0; y < nextHeight; y += 1) for (let x = 0; x < nextWidth; x += 1) {
      const sx = Math.min(width - 1, Math.round(x / scale));
      const sy = Math.min(height - 1, Math.round(y / scale));
      const from = (sy * width + sx) * 4, to = (y * nextWidth + x) * 4;
      resized[to] = data[from]; resized[to + 1] = data[from + 1];
      resized[to + 2] = data[from + 2]; resized[to + 3] = data[from + 3];
    }
    return { grid: buildCostMap(resized, nextWidth, nextHeight, step), width: nextWidth, height: nextHeight, sourceWidth: width, sourceHeight: height };
  }
  return { grid: buildCostMap(data, width, height, step), width, height, sourceWidth: width, sourceHeight: height };
}

function nearestInkCell(grid, point, radiusPx) {
  const cx = clamp(Math.round(point.x / grid.step), 0, grid.width - 1);
  const cy = clamp(Math.round(point.y / grid.step), 0, grid.height - 1);
  const radius = Math.max(1, Math.ceil(radiusPx / grid.step));
  let best = null;
  for (let dy = -radius; dy <= radius; dy += 1) {
    const y = cy + dy;
    if (y < 0 || y >= grid.height) continue;
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = cx + dx;
      if (x < 0 || x >= grid.width) continue;
      const pixelDistance = Math.hypot(dx * grid.step, dy * grid.step);
      if (pixelDistance > radiusPx) continue;
      const index = y * grid.width + x, strength = grid.strength[index];
      if (strength < 0.14) continue;
      const score = grid.cost[index] + pixelDistance * 0.045;
      if (!best || score < best.score) best = { x, y, index, score, distance: pixelDistance, strength };
    }
  }
  return best;
}

function pointSegmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 > 0 ? clamp(((x - ax) * dx + (y - ay) * dy) / length2, 0, 1) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function simplifyPath(points, epsilon) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]], epsilonSquared = epsilon * epsilon;
  while (stack.length) {
    const [start, end] = stack.pop();
    const a = points[start], b = points[end];
    const dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
    let maximum = epsilonSquared, maximumIndex = -1;
    for (let index = start + 1; index < end; index += 1) {
      const p = points[index];
      const t = lengthSquared > 0 ? clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared, 0, 1) : 0;
      const distanceSquared = (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2;
      if (distanceSquared > maximum) { maximum = distanceSquared; maximumIndex = index; }
    }
    if (maximumIndex >= 0) { keep[maximumIndex] = 1; stack.push([start, maximumIndex], [maximumIndex, end]); }
  }
  return points.filter((_point, index) => keep[index]);
}

/** Trace between two operator waypoints through actual pen pixels in a corridor. */
export function traceInkRoute({ prepared, data, width, height, start, end, step = 2, corridorPx = 38, maxVisited = 220000 }) {
  let grid = prepared?.grid;
  if (!grid) {
    if (!data || !Number.isInteger(width) || !Number.isInteger(height) || data.length < width * height * 4) return { ok: false, reason: 'Подложка недоступна для анализа пикселей.' };
    grid = buildCostMap(data, width, height, Math.max(1, Math.min(4, Math.round(step))));
  }
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) return { ok: false, reason: 'Не заданы начало и конец маршрута.' };
  const startCell = nearestInkCell(grid, start, 26), goalCell = nearestInkCell(grid, end, 26);
  if (!startCell || !goalCell) return { ok: false, reason: 'Рядом с точкой не найдены штрихи ручки. Поставьте её ближе к линии.' };
  if (startCell.index === goalCell.index) return { ok: false, reason: 'Начало и конец слишком близко друг к другу.' };

  const ax = startCell.x, ay = startCell.y, bx = goalCell.x, by = goalCell.y;
  const corridorCells = Math.max(3, corridorPx / grid.step);
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - corridorCells - 2));
  const maxX = Math.min(grid.width - 1, Math.ceil(Math.max(ax, bx) + corridorCells + 2));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - corridorCells - 2));
  const maxY = Math.min(grid.height - 1, Math.ceil(Math.max(ay, by) + corridorCells + 2));

  const stateCount = grid.width * grid.height * 9;
  // Reuse typed search buffers for each segment in the same drawing session.
  const scores = grid.searchScores || (grid.searchScores = new Float32Array(stateCount));
  const parents = grid.searchParents || (grid.searchParents = new Int32Array(stateCount));
  scores.fill(Infinity);
  const startState = startCell.index * 9 + 8;
  scores[startState] = 0; parents[startState] = -1;
  const heap = new MinHeap();
  heap.push(startState, Math.hypot(bx - ax, by - ay) * 1.15);
  let goalState = -1, visited = 0;

  while (heap.size && visited < maxVisited) {
    const current = heap.pop(); if (!current) break;
    const state = current.state, cellIndex = Math.floor(state / 9), previousDirection = state % 9;
    const currentScore = scores[state], x = cellIndex % grid.width, y = Math.floor(cellIndex / grid.width);
    if (cellIndex === goalCell.index) { goalState = state; break; }
    visited += 1;
    for (let direction = 0; direction < DIRECTIONS.length; direction += 1) {
      const [dx, dy, length] = DIRECTIONS[direction], nx = x + dx, ny = y + dy;
      if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
      if (pointSegmentDistance(nx, ny, ax, ay, bx, by) > corridorCells) continue;
      const nextIndex = ny * grid.width + nx, nextState = nextIndex * 9 + direction;
      const turnSteps = previousDirection === 8 ? 0 : Math.min((direction - previousDirection + 8) % 8, (previousDirection - direction + 8) % 8);
      const turnCost = turnSteps * 0.30;
      const newScore = currentScore + grid.cost[nextIndex] * length + turnCost;
      if (newScore >= scores[nextState]) continue;
      scores[nextState] = newScore; parents[nextState] = state;
      const heuristic = Math.hypot(bx - nx, by - ny) * 1.15;
      heap.push(nextState, newScore + heuristic);
    }
  }
  if (goalState < 0) return { ok: false, reason: visited >= maxVisited
    ? 'Слишком сложный участок. Добавьте промежуточную точку на повороте.'
    : 'Не нашёл непрерывный штрих в коридоре. Добавьте точку ближе к линии или увеличьте ширину коридора.' , metrics: { visited, corridorPx } };

  const rawPoints = [];
  let cursor = goalState;
  while (cursor >= 0) {
    const cellIndex = Math.floor(cursor / 9), x = cellIndex % grid.width, y = Math.floor(cellIndex / grid.width);
    rawPoints.push([Math.min(grid.sourceWidth - 1, x * grid.step + grid.step / 2), Math.min(grid.sourceHeight - 1, y * grid.step + grid.step / 2)]);
    if (cursor === startState) break;
    cursor = parents[cursor];
    if (rawPoints.length > grid.width * grid.height) break;
  }
  rawPoints.reverse();
  if (rawPoints.length < 2) return { ok: false, reason: 'Получился слишком короткий путь.' };
  const simplified = simplifyPath(rawPoints, Math.max(1.6, grid.step * 1.15));
  const points = [[start.x, start.y], ...simplified, [end.x, end.y]];
  const compact = points.filter((point, index) => index === 0 || Math.hypot(point[0] - points[index - 1][0], point[1] - points[index - 1][1]) > 1.25);
  let inkHits = 0, costTotal = 0;
  for (const [px, py] of rawPoints) {
    const gx = clamp(Math.floor(px / grid.step), 0, grid.width - 1), gy = clamp(Math.floor(py / grid.step), 0, grid.height - 1);
    const index = gy * grid.width + gx;
    if (grid.strength[index] >= 0.30) inkHits += 1;
    costTotal += grid.cost[index];
  }
  const inkSupport = inkHits / rawPoints.length, meanCost = costTotal / rawPoints.length;
  const lengthPx = compact.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - compact[index][0], point[1] - compact[index][1]), 0);
  const straightDistancePx = Math.hypot(end.x - start.x, end.y - start.y);
  if (inkSupport < 0.24 || meanCost > 9.2) return { ok: false, reason: `Недостаточно подтверждения чернилами (${Math.round(inkSupport * 100)}%).` , metrics: { inkSupport, meanCost, visited } };
  return {
    ok: true,
    points: compact.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]),
    metrics: { rawPoints: rawPoints.length, simplifiedPoints: compact.length, lengthPx: Math.round(lengthPx * 10) / 10,
      straightDistancePx: Math.round(straightDistancePx * 10) / 10, inkSupport: Math.round(inkSupport * 1000) / 1000,
      meanCost: Math.round(meanCost * 100) / 100, visited, corridorPx, snappedStartPx: Math.round(startCell.distance * 10) / 10,
      snappedEndPx: Math.round(goalCell.distance * 10) / 10 }
  };
}
