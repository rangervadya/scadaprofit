import test from 'node:test';
import assert from 'node:assert/strict';
import { countDirectedPaths, validateInputGraph, validateRouteOutput } from '../graph.js';

const graph = {
  points: [{ id: 'P1', x: 199, y: 415 }, { id: 'P2', x: 854, y: 217 }],
  lines: [{ from: 'P1', to: 'P2' }],
};
const correctRoute = {
  status: 'ok',
  points: graph.points,
  lines: graph.lines,
  path: ['P1', 'P2'],
  total_length: Math.hypot(854 - 199, 217 - 415),
  warnings: [],
};

test('validates simple directed P1 -> P2 graph', () => {
  assert.equal(validateInputGraph(graph).valid, true);
  assert.equal(countDirectedPaths(graph, 'P1', 'P2'), 1);
  assert.equal(validateRouteOutput(correctRoute, graph, 'P1', 'P2').valid, true);
});

test('rejects reversed directed edge', () => {
  const reversed = { ...correctRoute, lines: [{ from: 'P2', to: 'P1' }], path: ['P1', 'P2'] };
  const result = validateRouteOutput(reversed, graph, 'P1', 'P2');
  assert.equal(result.valid, false);
  assert.ok(result.warnings.some(item => item.includes('направление')) || result.warnings.some(item => item.includes('нет направленной связи')));
});

test('rejects changed coordinates and incorrect length', () => {
  const changed = {
    ...correctRoute,
    points: [{ id: 'P1', x: 200, y: 415 }, graph.points[1]],
    total_length: 100,
  };
  const result = validateRouteOutput(changed, graph, 'P1', 'P2');
  assert.equal(result.valid, false);
  assert.ok(result.warnings.some(item => item.includes('координаты')));
  assert.ok(result.warnings.some(item => item.includes('total_length')));
});

test('detects ambiguous directed graph', () => {
  const branched = {
    points: [
      { id: 'A', x: 0, y: 0 }, { id: 'B', x: 10, y: 0 },
      { id: 'C', x: 0, y: 10 }, { id: 'D', x: 20, y: 0 },
    ],
    lines: [{ from: 'A', to: 'B' }, { from: 'B', to: 'D' }, { from: 'A', to: 'C' }, { from: 'C', to: 'D' }],
  };
  assert.equal(countDirectedPaths(branched, 'A', 'D'), 2);
});

test('rejects duplicate point ids', () => {
  const result = validateInputGraph({ points: [{ id: 'A', x: 1, y: 1 }, { id: 'A', x: 2, y: 2 }], lines: [] });
  assert.equal(result.valid, false);
  assert.ok(result.warnings.some(item => item.includes('повторяется id')));
});
