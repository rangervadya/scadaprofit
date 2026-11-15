import express from 'express';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';

/**
 * Job routes (P2-1): graph, connections, review.
 *
 * Graph mutation stays in one place; the router receives the URL builder and the
 * small graph helpers from server.js so behaviour is unchanged.
 */
export function createJobsRouter({
  dataDir,
  attachJobUrls,
  nextManualEdgeId,
  validateBody,
  connectionSchema,
  reviewSchema,
  cleanLabel,
  shortJobId,
  JOB_ID_PATTERN,
}) {
  const router = express.Router();

  router.get('/:jobId/graph', async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });

    const jobDir = path.join(dataDir, jobId);
    try {
      const [raw, entries] = await Promise.all([readFile(path.join(jobDir, 'graph.json'), 'utf8'), readdir(jobDir)]);
      const graph = JSON.parse(raw);
      const sourceName = entries.find((name) => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name)) || null;
      if (!sourceName) return res.status(404).json({ error: 'Исходное изображение задания не найдено.' });
      return res.json(attachJobUrls(jobId, graph, sourceName));
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      return res.status(status).json({
        error:
          status === 404 ? 'Сохранённое задание не найдено или уже удалено.' : 'Не удалось прочитать граф задания.',
      });
    }
  });

  router.post('/:jobId/connections', validateBody(connectionSchema), async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });

    const from = String(req.body?.from || '').trim();
    const to = String(req.body?.to || '').trim();
    const candidateId = req.body?.candidateId == null ? null : String(req.body.candidateId).trim();
    const confirmAlternative = req.body?.confirmAlternative === true;

    if (!from || !to || from === to || from.length > 64 || to.length > 64) {
      return res.status(400).json({ error: 'Укажите два разных узла графа.' });
    }

    const jobDir = path.join(dataDir, jobId);
    const graphPath = path.join(jobDir, 'graph.json');

    try {
      const graph = JSON.parse(await readFile(graphPath, 'utf8'));
      graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
      graph.edges = Array.isArray(graph.edges) ? graph.edges : [];
      graph.joinCandidates = Array.isArray(graph.joinCandidates) ? graph.joinCandidates : [];
      graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];

      const nodeById = new Map(graph.nodes.map((node) => [String(node.id), node]));
      const a = nodeById.get(from);
      const b = nodeById.get(to);
      if (!a || !b) {
        return res.status(404).json({ error: 'Один из узлов больше не существует в сохранённом графе.' });
      }

      let candidate = null;
      if (candidateId) {
        candidate = graph.joinCandidates.find((item) => {
          const samePair =
            (String(item.from) === from && String(item.to) === to) ||
            (String(item.from) === to && String(item.to) === from);
          return String(item.id) === candidateId && samePair;
        });

        if (!candidate) {
          return res
            .status(409)
            .json({ error: 'Кандидат устарел или уже был использован. Обновите сохранённое задание.' });
        }
        if (candidate.has_alternatives && !confirmAlternative) {
          return res
            .status(409)
            .json({ error: 'У узла есть конкурирующие варианты. Требуется явное подтверждение выбранной пары.' });
        }
        if (Number(a.degree) !== 1 || Number(b.degree) !== 1) {
          return res.status(409).json({ error: 'Один из концов уже соединён. Обновите список кандидатов.' });
        }
      }

      const duplicate = graph.edges.some(
        (edge) =>
          (String(edge.from) === from && String(edge.to) === to) ||
          (String(edge.from) === to && String(edge.to) === from),
      );
      if (duplicate) return res.status(409).json({ error: 'Такое соединение уже существует.' });

      const edgeId = nextManualEdgeId(graph.edges);
      const confirmedAt = new Date().toISOString();

      graph.edges.push({
        id: edgeId,
        from,
        to,
        source: 'manual',
        confidence: 1,
        geometry: [
          [Number(a.x), Number(a.y)],
          [Number(b.x), Number(b.y)],
        ],
        visible: true,
        review: false,
        detector: 'MANUAL',
        component_role: 'line_structure',
        component_id: 'MANUAL',
        manual_reason: candidate ? 'user-confirmed-join-candidate' : 'user-created-connection',
        candidate_id: candidate?.id || null,
        candidate_score: candidate?.score ?? null,
        confirmed_at: confirmedAt,
      });

      a.degree = Number(a.degree || 0) + 1;
      b.degree = Number(b.degree || 0) + 1;
      a.review = false;
      b.review = false;

      const record = {
        id: `MC${graph.confirmedConnections.length + 1}`,
        edgeId,
        candidateId: candidate?.id || null,
        from,
        to,
        score: candidate?.score ?? null,
        confirmedAt,
        confirmation: 'explicit-user-action',
      };
      graph.confirmedConnections.push(record);
      const consumed = new Set([from, to]);
      graph.joinCandidates = graph.joinCandidates.filter(
        (item) => !consumed.has(String(item.from)) && !consumed.has(String(item.to)),
      );

      graph.summary = graph.summary && typeof graph.summary === 'object' ? graph.summary : {};
      graph.summary.edges = graph.edges.length;
      graph.summary.confirmed_connections = graph.confirmedConnections.length;

      const tempPath = `${graphPath}.tmp-${randomUUID()}`;
      await writeFile(tempPath, JSON.stringify(graph, null, 2), 'utf8');
      await rename(tempPath, graphPath);

      const entries = await readdir(jobDir);
      const sourceName = entries.find((name) => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name)) || null;
      req.log.info(
        { jobId: shortJobId(jobId), connectionId: record.id, from, to, edgeId, candidateId: candidate?.id || 'manual' },
        'Confirmed graph connection',
      );
      return res.json({ ok: true, connection: record, graph: attachJobUrls(jobId, graph, sourceName) });
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      req.log.error({ err: error, jobId: shortJobId(jobId) }, 'Cannot save connection');
      return res
        .status(status)
        .json({ error: status === 404 ? 'Задание не найдено.' : 'Не удалось сохранить соединение.' });
    }
  });

  router.post('/:jobId/review', validateBody(reviewSchema), async (req, res) => {
    const { jobId } = req.params;
    if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });
    const action = String(req.body?.action || '').trim();
    const targetId = String(req.body?.targetId || '').trim();
    if (!action || !targetId || targetId.length > 64)
      return res.status(400).json({ error: 'Не указано действие или объект проверки.' });
    const jobDir = path.join(dataDir, jobId);
    const graphPath = path.join(jobDir, 'graph.json');
    try {
      const graph = JSON.parse(await readFile(graphPath, 'utf8'));
      const model = graph.documentModel;
      if (!model || typeof model !== 'object')
        return res.status(409).json({ error: 'В задании нет редактируемой модели.' });
      model.reviewTasks = Array.isArray(model.reviewTasks) ? model.reviewTasks : [];
      model.validationFindings = Array.isArray(model.validationFindings) ? model.validationFindings : [];
      const resolveTasks = (kind) =>
        model.reviewTasks.forEach((task) => {
          if ((!kind || task.kind === kind) && (task.targetIds || []).map(String).includes(targetId))
            task.status = 'resolved';
        });
      if (action === 'classify_symbol') {
        const symbol = (model.symbols || []).find((item) => String(item.id) === targetId);
        const symbolType = String(req.body?.symbolType || '').trim();
        const catalog = (graph.symbolCatalog || []).find((item) => String(item.type) === symbolType);
        if (!symbol) return res.status(404).json({ error: 'Кандидат символа не найден.' });
        if (!catalog) return res.status(400).json({ error: 'Неизвестный тип CAD-символа.' });
        Object.assign(symbol, {
          type: symbolType,
          catalogLabel: cleanLabel(catalog.label, 100),
          rotation: Math.max(0, Math.min(359.99, Number(req.body?.rotation) || 0)),
          ports: Array.isArray(catalog.ports) ? catalog.ports : [],
          state: 'primary',
        });
        resolveTasks('classify_symbol');
      } else if (action === 'assign_dimension') {
        const dimension = (model.dimensions || []).find((item) => String(item.id) === targetId);
        const pipeId = String(req.body?.pipeId || '').trim();
        const pipe = (model.pipes || []).find((item) => String(item.id) === pipeId && item.state === 'primary');
        if (!dimension) return res.status(404).json({ error: 'Размер не найден.' });
        if (!pipe) return res.status(400).json({ error: 'Выберите подтверждённый участок трубопровода.' });
        const numericValue = Number(req.body?.value);
        if (Number.isFinite(numericValue) && numericValue >= 0) dimension.value = numericValue;
        Object.assign(dimension, { targetId: pipeId, state: 'primary' });
        resolveTasks('assign_dimension');
      } else if (action === 'verify_text') {
        const label = (model.labels || []).find((item) => String(item.id) === targetId);
        const text = cleanLabel(req.body?.text, 240);
        if (!label) return res.status(404).json({ error: 'Подпись не найдена.' });
        if (!text) return res.status(400).json({ error: 'Введите подтверждённый текст.' });
        Object.assign(label, { text, state: 'primary' });
        resolveTasks('verify_text');
      } else if (action === 'resolve_finding') {
        const finding = model.validationFindings.find((item) => String(item.id) === targetId);
        if (!finding) return res.status(404).json({ error: 'Замечание не найдено.' });
        Object.assign(finding, {
          status: 'resolved',
          resolution: cleanLabel(req.body?.resolution || 'Проверено оператором', 180),
        });
      } else if (action === 'dismiss_task') {
        const task = model.reviewTasks.find((item) => String(item.id) === targetId);
        if (!task) return res.status(404).json({ error: 'Задание проверки не найдено.' });
        task.status = 'dismissed';
      } else return res.status(400).json({ error: 'Неподдерживаемое действие проверки.' });

      model.status =
        model.reviewTasks.some((item) => item.status === 'open') ||
        model.validationFindings.some((item) => item.status === 'open')
          ? 'needs_review'
          : 'confirmed';
      graph.status = model.status;
      const tempPath = `${graphPath}.tmp-${randomUUID()}`;
      await writeFile(tempPath, JSON.stringify(graph, null, 2), 'utf8');
      await rename(tempPath, graphPath);
      const entries = await readdir(jobDir);
      const sourceName = entries.find((name) => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name)) || null;
      return res.json({ ok: true, graph: attachJobUrls(jobId, graph, sourceName) });
    } catch (error) {
      const status = error?.code === 'ENOENT' ? 404 : 500;
      req.log.error({ err: error, jobId: shortJobId(jobId) }, 'Cannot save review action');
      return res
        .status(status)
        .json({ error: status === 404 ? 'Задание не найдено.' : 'Не удалось сохранить решение проверки.' });
    }
  });

  return router;
}
