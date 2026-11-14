export type WorkforceDefectInput = {
  id: string;
  status: string;
  street?: string;
  address?: string;
  note?: string;
};
export type WorkforceDefectFormRow = {
  enabled: boolean;
  location: string;
  text: string;
  recommendation: string;
  workforceReportId?: string;
  workforceTaskId?: string;
};
export function mergeAcceptedWorkforceDefects(
  currentRows: WorkforceDefectFormRow[],
  reports: WorkforceDefectInput[],
  taskId: string,
  maxRows?: number,
): { rows: WorkforceDefectFormRow[]; overflow: number; imported: number };
