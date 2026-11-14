const DEFECT_COUNT = 11;
const VALVE_COUNT = 3;
const UZT_SHARED_COUNT = 24;
const UZT_FLAT_COUNT = 42;
const RESOURCE_COUNT = 4;
const RESOURCE_KEYS = [
  'section', 'kz', 'thickness', 'base_velocity', 'k1', 'k2', 'factor', 'velocity', 'years',
];
const VALVE_KEYS = [
  'location', 'diameter', 'type', 'surface', 'outer', 'inner', 'function', 'conclusion',
];
const MATERIAL_PAGES = [16, 17, 31, 32, 33, 34, 35, 36, 41, 42, 43, 44, 45, 46, 47];

const FIELD_LABEL_ALIASES = new Map([
  ['номер заключения', 'report_number'], ['номер отчета', 'report_number'], ['номер отчёта', 'report_number'], ['дата заключения', 'report_date'],
  ['адрес объекта', 'address'], ['адрес обследуемого объекта', 'address'], ['год отчета', 'report_year'], ['год отчёта', 'report_year'],
  ['дата следующего технического диагностирования', 'next_diagnostic'],
  ['заказчик сокращенно', 'customer'], ['заказчик сокращённо', 'customer'],
  ['заказчик полное наименование', 'customer_legal_name'], ['адрес заказчика', 'customer_address'],
  ['телефон заказчика', 'customer_phone'], ['директор заказчика инициалы', 'customer_director'],
  ['исполнитель краткое наименование', 'executor'], ['полное наименование исполнителя', 'executor_legal_name'],
  ['юридический адрес исполнителя', 'executor_address'], ['телефон исполнителя', 'executor_phone'],
  ['генеральный директор инициалы', 'general_director'], ['генеральный директор фио', 'general_director_full'],
  ['специалист ii уровня инициалы', 'specialist'], ['специалист ii уровня фио', 'specialist_full'],
  ['слесарь по эрго инициалы', 'technician'], ['слесарь по эрго фио', 'technician_full'],
  ['номер приказа о назначении рабочей группы', 'work_group_order_number'],
  ['дата приказа о назначении рабочей группы', 'work_group_order_date'],
  ['документ о квалификации слесаря', 'technician_certificate'],
  ['документ о квалификации слесаря номер дата учебный центр', 'technician_certificate'],
  ['полные данные удостоверения специалиста', 'specialist_certificate'],
  ['полные данные удостоверения специалиста уровень номер дата кто выдал', 'specialist_certificate'],
  ['дополнительная квалификация специалиста', 'specialist_additional_certificate'],
  ['дополнительная квалификация в строке специалиста', 'specialist_additional_certificate'],
  ['дополнительные сведения о квалификации специалиста', 'specialist_additional_certificate'],
  ['подтвержденная протяженность м', 'pipe_length'], ['подтверждённая протяжённость м', 'pipe_length'],
  ['подтвержденная протяженность', 'pipe_length'], ['подтверждённая протяжённость', 'pipe_length'],
  ['разрешенное давление мпа', 'pressure'], ['разрешённое давление мпа', 'pressure'], ['разрешенное давление', 'pressure'], ['разрешённое давление', 'pressure'],
  ['минимальная толщина стенки мм', 'min_thickness'], ['максимальная толщина стенки мм', 'max_thickness'],
  ['итоговый остаточный ресурс', 'remaining_life_years'],
  ['тип модель толщиномера uzt', 'uzt_device_model'], ['заводской номер толщиномера uzt', 'uzt_device_serial'],
  ['дата поверки толщиномера uzt', 'uzt_calibration_date'],
  ['год проведения замеров толщины стенок', 'measurement_year'],
  ['дефектоскоп ук модель приложение 5', 'uk_device_model'],
  ['дефектоскоп ук заводской номер', 'uk_device_serial'],
  ['дефектоскоп ук дата поверки', 'uk_calibration_date'],
  ['приложение 5 номер сварного соединения участка', 'uk_joint_number'],
  ['приложение 5 материал диаметр и толщина', 'uk_material_description'],
  ['приложение 5 предельная чувствительность', 'uk_sensitivity'],
  ['приложение 5 фактическое описание дефектов', 'uk_defect_description'],
  ['приложение 5 оценка результатов контроля', 'uk_result'],
  ['приложение 5 доступность контроля', 'uk_accessibility_percent'],
  ['вывод по результатам обследования арматуры', 'conclusion_text'],
  ['рабочее давление в расчете приложения 11', 'resource_working_pressure'],
  ['рабочее давление в расчёте приложения 11', 'resource_working_pressure'],
  ['фио лица выполнившего расчет остаточного ресурса', 'resource_calculated_by'],
  ['фио лица выполнившего расчёт остаточного ресурса', 'resource_calculated_by'],
  ['проверка загазованности помещений', 'gas_status'], ['результат проверки загазованности', 'gas_status'],
  ['проверка утечек на внутренних и вводных газопроводах', 'leak_status'], ['результат проверки утечек', 'leak_status'],
  ['место утечки', 'leak_location'], ['место утечки требуется если выявлена', 'leak_location'],
  ['фио собственника помещение', 'leak_owner'], ['ф и о собственника помещение если выявлена', 'leak_owner'], ['фио собственника помещение если выявлена', 'leak_owner'], ['фио собственника', 'leak_owner'],
  ['результат проверки герметичности', 'test_result'], ['испытательное давление', 'test_pressure'],
  ['классификация результатов', 'finding_status'],
  ['подтверждение в фотослоты загружены только фотографии текущего объекта', 'photo_content_confirm'],
  ['подтверждение проверки итогового документа', 'template_review_confirm'],
  ['заказчик сокращенно', 'customer'], ['заказчик сокращённо', 'customer'],
  ['заказчик полное наименование', 'customer_legal_name'],
  ['исполнитель краткое наименование', 'executor'],
  ['полное наименование исполнителя', 'executor_legal_name'],
  ['специалист 2 уровня инициалы', 'specialist'], ['специалист второго уровня инициалы', 'specialist'],
  ['специалист 2 уровня фио', 'specialist_full'], ['специалист второго уровня фио', 'specialist_full'],
  ['слесарь по эрго инициалы', 'technician'], ['слесарь по эрго фио', 'technician_full'],
  ['минимальная толщина стенки', 'min_thickness'], ['максимальная толщина стенки', 'max_thickness'],
  ['тип модель толщиномера узт', 'uzt_device_model'], ['заводской номер толщиномера узт', 'uzt_device_serial'],
  ['дата поверки толщиномера узт', 'uzt_calibration_date'],
  ['дефектоскоп ук модель', 'uk_device_model'], ['дефектоскоп ук заводской номер', 'uk_device_serial'],
  ['дефектоскоп ук дата поверки', 'uk_calibration_date'],
  ['вывод по результатам обследования арматуры раздел 5 4', 'conclusion_text'],
  ['результат проверки на герметичность', 'test_result'],
  ['проверка герметичности результат', 'test_result'],
  ['классификация результатов проверки', 'finding_status'],
]);

function normalizeLabelKey(value) {
  return String(value || '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

const KNOWN_FIELDS = new Set([
  'report_number', 'report_date', 'address', 'report_year', 'next_diagnostic',
  'customer', 'customer_legal_name', 'customer_address', 'customer_phone', 'customer_director',
  'executor', 'executor_legal_name', 'executor_address', 'executor_phone',
  'general_director', 'general_director_full', 'specialist', 'specialist_full',
  'technician', 'technician_full', 'work_group_order_number', 'work_group_order_date',
  'technician_certificate', 'specialist_certificate', 'specialist_additional_certificate',
  'pipe_length', 'pressure', 'min_thickness', 'max_thickness', 'remaining_life_years',
  'uzt_device_model', 'uzt_device_serial', 'uzt_calibration_date', 'measurement_year',
  'uk_device_model', 'uk_device_serial', 'uk_calibration_date', 'uk_joint_number',
  'uk_material_description', 'uk_sensitivity', 'uk_defect_description', 'uk_result',
  'uk_accessibility_percent', 'resource_working_pressure', 'resource_calculated_by',
  'conclusion_text', 'gas_status', 'leak_status', 'leak_location', 'leak_owner',
  'test_result', 'test_pressure', 'finding_status', 'photo_content_confirm',
  'template_review_confirm', 'uzt_calibration_date_nd', 'uk_calibration_date_nd',
]);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scalar(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '1' : '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(scalar).filter(Boolean).join(', ');
  if (isObject(value)) {
    for (const key of ['value', 'rawValue', 'raw_value', 'valueRaw', 'value_raw', 'currentValue', 'current_value', 'defaultValue', 'default_value', 'selectedValue', 'selected_value', 'selectedOption', 'selected_option', 'displayValue', 'display_value', 'formattedValue', 'formatted_value', 'inputValue', 'input_value', 'stringValue', 'string_value', 'textValue', 'text_value', 'text', 'content', 'plainText', 'plain_text', 'answer', 'answerValue', 'answer_value', 'answerText', 'answer_text', 'result', 'checked', 'selected', 'dataValue', 'data_value']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return scalar(value[key]);
    }
  }
  return '';
}

function booleanValue(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === null || value === undefined) return false;
  const text = scalar(value).trim().toLocaleLowerCase('ru-RU');
  return ['1', 'true', 'yes', 'да', 'checked', 'on', 'включено'].includes(text);
}

function normalizeKey(key) {
  let raw = String(key || '').trim();
  const bracket = raw.match(/^(?:form|fields|data|values|report|prepared|draft)\[([^\]]+)\]$/i);
  if (bracket) raw = bracket[1].trim();
  raw = raw.replace(/^(?:form|fields|data|values|report|prepared|draft)[.]/i, '');
  raw = raw.replace(/\.(?:value|currentValue|text|answer|result)$/i, '');
  raw = raw.replace(/\[\]$/, '').trim();
  raw = raw.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  // Some prepared exports store the human-readable control caption instead of
  // its HTML name. Try the full caption first: slashes are common inside real
  // labels (for example, "Тип / модель толщиномера УЗТ") and must not be
  // mistaken for path separators. Only pipe/chevron separators delimit paths.
  const fullLabel = normalizeLabelKey(raw);
  if (FIELD_LABEL_ALIASES.has(fullLabel)) return FIELD_LABEL_ALIASES.get(fullLabel);
  const label = normalizeLabelKey(raw.split(/[|>]/).pop());
  if (FIELD_LABEL_ALIASES.has(label)) return FIELD_LABEL_ALIASES.get(label);
  const aliases = {
    report_no: 'report_number', reportnum: 'report_number', conclusion_number: 'report_number',
    conclusion_date: 'report_date', reportdate: 'report_date', object_address: 'address',
    facility_address: 'address', objectaddress: 'address', next_inspection_date: 'next_diagnostic',
    next_diagnostic_date: 'next_diagnostic', defectoscope_model: 'uk_device_model',
    defectoscope_serial: 'uk_device_serial',
  };
  const defect = raw.match(/^defect_(\d+)_(place|where|defect|description|note|action|measure)$/);
  if (defect) return `defect_${defect[1]}_${['place', 'where'].includes(defect[2]) ? 'location' : ['action', 'measure'].includes(defect[2]) ? 'recommendation' : 'text'}`;
  const shared = raw.match(/^uzt_shared_(\d+)_(du|nominal_diameter|wall_thickness)$/);
  if (shared) return `uzt_shared_${shared[1]}_${shared[2] === 'wall_thickness' ? 'thickness' : 'diameter'}`;
  const flat = raw.match(/^uzt_flat_(\d+)_(du_?25|du_?20|du_?15)$/);
  if (flat) return `uzt_flat_${flat[1]}_${flat[2].replace('_', '')}`;
  return aliases[raw] || raw;
}

function isKnownField(key) {
  return KNOWN_FIELDS.has(key)
    || /^defect_\d+_(?:enabled|location|text|recommendation)$/.test(key)
    || /^valve_\d+_(?:enabled|.+)$/.test(key)
    || /^uzt_shared_\d+_(?:segment|diameter|thickness)$/.test(key)
    || /^uzt_flat_\d+_(?:apartment|du25|du20|du15)$/.test(key)
    || /^resource_(?:section|kz|thickness|base_velocity|k1|k2|factor|velocity|years)_\d+$/.test(key)
    || /^exclude_material_page_\d+$/.test(key);
}

function descriptorKeys(value) {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (!isObject(value)) return [];
  const direct = [value.name, value.key, value.fieldName, value.field_name, value.fieldKey, value.field_key,
    value.fieldId, value.field_id, value.inputName, value.input_name, value.controlName, value.control_name,
    value.htmlName, value.html_name, value.path, value.code, value.slug, value.id, value.label,
    value.caption, value.title];
  // Some form builders store a dictionary keyed by an opaque control id and
  // put the real field descriptor one level inside the value object.
  const nested = [value.field, value.descriptor, value.control, value.component, value.metadata, value.meta]
    .flatMap(item => isObject(item) ? descriptorKeys(item) : []);
  return [...direct, ...nested].filter(item => item !== undefined && item !== null && String(item).trim());
}

function resolveEntryKey(rawKey, rawValue) {
  const candidates = [rawKey, ...(isObject(rawValue) ? descriptorKeys(rawValue) : [])];
  return firstKnownKey(candidates) ?? rawKey;
}

function resolveAliasedEntryKey(rawKey, rawValue, aliases, allowedKeys = new Set()) {
  const candidates = [rawKey, ...(isObject(rawValue) ? descriptorKeys(rawValue) : [])];
  return candidates.find(candidate => aliases.has(normalizeLabelKey(candidate))
    || allowedKeys.has(normalizeKey(candidate))) ?? rawKey;
}

function unwrapEntryValue(value) {
  if (!isObject(value)) return value;
  for (const key of ['value', 'rawValue', 'raw_value', 'valueRaw', 'value_raw', 'currentValue', 'current_value',
    'defaultValue', 'default_value', 'selectedValue', 'selected_value', 'selectedOption', 'selected_option',
    'displayValue', 'display_value', 'formattedValue', 'formatted_value', 'inputValue', 'input_value',
    'stringValue', 'string_value', 'textValue', 'text_value', 'plainText', 'plain_text', 'answer',
    'answerValue', 'answer_value', 'answerText', 'answer_text', 'result', 'checked', 'selected',
    'dataValue', 'data_value', 'content', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  }
  return value;
}

function firstKnownKey(candidates) {
  const expanded = candidates.flatMap(descriptorKeys);
  for (const candidate of expanded) {
    const normalized = normalizeKey(candidate);
    if (normalized && isKnownField(normalized)) return candidate;
  }
  // Preserve unknown name candidates last so diagnostics can still identify their shape;
  // normalizeFieldMap will ignore them if no known alias matches.
  return expanded[0];
}

function normalizeFieldMap(source) {
  const result = {};
  const recordEntry = item => {
    if (!isObject(item)) return null;
    // Prefer a known HTML field name, but fall back to the human-readable label when
    // exporters use opaque numeric ids (for example id=field-17, label=Адрес объекта).
    const key = firstKnownKey([item.name, item.key, item.fieldName, item.field_name, item.fieldKey,
      item.field_key, item.inputName, item.input_name, item.controlName, item.control_name,
      item.htmlName, item.html_name, item.code, item.slug, item.field, item.id,
      item.label, item.caption, item.title, item.path]);
    const value = item.value ?? item.rawValue ?? item.raw_value ?? item.currentValue ?? item.current_value
      ?? item.selectedValue ?? item.selected_value ?? item.displayValue ?? item.display_value
      ?? item.valueRaw ?? item.value_raw ?? item.defaultValue ?? item.default_value ?? item.selectedOption ?? item.selected_option
      ?? item.formattedValue ?? item.formatted_value ?? item.inputValue ?? item.input_value ?? item.stringValue ?? item.string_value
      ?? item.textValue ?? item.text_value ?? item.answer ?? item.answerValue ?? item.answer_value ?? item.answerText ?? item.answer_text
      ?? item.result ?? item.checked ?? item.selected ?? item.dataValue ?? item.data_value ?? item.content ?? item.data ?? item.plainText ?? item.plain_text;
    return key !== undefined && value !== undefined ? [key, value] : null;
  };
  const entries = Array.isArray(source)
    ? source.flatMap(item => {
      if (Array.isArray(item) && item.length >= 2) return [[item[0], item[1]]];
      const entry = recordEntry(item);
      return entry ? [entry] : [];
    })
    : isObject(source) && firstKnownKey([source.name, source.key, source.fieldName, source.field_name,
      source.fieldKey, source.field_key, source.inputName, source.input_name, source.field,
      source.id, source.label, source.caption, source.title, source.path]) !== undefined
      && (source.value !== undefined || source.rawValue !== undefined || source.raw_value !== undefined || source.valueRaw !== undefined || source.value_raw !== undefined || source.currentValue !== undefined || source.current_value !== undefined || source.defaultValue !== undefined || source.selectedValue !== undefined || source.displayValue !== undefined || source.formattedValue !== undefined || source.inputValue !== undefined || source.answer !== undefined || source.result !== undefined || source.checked !== undefined || source.data !== undefined || source.content !== undefined)
      ? [recordEntry(source)].filter(Boolean)
      : isObject(source) ? Object.entries(source) : [];
  for (const [rawKey, rawValue] of entries) {
    const descriptor = resolveEntryKey(rawKey, rawValue);
    const key = normalizeKey(descriptor);
    if (!key || !isKnownField(key)) continue;
    const value = scalar(unwrapEntryValue(rawValue));
    if (value !== '') result[key] = value;
    else if (rawValue === '' || rawValue === false || rawValue === null || rawValue === undefined) result[key] = '';
  }
  return result;
}

function mergeFieldSources(candidates) {
  const merged = {};
  for (const candidate of candidates) {
    const normalized = normalizeFieldMap(candidate);
    for (const [key, value] of Object.entries(normalized)) {
      // Empty `values` objects from older exporters must not erase populated `fields`.
      // An explicitly empty value is retained only when no populated source supplied it.
      if (value !== '' || !Object.prototype.hasOwnProperty.call(merged, key)) merged[key] = value;
    }
  }
  return merged;
}

function collectNestedSources(root) {
  const ordinary = [];
  const valueMaps = [];
  const seen = new WeakSet();
  const containerKeys = new Set([
    'fields', 'values', 'form', 'data', 'report', 'payload', 'formdata', 'form_data',
    'prepared', 'draft', 'result', 'answers', 'answer', 'fieldvalues', 'field_values',
    'sections', 'sectiondata', 'section_data', 'document', 'conclusion', 'formfields', 'form_fields', 'reportdata', 'report_data', 'draftdata', 'draft_data',
    'items', 'rows', 'records', 'entries', 'controls', 'components', 'blocks', 'fieldsdata', 'fields_data',
  ]);
  const visit = (node, key = '', depth = 0) => {
    if (depth > 7 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      // Some JSON exporters emit a list of [fieldName, value] pairs or field records.
      if (node.some(item => Array.isArray(item) || (isObject(item) && (item.name || item.key || item.field || item.fieldName || item.field_name || item.fieldId || item.id || item.label || item.caption || item.title)))) {
        (key === 'values' ? valueMaps : ordinary).push(node);
      }
      for (const item of node) if (isObject(item) || Array.isArray(item)) visit(item, key, depth + 1);
      return;
    }
    if (!isObject(node) || seen.has(node)) return;
    seen.add(node);
    (key === 'values' || key === 'fieldvalues' || key === 'field_values' ? valueMaps : ordinary).push(node);
    for (const [childKey, child] of Object.entries(node)) {
      const normalized = childKey.toLowerCase();
      if (containerKeys.has(normalized) || isObject(child) || Array.isArray(child)) {
        visit(child, normalized, depth + 1);
      }
    }
  };
  visit(root);
  return { ordinary, valueMaps };
}

function findFieldSource(parsed) {
  const nested = collectNestedSources(parsed);
  // Explicit maps preserve the documented legacy/current precedence. Deeply nested
  // section-based and form-builder exports are then considered; current value maps
  // are last, but blank values never erase a populated legacy field.
  return mergeFieldSources([
    parsed.fields,
    parsed.form?.fields,
    parsed.form,
    parsed.data?.fields,
    parsed.data,
    parsed.report?.fields,
    parsed.report,
    parsed.payload?.fields,
    parsed.payload,
    parsed.formData,
    ...nested.ordinary,
    parsed.values,
    ...nested.valueMaps,
  ]);
}

function findArraySource(parsed, keys) {
  const nested = collectNestedSources(parsed);
  const normalizedKeys = new Set(keys.map(key => normalizeLabelKey(key).replace(/\s+/g, '')));
  for (const container of [...nested.ordinary, ...nested.valueMaps]) {
    if (!isObject(container)) continue;
    for (const [rawKey, value] of Object.entries(container)) {
      const normalized = normalizeLabelKey(rawKey).replace(/\s+/g, '');
      if (!normalizedKeys.has(normalized)) continue;
      if (Array.isArray(value)) return value;
      if (isObject(value)) {
        for (const [childKey, child] of Object.entries(value)) {
          if (['rows', 'items', 'records', 'entries', 'list', 'data'].includes(normalizeLabelKey(childKey).replace(/\s+/g, '')) && Array.isArray(child)) return child;
        }
      }
    }
  }
  return null;
}

function dateValue(value) {
  const text = scalar(value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  const slashIso = text.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (slashIso) return `${slashIso[3]}.${slashIso[2]}.${slashIso[1]}`;
  const slashRu = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashRu) return `${slashRu[1]}.${slashRu[2]}.${slashRu[3]}`;
  return text;
}

function selectValue(key, value) {
  const raw = scalar(value).trim();
  const normalized = raw.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
  if (key === 'gas_status' || key === 'leak_status') {
    if (['не обнаружено', 'не выявлено', 'не выявлены', 'отсутствует', 'нет'].includes(normalized)) return 'not_detected';
    if (['обнаружено', 'выявлено', 'выявлены', 'есть'].includes(normalized)) return 'detected';
    if (['не проверялось', 'не проверялась', 'проверка не проводилась', 'не проводилась', 'н.д.', 'н/д'].includes(normalized)) return 'not_checked';
  }
  if (key === 'finding_status') {
    if (['выявлены неисправности', 'есть дефекты', 'дефекты выявлены'].includes(normalized)) return 'defects';
    if (['неисправности не выявлены', 'не выявлено', 'дефектов нет', 'нет'].includes(normalized)) return 'none';
  }
  return raw;
}

function normalizeMissingDateFlags(values) {
  for (const key of ['uzt_calibration_date', 'uk_calibration_date']) {
    const raw = String(values[key] || '').trim().toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
    if (['н.д.', 'н.д', 'н/д', 'не применялся', 'не применялась', 'не требуется'].includes(raw)) {
      values[`${key}_nd`] = '1';
      values[key] = '';
    }
  }
}

function normalizeDefectRowSource(row) {
  if (!isObject(row)) return {};
  const nested = row.fields ?? row.values ?? row.data ?? row.properties ?? row.attributes;
  const source = isObject(nested) || Array.isArray(nested) ? nested : row;
  const mapped = {};
  const aliases = new Map([
    ['location', 'location'], ['place', 'location'], ['where', 'location'], ['место расположения', 'location'],
    ['место выявления', 'location'], ['расположение дефекта', 'location'], ['место дефекта', 'location'], ['участок', 'location'],
    ['text', 'text'], ['defect', 'text'], ['description', 'text'], ['note', 'text'], ['дефект', 'text'],
    ['наименование неисправности', 'text'], ['описание дефекта', 'text'], ['описание неисправности', 'text'],
    ['выявленная неисправность', 'text'], ['содержание дефекта', 'text'], ['описание выявленного дефекта', 'text'], ['дефект описание', 'text'],
    ['recommendation', 'recommendation'], ['action', 'recommendation'], ['measure', 'recommendation'],
    ['рекомендации по устранению', 'recommendation'], ['рекомендация по устранению', 'recommendation'],
    ['меры по устранению', 'recommendation'], ['мероприятия по устранению', 'recommendation'], ['рекомендация', 'recommendation'],
    ['enabled', 'enabled'], ['включено', 'enabled'], ['активен', 'enabled'],
  ]);
  const entries = Array.isArray(source)
    ? source.flatMap(item => {
      if (Array.isArray(item) && item.length >= 2) return [[item[0], item[1]]];
      if (!isObject(item)) return [];
      const candidates = [item.name, item.key, item.fieldName, item.field_name, item.fieldKey, item.field_key,
        item.inputName, item.input_name, item.field, item.id, item.label, item.caption, item.title].flatMap(descriptorKeys);
      const key = candidates.find(candidate => {
        const normalized = normalizeLabelKey(candidate);
        return aliases.has(normalized) || ['location', 'place', 'where', 'text', 'defect', 'description', 'note', 'recommendation', 'action', 'measure', 'enabled'].includes(normalized)
          || /^defect_\d+_(?:location|text|recommendation|enabled)$/.test(normalizeKey(candidate));
      }) ?? candidates[0];
      const value = item.value ?? item.rawValue ?? item.raw_value ?? item.valueRaw ?? item.value_raw ?? item.currentValue ?? item.current_value ?? item.defaultValue ?? item.default_value ?? item.selectedValue ?? item.selected_value ?? item.displayValue ?? item.display_value ?? item.formattedValue ?? item.formatted_value ?? item.inputValue ?? item.input_value ?? item.answer ?? item.result ?? item.text ?? item.content ?? item.data;
      return key !== undefined && value !== undefined ? [[key, value]] : [];
    })
    : isObject(source) ? Object.entries(source) : [];
  for (const [rawKey, rawValue] of entries) {
    const descriptor = resolveAliasedEntryKey(rawKey, rawValue, aliases,
      new Set(['location', 'text', 'recommendation', 'enabled']));
    const normalized = normalizeLabelKey(normalizeKey(descriptor));
    const canonical = aliases.get(normalized) || (['location', 'text', 'recommendation', 'enabled'].includes(normalized) ? normalized : '');
    if (canonical) mapped[canonical] = scalar(unwrapEntryValue(rawValue));
  }
  for (const key of ['location', 'text', 'recommendation', 'enabled']) {
    if (mapped[key] === undefined && row[key] !== undefined) mapped[key] = scalar(row[key]);
  }
  mapped.workforceReportId = scalar(row.workforceReportId ?? row.workforce_report_id ?? row.reportId ?? row.report_id);
  mapped.workforceTaskId = scalar(row.workforceTaskId ?? row.workforce_task_id ?? row.taskId ?? row.task_id);
  return mapped;
}

function normalizeDefectRows(parsed, fields) {
  const supplied = findArraySource(parsed, ['defects', 'defectRows', 'defect_rows', 'замечания', 'выявленные дефекты', 'неисправности']);
  return Array.from({ length: DEFECT_COUNT }, (_, index) => {
    const fallback = normalizeDefectRowSource(supplied?.[index] || {});
    const number = index + 1;
    const location = scalar(fallback.location ?? fields[`defect_${number}_location`]);
    const text = scalar(fallback.text ?? fields[`defect_${number}_text`]);
    const recommendation = scalar(fallback.recommendation ?? fields[`defect_${number}_recommendation`]);
    const enabledSource = fallback.enabled ?? fields[`defect_${number}_enabled`];
    return {
      enabled: enabledSource !== undefined ? booleanValue(enabledSource) : Boolean(location || text || recommendation),
      location,
      text,
      recommendation,
      ...(fallback.workforceReportId ? { workforceReportId: fallback.workforceReportId } : {}),
      ...(fallback.workforceTaskId ? { workforceTaskId: fallback.workforceTaskId } : {}),
    };
  });
}

function normalizeDescriptorRecord(source, aliases, allowedKeys) {
  const nested = source?.fields ?? source?.values ?? source?.data ?? source?.properties ?? source?.attributes;
  const row = isObject(nested) || Array.isArray(nested) ? nested : source;
  const mapped = {};
  const entries = Array.isArray(row)
    ? row.flatMap(item => {
      if (Array.isArray(item) && item.length >= 2) return [[item[0], item[1]]];
      if (!isObject(item)) return [];
      const candidates = [item.name, item.key, item.fieldName, item.field_name, item.fieldKey, item.field_key,
        item.inputName, item.input_name, item.controlName, item.control_name, item.field, item.id,
        item.label, item.caption, item.title].flatMap(descriptorKeys);
      const key = candidates.find(candidate => {
        const normalized = normalizeLabelKey(candidate);
        return aliases.has(normalized) || allowedKeys.has(normalizeKey(candidate));
      }) ?? candidates[0];
      const value = item.value ?? item.rawValue ?? item.raw_value ?? item.valueRaw ?? item.value_raw
        ?? item.currentValue ?? item.current_value ?? item.defaultValue ?? item.default_value
        ?? item.selectedValue ?? item.selected_value ?? item.selectedOption ?? item.selected_option
        ?? item.displayValue ?? item.display_value ?? item.formattedValue ?? item.formatted_value
        ?? item.inputValue ?? item.input_value ?? item.answer ?? item.result ?? item.text ?? item.content ?? item.data;
      return key !== undefined && value !== undefined ? [[key, value]] : [];
    })
    : isObject(row) ? Object.entries(row) : [];
  for (const [rawKey, rawValue] of entries) {
    const descriptor = resolveAliasedEntryKey(rawKey, rawValue, aliases, allowedKeys);
    const normalizedLabel = normalizeLabelKey(descriptor);
    const normalizedKey = normalizeKey(descriptor);
    const key = aliases.get(normalizedLabel) || (allowedKeys.has(normalizedKey) ? normalizedKey : '');
    if (key) mapped[key] = scalar(unwrapEntryValue(rawValue));
  }
  return mapped;
}

const VALVE_LABEL_ALIASES = new Map([
  ['место установки', 'location'], ['расположение', 'location'], ['подъезд', 'location'],
  ['условный проход ду мм', 'diameter'], ['условный проход', 'diameter'], ['диаметр', 'diameter'], ['ду', 'diameter'],
  ['тип запорной арматуры', 'type'], ['тип арматуры', 'type'],
  ['состояние поверхности', 'surface'], ['наружная герметичность', 'outer'],
  ['внутренняя герметичность', 'inner'], ['проверка работоспособности', 'function'],
  ['заключение', 'conclusion'],
]);
const VALVE_KEY_SET = new Set(VALVE_KEYS);

function normalizeValveRows(parsed, fields) {
  const supplied = findArraySource(parsed, ['valves', 'valveRows', 'valve_rows', 'арматура', 'результаты проверки арматуры']);
  return Array.from({ length: VALVE_COUNT }, (_, index) => {
    const fallback = supplied?.[index] || {};
    const number = index + 1;
    const rowFields = normalizeDescriptorRecord(fallback, VALVE_LABEL_ALIASES, VALVE_KEY_SET);
    const values = {};
    for (const key of VALVE_KEYS) values[key] = scalar(rowFields[key] ?? fields[`valve_${number}_${key}`] ?? fallback[key]);
    const enabledSource = fallback.enabled ?? rowFields.enabled ?? fields[`valve_${number}_enabled`];
    return {
      enabled: enabledSource !== undefined ? booleanValue(enabledSource) : Object.values(values).some(Boolean),
      fields: values,
    };
  });
}

const UZT_SHARED_LABEL_ALIASES = new Map([
  ['участок', 'segment'], ['участок для измерения', 'segment'], ['номер участка', 'segment'],
  ['условный проход ду', 'diameter'], ['ду мм', 'diameter'], ['диаметр', 'diameter'],
  ['толщина стенки', 'thickness'], ['толщина мм', 'thickness'], ['фактическая толщина', 'thickness'],
]);
const UZT_SHARED_KEY_SET = new Set(['segment', 'diameter', 'thickness']);
const UZT_FLAT_LABEL_ALIASES = new Map([
  ['номер квартиры', 'apartment'], ['квартира', 'apartment'], ['номер помещения', 'apartment'],
  ['ду25', 'du25'], ['ду 25', 'du25'], ['толщина ду25', 'du25'],
  ['ду20', 'du20'], ['ду 20', 'du20'], ['толщина ду20', 'du20'],
  ['ду15', 'du15'], ['ду 15', 'du15'], ['толщина ду15', 'du15'],
]);
const UZT_FLAT_KEY_SET = new Set(['apartment', 'du25', 'du20', 'du15']);
const RESOURCE_LABEL_ALIASES = new Map([
  ['участок для расчета', 'section'], ['участок для расчёта', 'section'], ['участок', 'section'],
  ['коэффициент запаса кз', 'kz'], ['коэффициент запаса', 'kz'], ['кз', 'kz'],
  ['минимальная толщина стенки мм', 'thickness'], ['толщина стенки', 'thickness'],
  ['базовая скорость коррозии мм год', 'base_velocity'], ['базовая скорость коррозии', 'base_velocity'],
  ['коэффициент к1', 'k1'], ['к1', 'k1'], ['коэффициент к2', 'k2'], ['к2', 'k2'],
  ['ку з коэффициент условий эксплуатации', 'factor'], ['коэффициент условий эксплуатации', 'factor'],
  ['ву к условная скорость коррозии', 'velocity'], ['условная скорость коррозии', 'velocity'],
  ['т ресурс по участку лет', 'years'], ['ресурс по участку лет', 'years'], ['ресурс лет', 'years'],
]);
const RESOURCE_KEY_SET = new Set(RESOURCE_KEYS);

function normalizeUztShared(parsed, fields) {
  const supplied = findArraySource(parsed, ['uztShared', 'uzt_shared', 'uztSharedRows', 'узт общие участки']);
  return Array.from({ length: UZT_SHARED_COUNT }, (_, index) => {
    const row = supplied?.[index] || {};
    const number = index + 1;
    const mapped = normalizeDescriptorRecord(row, UZT_SHARED_LABEL_ALIASES, UZT_SHARED_KEY_SET);
    return {
      segment: scalar(mapped.segment ?? row.segment ?? fields[`uzt_shared_${number}_segment`]),
      diameter: scalar(mapped.diameter ?? row.diameter ?? fields[`uzt_shared_${number}_diameter`]),
      thickness: scalar(mapped.thickness ?? row.thickness ?? fields[`uzt_shared_${number}_thickness`]),
    };
  });
}

function normalizeUztFlat(parsed, fields) {
  const supplied = findArraySource(parsed, ['uztFlat', 'uzt_flat', 'uztFlatRows', 'узт квартиры']);
  return Array.from({ length: UZT_FLAT_COUNT }, (_, index) => {
    const row = supplied?.[index] || {};
    const number = index + 1;
    const mapped = normalizeDescriptorRecord(row, UZT_FLAT_LABEL_ALIASES, UZT_FLAT_KEY_SET);
    return {
      apartment: scalar(mapped.apartment ?? row.apartment ?? fields[`uzt_flat_${number}_apartment`]),
      du25: scalar(mapped.du25 ?? row.du25 ?? fields[`uzt_flat_${number}_du25`]),
      du20: scalar(mapped.du20 ?? row.du20 ?? fields[`uzt_flat_${number}_du20`]),
      du15: scalar(mapped.du15 ?? row.du15 ?? fields[`uzt_flat_${number}_du15`]),
    };
  });
}

function normalizeResource(parsed, fields) {
  const supplied = findArraySource(parsed, ['resource', 'resources', 'resourceRows', 'расчет ресурса', 'расчёт ресурса']);
  return Array.from({ length: RESOURCE_COUNT }, (_, index) => {
    const row = supplied?.[index] || {};
    const number = index + 1;
    const mapped = normalizeDescriptorRecord(row, RESOURCE_LABEL_ALIASES, RESOURCE_KEY_SET);
    return Object.fromEntries(RESOURCE_KEYS.map(key => [key, scalar(mapped[key] ?? row[key] ?? fields[`resource_${key}_${number}`])]));
  });
}


export function parseConclusionDraftJson(text) {
  if (typeof text !== 'string') throw new Error('Файл не является текстом JSON.');
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  const unfenced = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced);
  } catch {
    throw new Error('Файл не является корректным JSON. Проверьте, что файл содержит данные заключения, а не текст или таблицу.');
  }
}

export function normalizeConclusionDraft(input) {
  const parsed = Array.isArray(input) ? { fields: input } : input;
  if (!isObject(parsed)) throw new Error('JSON должен содержать объект с данными заключения.');
  const fields = findFieldSource(parsed);
  const values = {};
  for (const [key, rawValue] of Object.entries(fields)) {
    // Exclude only indexed table cells. Scalar fields beginning with `resource_`
    // (resource_working_pressure/resource_calculated_by) belong to Section 3
    // and must remain ordinary form values for both the React UI and PDF export.
    if (/^(?:defect_\d+_|valve_\d+_|uzt_shared_\d+_|uzt_flat_\d+_|resource_(?:section|kz|thickness|base_velocity|k1|k2|factor|velocity|years)_\d+$|exclude_material_page_\d+$)/.test(key)) continue;
    const value = key.endsWith('_date') || key === 'next_diagnostic' ? dateValue(rawValue) : scalar(rawValue);
    values[key] = ['gas_status', 'leak_status', 'finding_status'].includes(key) ? selectValue(key, value) : value;
  }
  normalizeMissingDateFlags(values);

  const defects = normalizeDefectRows(parsed, fields);
  const valves = normalizeValveRows(parsed, fields);
  const uztShared = normalizeUztShared(parsed, fields);
  const uztFlat = normalizeUztFlat(parsed, fields);
  const resource = normalizeResource(parsed, fields);

  const suppliedConfirmations = [parsed.confirmations, parsed.data?.confirmations, parsed.form?.confirmations]
    .find(isObject) || {};
  const confirmations = { ...suppliedConfirmations };
  for (const key of ['photo_content_confirm', 'template_review_confirm']) {
    if (fields[key] !== undefined) confirmations[key] = booleanValue(fields[key]);
  }

  const materials = {};
  const suppliedMaterials = [parsed.materials, parsed.data?.materials, parsed.form?.materials].find(isObject) || {};
  for (const page of MATERIAL_PAGES) {
    materials[page] = {
      file: null,
      exclude: (suppliedMaterials[String(page)]?.exclude === true || suppliedMaterials[String(page)]?.exclude === '1') || fields[`exclude_material_page_${page}`] === '1',
    };
  }

  const importedCount = Object.values(values).filter(value => String(value || '').trim()).length
    + defects.filter(row => row.enabled || row.location || row.text || row.recommendation).length
    + valves.filter(row => row.enabled || Object.values(row.fields).some(Boolean)).length
    + uztShared.filter(row => Object.values(row).some(Boolean)).length
    + uztFlat.filter(row => Object.values(row).some(Boolean)).length
    + resource.filter(row => Object.values(row).some(Boolean)).length
    + Object.values(confirmations).filter(Boolean).length
    + Object.values(materials).filter(item => item.exclude).length;

  if (!importedCount) {
    throw new Error('Файл прочитан, но в нём не найдено заполненных полей заключения. Поддерживаются JSON текущего формата и старый формат vdgo-report-v1 с объектом fields.');
  }

  const format = parsed.schema === 'vdgo-report-v1' ? 'legacy-vdgo' : (parsed.version === 1 ? 'profit-draft-v1' : 'prepared-json');
  return { values, defects, valves, uztShared, uztFlat, resource, confirmations, materials, importedCount, format };
}
