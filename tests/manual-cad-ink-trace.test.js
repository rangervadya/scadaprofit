import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareInkTrace, traceInkRoute } from '../public/manual-cad-ink-trace.js';

function image(width, height) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255; data[i + 1] = 255; data[i + 2] = 255; data[i + 3] = 255;
  }
  return data;
}
function inkLine(data, width, x0, y0, x1, y1, color = [24, 38, 28]) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let n = 0; n <= steps; n += 1) {
    const t = steps ? n / steps : 0;
    const x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    const offset = (y * width + x) * 4;
    data[offset] = color[0]; data[offset + 1] = color[1]; data[offset + 2] = color[2]; data[offset + 3] = 255;
  }
}

test('ink tracer follows a hand-drawn bent route between operator waypoints', () => {
  const width = 120, height = 90, data = image(width, height);
  inkLine(data, width, 8, 35, 58, 35, [25, 55, 180]);
  inkLine(data, width, 58, 35, 58, 70, [25, 55, 180]);
  const prepared = prepareInkTrace({ data, width, height, step: 1 });
  const first = traceInkRoute({ prepared, start: { x: 8, y: 35 }, end: { x: 58, y: 35 }, corridorPx: 18 });
  const second = traceInkRoute({ prepared, start: { x: 58, y: 35 }, end: { x: 58, y: 70 }, corridorPx: 18 });
  assert.equal(first.ok, true, first.reason);
  assert.equal(second.ok, true, second.reason);
  assert.ok(first.metrics.inkSupport > 0.65);
  assert.ok(second.metrics.inkSupport > 0.65);
  assert.ok(first.points.length >= 2);
  assert.ok(second.points.length >= 2);
  const near = (actual, expected) => Math.hypot(actual[0] - expected[0], actual[1] - expected[1]) <= 1.5;
  assert.ok(near(first.points[0], [8, 35]));
  assert.ok(near(first.points.at(-1), [58, 35]));
  assert.ok(near(second.points[0], [58, 35]));
  assert.ok(near(second.points.at(-1), [58, 70]));
});

test('ink tracer does not jump to a distant parallel stroke outside its corridor', () => {
  const width = 120, height = 90, data = image(width, height);
  inkLine(data, width, 10, 25, 110, 25, [25, 55, 180]);
  inkLine(data, width, 10, 65, 110, 65, [25, 55, 180]);
  const prepared = prepareInkTrace({ data, width, height, step: 1 });
  const result = traceInkRoute({ prepared, start: { x: 10, y: 25 }, end: { x: 110, y: 25 }, corridorPx: 12 });
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.points.every(point => point[1] < 40), 'route should remain on the selected upper line');
});

test('ink tracer fails with a useful reason when no ink exists near a waypoint', () => {
  const width = 80, height = 60, data = image(width, height);
  const prepared = prepareInkTrace({ data, width, height, step: 2 });
  const result = traceInkRoute({ prepared, start: { x: 10, y: 10 }, end: { x: 70, y: 50 } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /не найдены штрихи/i);
});
