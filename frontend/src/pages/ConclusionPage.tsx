import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Empty, Loading, Spinner, useToast } from '../components/ui';
import { buildDefectPhotos, buildWorkforceSchemes, conclusionApi, workforceApi } from '../lib/api';
import { formatDateTime } from '../lib/format';
import type { ConclusionContext } from '../lib/types';
import { SectionRenderer } from './conclusion/ConclusionSections';
import { SECTIONS } from './conclusion/schema';
import { useConclusionForm } from './conclusion/useConclusionForm';

type Busy = null | 'pdf' | 'docx' | 'preview';

export function ConclusionPage() {
  const [params] = useSearchParams();
  const taskId = params.get('task');
  const reportId = params.get('report');
  const defectId = params.get('defectReport');
  const form = useConclusionForm(taskId);
  const { notify } = useToast();

  const [context, setContext] = useState<ConclusionContext | null>(null);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(Boolean(taskId));
  const [busy, setBusy] = useState<Busy>(null);
  const [activeSection, setActiveSection] = useState('main');
  const loadRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!taskId) {
      setContext(null);
      setContextLoading(false);
      return;
    }
    setContextLoading(true);
    setContextError(null);
    workforceApi
      .conclusionContext({ task: taskId, report: reportId || undefined, defectReport: defectId || undefined })
      .then(data => setContext({ task: data.task, reports: data.reports || [], defectReports: data.defectReports || [] }))
      .catch(cause => {
        setContext(null);
        setContextError(cause instanceof Error ? cause.message : 'Не удалось загрузить материалы задания');
      })
      .finally(() => setContextLoading(false));
  }, [taskId, reportId, defectId]);

  useEffect(() => {
    if (!context) return;
    // Accepted fitter defect reports become editable rows in the existing defect table.
    form.applyWorkforceDefects(context.defectReports || [], context.task.id);
    // Keep the existing conclusion template and bind this task's accepted materials
    // to the same address. This prevents importing a draft for another house and
    // accidentally generating a mixed-address document.
    const address = `${context.task.street}, дом ${context.task.address}`;
    if (form.values.address !== address) form.setField('address', address);
  }, [context, form.applyWorkforceDefects, form.setField]);

  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>('.form-section');
    if (!sections.length) return;
    const observer = new IntersectionObserver(
      entries => {
        const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActiveSection(visible.target.id);
      },
      { rootMargin: '-120px 0px -60% 0px', threshold: 0 },
    );
    sections.forEach(section => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  const materials = useMemo(() => {
    const reports = context?.reports || [];
    const defects = context?.defectReports || [];
    const acceptedSchemes = reports.filter(report => report.status === 'accepted' && (report.schemeSvgUrl || report.manualCadProjectId || report.schemeJobId));
    const acceptedDefects = defects.filter(report => report.status === 'accepted');
    return {
      schemes: acceptedSchemes,
      defects: acceptedDefects,
      photos: acceptedDefects.reduce((sum, report) => sum + (report.photos || []).length, 0),
      ready: reports.every(report => report.status === 'accepted' && Boolean(report.schemeSvgUrl || report.manualCadProjectId || report.schemeJobId))
        && defects.every(report => report.status === 'accepted' && (report.photos || []).length > 0),
    };
  }, [context]);

  const downloadDraft = () => {
    const blob = new Blob([form.exportDraft()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `conclusion-draft-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    notify('Черновик сохранён в JSON', 'success');
  };

  const uploadDraft = async (file: File) => {
    try {
      const imported = form.importDraft(await file.text());
      if (context) {
        form.applyWorkforceDefects(context.defectReports || [], context.task.id);
        form.setField('address', `${context.task.street}, дом ${context.task.address}`);
      }
      const formatLabel = imported.format === 'legacy-vdgo' ? 'старый формат ВДГО' : 'формат заключения';
      notify(`JSON импортирован (${formatLabel}): заполнено ${imported.importedCount} полей и строк`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось прочитать файл', 'error');
    }
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const format = (submitter?.dataset.format as Busy) || 'pdf';
    if (format === 'preview') {
      await run('preview');
      return;
    }
    await run(format);
  };

  const run = async (mode: Busy) => {
    if (!mode) return;
    if (form.workforceDefectOverflow > 0) {
      notify(`В форме осталось только 11 строк дефектов. Не помещается ещё ${form.workforceDefectOverflow} записи слесарей — объедините однотипные дефекты или увеличьте число строк вручную.`, 'error');
      return;
    }
    if (taskId && context) {
      if (!materials.schemes.length && !materials.defects.length) {
        notify('Формирование заблокировано: к заданию не добавлены схемы и фотографии дефектов', 'error');
        return;
      }
      if (!materials.ready) {
        notify('Дождитесь готовности CAD-схем и фотографий дефектов', 'error');
        return;
      }
    }
    setBusy(mode);
    try {
      let schemes: Array<Record<string, string>> | null = null;
      let defectPhotos: File[] = [];
      if (taskId && context && materials.schemes.length + materials.defects.length > 0) {
        schemes = await buildWorkforceSchemes(materials.schemes);
        const prepared = await buildDefectPhotos(materials.defects);
        defectPhotos = prepared.map(item => item.file);
      }
      const formData = form.buildFormData(schemes, defectPhotos);
      if (mode === 'preview') await conclusionApi.preview(formData);
      else await conclusionApi.generate(formData, mode);
      notify(mode === 'preview' ? 'Предпросмотр PDF открыт' : mode === 'docx' ? 'Документ Word сформирован' : 'PDF сформирован', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось сформировать документ', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Документы</p>
          <div className="page__title">
            <h1>Техническое заключение ВДГО</h1>
            {context ? <Badge tone="brand">{context.task.street}, дом {context.task.address}</Badge> : null}
          </div>
          <p className="page__subtitle">
            Заполните данные объекта, проверьте приложения и сформируйте PDF или Word. Черновик автоматически
            сохраняется в браузере.
          </p>
        </div>
        <div className="page__actions">
          <Button icon="save" onClick={downloadDraft}>Сохранить JSON</Button>
          <Button icon="upload" onClick={() => loadRef.current?.click()}>Загрузить JSON</Button>
          <input
            ref={loadRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) void uploadDraft(file);
              event.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            icon="trash"
            onClick={() => {
              if (window.confirm('Очистить форму и сохранённый черновик?')) {
                form.reset();
                notify('Форма очищена');
              }
            }}
          >
            Очистить
          </Button>
        </div>
      </header>

      {taskId ? (
        contextLoading ? (
          <Card><Loading>Загружаем материалы задания…</Loading></Card>
        ) : contextError ? (
          <div className="alert alert--warn"><Icon name="alert" /><span>{contextError}. Форму можно заполнить вручную без материалов задания.</span></div>
        ) : context ? (
          <Card
            title={
              <>
                <Icon name="folder" />
                Материалы слесаря по адресу
              </>
            }
            actions={
              <Link to={`/team?task=${encodeURIComponent(context.task.id)}`} className="btn btn--ghost btn--sm">
                Открыть задание <Icon name="chevronRight" />
              </Link>
            }
          >
            {materials.schemes.length === 0 && materials.defects.length === 0 ? (
              <div className="alert alert--warn">
                <Icon name="alert" />
                <div>
                  <div style={{ fontWeight: 650, marginBottom: 4 }}>Вложений пока нет</div>
                  <div>
                    Формирование PDF или Word блокируется, пока приёмщик не добавит папку адреса.{' '}
                    <Link to={`/team?task=${encodeURIComponent(context.task.id)}`}>Перейти в приёмку</Link>.
                  </div>
                </div>
              </div>
            ) : (
              <div className="grid grid--2">
                <div className="stack stack--sm">
                  <div className="row row--between">
                    <h4>Схемы · {materials.schemes.length}</h4>
                    <Badge tone={materials.schemes.every(item => item.manualCadProjectId) ? 'success' : 'warn'}>
                      {materials.schemes.every(item => item.manualCadProjectId) ? 'CAD готов' : 'Готовится'}
                    </Badge>
                  </div>
                  {materials.schemes.length === 0 ? (
                    <p className="field__hint">Схемы ещё не добавлены.</p>
                  ) : (
                    materials.schemes.map(report => (
                      <div key={report.id} className="list-item">
                        <div className="list-item__main">
                          <span className="list-item__title">{report.street}, дом {report.address}</span>
                          <span className="list-item__meta">{report.userName} · {formatDateTime(report.submittedAt)}</span>
                        </div>
                        {report.manualCadProjectId ? (
                          <Badge tone="success">Принята</Badge>
                        ) : (
                          <Badge tone="warn">{report.schemeStatus || 'в обработке'}</Badge>
                        )}
                      </div>
                    ))
                  )}
                </div>
                <div className="stack stack--sm">
                  <div className="row row--between">
                    <h4>Дефекты · {materials.defects.length} комплектов, {materials.photos} фото</h4>
                    <Badge tone={materials.photos ? 'success' : 'warn'}>{materials.photos ? 'Фото есть' : 'Нет фото'}</Badge>
                  </div>
                  {materials.defects.length === 0 ? (
                    <p className="field__hint">Фотографии дефектов ещё не добавлены.</p>
                  ) : (
                    materials.defects.map(report => (
                      <div key={report.id} className="list-item">
                        <div className="list-item__main">
                          <span className="list-item__title">{report.userName} · {report.photos.length} фото</span>
                          <span className="list-item__meta">{report.note || 'Без комментария'}</span>
                        </div>
                        <Badge tone={report.status === 'accepted' ? 'success' : 'warn'}>{report.status === 'accepted' ? 'Принят' : 'На проверке'}</Badge>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
            {form.workforceDefectOverflow > 0 ? (
              <div className="alert alert--warn"><Icon name="alert" /><span>Не все описания дефектов помещаются в 11 строк раздела 6.1. Объедините однотипные записи или оформите продолжение вручную.</span></div>
            ) : null}
            <p className="field__hint" style={{ marginTop: 12 }}>
              Принятые описания дефектов уже подставлены в таблицу раздела 6.1 — заполните рекомендации по устранению.
              Фото дефектов пойдут в Приложение 3, а CAD-схемы — в Приложение 2 (ссылка на неё остаётся в пункте 5.1.3).
            </p>
          </Card>
        ) : (
          <Card><Empty icon="folder" title="Материалы задания недоступны">Проверьте ссылку или откройте задание в разделе «Команда».</Empty></Card>
        )
      ) : null}

      <div className="conclusion-layout">
        <nav className="conclusion-nav" aria-label="Разделы заключения">
          {SECTIONS.map(section => (
            <button
              key={section.id}
              type="button"
              className="conclusion-nav__link"
              aria-current={activeSection === section.id}
              onClick={() => document.getElementById(section.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            >
              <span className="conclusion-nav__num">{section.num}</span>
              {section.title}
            </button>
          ))}
          <button
            type="button"
            className="conclusion-nav__link"
            aria-current={activeSection === 'finish'}
            onClick={() => document.getElementById('finish')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            <span className="conclusion-nav__num">10</span>
            Контроль перед выпуском
          </button>
        </nav>

        <form id="conclusion-form" ref={formRef} className="stack" onSubmit={submit} noValidate={false}>
          {SECTIONS.map(section => (
            <SectionRenderer
              key={section.id}
              section={section}
              form={form}
              workforceDefectReports={materials.defects}
              workforceSchemes={materials.schemes}
            />
          ))}

          <section className="card form-section" id="finish">
            <header className="form-section__head">
              <span className="form-section__num">10</span>
              <div>
                <h2>Контроль перед выпуском</h2>
                <p className="form-section__note" style={{ marginTop: 4 }}>
                  Основная форма — 49 страниц; при более чем 20 фотографиях добавляются листы. Пустые фотолисты
                  удаляются автоматически.
                </p>
              </div>
            </header>
            <div className="form-section__body">
              <div className="pill-list">
                <Badge tone="brand" plain>49 основных страниц</Badge>
                <Badge plain>Дополнительные фотолисты</Badge>
                <Badge plain>11 строк дефектов</Badge>
                <Badge plain>Без автогенерации вывода</Badge>
                <Badge plain>Проверка обязательных полей</Badge>
              </div>
              <div className="alert alert--info">
                <Icon name="info" />
                <span>Перед отправкой просмотрите предпросмотр PDF. Схема Приложения 2 сохраняется и получает актуальный адрес.</span>
              </div>
            </div>
          </section>

          <div className="sticky-actions">
            <Button variant="ghost" icon="refresh" onClick={() => formRef.current?.reset()} disabled={Boolean(busy)}>Сбросить</Button>
            <span className="sticky-actions__spacer" />
            {busy ? <span className="row" style={{ color: 'var(--muted)', fontSize: 12 }}><Spinner /> Формируем…</span> : null}
            <Button icon="doc" type="submit" name="format" value="docx" data-format="docx" disabled={Boolean(busy)}>Word</Button>
            <Button icon="doc" type="submit" name="format" value="preview" data-format="preview" disabled={Boolean(busy)}>Проверить PDF</Button>
            <Button variant="primary" icon="download" type="submit" name="format" value="pdf" data-format="pdf" disabled={Boolean(busy)}>
              Сформировать PDF
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}