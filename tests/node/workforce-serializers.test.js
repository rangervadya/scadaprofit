// Serializer and lookup cache tests (P2-1).
//
// These are pure functions after the workforce split, so they can be tested
// without a server or database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLookups,
  createLookupCache,
  taskForClient,
  reportForClient,
  defectReportForClient,
} from '../../services/ollama/api/workforce-serializers.js';

const users = [
  { id: 'u1', displayName: 'Иван Петров', role: 'fitter' },
  { id: 'u2', displayName: 'Пётр Сидоров', role: 'supervisor' },
];

function makeWorkspace() {
  return {
    tasks: [
      { id: 't1', title: 'Обход', street: 'Ленина', address: '1', assignedTo: 'u1', status: 'in_progress', events: [] },
      { id: 't2', title: 'Обход 2', street: 'Мира', address: '2', assignedTo: null, status: 'assigned' },
    ],
    reports: [
      {
        id: 'r1',
        taskId: 't1',
        userId: 'u1',
        status: 'pending_review',
        note: 'ok',
        submittedAt: '2026-01-01T00:00:00Z',
      },
    ],
    defectReports: [
      { id: 'd1', taskId: 't1', userId: 'u1', status: 'accepted', photos: [{ id: 'p1', originalName: 'a.jpg' }] },
    ],
  };
}

test('buildLookups indexes by id and groups by task', () => {
  const lookups = buildLookups(users, makeWorkspace());
  assert.equal(lookups.usersById.get('u1').displayName, 'Иван Петров');
  assert.equal(lookups.tasksById.get('t1').title, 'Обход');
  assert.equal(lookups.reportsByTask.get('t1').length, 1);
  assert.equal(lookups.defectsByTask.get('t1').length, 1);
  assert.equal(lookups.reportsByTask.get('t2'), undefined);
});

test('lookup cache rebuilds only after invalidate', () => {
  const workspace = makeWorkspace();
  const cache = createLookupCache(users, workspace);
  assert.equal(cache.get().reportsByTask.get('t1').length, 1);

  workspace.reports.push({ id: 'r2', taskId: 't1', userId: 'u2', status: 'pending_review' });
  // Without invalidate the stale map is returned.
  assert.equal(cache.get().reportsByTask.get('t1').length, 1);

  cache.invalidate();
  assert.equal(cache.get().reportsByTask.get('t1').length, 2);
});

test('taskForClient resolves the assignee and report counts', () => {
  const workspace = makeWorkspace();
  const lookups = buildLookups(users, workspace);
  const task = taskForClient(workspace.tasks[0], lookups);
  assert.equal(task.assignedName, 'Иван Петров');
  assert.equal(task.reportsCount, 1);
  assert.equal(task.defectReportsCount, 1);

  const unassigned = taskForClient(workspace.tasks[1], lookups);
  assert.equal(unassigned.assignedName, 'Не назначен');
  assert.equal(unassigned.reportsCount, 0);
});

test('reportForClient resolves task, author and file urls', () => {
  const workspace = makeWorkspace();
  const lookups = buildLookups(users, workspace);
  const report = reportForClient(workspace.reports[0], lookups);
  assert.equal(report.taskTitle, 'Обход');
  assert.equal(report.street, 'Ленина');
  assert.equal(report.userName, 'Иван Петров');
  assert.equal(report.taskId, 't1');
});

test('defectReportForClient resolves user and photo urls', () => {
  const workspace = makeWorkspace();
  const lookups = buildLookups(users, workspace);
  const defect = defectReportForClient(workspace.defectReports[0], lookups);
  assert.equal(defect.userName, 'Иван Петров');
  assert.equal(defect.photos[0].url, '/api/workforce/defects/d1/files/p1');
});
