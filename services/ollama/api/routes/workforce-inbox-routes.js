import express from 'express';
import path from 'node:path';

/**
 * Inbox routes (P2-1): defects, reports, conclusion, overview.
 *
 * `refreshSchemeState` is included here because the reports list refreshes CAD
 * status while polling. Workspace is read through an accessor.
 */
export function createInboxRouter(ctx) {
  const {
    getWorkspace,
    getUsers,
    saveWorkspace,
    requireRoles,
    cleanText,
    reportForClient,
    defectReportForClient,
    sendJsonConditional,
    getSketchStatus,
    evaluateAddressFolder,
    reportFilesDir,
    log,
    taskForClient,
    publicUser,
  } = ctx;

  const router = express.Router();

  router.get('/defects', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const list = getWorkspace()
      .defectReports.filter((report) => report.status !== 'superseded')
      .map((report) => ({
        ...defectReportForClient(report),
        seen: Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id),
      }));
    return sendJsonConditional(req, res, {
      ok: true,
      reports: list,
      unreadCount: list.filter((report) => !report.seen && report.status === 'pending_review').length,
      pendingCount: list.filter((report) => report.status === 'pending_review').length,
    });
  });

  router.post('/defects/:id/seen', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = getWorkspace().defectReports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    report.seenBy = Array.isArray(report.seenBy) ? report.seenBy : [];
    if (!report.seenBy.includes(req.user.id)) report.seenBy.push(req.user.id);
    report.lastSeenAt = new Date().toISOString();
    await saveWorkspace();
    return res.json({ ok: true, seen: true });
  });

  router.post('/defects/:id/review', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = getWorkspace().defectReports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    if (req.user.role === 'receiver' && !(Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id))) {
      return res.status(409).json({ error: 'Сначала открой фотографии дефектов.' });
    }
    const status = String(req.body?.status || '');
    if (!['accepted', 'revision_requested'].includes(status))
      return res.status(400).json({ error: 'Подтверди, что фотографии подходят, или верни отчёт.' });
    report.status = status;
    report.reviewComment = cleanText(req.body?.comment, 1200);
    report.reviewedAt = new Date().toISOString();
    report.reviewedBy = req.user.id;
    await saveWorkspace();
    req.log.info(
      { reportId: report.id, taskId: report.taskId, status, reviewerId: req.user.id },
      'Defect photo report reviewed',
    );
    return res.json({ ok: true, report: defectReportForClient(report) });
  });

  router.get('/defects/:reportId/files/:fileId', (req, res) => {
    if (!req.user || !['fitter', 'receiver', 'supervisor', 'developer'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Нет доступа к фотографиям дефектов.' });
    }
    const report = getWorkspace().defectReports.find((item) => item.id === req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Отчёт о дефектах не найден.' });
    if (req.user.role === 'fitter' && report.userId !== req.user.id)
      return res.status(403).json({ error: 'Нет доступа к этой фотографии.' });
    const file = (report.photos || []).find((item) => item.id === req.params.fileId);
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName || ''))
      return res.status(404).json({ error: 'Фотография не найдена.' });
    const fullPath = path.join(reportFilesDir, report.id, file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName || 'defect-photo')}`,
    );
    return res.sendFile(fullPath, { dotfiles: 'allow' }, (error) => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Фотография дефекта недоступна.' });
    });
  });

  /**
   * Refresh a report's CAD status. Returns true when anything actually changed,
   * so callers can skip a workspace write on a poll that found nothing new.
   */
  async function refreshSchemeState(report) {
    if (!report?.schemeJobId || typeof getSketchStatus !== 'function') return false;
    const before = `${report.schemeStatus}|${report.schemeError}|${report.schemeCompletedAt}|${report.schemePartialGraphReady}|${report.status}`;
    try {
      const state = await getSketchStatus(report.schemeJobId);
      if (state?.status) report.schemeStatus = state.status;
      if (state?.error !== undefined) report.schemeError = cleanText(state.error, 900);
      if (state?.completedAt) report.schemeCompletedAt = state.completedAt;
      if (state?.partialGraphReady) report.schemePartialGraphReady = true;
      const hasReviewableResult =
        report.schemeStatus === 'completed' || (report.schemeStatus === 'failed' && report.schemePartialGraphReady);
      if (hasReviewableResult) {
        if (!['accepted', 'revision_requested'].includes(report.status)) report.status = 'pending_review';
        const task = getWorkspace().tasks.find((item) => item.id === report.taskId);
        if (task && task.status === 'submitted') task.status = 'pending_review';
      } else if (report.schemeStatus === 'failed') {
        report.status = 'processing_failed';
        const task = getWorkspace().tasks.find((item) => item.id === report.taskId);
        if (task && task.status === 'submitted') task.status = 'processing_failed';
      }
    } catch (error) {
      report.schemeError = cleanText(error?.message || 'Не удалось проверить состояние CAD-обработки.', 900);
      log.warn(
        { err: error, reportId: report.id, schemeJobId: report.schemeJobId },
        'Failed to refresh CAD scheme status',
      );
    }
    const after = `${report.schemeStatus}|${report.schemeError}|${report.schemeCompletedAt}|${report.schemePartialGraphReady}|${report.status}`;
    return before !== after;
  }

  router.get('/reports', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    let changed = false;
    for (const report of getWorkspace().reports) {
      if (await refreshSchemeState(report)) changed = true;
    }
    // Only persist when a scheme status actually moved: this endpoint is polled.
    if (changed) await saveWorkspace();
    const reports = getWorkspace()
      .reports.filter(
        (report) =>
          req.user.role !== 'receiver' ||
          ['processing', 'processing_failed', 'pending_review', 'accepted', 'revision_requested'].includes(
            report.status,
          ),
      )
      .map((report) => ({
        ...reportForClient(report),
        seen: Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id),
      }));
    return sendJsonConditional(req, res, {
      ok: true,
      reports,
      unreadCount: getWorkspace().reports.filter(
        (report) =>
          report.status !== 'superseded' && (!Array.isArray(report.seenBy) || !report.seenBy.includes(req.user.id)),
      ).length,
    });
  });

  router.post('/reports/:id/seen', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = getWorkspace().reports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Уведомление не найдено.' });
    report.seenBy = Array.isArray(report.seenBy) ? report.seenBy : [];
    if (!report.seenBy.includes(req.user.id)) report.seenBy.push(req.user.id);
    report.lastSeenAt = new Date().toISOString();
    await saveWorkspace();
    return res.json({ ok: true, seen: true });
  });

  router.post('/reports/:id/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    return res.status(409).json({
      error:
        'Теперь схемы добавляются только целой папкой адреса. Открой уведомления по дому и нажми «Добавить папку в заключение».',
    });
  });

  router.post('/defects/:id/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    return res.status(409).json({
      error:
        'Фотографии дефектов добавляются только вместе со всей папкой адреса. Открой уведомления по дому и нажми «Добавить папку в заключение».',
    });
  });

  router.post('/tasks/:taskId/conclusion', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const task = getWorkspace().tasks.find((item) => item.id === req.params.taskId);
    if (!task) return res.status(404).json({ error: 'Папка задания по этому адресу не найдена.' });

    const allTaskSchemes = getWorkspace().reports.filter((report) => report.taskId === task.id);
    const allTaskDefects = getWorkspace().defectReports.filter((report) => report.taskId === task.id);
    for (const report of allTaskSchemes) await refreshSchemeState(report);
    await saveWorkspace();
    const folderState = evaluateAddressFolder({
      schemes: allTaskSchemes,
      defects: allTaskDefects,
      userId: req.user.role === 'receiver' ? req.user.id : null,
    });
    const schemeReports = folderState.schemes;
    const defectReports = folderState.defects;
    const materialReports = folderState.items;
    if (!materialReports.length)
      return res.status(409).json({ error: 'В папке пока нет отправленных схем или фотографий дефектов.' });
    if (folderState.unseenCount)
      return res.status(409).json({ error: 'Сначала открой папку и просмотри все схемы и фотографии дефектов.' });
    if (!folderState.allAccepted) {
      const schemesPending = schemeReports.filter((report) => report.status !== 'accepted').length;
      const defectsPending = defectReports.filter((report) => report.status !== 'accepted').length;
      return res.status(409).json({
        error: `Нельзя перенести папку целиком: сначала прими все материалы. Не приняты схемы: ${schemesPending}, отчёты о дефектах: ${defectsPending}.`,
      });
    }
    if (!folderState.schemesReady)
      return res.status(409).json({
        error: 'CAD-обработка ещё не готова для одной или нескольких схем. Дождись завершения и повтори перенос папки.',
      });
    if (!folderState.photosReady)
      return res
        .status(409)
        .json({ error: 'В одном из отчётов о дефектах нет прикреплённых фотографий. Проверь папку.' });

    const addedAt = new Date().toISOString();
    const previousValues = materialReports.map((report) => ({
      report,
      conclusionAddedAt: report.conclusionAddedAt || null,
      conclusionAddedBy: report.conclusionAddedBy || null,
    }));
    const previousFolderValues = {
      conclusionFolderAddedAt: task.conclusionFolderAddedAt || null,
      conclusionFolderAddedBy: task.conclusionFolderAddedBy || null,
    };
    for (const report of materialReports) {
      report.conclusionAddedAt ||= addedAt;
      report.conclusionAddedBy ||= req.user.id;
      report.conclusionFolderId = task.id;
    }
    task.conclusionFolderAddedAt = addedAt;
    task.conclusionFolderAddedBy = req.user.id;
    try {
      await saveWorkspace();
    } catch (error) {
      for (const previous of previousValues) {
        if (previous.conclusionAddedAt) previous.report.conclusionAddedAt = previous.conclusionAddedAt;
        else delete previous.report.conclusionAddedAt;
        if (previous.conclusionAddedBy) previous.report.conclusionAddedBy = previous.conclusionAddedBy;
        else delete previous.report.conclusionAddedBy;
      }
      if (previousFolderValues.conclusionFolderAddedAt)
        task.conclusionFolderAddedAt = previousFolderValues.conclusionFolderAddedAt;
      else delete task.conclusionFolderAddedAt;
      if (previousFolderValues.conclusionFolderAddedBy)
        task.conclusionFolderAddedBy = previousFolderValues.conclusionFolderAddedBy;
      else delete task.conclusionFolderAddedBy;
      return res.status(500).json({ error: `Не удалось сохранить папку в заключение: ${error.message}` });
    }
    req.log.info(
      {
        taskId: task.id,
        userId: req.user.id,
        schemes: schemeReports.length,
        defects: defectReports.length,
        photos: defectReports.reduce((sum, report) => sum + (report.photos || []).length, 0),
      },
      'Address folder transferred into conclusion',
    );
    return res.json({
      ok: true,
      folder: {
        taskId: task.id,
        street: task.street,
        address: task.address,
        schemesCount: schemeReports.length,
        defectReportsCount: defectReports.length,
        photosCount: defectReports.reduce((sum, report) => sum + (report.photos || []).length, 0),
        addedAt,
      },
      conclusionUrl: `/conclusion.html?task=${encodeURIComponent(task.id)}`,
    });
  });

  router.get('/conclusion', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    let taskId = cleanText(req.query.task, 120);
    if (!taskId && req.query.report) {
      const target = getWorkspace().reports.find((item) => item.id === String(req.query.report));
      if (target?.conclusionAddedAt && target.status === 'accepted') taskId = target.taskId;
    }
    if (!taskId && req.query.defectReport) {
      const target = getWorkspace().defectReports.find((item) => item.id === String(req.query.defectReport));
      if (target?.conclusionAddedAt && target.status === 'accepted') taskId = target.taskId;
    }
    if (!taskId) return res.json({ ok: true, task: null, reports: [], defectReports: [] });
    const task = getWorkspace().tasks.find((item) => item.id === taskId);
    if (!task) return res.status(404).json({ error: 'Задание или адрес для заключения не найден.' });
    const reports = getWorkspace()
      .reports.filter(
        (report) => report.taskId === taskId && Boolean(report.conclusionAddedAt) && report.status === 'accepted',
      )
      .map((report) => {
        const manualCadBase = report.manualCadProjectId
          ? `/api/manual-cad/projects/${encodeURIComponent(report.manualCadProjectId)}`
          : null;
        return {
          ...reportForClient(report),
          schemeSvgUrl: manualCadBase
            ? `${manualCadBase}/preview.svg`
            : report.schemeJobId
              ? `/jobs/${report.schemeJobId}/clean.svg`
              : null,
          schemeDxfUrl: manualCadBase
            ? `${manualCadBase}/export.dxf`
            : report.schemeJobId
              ? `/jobs/${report.schemeJobId}/drawing.dxf`
              : null,
          schemeOriginalUrl: report.sketch
            ? `/api/workforce/reports/${encodeURIComponent(report.id)}/files/${encodeURIComponent(report.sketch.id)}`
            : null,
        };
      });
    const defectReports = getWorkspace()
      .defectReports.filter(
        (report) => report.taskId === taskId && Boolean(report.conclusionAddedAt) && report.status === 'accepted',
      )
      .map(defectReportForClient);
    return res.json({
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        street: task.street,
        address: task.address,
        scheduledDate: task.scheduledDate,
      },
      reports,
      defectReports,
    });
  });

  router.post('/reports/:id/review', async (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const report = getWorkspace().reports.find((item) => item.id === req.params.id);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден.' });
    if (req.user.role === 'receiver' && !(Array.isArray(report.seenBy) && report.seenBy.includes(req.user.id))) {
      return res.status(409).json({ error: 'Сначала открой папку адреса и просмотри эту схему.' });
    }
    const status = String(req.body?.status || '');
    if (!['accepted', 'revision_requested'].includes(status))
      return res.status(400).json({ error: 'Выбери приёмку или возврат на исправление.' });
    report.status = status;
    report.reviewComment = cleanText(req.body?.comment, 1200);
    report.reviewedAt = new Date().toISOString();
    const task = getWorkspace().tasks.find((item) => item.id === report.taskId);
    if (task) {
      task.status = status;
      task.updatedAt = report.reviewedAt;
      if (status === 'revision_requested') {
        task.completedAt = null;
        task.visitedAt = null;
        task.officeAt = null;
      }
    }
    await saveWorkspace();
    req.log.info(
      { reportId: report.id, taskId: report.taskId, status, reviewerId: req.user.id },
      'Sketch report reviewed',
    );
    return res.json({ ok: true, report: reportForClient(report), task: task ? taskForClient(task) : null });
  });

  router.get('/reports/:reportId/files/:fileId', async (req, res) => {
    const report = getWorkspace().reports.find((item) => item.id === req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Отчёт не найден.' });
    if (req.user.role === 'fitter' && report.userId !== req.user.id)
      return res.status(403).json({ error: 'Нет доступа к этому файлу.' });
    const file = [...(report.photos || []), ...(report.sketch ? [report.sketch] : [])].find(
      (item) => item.id === req.params.fileId,
    );
    if (!file || !/^[a-f0-9-]{36}\.[a-z0-9]{1,12}$/i.test(file.fileName))
      return res.status(404).json({ error: 'Файл не найден.' });
    const fullPath = path.join(reportFilesDir, report.id, file.fileName);
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.originalName || 'report-file')}`,
    );
    return res.sendFile(fullPath, { dotfiles: 'allow' }, (error) => {
      if (error) req.log.warn({ err: error, fullPath }, 'Cannot send workforce report file');
      if (error && !res.headersSent) res.status(404).json({ error: 'Файл отчёта недоступен.' });
    });
  });

  router.get('/overview', (req, res) => {
    if (!requireRoles(req, res, ['receiver', 'supervisor', 'developer'])) return;
    const visibleUsers = getUsers().filter(
      (user) =>
        user.active !== false &&
        (req.user.role === 'receiver' ? ['fitter', 'supervisor'].includes(user.role) : user.role !== 'developer'),
    );
    const userList = visibleUsers.map((user) => ({
      ...publicUser(user),
      assignedTasks: getWorkspace().tasks.filter(
        (task) => task.assignedTo === user.id && !['accepted'].includes(task.status),
      ).length,
      activeTask: getWorkspace().tasks.find(
        (task) => task.assignedTo === user.id && !['accepted', 'submitted'].includes(task.status),
      )
        ? taskForClient(
            getWorkspace().tasks.find(
              (task) => task.assignedTo === user.id && !['accepted', 'submitted'].includes(task.status),
            ),
          )
        : null,
    }));
    return sendJsonConditional(req, res, {
      ok: true,
      users: userList,
      tasks: getWorkspace().tasks.map(taskForClient),
      reports: getWorkspace().reports.map(reportForClient),
      defectReports: getWorkspace().defectReports.map(defectReportForClient),
      summary: {
        activeFitters: getUsers().filter((user) => user.active !== false && user.role === 'fitter').length,
        assigned: getWorkspace().tasks.filter((task) => ['assigned', 'in_progress'].includes(task.status)).length,
        submitted: getWorkspace().tasks.filter((task) => task.status === 'submitted').length,
        pendingReports: getWorkspace().reports.filter((report) => report.status === 'pending_review').length,
        pendingDefects: getWorkspace().defectReports.filter((report) => report.status === 'pending_review').length,
      },
    });
  });

  return router;
}
