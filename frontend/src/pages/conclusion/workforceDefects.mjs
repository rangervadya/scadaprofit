const hasContent = row => Boolean(row?.enabled || row?.location?.trim() || row?.text?.trim() || row?.recommendation?.trim());

/** Merge accepted fitter defect descriptions into the existing defect table. */
export function mergeAcceptedWorkforceDefects(currentRows, reports, taskId, maxRows = 11) {
  const current = Array.isArray(currentRows) ? currentRows : [];
  const accepted = (Array.isArray(reports) ? reports : []).filter(report => report?.status === 'accepted');
  const rows = Array.from({ length: maxRows }, () => ({ enabled: false, location: '', text: '', recommendation: '' }));
  const used = new Set();
  const acceptedIds = new Set(accepted.map(report => String(report.id)));
  const existingById = new Map(current
    .filter(row => row?.workforceReportId && acceptedIds.has(String(row.workforceReportId)))
    .map(row => [String(row.workforceReportId), row]));

  // Receiver-authored defects stay in their original positions. Worker-derived
  // rows from another address are intentionally not carried into this conclusion.
  current.forEach((row, index) => {
    if (!row?.workforceReportId && index < maxRows) {
      rows[index] = { ...rows[index], ...row };
      if (hasContent(row)) used.add(index);
    }
  });

  let overflow = 0;
  for (const report of accepted) {
    const reportId = String(report.id);
    const existing = existingById.get(reportId);
    let index = existing ? current.findIndex(row => String(row?.workforceReportId || '') === reportId) : -1;
    if (index < 0 || index >= maxRows || used.has(index)) {
      index = rows.findIndex((row, rowIndex) => !used.has(rowIndex) && !hasContent(row));
    }
    if (index < 0) {
      overflow += 1;
      continue;
    }
    rows[index] = {
      enabled: true,
      location: existing?.location || `${String(report.street || '').trim()}, дом ${String(report.address || '').trim()}`.replace(/^, |, дом $/g, '').trim(),
      text: existing?.text || String(report.note || '').trim(),
      recommendation: existing?.recommendation || '',
      workforceReportId: reportId,
      workforceTaskId: String(taskId || ''),
    };
    used.add(index);
  }

  return { rows, overflow, imported: accepted.length - overflow };
}
