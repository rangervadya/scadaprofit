import { useMemo, useRef, useState } from 'react';
import { Icon } from '../../components/ui/Icon';
import { Badge, Button, Field } from '../../components/ui';
import type { ConclusionForm } from './useConclusionForm';
import {
  DEFECTS,
  MATERIAL_PAGES,
  MAX_MATERIAL_UPLOAD_BYTES,
  MAX_PHOTO_UPLOAD_BYTES,
  RESOURCE_LABELS,
  RESOURCE_ROWS,
  SECTIONS,
  UZT_FLAT_ROWS,
  UZT_SHARED_ROWS,
  VALVE_FIELDS,
} from './schema';
import type { FieldDef, SectionDef } from './schema';

function maskDate(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  const parts = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean);
  return parts.join('.');
}

function DateInput({ value, onChange, required }: { value: string; onChange: (next: string) => void; required?: boolean }) {
  const pickerRef = useRef<HTMLInputElement>(null);
  return (
    <span style={{ display: 'flex', gap: 6 }}>
      <input
        className="input"
        value={value}
        onChange={event => onChange(maskDate(event.target.value))}
        inputMode="numeric"
        placeholder="ДД.ММ.ГГГГ"
        required={required}
        pattern="[0-9]{2}\.[0-9]{2}\.[0-9]{4}"
        title="Введите дату в формате ДД.ММ.ГГГГ"
      />
      <button
        type="button"
        className="btn btn--sm"
        style={{ width: 38, padding: 0 }}
        aria-label="Выбрать дату в календаре"
        onClick={() => {
          const picker = pickerRef.current;
          if (!picker) return;
          if (typeof picker.showPicker === 'function') picker.showPicker();
          else picker.click();
        }}
      >
        <Icon name="clock" />
      </button>
      <input
        ref={pickerRef}
        type="date"
        tabIndex={-1}
        aria-hidden="true"
        style={{ position: 'absolute', width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
        onChange={event => {
          const iso = event.target.value;
          if (!iso) return;
          const [year, month, day] = iso.split('-');
          onChange(`${day}.${month}.${year}`);
        }}
      />
    </span>
  );
}

export function FieldsSection({ section, form }: { section: SectionDef; form: ConclusionForm }) {
  const fields = section.fields || [];
  const gridClass = fields.some(field => field.type === 'textarea') ? 'grid grid--2' : 'field-row';
  return (
    <section className="card form-section" id={section.id}>
      <header className="form-section__head">
        <span className="form-section__num">{section.num}</span>
        <div>
          <h2>{section.title}</h2>
          {section.note ? <p className="form-section__note" style={{ marginTop: 4 }}>{section.note}</p> : null}
        </div>
      </header>
      <div className="form-section__body">
        <div className={gridClass}>
          {fields.map(field => {
            const value = form.values[field.name] || '';
            const common = {
              required: field.required,
              placeholder: field.placeholder,
            };
            const control =
              field.type === 'textarea' ? (
                <textarea
                  className="textarea"
                  value={value}
                  onChange={event => form.setField(field.name, event.target.value)}
                  placeholder={field.placeholder}
                  required={field.required}
                  maxLength={field.name === 'conclusion_text' ? 700 : 900}
                />
              ) : field.type === 'select' ? (
                <select
                  className="select"
                  value={value}
                  onChange={event => form.setField(field.name, event.target.value)}
                  required={field.required}
                >
                  {(field.options || []).map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : field.type === 'date' ? (
                <DateInput
                  value={value}
                  required={field.required}
                  onChange={next => {
                    form.setField(field.name, next);
                    if (field.name === 'report_date') {
                      const year = next.slice(6, 10);
                      if (/^\d{4}$/.test(year)) form.setField('report_year', year);
                    }
                  }}
                />
              ) : (
                <input
                  className="input"
                  type={field.type === 'number' ? 'number' : 'text'}
                  value={value}
                  onChange={event => form.setField(field.name, event.target.value)}
                  {...common}
                />
              );
            const node = (
              <div key={field.name} style={field.full ? { gridColumn: '1 / -1' } : undefined}>
                <Field label={field.label} hint={field.hint} required={field.required}>
                  {control}
                </Field>
              </div>
            );
            return node;
          })}
        </div>
        {section.id === 'calc' ? (
          <div className="grid grid--2">
            <div>
              <Field label="Дата поверки УЗТ — нет данных">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.values.uzt_calibration_date_nd === '1'}
                    onChange={event => form.setField('uzt_calibration_date_nd', event.target.checked ? '1' : '')}
                  />
                  <span>Нет данных о поверке (н.д.)</span>
                </label>
              </Field>
            </div>
            <div>
              <Field label="Дата поверки дефектоскопа — нет данных">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={form.values.uk_calibration_date_nd === '1'}
                    onChange={event => form.setField('uk_calibration_date_nd', event.target.checked ? '1' : '')}
                  />
                  <span>Нет данных / не применялся (н.д.)</span>
                </label>
              </Field>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function DefectsSection({ form }: { form: ConclusionForm }) {
  return (
    <section className="card form-section" id="defects">
      <header className="form-section__head">
        <span className="form-section__num">5</span>
        <div>
          <h2>Дефекты</h2>
          <p className="form-section__note" style={{ marginTop: 4 }}>
            Включайте только фактически выявленные дефекты. Незаполненные строки не попадут в документ.
          </p>
        </div>
      </header>
      <div className="form-section__body">
        {form.defects.map((row, index) => {
          const defect = DEFECTS[index];
          return (
            <div key={defect.id} className="stack stack--sm" style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 10, background: row.enabled ? 'var(--brand-soft)' : '#fff' }}>
              <label className="check" style={{ fontWeight: 600 }}>
                <input type="checkbox" checked={row.enabled} onChange={event => form.setDefect(index, { enabled: event.target.checked })} />
                <span>Дефект {defect.id}</span>
              </label>
              {row.enabled ? (
                <>
                  <Field label="Место расположения" required>
                    <textarea className="textarea" style={{ minHeight: 64 }} value={row.location} onChange={event => form.setDefect(index, { location: event.target.value })} placeholder={defect.location} required />
                  </Field>
                  <Field label="Наименование неисправности" required>
                    <textarea className="textarea" style={{ minHeight: 64 }} value={row.text} onChange={event => form.setDefect(index, { text: event.target.value })} placeholder={defect.defect} required />
                  </Field>
                  <Field label="Рекомендации по устранению" required>
                    <textarea className="textarea" style={{ minHeight: 64 }} value={row.recommendation} onChange={event => form.setDefect(index, { recommendation: event.target.value })} placeholder={defect.recommendation} required />
                  </Field>
                </>
              ) : (
                <p className="field__hint">Типовой дефект: {defect.defect}</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ValvesSection({ form }: { form: ConclusionForm }) {
  const fields = (SECTIONS.find(section => section.id === 'valves')?.fields || []).filter(field => !VALVE_FIELDS.some(item => field.name.startsWith(`valve_${item.key}`)));
  return (
    <section className="card form-section" id="valves">
      <header className="form-section__head">
        <span className="form-section__num">6</span>
        <div>
          <h2>Арматура и результаты проверок</h2>
          <p className="form-section__note" style={{ marginTop: 4 }}>Включайте только фактически проверенную арматуру.</p>
        </div>
      </header>
      <div className="form-section__body">
        {form.valves.map((row, index) => (
          <div key={index} className="stack stack--sm" style={{ padding: 14, border: '1px solid var(--line)', borderRadius: 10, background: row.enabled ? 'var(--brand-soft)' : '#fff' }}>
            <label className="check" style={{ fontWeight: 600 }}>
              <input type="checkbox" checked={row.enabled} onChange={event => form.setValve(index, { enabled: event.target.checked })} />
              <span>Строка {index + 1}</span>
            </label>
            {row.enabled ? (
              <div className="field-row field-row--3">
                {VALVE_FIELDS.map(field => (
                  <Field key={field.key} label={field.label} required>
                    <input
                      className="input input--sm"
                      value={row.fields[field.key] || ''}
                      onChange={event => form.setValve(index, { fields: { ...row.fields, [field.key]: event.target.value } })}
                      placeholder={field.placeholder}
                      required
                    />
                  </Field>
                ))}
              </div>
            ) : null}
          </div>
        ))}
        <div className="field-row">
          {fields.map(field => (
            <div key={field.name} style={field.full ? { gridColumn: '1 / -1' } : undefined}>
              <Field label={field.label} required={field.required}>
                {field.type === 'textarea' ? (
                  <textarea className="textarea" value={form.values[field.name] || ''} onChange={event => form.setField(field.name, event.target.value)} required={field.required} />
                ) : field.type === 'select' ? (
                  <select className="select" value={form.values[field.name] || ''} onChange={event => form.setField(field.name, event.target.value)} required={field.required}>
                    {(field.options || []).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                ) : (
                  <input className="input" value={form.values[field.name] || ''} onChange={event => form.setField(field.name, event.target.value)} required={field.required} />
                )}
              </Field>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function UztSection({ form }: { form: ConclusionForm }) {
  const [tab, setTab] = useState<'shared' | 'flat' | 'resource'>('shared');
  return (
    <section className="card form-section" id="uzt">
      <header className="form-section__head">
        <span className="form-section__num">4</span>
        <div>
          <h2>Таблицы УЗТ и расчёт ресурса</h2>
          <p className="form-section__note" style={{ marginTop: 4 }}>Для отсутствующих данных введите «н.д.».</p>
        </div>
      </header>
      <div className="form-section__body">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'shared'} className="tabs__tab" onClick={() => setTab('shared')}>Общие участки · {UZT_SHARED_ROWS}</button>
          <button type="button" role="tab" aria-selected={tab === 'flat'} className="tabs__tab" onClick={() => setTab('flat')}>Жилые помещения · {UZT_FLAT_ROWS}</button>
          <button type="button" role="tab" aria-selected={tab === 'resource'} className="tabs__tab" onClick={() => setTab('resource')}>Расчёт ресурса · {RESOURCE_ROWS}</button>
        </div>

        {tab === 'shared' ? (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="data-table">
              <thead><tr><th className="row-num">№</th><th>Обозначение участка</th><th>Ду, мм</th><th>Толщина, мм</th></tr></thead>
              <tbody>
                {form.uztShared.map((row, index) => (
                  <tr key={index}>
                    <td className="row-num">{index + 1}</td>
                    <td><input className="input table-input" value={row.segment} onChange={event => form.setUztShared(index, { segment: event.target.value })} placeholder="№ участка" /></td>
                    <td><input className="input table-input" value={row.diameter} onChange={event => form.setUztShared(index, { diameter: event.target.value })} placeholder="н.д." /></td>
                    <td><input className="input table-input" value={row.thickness} onChange={event => form.setUztShared(index, { thickness: event.target.value })} placeholder="н.д." /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'flat' ? (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="data-table">
              <thead><tr><th className="row-num">№</th><th>Квартира</th><th>Ду25</th><th>Ду20</th><th>Ду15</th></tr></thead>
              <tbody>
                {form.uztFlat.map((row, index) => (
                  <tr key={index}>
                    <td className="row-num">{index + 1}</td>
                    <td><input className="input table-input" value={row.apartment} onChange={event => form.setUztFlat(index, { apartment: event.target.value })} placeholder="№ квартиры" /></td>
                    <td><input className="input table-input" value={row.du25} onChange={event => form.setUztFlat(index, { du25: event.target.value })} placeholder="н.д." /></td>
                    <td><input className="input table-input" value={row.du20} onChange={event => form.setUztFlat(index, { du20: event.target.value })} placeholder="н.д." /></td>
                    <td><input className="input table-input" value={row.du15} onChange={event => form.setUztFlat(index, { du15: event.target.value })} placeholder="н.д." /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'resource' ? (
          <div className="grid grid--2">
            {Array.from({ length: RESOURCE_ROWS }, (_, index) => (
              <div key={index} className="stack stack--sm" style={{ padding: 12, border: '1px solid var(--line)', borderRadius: 10 }}>
                <h4>Расчётная позиция {index + 1}</h4>
                <div className="field-row">
                  {RESOURCE_LABELS.map(item => (
                    <Field key={item.key} label={item.label}>
                      <input className="input input--sm" value={form.resource[index]?.[item.key] || ''} onChange={event => form.setResource(index, { [item.key]: event.target.value })} placeholder={item.placeholder} />
                    </Field>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

export function PhotosSection({ form }: { form: ConclusionForm }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const previews = useMemo(() => form.photos.map(file => ({ file, url: URL.createObjectURL(file) })), [form.photos]);

  const accept = (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      try {
        form.addPhoto(file);
      } catch (error) {
        window.alert(error instanceof Error ? error.message : 'Не удалось добавить файл');
      }
    }
  };

  return (
    <section className="card form-section" id="photos">
      <header className="form-section__head">
        <span className="form-section__num">7</span>
        <div>
          <h2>Фотографии объекта</h2>
          <p className="form-section__note" style={{ marginTop: 4 }}>
            Каждый файл до 15 МБ, минимум 150×150 пикселей. После первых 20 снимков добавляются листы.
          </p>
        </div>
      </header>
      <div className="form-section__body">
        <div
          className={`dropzone ${over ? 'dropzone--over' : ''}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={event => { event.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={event => { event.preventDefault(); setOver(false); accept(event.dataTransfer.files); }}
          role="button"
          tabIndex={0}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click(); }}
        >
          <span className="dropzone__icon"><Icon name="upload" /></span>
          <span className="dropzone__title">Перетащите фотографии или нажмите для выбора</span>
          <span className="dropzone__hint">JPG, PNG или WEBP · до {MAX_PHOTO_UPLOAD_BYTES / 1024 / 1024} МБ на файл</span>
          <input ref={inputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={event => { if (event.target.files) accept(event.target.files); event.target.value = ''; }} />
        </div>

        {previews.length ? (
          <div className="photo-grid">
            {previews.map((preview, index) => (
              <div key={`${preview.file.name}-${index}`} className="photo-card">
                <div className="photo-card__preview"><img src={preview.url} alt={preview.file.name} /></div>
                <span className="photo-card__name">{index + 1}. {preview.file.name}</span>
                <Button size="sm" variant="ghost" icon="trash" onClick={() => form.removePhoto(index)}>Удалить</Button>
              </div>
            ))}
          </div>
        ) : null}

        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(form.confirmations.photo_content_confirm)}
            onChange={event => form.setConfirmation('photo_content_confirm', event.target.checked)}
            required
          />
          <span>Подтверждаю, что в фотослоты загружены только фотографии текущего объекта; SCADA/экраны, работники, удостоверения и акты сюда не загружены.</span>
        </label>
      </div>
    </section>
  );
}

export function MaterialsSection({ form }: { form: ConclusionForm }) {
  return (
    <section className="card form-section" id="materials">
      <header className="form-section__head">
        <span className="form-section__num">8</span>
        <div>
          <h2>Актуальные схемы, удостоверения и акты</h2>
          <p className="form-section__note" style={{ marginTop: 4 }}>
            Для каждой страницы загрузите актуальный одностраничный PDF или изображение либо отметьте «Не включать».
            Страницы 16–17 можно оставить пустыми — они необязательны.
          </p>
        </div>
      </header>
      <div className="form-section__body">
        <div className="material-grid">
          {MATERIAL_PAGES.map(item => {
            const entry = form.materials[item.page] || { file: null, exclude: false };
            return (
              <div key={item.page} className={`material-card ${item.optional ? '' : 'material-card--required'}`}>
                <div className="material-card__head">
                  <span className="material-card__title">Страница {item.page} — {item.title}</span>
                  {entry.file ? <Badge tone="success">Файл</Badge> : entry.exclude ? <Badge tone="warn">Исключена</Badge> : item.optional ? <Badge plain>Необязательно</Badge> : <Badge tone="danger">Нужно</Badge>}
                </div>
                <input
                  className="input input--sm"
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
                  disabled={entry.exclude}
                  onChange={event => {
                    const file = event.target.files?.[0] || null;
                    if (file && file.size > MAX_MATERIAL_UPLOAD_BYTES) {
                      window.alert(`Файл «${file.name}» больше ${MAX_MATERIAL_UPLOAD_BYTES / 1024 / 1024} МБ.`);
                      event.target.value = '';
                      return;
                    }
                    form.setMaterial(item.page, { file, exclude: false });
                  }}
                />
                <span className="field__hint">{entry.file ? entry.file.name : 'Файл не выбран'}</span>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={entry.exclude}
                    onChange={event => form.setMaterial(item.page, { file: null, exclude: event.target.checked })}
                  />
                  <span>Не включать эту страницу</span>
                </label>
              </div>
            );
          })}
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={Boolean(form.confirmations.template_review_confirm)}
            onChange={event => form.setConfirmation('template_review_confirm', event.target.checked)}
            required
          />
          <span>Я проверил все страницы итогового документа. Схема Приложения 2 проверена; актуальные вложения загружены или страницы явно исключены; в фотослоты не загружены SCADA/экраны, удостоверения и акты.</span>
        </label>
      </div>
    </section>
  );
}

export function SectionRenderer({ section, form }: { section: SectionDef; form: ConclusionForm }) {
  if (section.kind === 'fields') return <FieldsSection section={section} form={form} />;
  if (section.kind === 'defects') return <DefectsSection form={form} />;
  if (section.kind === 'valves') return <ValvesSection form={form} />;
  if (section.kind === 'uzt') return <UztSection form={form} />;
  if (section.kind === 'photos') return <PhotosSection form={form} />;
  if (section.kind === 'materials') return <MaterialsSection form={form} />;
  return null;
}

export type { FieldDef };