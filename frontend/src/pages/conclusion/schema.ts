export type FieldType = 'text' | 'textarea' | 'number' | 'date' | 'select';

export type FieldDef = {
  name: string;
  label: string;
  type?: FieldType;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  full?: boolean;
};

export type SectionKind = 'fields' | 'defects' | 'valves' | 'uzt' | 'photos' | 'materials';

export type SectionDef = {
  id: string;
  num: string;
  title: string;
  note?: string;
  kind: SectionKind;
  fields?: FieldDef[];
};

export const DEFECTS = [
  { id: '1.1', location: 'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 1, 6, 9, 10.', defect: 'Нарушение технологии заделки футляра (СП 42-101-2003 (п.6.7)).', recommendation: 'Пространство между газопроводом и футляром на всю его длину необходимо заделывать просмоленной паклей, резиновыми втулками или другим эластичными материалами.' },
  { id: '1.2', location: 'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 3, 4, 7, 8, 10.', defect: 'Техническое обслуживание запорной арматуры не проведено (Постановление Правительства РФ от 14 мая 2013 г. N 410).', recommendation: 'Провести техническое обслуживание запорной арматуры.' },
  { id: '1.3', location: 'Подъезд №1, условный проход Ду25, смотри схему контроля, фото 4, 7.', defect: 'Касание газопровода со строительной конструкцией (СП 42-101-2003 (п.6.7)).', recommendation: 'При прокладке газопроводов через конструкции зданий и сооружений газопроводы следует заключать в футляр. Края футляров должны быть на одном уровне с поверхностями пересекаемых конструкций.' },
  { id: '1.4', location: 'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 1-5, 7.', defect: 'Провода и кабели вблизи газопровода (СП 42-101-2003 (п.6.6); ПУЭ (п.2.1.56, п.2.1.57)).', recommendation: 'При пересечении незащищенных и защищенных проводов и кабелей с трубопроводами расстояния между ними в свету должны быть не менее 50 мм, а с трубопроводами, содержащими горючие или легковоспламеняющиеся жидкости и газы, — не менее 100 мм.' },
  { id: '1.5', location: 'Подъезд №1, условный проход Ду25, смотри схему контроля, фото 7.', defect: 'Касание газопровода со строительной конструкцией СП 42-101-2003 (п.10.216).', recommendation: 'Обеспечить расстояние между газопроводом и строительной конструкцией не менее радиуса трубы.' },
  { id: '1.6', location: 'Подъезд №1, условный проход Ду32, 25, смотри схему контроля, фото 2, 5.', defect: 'Газопровод вблизи строительной конструкции СП 42-101-2003 (п.10.216).', recommendation: 'Обеспечить расстояние между газопроводом и строительной конструкцией не менее радиуса трубы.' },
  { id: '1.7', location: 'Подъезд №2, условный проход Ду32, смотри схему контроля, фото 12, 15.', defect: 'Нарушение технологии заделки футляра (СП 42-101-2003 (п.6.7)).', recommendation: 'Пространство между газопроводом и футляром на всю его длину необходимо заделывать просмоленной паклей, резиновыми втулками или другим эластичными материалами.' },
  { id: '1.8', location: 'Подъезд №2, условный проход Ду25, смотри схему контроля, фото 11, 13, 14, 17.', defect: 'Техническое обслуживание запорной арматуры не проведено (Постановление Правительства РФ от 14 мая 2013 г. N 410).', recommendation: 'Провести техническое обслуживание запорной арматуры.' },
  { id: '1.9', location: 'Подъезд №2, условный проход Ду32, 25, смотри схему контроля, фото 13, 14, 17, 18, 19.', defect: 'Касание газопровода со строительной конструкцией (СП 42-101-2003 (п.6.7)).', recommendation: 'При прокладке газопроводов через конструкции зданий и сооружений газопроводы следует заключать в футляр. Края футляров должны быть на одном уровне с поверхностями пересекаемых конструкций.' },
  { id: '1.10', location: 'Подъезд №2, условный проход Ду32, 25, смотри схему контроля, фото 11, 14, 16, 19, 20.', defect: 'Провода и кабели вблизи газопровода (СП 42-101-2003 (п.6.6); ПУЭ (п.2.1.56, п.2.1.57)).', recommendation: 'При пересечении незащищенных и защищенных проводов и кабелей с трубопроводами расстояния между ними в свету должны быть не менее 50 мм, а с трубопроводами, содержащими горючие или легковоспламеняющиеся жидкости и газы, — не менее 100 мм.' },
  { id: '1.11', location: 'Подъезд №2, условный проход Ду32, 25, смотри схему контроля, фото 16, 17, 20.', defect: 'Газопровод вблизи строительной конструкции СП 42-101-2003 (п.10.216).', recommendation: 'Обеспечить расстояние между газопроводом и строительной конструкцией не менее радиуса трубы.' },
];

export const VALVE_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'location', label: 'Место установки', placeholder: 'Например, подъезд № 1' },
  { key: 'diameter', label: 'Условный проход Ду, мм', placeholder: '32' },
  { key: 'type', label: 'Тип запорной арматуры', placeholder: 'Кран шаровый' },
  { key: 'surface', label: 'Состояние поверхности', placeholder: 'Удовлетворительно' },
  { key: 'outer', label: 'Наружная герметичность', placeholder: 'Герметична / негерметична / нет данных' },
  { key: 'inner', label: 'Внутренняя герметичность', placeholder: 'Герметична / негерметична / нет данных' },
  { key: 'function', label: 'Проверка работоспособности', placeholder: 'Исправна / неисправна / нет данных' },
  { key: 'conclusion', label: 'Заключение', placeholder: 'Допускается / не допускается / обслуживание' },
];

export const RESOURCE_LABELS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: 'section', label: 'Участок для расчёта', placeholder: 'Например: 1' },
  { key: 'kz', label: 'Коэффициент запаса Кз', placeholder: '0,45' },
  { key: 'thickness', label: 'Минимальная толщина стенки, мм', placeholder: 'Фактический замер' },
  { key: 'base_velocity', label: 'Базовая скорость коррозии, мм/год', placeholder: 'Значение из методики' },
  { key: 'k1', label: 'Коэффициент К1', placeholder: 'Расчётное значение' },
  { key: 'k2', label: 'Коэффициент К2', placeholder: 'Расчётное значение' },
  { key: 'factor', label: 'Ку.з. — коэффициент условий эксплуатации', placeholder: 'Результат расчёта' },
  { key: 'velocity', label: 'Vу.к. — условная скорость коррозии', placeholder: 'Результат расчёта' },
  { key: 'years', label: 'Т — ресурс по участку, лет', placeholder: 'Результат расчёта' },
];

export const MATERIAL_PAGES: Array<{ page: number; title: string; optional: boolean }> = [
  { page: 16, title: 'Приложение 2. Схема неразрушающего контроля — подъезд 1', optional: true },
  { page: 17, title: 'Приложение 2. Схема неразрушающего контроля — подъезд 2', optional: true },
  { page: 31, title: 'Приложение 6. Протокол контроля влажности', optional: false },
  { page: 32, title: 'Приложение 7. Протокол контроля контакта «труба-футляр»', optional: false },
  { page: 33, title: 'Приложение 8. Визуальный и измерительный контроль — лист 1', optional: false },
  { page: 34, title: 'Приложение 8. Визуальный и измерительный контроль — лист 2', optional: false },
  { page: 35, title: 'Приложение 9. Протокол контроля на герметичность', optional: false },
  { page: 36, title: 'Приложение 10. Акт пневматического испытания газопровода', optional: false },
  { page: 41, title: 'Приложение 13. Копии удостоверений специалистов', optional: false },
  { page: 42, title: 'Приложение 13. Продолжение. Документы о квалификации', optional: false },
  { page: 43, title: 'Приложение 13. Продолжение. Дополнительные документы', optional: false },
  { page: 44, title: 'Приложение 14. Лист учёта толщины стенки при УЗТ', optional: false },
  { page: 45, title: 'Приложение 15. Акт отсутствия доступа — лист 1', optional: false },
  { page: 46, title: 'Приложение 16. Лист учёта толщины стенки при УЗТ', optional: false },
  { page: 47, title: 'Приложение 17. Акт отсутствия доступа — лист 2', optional: false },
];

const gasOptions = [
  { value: '', label: '— Выберите результат —' },
  { value: 'not_detected', label: 'Не обнаружено' },
  { value: 'detected', label: 'Обнаружено' },
  { value: 'not_checked', label: 'Проверка не проводилась' },
];

export const SECTIONS: SectionDef[] = [
  {
    id: 'main',
    num: '1',
    title: 'Основные данные',
    kind: 'fields',
    fields: [
      { name: 'report_number', label: 'Номер заключения', required: true },
      { name: 'report_date', label: 'Дата заключения', type: 'date', required: true, hint: 'ДД.ММ.ГГГГ. Год отчёта подставится автоматически.' },
      { name: 'address', label: 'Адрес объекта', required: true, full: true },
      { name: 'report_year', label: 'Год отчёта', type: 'number', required: true },
      { name: 'next_diagnostic', label: 'Дата следующего технического диагностирования', type: 'date', required: true, hint: 'ДД.ММ.ГГГГ; в PDF будет дата словами.' },
    ],
  },
  {
    id: 'people',
    num: '2',
    title: 'Заказчик и специалисты',
    kind: 'fields',
    fields: [
      { name: 'customer', label: 'Заказчик (сокращённо)', required: true, placeholder: 'Например, ООО «Организация»' },
      { name: 'customer_legal_name', label: 'Заказчик (полное наименование)', required: true },
      { name: 'customer_address', label: 'Адрес заказчика', required: true },
      { name: 'customer_phone', label: 'Телефон заказчика', required: true },
      { name: 'customer_director', label: 'Директор заказчика (инициалы)', required: true },
      { name: 'executor', label: 'Исполнитель (краткое наименование)', required: true },
      { name: 'executor_legal_name', label: 'Полное наименование исполнителя', required: true },
      { name: 'executor_address', label: 'Юридический адрес исполнителя', required: true },
      { name: 'executor_phone', label: 'Телефон исполнителя', required: true },
      { name: 'general_director', label: 'Генеральный директор (инициалы)', required: true },
      { name: 'general_director_full', label: 'Генеральный директор (ФИО)', required: true },
      { name: 'specialist', label: 'Специалист II уровня (инициалы)', required: true },
      { name: 'specialist_full', label: 'Специалист II уровня (ФИО)', required: true },
      { name: 'technician', label: 'Слесарь по ЭРГО (инициалы)', required: true },
      { name: 'technician_full', label: 'Слесарь по ЭРГО (ФИО)', required: true },
      { name: 'work_group_order_number', label: 'Номер приказа о назначении рабочей группы', required: true },
      { name: 'work_group_order_date', label: 'Дата приказа о назначении рабочей группы', type: 'date', required: true },
      { name: 'technician_certificate', label: 'Документ о квалификации слесаря (номер, дата, учебный центр)', required: true, full: true },
      { name: 'specialist_certificate', label: 'Полные данные удостоверения специалиста (уровень, номер, дата, кто выдал)', required: true, full: true },
      { name: 'specialist_additional_certificate', label: 'Дополнительная квалификация в строке специалиста', required: true, full: true },
    ],
  },
  {
    id: 'calc',
    num: '3',
    title: 'Данные УЗТ и остаточный ресурс',
    note: 'Текстовые результаты должны быть краткими и точно соответствовать фактическому протоколу.',
    kind: 'fields',
    fields: [
      { name: 'pipe_length', label: 'Подтверждённая протяжённость, м', required: true },
      { name: 'pressure', label: 'Разрешённое давление, МПа', required: true },
      { name: 'min_thickness', label: 'Минимальная толщина стенки, мм', required: true },
      { name: 'max_thickness', label: 'Максимальная толщина стенки, мм', required: true },
      { name: 'remaining_life_years', label: 'Итоговый остаточный ресурс', required: true, placeholder: 'Например, 3 года по подтверждённому расчёту' },
      { name: 'uzt_device_model', label: 'Тип / модель толщиномера УЗТ', required: true, placeholder: 'По фактическому прибору, без данных — н.д.' },
      { name: 'uzt_device_serial', label: 'Заводской номер толщиномера УЗТ', required: true },
      { name: 'uzt_calibration_date', label: 'Дата поверки толщиномера УЗТ', type: 'date', required: true },
      { name: 'measurement_year', label: 'Год проведения замеров толщины стенок', type: 'number', required: true },
      { name: 'uk_device_model', label: 'Дефектоскоп УК — модель (Приложение 5)', required: true, placeholder: 'Фактическая модель или «не применялся»' },
      { name: 'uk_device_serial', label: 'Дефектоскоп УК — заводской номер', required: true, placeholder: 'По прибору или «н.д.»' },
      { name: 'uk_calibration_date', label: 'Дефектоскоп УК — дата поверки', type: 'date', required: true },
      { name: 'uk_joint_number', label: 'Приложение 5 — номер сварного соединения / участка', required: true },
      { name: 'uk_material_description', label: 'Приложение 5 — материал, диаметр и толщина', required: true },
      { name: 'uk_sensitivity', label: 'Приложение 5 — предельная чувствительность', required: true },
      { name: 'uk_defect_description', label: 'Приложение 5 — фактическое описание дефектов', required: true },
      { name: 'uk_result', label: 'Приложение 5 — оценка результатов контроля', required: true, placeholder: 'Кратко: годен / не годен' },
      { name: 'uk_accessibility_percent', label: 'Приложение 5 — доступность контроля, %', required: true, placeholder: 'Число от 0 до 100' },
      { name: 'resource_working_pressure', label: 'Рабочее давление в расчёте Приложения 11', required: true },
      { name: 'resource_calculated_by', label: 'ФИО лица, выполнившего расчёт остаточного ресурса', required: true },
    ],
  },
  { id: 'uzt', num: '4', title: 'Таблицы УЗТ и расчёт ресурса', note: 'Исходные значения очищаются. Для отсутствующих данных введите «н.д.».', kind: 'uzt' },
  { id: 'defects', num: '5', title: 'Дефекты', note: 'Включайте только фактически выявленные дефекты — они попадут в раздел 6.1 и Приложение 12.', kind: 'defects' },
  {
    id: 'valves',
    num: '6',
    title: 'Арматура и результаты проверок',
    kind: 'valves',
    fields: [
      { name: 'conclusion_text', label: 'Вывод по результатам обследования арматуры (раздел 5.4)', type: 'textarea', required: true, full: true },
      { name: 'gas_status', label: 'Проверка загазованности помещений', type: 'select', required: true, options: gasOptions },
      { name: 'leak_status', label: 'Проверка утечек на внутренних и вводных газопроводах', type: 'select', required: true, options: gasOptions },
      { name: 'leak_location', label: 'Место утечки (требуется, если выявлена)' },
      { name: 'leak_owner', label: 'Ф.И.О. собственника / помещение (если выявлена)' },
    ],
  },
  { id: 'photos', num: '7', title: 'Фотографии объекта', note: 'Только актуальные фото оборудования, трубопроводов, арматуры и выявленных дефектов. SCADA, экраны, удостоверения и акты загружать нельзя.', kind: 'photos' },
  { id: 'materials', num: '8', title: 'Актуальные схемы, удостоверения и акты', note: 'Для каждой страницы загрузите актуальный одностраничный PDF или изображение либо явно отметьте «Не включать».', kind: 'materials' },
  {
    id: 'test',
    num: '9',
    title: 'Проверка герметичности',
    kind: 'fields',
    fields: [
      { name: 'test_result', label: 'Результат проверки герметичности', type: 'textarea', required: true, full: true },
      { name: 'test_pressure', label: 'Испытательное давление', required: true },
      {
        name: 'finding_status',
        label: 'Классификация результатов',
        type: 'select',
        required: true,
        options: [
          { value: '', label: '— Выберите по фактическим результатам —' },
          { value: 'defects', label: 'Выявлены неисправности' },
          { value: 'none', label: 'Неисправности не выявлены' },
        ],
      },
    ],
  },
];

export const CONFIRM_FIELDS = {
  photo_content_confirm:
    'Подтверждаю, что в фотослоты загружены только фотографии текущего объекта; SCADA/экраны, работники, удостоверения и акты сюда не загружены.',
  template_review_confirm:
    'Я проверил все страницы итогового документа. Схема Приложения 2 проверена; актуальные вложения загружены или страницы явно исключены; в фотослоты не загружены SCADA/экраны, удостоверения и акты.',
};

export const UZT_SHARED_ROWS = 24;
export const UZT_FLAT_ROWS = 42;
export const RESOURCE_ROWS = 4;
export const MAX_MATERIAL_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PHOTO_UPLOAD_BYTES = 15 * 1024 * 1024;