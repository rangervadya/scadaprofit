import test from 'node:test';
import assert from 'node:assert/strict';
import { strokesToGraph } from '../strokes.js';

test('converts one polyline to directed adjacent edges', () => {
  const graph = strokesToGraph({
    strokes: [{ id: 'S1', confidence: 0.8, points: [{ x: 10, y: 20 }, { x: 30, y: 40 }, { x: 50, y: 40 }] }],
    warnings: [],
  });
  assert.equal(graph.strokeCount, 1);
  assert.deepEqual(graph.points, [
    { id: 'S1_P1', x: 10, y: 20 },
    { id: 'S1_P2', x: 30, y: 40 },
    { id: 'S1_P3', x: 50, y: 40 },
  ]);
  assert.deepEqual(graph.lines, [
    { from: 'S1_P1', to: 'S1_P2' },
    { from: 'S1_P2', to: 'S1_P3' },
  ]);
});

test('does not merge separate strokes even when endpoints coincide', () => {
  const graph = strokesToGraph({ strokes: [
    { id: 'S1', points: [{ x: 10, y: 10 }, { x: 20, y: 20 }] },
    { id: 'S2', points: [{ x: 20, y: 20 }, { x: 30, y: 10 }] },
  ] });
  assert.equal(graph.points.length, 4);
  assert.equal(graph.lines.length, 2);
  assert.notEqual(graph.lines[0].to, graph.lines[1].from);
});

test('filters invalid coordinates and skips too-short strokes', () => {
  const graph = strokesToGraph({ strokes: [
    { id: 'S1', points: [{ x: -1, y: 0 }, { x: 10, y: 10 }] },
    { id: 'S2', points: [{ x: 30, y: 30 }, { x: 30, y: 30 }] },
  ] });
  assert.equal(graph.strokeCount, 0);
  assert.equal(graph.skippedStrokes, 2);
  assert.equal(graph.points.length, 0);
  assert.equal(graph.lines.length, 0);
});
