export type ServiceState = 'checking' | 'ok' | 'error' | 'not-configured' | 'unknown';

export type HealthResponse = {
  status?: string;
  ok?: boolean;
  backend?: string;
  version?: string;
  release?: string;
  database?: { status?: string; configured?: boolean; message?: string };
  localRecognition?: { mode?: string; cloudDisabled?: boolean };
  drawingTemplateConfigured?: boolean;
  mode?: string;
  qwenModel?: string;
  ollama?: { reachable?: boolean; error?: string | null; model?: string };
};

export type ReportRun = {
  id: number;
  created_at: string | null;
  report_number: string;
  report_date: string;
  output_format: string;
  page_count: number;
  output_filename: string;
};

export type Role = 'fitter' | 'receiver' | 'supervisor' | 'developer';

export type SessionUser = {
  id: string;
  username: string;
  displayName: string;
  firstName: string;
  lastName: string;
  role: Role;
  roleName: string;
  active: boolean;
};

export type SchemeStatus = 'pending' | 'queued' | 'processing' | 'completed' | 'failed';

export type SchemeSummary = {
  jobId: string;
  title: string;
  createdAt: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  uploadedBy: string;
  sourceName: string;
  status: SchemeStatus;
  originalName: string;
  error: string;
};

export type Building = {
  id: string;
  name: string;
  createdAt: string | null;
  schemes: SchemeSummary[];
};

export type Street = {
  id: string;
  name: string;
  createdAt: string | null;
  buildings: Building[];
};

export type AddressLibrary = {
  schemaVersion: number;
  streets: Street[];
};

export type GraphNode = {
  id: string;
  x: number;
  y: number;
  degree?: number;
};

export type GraphEdge = {
  id: string;
  from: string;
  to: string;
  geometry?: number[][];
  visible?: boolean;
  detector?: string;
  confidence?: number;
  component_role?: string;
  component_id?: string;
  source?: string;
  cad_include?: boolean;
  user_include?: boolean;
  cad_reason?: string;
};

export type GraphAnnotation = {
  id: string;
  text?: string;
  source?: string;
  confidence?: number;
  include?: boolean;
  verified?: boolean;
};

export type ReviewTask = {
  id: string;
  kind?: string;
  message?: string;
  status?: string;
  targetIds?: string[];
};

export type ValidationFinding = {
  id: string;
  code?: string;
  message?: string;
  severity?: string;
  status?: string;
  targetIds?: string[];
};

export type DocumentModel = {
  symbols?: Array<Record<string, unknown>>;
  dimensions?: Array<Record<string, unknown>>;
  pipes?: Array<Record<string, unknown>>;
  labels?: Array<Record<string, unknown>>;
  reviewTasks?: ReviewTask[];
  validationFindings?: ValidationFinding[];
  status?: string;
};

export type JoinCandidate = {
  id: string;
  from: string;
  to: string;
  distance?: number;
  alignment?: number;
  lateral_offset_px?: number;
  score?: number;
  priority?: string;
  has_alternatives?: boolean;
  conflicting_nodes?: string[];
  review_flags?: string[];
  message?: string;
};

export type JobGraph = {
  jobId?: string;
  complete?: boolean;
  analysisStatus?: string;
  image?: { width: number; height: number };
  sourceUrl?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  crossings: Array<{ x: number; y: number }>;
  annotations: GraphAnnotation[];
  joinCandidates: JoinCandidate[];
  confirmedConnections: Array<Record<string, unknown>>;
  symbolCatalog: Array<{ type: string; label: string }>;
  documentModel: DocumentModel | null;
  summary?: Record<string, number>;
  warnings: string[];
  statusline?: string;
  semanticRoutes?: Array<Record<string, unknown>>;
  centerlineTrace?: { available?: boolean; paths?: number };
  referenceTrace?: { available?: boolean; contours?: number };
  centerlineTraceSvgUrl?: string;
  referenceTraceSvgUrl?: string;
  cadDraftSvgUrl?: string;
  cadDraftDxfUrl?: string;
  progressUrl?: string;
  diagnosticsUrl?: string;
};

export type ManualCadProjectSummary = {
  id: string;
  title: string;
  updatedAt: string;
  createdAt: string;
  source: string | null;
  sourceJobId: string | null;
  siteAddress: string;
  pipeCount: number;
};

export type ManualCadPipe = {
  id: string;
  name?: string;
  diameter?: string;
  kind?: 'pipe' | 'branch' | 'riser';
  points: number[][];
  visible?: boolean;
  reviewOnly?: boolean;
  reviewReason?: string;
  source?: string;
  traceMetrics?: Array<Record<string, number>>;
};

export type ManualCadSymbol = {
  id: string;
  type: 'valve' | 'meter' | 'regulator' | 'consumer' | 'riser' | 'filter' | 'callout' | 'unknown';
  x: number;
  y: number;
  rotation?: number;
  label?: string;
  scale?: number;
  reviewOnly?: boolean;
  reviewReason?: string;
};

export type ManualCadLabel = {
  id: string;
  text: string;
  x: number;
  y: number;
  size?: number;
  rotation?: number;
  anchor?: 'start' | 'middle';
  reviewOnly?: boolean;
};

export type ManualCadDimension = {
  id: string;
  a: number[];
  b: number[];
  text: string;
};

export type ManualCadJunction = {
  id: string;
  x: number;
  y: number;
  pipeIds: string[];
};

export type ManualCadProject = {
  schema: string;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: unknown;
  sourceJobId: string | null;
  sourceStreetId: string | null;
  sourceBuildingId: string | null;
  sourceReportId?: string | null;
  analysisComplete: boolean;
  manualEditRevision: number;
  width: number;
  height: number;
  page: 'portrait' | 'landscape';
  paperSize: 'A4' | 'A3';
  drawingStyle: 'standard' | 'lpgcad-r1';
  preparedBy: string;
  siteAddress: string;
  entrance: string;
  inspectionTitle: string;
  schemeSubtitle: string;
  schemeAuthor: string;
  schemeChecker: string;
  riserGroups: Array<{ id: string; name: string; apartments: string[] }>;
  notes: string;
  pipes: ManualCadPipe[];
  junctions: ManualCadJunction[];
  symbols: ManualCadSymbol[];
  labels: ManualCadLabel[];
  dimensions: ManualCadDimension[];
  sourceUrl?: string | null;
  previewUrl?: string;
};

export type TaskStatus =
  | 'assigned'
  | 'in_progress'
  | 'house_visited'
  | 'at_office'
  | 'submitted'
  | 'processing'
  | 'pending_review'
  | 'accepted'
  | 'revision_requested'
  | 'processing_failed';

export type TaskEvent = {
  type: string;
  label: string;
  at: string;
  userId?: string;
  userName?: string;
};

export type WorkforceFile = {
  id: string;
  originalName: string;
  size: number;
  url: string;
  kind?: string;
  mimeType?: string;
};

export type WorkforceTask = {
  id: string;
  title: string;
  street: string;
  address: string;
  instructions?: string;
  scheduledDate: string;
  assignedTo: string;
  assignedName: string;
  status: TaskStatus;
  events: TaskEvent[];
  reportsCount: number;
  defectReportsCount: number;
  defectReports: WorkforceDefectReport[];
  lastReviewComment?: string;
  lastReportStatus?: string | null;
  officeAt?: string | null;
};

export type WorkforceReport = {
  id: string;
  taskId: string;
  taskTitle: string;
  street: string;
  address: string;
  scheduledDate: string | null;
  assignedName: string | null;
  userId: string;
  userName: string;
  note: string;
  status: string;
  reviewComment: string;
  submittedAt: string;
  reviewedAt: string | null;
  schemeJobId: string | null;
  manualCadProjectId: string | null;
  schemeStatus: string;
  schemeError: string;
  schemePartialGraphReady: boolean;
  seen: boolean;
  conclusionAddedAt: string | null;
  photos: WorkforceFile[];
  sketch: WorkforceFile | null;
};

export type WorkforceDefectReport = {
  id: string;
  taskId: string;
  taskTitle: string;
  street: string;
  address: string;
  scheduledDate: string | null;
  assignedName: string | null;
  userId: string;
  userName: string;
  note: string;
  status: string;
  reviewComment: string;
  submittedAt: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  conclusionAddedAt: string | null;
  seen: boolean;
  photos: WorkforceFile[];
};

export type WorkforceUser = SessionUser & {
  assignedTasks?: number;
  activeTask?: WorkforceTask | null;
};

export type WorkforceOverview = {
  users: WorkforceUser[];
  tasks: WorkforceTask[];
  reports: WorkforceReport[];
  defectReports: WorkforceDefectReport[];
  summary: {
    activeFitters: number;
    assigned: number;
    submitted: number;
    pendingReports: number;
    pendingDefects: number;
  };
};

export type ConclusionContext = {
  task: WorkforceTask & { street: string; address: string };
  reports: WorkforceReport[];
  defectReports: WorkforceDefectReport[];
};

export type ReportSection = [string, string];