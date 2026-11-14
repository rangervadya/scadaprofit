import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeConclusionDraft, parseConclusionDraftJson } from '../../frontend/src/pages/conclusion/draftImport.mjs';

test('legacy vdgo-report-v1 imports populated fields even when an empty values object is present', () => {
  const draft = normalizeConclusionDraft({
    schema: 'vdgo-report-v1',
    fields: {
      report_number: 'VDGO-2026-017',
      report_date: '13.11.2026',
      address: 'г. Москва, ул. Ленина, д. 10',
      customer_legal_name: 'ООО «Тест»',
      defect_1_enabled: '1',
      defect_1_location: 'Подъезд 1, этаж 2',
      defect_1_text: 'Повреждён участок изоляции',
      defect_1_recommendation: 'Восстановить изоляцию',
      uzt_shared_1_segment: 'Участок 1',
      uzt_shared_1_diameter: '32',
      uzt_shared_1_thickness: '3.2',
      exclude_material_page_31: '1',
    },
    values: {},
  });

  assert.equal(draft.format, 'legacy-vdgo');
  assert.equal(draft.values.report_number, 'VDGO-2026-017');
  assert.equal(draft.values.report_date, '13.11.2026');
  assert.equal(draft.values.address, 'г. Москва, ул. Ленина, д. 10');
  assert.equal(draft.defects[0].enabled, true);
  assert.equal(draft.defects[0].text, 'Повреждён участок изоляции');
  assert.equal(draft.uztShared[0].segment, 'Участок 1');
  assert.equal(draft.uztShared[0].thickness, '3.2');
  assert.equal(draft.materials[31].exclude, true);
  assert.ok(draft.importedCount >= 7);
});

test('current draft values override legacy fields only when they contain a value', () => {
  const draft = normalizeConclusionDraft({
    schema: 'vdgo-report-v1',
    fields: { report_number: 'OLD-1', address: 'Старая улица, дом 1', customer: 'ООО «Старое»' },
    values: { report_number: 'NEW-2', address: '', customer: null },
  });

  assert.equal(draft.values.report_number, 'NEW-2');
  assert.equal(draft.values.address, 'Старая улица, дом 1');
  assert.equal(draft.values.customer, 'ООО «Старое»');
});

test('legacy fields nested in data and bracket/dot key formats are normalized', () => {
  const draft = normalizeConclusionDraft({
    data: {
      fields: [
        { name: 'form[report_number]', value: 'NESTED-3' },
        { name: 'fields.address', value: 'г. Казань, ул. Тестовая, д. 3' },
        { name: 'form[work_group_order_number]', value: '42' },
      ],
    },
  });

  assert.equal(draft.values.report_number, 'NESTED-3');
  assert.equal(draft.values.address, 'г. Казань, ул. Тестовая, д. 3');
  assert.equal(draft.values.work_group_order_number, '42');
});

test('legacy boolean values and defect aliases populate the existing defect rows', () => {
  const draft = normalizeConclusionDraft({
    fields: { report_number: 'DEF-4' },
    defects: [{ enabled: 'да', place: 'Подъезд 2', description: 'Коррозия трубы', action: 'Очистить и восстановить покрытие' }],
  });

  assert.equal(draft.defects[0].enabled, true);
  assert.equal(draft.defects[0].location, 'Подъезд 2');
  assert.equal(draft.defects[0].text, 'Коррозия трубы');
  assert.equal(draft.defects[0].recommendation, 'Очистить и восстановить покрытие');
});

test('current Profit JSON values and table arrays continue to import', () => {
  const draft = normalizeConclusionDraft({
    version: 1,
    values: { report_number: 'PROFIT-5', report_date: '2026-11-13', address: 'ул. Новая, д. 5' },
    uztShared: [{ segment: 'А-1', diameter: '25', thickness: '2.8' }],
    defects: [{ enabled: true, location: 'Подъезд 1', text: 'Нарушение', recommendation: 'Устранить' }],
  });

  assert.equal(draft.values.report_number, 'PROFIT-5');
  assert.equal(draft.values.report_date, '13.11.2026');
  assert.equal(draft.uztShared[0].segment, 'А-1');
  assert.equal(draft.defects[0].enabled, true);
  assert.equal(draft.defects[0].text, 'Нарушение');
});


test('the exact legacy HTML JSON field names populate React form values and table rows', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const html = await readFile(path.join(projectRoot, 'services/vdgo/backend/templates/index.html'), 'utf8');
  const names = [...html.matchAll(/\bname="([^"]+)"/g)].map(match => match[1]);
  const fields = Object.fromEntries(names
    .filter(name => name !== 'query' && !name.startsWith('photo_'))
    .map(name => [name, name.endsWith('_nd') ? '' : `VALUE:${name}`]));
  Object.assign(fields, {
    defect_1_enabled: '1',
    defect_1_location: 'Подъезд 1, этаж 2',
    defect_1_text: 'Коррозия трубы',
    defect_1_recommendation: 'Восстановить покрытие',
    valve_1_enabled: '1',
    valve_1_location: 'Подъезд 1',
    uzt_shared_1_segment: 'Стояк 1',
    uzt_shared_1_diameter: '32',
    uzt_shared_1_thickness: '3.2',
    uzt_flat_1_apartment: '12',
    uzt_flat_1_du25: '2.8',
    resource_section_1: 'Участок 1',
    resource_years_1: '12',
  });
  const draft = normalizeConclusionDraft({ schema: 'vdgo-report-v1', fields, values: {} });
  assert.equal(draft.values.report_number, 'VALUE:report_number');
  assert.equal(draft.values.address, 'VALUE:address');
  assert.equal(draft.defects[0].enabled, true);
  assert.equal(draft.defects[0].text, 'Коррозия трубы');
  assert.equal(draft.uztShared[0].segment, 'Стояк 1');
  assert.equal(draft.uztFlat[0].apartment, '12');
  assert.equal(draft.resource[0].years, '12');
});

test('nested prepared JSON sections, field-record arrays, camelCase names, selects and missing calibration dates import', () => {
  const draft = normalizeConclusionDraft({
    prepared: {
      sections: [
        { title: 'Основные данные', fields: [
          { id: 'reportNumber', value: 'PREP-19' },
          { name: 'objectAddress', currentValue: 'ул. Ленина, д. 10' },
          { name: 'reportDate', value: '2026-11-13' },
        ] },
        { title: 'Проверки', fields: [
          { key: 'gasStatus', value: 'Не обнаружено' },
          { key: 'uk_calibration_date', value: 'н.д.' },
        ] },
      ],
      values: {},
    },
  });
  assert.equal(draft.values.report_number, 'PREP-19');
  assert.equal(draft.values.address, 'ул. Ленина, д. 10');
  assert.equal(draft.values.report_date, '13.11.2026');
  assert.equal(draft.values.gas_status, 'not_detected');
  assert.equal(draft.values.uk_calibration_date, '');
  assert.equal(draft.values.uk_calibration_date_nd, '1');
});

test('top-level field tuple arrays and UTF-8 BOM or fenced JSON payloads are accepted', () => {
  const parsed = parseConclusionDraftJson('\uFEFF```json\n[[\"report_no\",\"ARRAY-1\"],[\"object_address\",\"ул. Полевая, д. 4\"],[\"reportDate\",\"13/11/2026\"]]\n```');
  const draft = normalizeConclusionDraft(parsed);
  assert.equal(draft.values.report_number, 'ARRAY-1');
  assert.equal(draft.values.address, 'ул. Полевая, д. 4');
  assert.equal(draft.values.report_date, '13.11.2026');
});

test('prepared JSON accepts opaque UI ids with Russian labels and nested value wrappers', () => {
  const draft = normalizeConclusionDraft({
    document: {
      sections: [
        { label: 'Основные данные', fields: [
          { id: 'field-001', label: 'Номер заключения', value: { rawValue: 'PREPARED-2026-01' } },
          { id: 'field-002', label: 'Адрес объекта', value: { displayValue: 'ул. Ленина, дом 10' } },
          { id: 'field-003', label: 'Дата заключения', value: '2026-11-13' },
          { id: 'field-004', label: 'Заказчик (сокращённо)', value: 'ООО «Профит»' },
          { id: 'field-005', label: 'Результат проверки герметичности', value: 'Проверка выполнена, утечек не выявлено.' },
        ] },
      ],
    },
  });
  assert.equal(draft.values.report_number, 'PREPARED-2026-01');
  assert.equal(draft.values.address, 'ул. Ленина, дом 10');
  assert.equal(draft.values.report_date, '13.11.2026');
  assert.equal(draft.values.customer, 'ООО «Профит»');
  assert.equal(draft.values.test_result, 'Проверка выполнена, утечек не выявлено.');
});

test('prepared JSON imports defect rows from nested Russian-labelled field records', () => {
  const draft = normalizeConclusionDraft({
    data: {
      sections: [{
        title: 'Дефекты',
        defects: { items: [{
          fields: [
            { id: 'd-1', label: 'Место расположения', value: 'Подъезд 2, этаж 3' },
            { id: 'd-2', label: 'Наименование неисправности', value: 'Коррозия участка газопровода' },
            { id: 'd-3', label: 'Рекомендации по устранению', value: 'Заменить повреждённый участок после согласования' },
          ],
        }] },
      }],
    },
  });
  assert.equal(draft.defects[0].enabled, true);
  assert.equal(draft.defects[0].location, 'Подъезд 2, этаж 3');
  assert.equal(draft.defects[0].text, 'Коррозия участка газопровода');
  assert.equal(draft.defects[0].recommendation, 'Заменить повреждённый участок после согласования');
});

test('prepared JSON imports table fields when labels and identifiers are nested objects', () => {
  const draft = normalizeConclusionDraft({
    formData: {
      fields: [
        { field: { id: 'x-1', name: 'reportNumber' }, value: 'TABLE-17' },
        { field: { id: 'x-2', label: 'Адрес объекта' }, value: 'ул. Полевая, д. 17' },
        { field: { id: 'x-3', label: 'Испытательное давление' }, value: '500 мм вод. ст.' },
      ],
    },
  });
  assert.equal(draft.values.report_number, 'TABLE-17');
  assert.equal(draft.values.address, 'ул. Полевая, д. 17');
  assert.equal(draft.values.test_pressure, '500 мм вод. ст.');
});

test('every existing scalar conclusion field can import from opaque records labelled with the unchanged Russian form caption', async () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const schema = await readFile(path.join(projectRoot, 'frontend/src/pages/conclusion/schema.ts'), 'utf8');
  const fieldDefinitions = [...schema.matchAll(/\{\s*name:\s*'([^']+)'\s*,\s*label:\s*'([^']+)'/g)]
    .map(([, name, label]) => ({ name, label }));
  assert.ok(fieldDefinitions.length >= 45, 'the current conclusion schema should expose its full scalar field list');
  const draft = normalizeConclusionDraft({
    preparedDocument: {
      sections: [{
        title: 'Сохранённая форма',
        fields: fieldDefinitions.map(({ label, name }, index) => ({
          id: `opaque-control-${index + 1}`,
          label,
          value: { raw_value: `IMPORTED:${name}` },
        })),
      }],
    },
  });
  for (const { name } of fieldDefinitions) {
    assert.equal(draft.values[name], `IMPORTED:${name}`, `The existing field ${name} must be filled from its Russian label`);
  }
});

test('prepared JSON imports valve, UZT and resource table cells from nested labelled cell records', () => {
  const draft = normalizeConclusionDraft({
    document: {
      sections: [
        { title: 'Арматура', valves: { items: [{ fields: [
          { id: 'v1', label: 'Место установки', value: 'Подъезд 3' },
          { id: 'v2', label: 'Условный проход Ду, мм', value: '32' },
          { id: 'v3', label: 'Тип запорной арматуры', value: 'Шаровый кран' },
          { id: 'v4', label: 'Состояние поверхности', value: 'Удовлетворительно' },
          { id: 'v5', label: 'Наружная герметичность', value: 'Герметична' },
          { id: 'v6', label: 'Внутренняя герметичность', value: 'Герметична' },
          { id: 'v7', label: 'Проверка работоспособности', value: 'Исправна' },
          { id: 'v8', label: 'Заключение', value: 'Допускается' },
        ] }] } },
        { title: 'УЗТ по участкам', uztShared: { rows: [{ fields: [
          { id: 'u1', label: 'Номер участка', value: 'Стояк 2' },
          { id: 'u2', label: 'Условный проход Ду', value: '25' },
          { id: 'u3', label: 'Фактическая толщина', value: '3.1' },
        ] }] } },
        { title: 'Остаточный ресурс', resources: { items: [{ fields: [
          { id: 'r1', label: 'Участок для расчёта', value: 'Участок А' },
          { id: 'r2', label: 'Коэффициент запаса Кз', value: '0.45' },
          { id: 'r3', label: 'Базовая скорость коррозии, мм/год', value: '0.1' },
          { id: 'r4', label: 'Коэффициент К1', value: '1.0' },
          { id: 'r5', label: 'Коэффициент К2', value: '0.9' },
          { id: 'r6', label: 'Т — ресурс по участку, лет', value: '12' },
        ] }] } },
      ],
    },
  });
  assert.equal(draft.valves[0].enabled, true);
  assert.deepEqual(draft.valves[0].fields, {
    location: 'Подъезд 3', diameter: '32', type: 'Шаровый кран', surface: 'Удовлетворительно',
    outer: 'Герметична', inner: 'Герметична', function: 'Исправна', conclusion: 'Допускается',
  });
  assert.deepEqual(draft.uztShared[0], { segment: 'Стояк 2', diameter: '25', thickness: '3.1' });
  assert.equal(draft.resource[0].section, 'Участок А');
  assert.equal(draft.resource[0].kz, '0.45');
  assert.equal(draft.resource[0].years, '12');
});

test('prepared JSON imports opaque object-keyed controls and table cells by their nested Russian labels', () => {
  const draft = normalizeConclusionDraft({
    prepared: {
      fields: {
        'control-001': { label: 'Номер заключения', value: 'OBJECT-KEY-01' },
        'control-002': { descriptor: { id: 'opaque-2', label: 'Адрес объекта' }, value: { rawValue: 'ул. Ленина, дом 10' } },
        'control-003': { field: { caption: 'Рабочее давление в расчёте Приложения 11' }, value: '0,003 МПа' },
      },
      defects: [{ fields: {
        'defect-place': { label: 'Место расположения', value: 'Подъезд 1, этаж 2' },
        'defect-text': { label: 'Наименование неисправности', value: 'Повреждение покрытия газопровода' },
      } }],
      valves: [{ fields: {
        'valve-place': { label: 'Место установки', value: 'Подъезд 1' },
        'valve-dn': { label: 'Условный проход Ду, мм', value: '25' },
        'valve-type': { label: 'Тип запорной арматуры', value: 'Шаровый' },
      } }],
      uztShared: [{ fields: {
        'uzt-segment': { label: 'Участок для измерения', value: 'Стояк 1' },
        'uzt-diameter': { label: 'Условный проход Ду', value: '32' },
        'uzt-thickness': { label: 'Фактическая толщина', value: '3,2' },
      } }],
      resource: [{ fields: {
        'resource-section': { label: 'Участок для расчёта', value: 'Участок 1' },
        'resource-years': { label: 'Т, ресурс по участку, лет', value: '12' },
      } }],
    },
  });

  assert.equal(draft.values.report_number, 'OBJECT-KEY-01');
  assert.equal(draft.values.address, 'ул. Ленина, дом 10');
  assert.equal(draft.values.resource_working_pressure, '0,003 МПа');
  assert.equal(draft.defects[0].location, 'Подъезд 1, этаж 2');
  assert.equal(draft.defects[0].text, 'Повреждение покрытия газопровода');
  assert.equal(draft.valves[0].fields.location, 'Подъезд 1');
  assert.equal(draft.valves[0].fields.diameter, '25');
  assert.equal(draft.valves[0].fields.type, 'Шаровый');
  assert.equal(draft.uztShared[0].segment, 'Стояк 1');
  assert.equal(draft.uztShared[0].diameter, '32');
  assert.equal(draft.uztShared[0].thickness, '3,2');
  assert.equal(draft.resource[0].section, 'Участок 1');
  assert.equal(draft.resource[0].years, '12');
});
