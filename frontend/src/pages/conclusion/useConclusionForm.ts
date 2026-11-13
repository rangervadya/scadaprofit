import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFECTS,
  MAX_PHOTO_UPLOAD_BYTES,
  MATERIAL_PAGES,
  RESOURCE_LABELS,
  RESOURCE_ROWS,
  UZT_FLAT_ROWS,
  UZT_SHARED_ROWS,
  VALVE_FIELDS,
} from './schema';

export type DefectRow = { enabled: boolean; location: string; text: string; recommendation: string };
export type ValveRow = { enabled: boolean; fields: Record<string, string> };
export type MaterialEntry = { file: File | null; exclude: boolean };

const STORAGE_KEY = 'profit.conclusion.draft.v1';

export function emptyDefects(): DefectRow[] {
  return DEFECTS.map(() => ({ enabled: false, location: '', text: '', recommendation: '' }));
}

export function emptyValves(): ValveRow[] {
  return [1, 2, 3].map(() => ({ enabled: false, fields: Object.fromEntries(VALVE_FIELDS.map(field => [field.key, ''])) }));
}

export function useConclusionForm(initialTask?: string | null) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [defects, setDefects] = useState<DefectRow[]>(emptyDefects);
  const [valves, setValves] = useState<ValveRow[]>(emptyValves);
  const [uztShared, setUztSharedRows] = useState(() => Array.from({ length: UZT_SHARED_ROWS }, () => ({ segment: '', diameter: '', thickness: '' })));
  const [uztFlat, setUztFlatRows] = useState(() => Array.from({ length: UZT_FLAT_ROWS }, () => ({ apartment: '', du25: '', du20: '', du15: '' })));
  const [resource, setResourceRows] = useState(() => Array.from({ length: RESOURCE_ROWS }, () => Object.fromEntries(RESOURCE_LABELS.map(item => [item.key, ''])) as Record<string, string>));
  const [photos, setPhotos] = useState<File[]>([]);
  const [materials, setMaterials] = useState<Record<number, MaterialEntry>>(() =>
    Object.fromEntries(MATERIAL_PAGES.map(item => [item.page, { file: null, exclude: false }])),
  );
  const [confirmations, setConfirmations] = useState<Record<string, boolean>>({});
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Record<string, unknown>;
      if (saved.values && typeof saved.values === 'object') setValues(saved.values as Record<string, string>);
      if (Array.isArray(saved.defects)) setDefects(saved.defects as DefectRow[]);
      if (Array.isArray(saved.valves)) setValves(saved.valves as ValveRow[]);
      if (Array.isArray(saved.uztShared)) setUztSharedRows(saved.uztShared as typeof uztShared);
      if (Array.isArray(saved.uztFlat)) setUztFlatRows(saved.uztFlat as typeof uztFlat);
      if (Array.isArray(saved.resource)) setResourceRows(saved.resource as typeof resource);
      if (saved.confirmations && typeof saved.confirmations === 'object') setConfirmations(saved.confirmations as Record<string, boolean>);
      const savedMaterials = saved.materials as Record<string, { exclude?: boolean }> | undefined;
      if (savedMaterials) {
        setMaterials(current => {
          const next = { ...current };
          for (const item of MATERIAL_PAGES) {
            if (savedMaterials[String(item.page)]?.exclude) next[item.page] = { file: null, exclude: true };
          }
          return next;
        });
      }
      setRestored(true);
    } catch {
      /* ignore corrupted draft */
    }
  }, []);

  useEffect(() => {
    if (!restored && Object.keys(values).length === 0) return;
    const payload = { values, defects, valves, uztShared, uztFlat, resource, confirmations, materials: Object.fromEntries(Object.entries(materials).map(([key, value]) => [key, { exclude: value.exclude }])) };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      /* quota exceeded — drafts are optional */
    }
  }, [values, defects, valves, uztShared, uztFlat, resource, confirmations, materials, restored]);

  const setField = useCallback((name: string, value: string) => {
    setValues(current => ({ ...current, [name]: value }));
  }, []);

  const setFields = useCallback((next: Record<string, string>) => {
    setValues(current => ({ ...current, ...next }));
  }, []);

  const setDefect = useCallback((index: number, patch: Partial<DefectRow>) => {
    setDefects(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const setValve = useCallback((index: number, patch: Partial<ValveRow>) => {
    setValves(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const setUztShared = useCallback((index: number, patch: Partial<(typeof uztShared)[number]>) => {
    setUztSharedRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const setUztFlat = useCallback((index: number, patch: Partial<(typeof uztFlat)[number]>) => {
    setUztFlatRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const setResource = useCallback((index: number, patch: Record<string, string>) => {
    setResourceRows(current => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const addPhoto = useCallback((file: File) => {
    if (file.size > MAX_PHOTO_UPLOAD_BYTES) throw new Error(`Файл «${file.name}» больше 15 МБ.`);
    setPhotos(current => [...current, file]);
  }, []);

  const removePhoto = useCallback((index: number) => {
    setPhotos(current => current.filter((_, i) => i !== index));
  }, []);

  const setMaterial = useCallback((page: number, entry: MaterialEntry) => {
    setMaterials(current => ({ ...current, [page]: entry }));
  }, []);

  const setConfirmation = useCallback((name: string, value: boolean) => {
    setConfirmations(current => ({ ...current, [name]: value }));
  }, []);

  const flatten = useMemo(() => {
    const fields: Record<string, string> = { ...values };
    defects.forEach((row, index) => {
      const i = index + 1;
      fields[`defect_${i}_enabled`] = row.enabled ? '1' : '';
      fields[`defect_${i}_location`] = row.location;
      fields[`defect_${i}_text`] = row.text;
      fields[`defect_${i}_recommendation`] = row.recommendation;
    });
    valves.forEach((row, index) => {
      const i = index + 1;
      fields[`valve_${i}_enabled`] = row.enabled ? '1' : '';
      for (const field of VALVE_FIELDS) fields[`valve_${i}_${field.key}`] = row.fields[field.key] || '';
    });
    uztShared.forEach((row, index) => {
      const i = index + 1;
      fields[`uzt_shared_${i}_segment`] = row.segment;
      fields[`uzt_shared_${i}_diameter`] = row.diameter;
      fields[`uzt_shared_${i}_thickness`] = row.thickness;
    });
    uztFlat.forEach((row, index) => {
      const i = index + 1;
      fields[`uzt_flat_${i}_apartment`] = row.apartment;
      fields[`uzt_flat_${i}_du25`] = row.du25;
      fields[`uzt_flat_${i}_du20`] = row.du20;
      fields[`uzt_flat_${i}_du15`] = row.du15;
    });
    resource.forEach((row, index) => {
      const i = index + 1;
      for (const item of RESOURCE_LABELS) fields[`resource_${item.key}_${i}`] = row[item.key] || '';
    });
    for (const [key, checked] of Object.entries(confirmations)) fields[key] = checked ? '1' : '';
    for (const item of MATERIAL_PAGES) {
      fields[`exclude_material_page_${item.page}`] = materials[item.page]?.exclude ? '1' : '';
    }
    return fields;
  }, [values, defects, valves, uztShared, uztFlat, resource, confirmations, materials]);

  const buildFormData = useCallback(
    (workforceSchemes: Array<Record<string, string>> | null, defectPhotos: File[]) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(flatten)) form.append(key, value);
      photos.forEach((file, index) => form.append(`photo_${index + 1}`, file, file.name));
      for (const item of MATERIAL_PAGES) {
        const file = materials[item.page]?.file;
        if (file) form.append(`material_page_${item.page}`, file, file.name);
      }
      if (workforceSchemes?.length) form.append('workforce_schemes_json', JSON.stringify(workforceSchemes));
      defectPhotos.forEach((file, index) => form.append(`photo_${photos.length + index + 1}`, file, file.name));
      if (initialTask) form.append('task_id', initialTask);
      return form;
    },
    [flatten, photos, materials, initialTask],
  );

  const exportDraft = useCallback(() => {
    const payload = { version: 1, savedAt: new Date().toISOString(), values, defects, valves, uztShared, uztFlat, resource, confirmations };
    return JSON.stringify(payload, null, 2);
  }, [values, defects, valves, uztShared, uztFlat, resource, confirmations]);

  const importDraft = useCallback((json: string) => {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') throw new Error('Файл не похож на сохранённый черновик.');
    if (parsed.values && typeof parsed.values === 'object') setValues(parsed.values as Record<string, string>);
    if (Array.isArray(parsed.defects)) setDefects(parsed.defects as DefectRow[]);
    if (Array.isArray(parsed.valves)) setValves(parsed.valves as ValveRow[]);
    if (Array.isArray(parsed.uztShared)) setUztSharedRows(parsed.uztShared as typeof uztShared);
    if (Array.isArray(parsed.uztFlat)) setUztFlatRows(parsed.uztFlat as typeof uztFlat);
    if (Array.isArray(parsed.resource)) setResourceRows(parsed.resource as typeof resource);
    if (parsed.confirmations && typeof parsed.confirmations === 'object') setConfirmations(parsed.confirmations as Record<string, boolean>);
  }, []);

  const reset = useCallback(() => {
    setValues({});
    setDefects(emptyDefects());
    setValves(emptyValves());
    setUztSharedRows(Array.from({ length: UZT_SHARED_ROWS }, () => ({ segment: '', diameter: '', thickness: '' })));
    setUztFlatRows(Array.from({ length: UZT_FLAT_ROWS }, () => ({ apartment: '', du25: '', du20: '', du15: '' })));
    setResourceRows(Array.from({ length: RESOURCE_ROWS }, () => Object.fromEntries(RESOURCE_LABELS.map(item => [item.key, ''])) as Record<string, string>));
    setPhotos([]);
    setMaterials(Object.fromEntries(MATERIAL_PAGES.map(item => [item.page, { file: null, exclude: false }])));
    setConfirmations({});
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const photoCount = photos.length;
  const materialCount = MATERIAL_PAGES.filter(item => materials[item.page]?.file).length;

  return {
    values,
    setField,
    setFields,
    defects,
    setDefect,
    valves,
    setValve,
    uztShared,
    setUztShared,
    uztFlat,
    setUztFlat,
    resource,
    setResource,
    photos,
    addPhoto,
    removePhoto,
    materials,
    setMaterial,
    confirmations,
    setConfirmation,
    flatten,
    buildFormData,
    exportDraft,
    importDraft,
    reset,
    photoCount,
    materialCount,
  };
}

export type ConclusionForm = ReturnType<typeof useConclusionForm>;