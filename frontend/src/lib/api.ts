import type {
  AddressLibrary,
  ConclusionContext,
  HealthResponse,
  JobGraph,
  ManualCadProject,
  ManualCadProjectSummary,
  ReportRun,
  SessionUser,
  WorkforceDefectReport,
  WorkforceOverview,
  WorkforceReport,
  WorkforceTask,
} from './types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type RequestOptions = Omit<RequestInit, 'body'> & { body?: BodyInit | unknown };

function isFormData(body: unknown): body is FormData {
  return typeof FormData !== 'undefined' && body instanceof FormData;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, ...rest } = options;
  const init: RequestInit = { credentials: 'same-origin', cache: 'no-store', ...rest };
  if (body !== undefined && body !== null) {
    init.body = isFormData(body) ? body : JSON.stringify(body);
  }
  const finalHeaders = new Headers(headers);
  if (init.body && !isFormData(body)) finalHeaders.set('Content-Type', 'application/json');
  finalHeaders.set('Accept', 'application/json');
  init.headers = finalHeaders;

  const response = await fetch(path, init);
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.text().catch(() => '');
  if (!response.ok) {
    const message = typeof payload === 'object' && payload && 'error' in payload
      ? String((payload as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export const api = {
  request,
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

const MAIN = '/api';
const VDGO = '/vdgo/api';

export const authApi = {
  status: () => api.get<{ ok: boolean; setupRequired: boolean }>(`${MAIN}/auth/status`),
  me: () => api.get<{ ok: boolean; user: SessionUser }>(`${MAIN}/auth/me`),
  login: (username: string, password: string) =>
    api.post<{ ok: boolean; user: SessionUser }>(`${MAIN}/auth/login`, { username, password }),
  setup: (username: string, displayName: string, password: string) =>
    api.post<{ ok: boolean; user: SessionUser }>(`${MAIN}/auth/setup`, { username, displayName, password }),
  logout: () => api.post<{ ok: boolean }>(`${MAIN}/auth/logout`),
};

export const healthApi = {
  main: () => api.get<HealthResponse>(`${MAIN}/health`),
  vdgo: () => api.get<HealthResponse>(`${VDGO}/health`),
  reports: () => api.get<{ items?: ReportRun[] }>(`${VDGO}/reports`),
};

export const libraryApi = {
  list: () => api.get<{ ok: boolean; library: AddressLibrary }>(`${MAIN}/library`),
  createStreet: (name: string) => api.post<{ ok: boolean }>(`${MAIN}/library/streets`, { name }),
  createBuilding: (streetId: string, name: string) =>
    api.post<{ ok: boolean }>(`${MAIN}/library/buildings`, { streetId, name }),
  uploadScheme: (input: { file: File; streetId: string; buildingId: string; title?: string; rotationDegrees?: string }) => {
    const form = new FormData();
    form.append('image', input.file, input.file.name);
    form.append('streetId', input.streetId);
    form.append('buildingId', input.buildingId);
    form.append('title', input.title || input.file.name.replace(/\.[^.]+$/, ''));
    if (input.rotationDegrees && input.rotationDegrees !== 'auto') form.append('rotationDegrees', input.rotationDegrees);
    return api.post<{ ok: boolean; scheme: { jobId: string } }>(`${MAIN}/library/schemes/upload`, form);
  },
  schemeStatus: (jobId: string) =>
    api.get<{ ok: boolean; status: string; progress?: string; error?: string; graphReady?: boolean; queuePosition?: number | null }>(
      `${MAIN}/library/schemes/${encodeURIComponent(jobId)}/status`,
    ),
  analyze: (jobId: string) =>
    api.post<{ ok: boolean; status: string }>(`${MAIN}/library/schemes/${encodeURIComponent(jobId)}/analyze`),
  graph: (jobId: string) => api.get<JobGraph>(`${MAIN}/jobs/${encodeURIComponent(jobId)}/graph`),
  connect: (jobId: string, payload: { from: string; to: string; candidateId?: string | null; confirmAlternative?: boolean }) =>
    api.post<{ ok: boolean; graph: JobGraph }>(`${MAIN}/jobs/${encodeURIComponent(jobId)}/connections`, payload),
  review: (
    jobId: string,
    payload: { action: string; targetId: string; symbolType?: string; rotation?: number; pipeId?: string; value?: string; text?: string },
  ) => api.post<{ ok: boolean; graph: JobGraph }>(`${MAIN}/jobs/${encodeURIComponent(jobId)}/review`, payload),
};

export const cadApi = {
  list: () => api.get<{ ok: boolean; projects: ManualCadProjectSummary[] }>(`${MAIN}/manual-cad/projects`),
  create: (title: string) => api.post<{ ok: boolean; project: ManualCadProject }>(`${MAIN}/manual-cad/projects`, { title }),
  get: (id: string) => api.get<{ ok: boolean; project: ManualCadProject }>(`${MAIN}/manual-cad/projects/${encodeURIComponent(id)}`),
  save: (id: string, project: ManualCadProject) =>
    api.put<{ ok: boolean; project: ManualCadProject }>(`${MAIN}/manual-cad/projects/${encodeURIComponent(id)}`, { project }),
  importJob: (jobId: string, title: string) =>
    api.post<{ ok: boolean; project: ManualCadProject }>(`${MAIN}/manual-cad/import-job/${encodeURIComponent(jobId)}`, { title }),
};

export const templateApi = {
  get: () => api.get<{ ok: boolean; template: { originalName: string; size: number; uploadedAt: string } | null }>(`${MAIN}/template`),
  upload: (file: File) => {
    const form = new FormData();
    form.append('template', file, file.name);
    return api.post<{ ok: boolean }>(`${MAIN}/template`, form);
  },
  remove: () => api.del<{ ok: boolean }>(`${MAIN}/template`),
};

export const workforceApi = {
  overview: () => api.get<{ ok: boolean } & WorkforceOverview>(`${MAIN}/workforce/overview`),
  tasks: () => api.get<{ ok: boolean; tasks: WorkforceTask[] }>(`${MAIN}/workforce/tasks`),
  createTask: (payload: {
    assignedTo: string;
    title: string;
    street: string;
    addresses: string;
    scheduledDate: string;
    instructions?: string;
  }) => api.post<{ ok: boolean; createdCount: number }>(`${MAIN}/workforce/tasks`, payload),
  startTask: (id: string) => api.post<{ ok: boolean }>(`${MAIN}/workforce/tasks/${encodeURIComponent(id)}/start`),
  visitTask: (id: string) => api.post<{ ok: boolean }>(`${MAIN}/workforce/tasks/${encodeURIComponent(id)}/visit`),
  officeTask: (id: string) => api.post<{ ok: boolean }>(`${MAIN}/workforce/tasks/${encodeURIComponent(id)}/office`),
  submitSketch: (id: string, file: File, note: string) => {
    const form = new FormData();
    form.append('sketch', file, file.name);
    form.append('note', note);
    return api.post<{ ok: boolean }>(`${MAIN}/workforce/tasks/${encodeURIComponent(id)}/report`, form);
  },
  submitDefects: (id: string, files: File[], note: string) => {
    const form = new FormData();
    for (const file of files) form.append('defectPhotos', file, file.name);
    form.append('note', note);
    return api.post<{ ok: boolean }>(`${MAIN}/workforce/tasks/${encodeURIComponent(id)}/defects`, form);
  },
  reports: () => api.get<{ ok: boolean; reports: WorkforceReport[]; unreadCount: number }>(`${MAIN}/workforce/reports`),
  defects: () => api.get<{ ok: boolean; reports: WorkforceDefectReport[]; unreadCount: number }>(`${MAIN}/workforce/defects`),
  seeReport: (id: string) => api.post<{ ok: boolean }>(`${MAIN}/workforce/reports/${encodeURIComponent(id)}/seen`),
  seeDefect: (id: string) => api.post<{ ok: boolean }>(`${MAIN}/workforce/defects/${encodeURIComponent(id)}/seen`),
  reviewReport: (id: string, status: 'accepted' | 'revision_requested', comment: string) =>
    api.post<{ ok: boolean }>(`${MAIN}/workforce/reports/${encodeURIComponent(id)}/review`, { status, comment }),
  reviewDefect: (id: string, status: 'accepted' | 'revision_requested', comment: string) =>
    api.post<{ ok: boolean }>(`${MAIN}/workforce/defects/${encodeURIComponent(id)}/review`, { status, comment }),
  conclusionContext: (query: { task?: string; report?: string; defectReport?: string }) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
    return api.get<{ ok: boolean } & ConclusionContext>(`${MAIN}/workforce/conclusion?${search.toString()}`);
  },
  addToConclusion: (taskId: string) =>
    api.post<{ ok: boolean; conclusionUrl: string }>(`${MAIN}/workforce/tasks/${encodeURIComponent(taskId)}/conclusion`),
  users: () => api.get<{ ok: boolean; users: WorkforceOverview['users'] }>(`${MAIN}/workforce/users`),
  createUser: (payload: { displayName: string; role: string; autoGenerate?: boolean; username?: string; password?: string }) =>
    api.post<{ ok: boolean; user: { id: string; displayName: string; roleName: string }; credentials: { username: string; password: string } }>(
      `${MAIN}/workforce/users`,
      payload,
    ),
  resetPassword: (id: string) =>
    api.post<{ ok: boolean; credentials: { username: string; password: string } }>(
      `${MAIN}/workforce/users/${encodeURIComponent(id)}/reset-password`,
    ),
  updateUser: (id: string, payload: { displayName?: string; role?: string; active?: boolean; password?: string }) =>
    api.patch<{ ok: boolean }>(`${MAIN}/workforce/users/${encodeURIComponent(id)}`, payload),
};

export const conclusionApi = {
  generate: (form: FormData, format: 'pdf' | 'docx') =>
    submitForm(`/vdgo/generate${format === 'docx' ? '_docx' : ''}`, form),
  preview: (form: FormData) => submitForm('/vdgo/preview', form),
};

async function submitForm(path: string, form: FormData): Promise<void> {
  const response = await fetch(path, { method: 'POST', body: form, credentials: 'same-origin' });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(text) as { error?: string } | string;
      if (typeof parsed === 'string') message = parsed.slice(0, 300);
      else if (parsed.error) message = parsed.error;
    } catch {
      if (text) message = text.slice(0, 300);
    }
    throw new ApiError(message, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = decodeDisposition(disposition) || (path.includes('docx') ? 'Заключение.docx' : 'Заключение.pdf');
  downloadBlob(blob, filename);
}

function decodeDisposition(value: string): string {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded) return decodeURIComponent(encoded[1]);
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain ? plain[1] : '';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export async function svgToPngBase64(svgUrl: string): Promise<string> {
  const response = await fetch(svgUrl, { cache: 'no-store', credentials: 'same-origin' });
  if (!response.ok) throw new ApiError(`Не удалось получить CAD-схему (HTTP ${response.status})`, response.status);
  const svgText = await response.text();
  if (!/<svg[\s>]/i.test(svgText)) throw new ApiError('CAD-файл не является SVG', response.status);
  const objectUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = objectUrl;
    await (typeof image.decode === 'function' ? image.decode() : new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new ApiError('Не удалось отрисовать CAD-схему', 500));
    }));
    const sourceWidth = image.naturalWidth || 1600;
    const sourceHeight = image.naturalHeight || 1200;
    const scale = Math.min(1.5, 2600 / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(150, Math.round(sourceWidth * scale));
    canvas.height = Math.max(150, Math.round(sourceHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new ApiError('Браузер не смог подготовить изображение CAD-схемы', 500);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(value => (value ? resolve(value) : reject(new ApiError('Не удалось преобразовать CAD-схему в PNG', 500))), 'image/png'),
    );
    return await blobToBase64(blob);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(binary);
}

async function convertDefectPhoto(blob: Blob, name: string, mimeType: string): Promise<File> {
  const supported = ['image/jpeg', 'image/png', 'image/webp'];
  if (supported.includes(mimeType) && blob.size <= 15 * 1024 * 1024) {
    return new File([blob], name, { type: mimeType });
  }
  const bitmap = await createImageBitmap(blob).catch(() => {
    throw new ApiError(`Не удалось открыть ${name}. Сохрани фото как JPG или PNG.`, 400);
  });
  try {
    if (bitmap.width < 150 || bitmap.height < 150) {
      throw new ApiError(`Фотография ${name} меньше 150×150 пикселей.`, 400);
    }
    const scale = Math.min(1, 2600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(150, Math.round(bitmap.width * scale));
    canvas.height = Math.max(150, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new ApiError('Не удалось подготовить фотографию', 500);
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(value => (value ? resolve(value) : reject(new ApiError('Не удалось сохранить JPEG', 500))), 'image/jpeg', 0.88),
    );
    return new File([jpeg], `${name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
  } finally {
    bitmap.close?.();
  }
}

export async function buildWorkforceSchemes(reports: WorkforceReport[]) {
  const payload: Array<Record<string, string>> = [];
  for (const report of reports) {
    const svgUrl = `/api/manual-cad/projects/${report.manualCadProjectId}/preview.svg`;
    const pngBase64 = await svgToPngBase64(svgUrl);
    payload.push({
      id: report.id,
      street: report.street,
      address: report.address,
      userName: report.userName,
      submittedAt: report.submittedAt,
      status: report.status,
      pngBase64,
    });
  }
  return payload;
}

export async function buildDefectPhotos(reports: WorkforceDefectReport[]) {
  const files: Array<{ file: File; report: WorkforceDefectReport }> = [];
  for (const report of reports) {
    for (const photo of report.photos) {
      const response = await fetch(photo.url, { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) throw new ApiError(`Не удалось загрузить фото «${photo.originalName}»`, response.status);
      const blob = await response.blob();
      const file = await convertDefectPhoto(blob, photo.originalName, photo.mimeType || blob.type);
      files.push({ file, report });
    }
  }
  return files;
}