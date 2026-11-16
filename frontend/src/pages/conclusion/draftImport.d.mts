export type ImportedDefectRow = {
  enabled: boolean;
  location: string;
  text: string;
  recommendation: string;
  workforceReportId?: string;
  workforceTaskId?: string;
};
export type ImportedValveRow = { enabled: boolean; fields: Record<string, string> };
export type ImportedDraft = {
  values: Record<string, string>;
  defects: ImportedDefectRow[];
  valves: ImportedValveRow[];
  uztShared: Array<{ segment: string; diameter: string; thickness: string }>;
  uztFlat: Array<{ apartment: string; du25: string; du20: string; du15: string }>;
  resource: Array<Record<string, string>>;
  confirmations: Record<string, boolean>;
  materials: Record<number, { file: File | null; exclude: boolean }>;
  importedCount: number;
  format: string;
};
export function normalizeConclusionDraft(input: unknown): ImportedDraft;

export function parseConclusionDraftJson(text: string): unknown;
