import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/ui/Icon';
import { Badge, Button, Card, Field, Loading, Spinner, useToast } from '../components/ui';
import { cadApi } from '../lib/api';
import type {
  ManualCadDimension,
  ManualCadJunction,
  ManualCadLabel,
  ManualCadProject,
  ManualCadSymbol,
} from '../lib/types';

type Tool = 'select' | 'pipe' | 'node' | 'label' | 'symbol' | 'dimension';
type Selection = { type: 'pipe' | 'symbol' | 'label' | 'dimension' | 'junction'; id: string } | null;

const SYMBOLS: Array<{ type: ManualCadSymbol['type']; label: string }> = [
  { type: 'valve', label: 'Кран' },
  { type: 'meter', label: 'Счётчик' },
  { type: 'regulator', label: 'Регулятор' },
  { type: 'consumer', label: 'Потребитель' },
  { type: 'riser', label: 'Стояк' },
  { type: 'filter', label: 'Фильтр' },
  { type: 'callout', label: 'Выноска' },
  { type: 'unknown', label: 'Прочее' },
];

const TOOLS: Array<{ id: Tool; label: string; icon: string }> = [
  { id: 'select', label: 'Выбор', icon: 'list' },
  { id: 'pipe', label: 'Труба', icon: 'route' },
  { id: 'node', label: 'Узел', icon: 'plus' },
  { id: 'label', label: 'Подпись', icon: 'doc' },
  { id: 'symbol', label: 'Символ', icon: 'sparkles' },
  { id: 'dimension', label: 'Размер', icon: 'settings' },
];

const uid = () => `m-${Math.random().toString(36).slice(2, 10)}`;
const round = (value: number) => Math.round(value * 10) / 10;

function SymbolShape({ symbol, selected, onPointerDown }: { symbol: ManualCadSymbol; selected: boolean; onPointerDown: (event: React.PointerEvent) => void }) {
  const scale = symbol.scale || 1;
  const rotation = symbol.rotation || 0;
  const common = {
    stroke: selected ? '#f59e0b' : '#1f4e8c',
    strokeWidth: selected ? 2.6 : 1.8,
    fill: 'none',
    vectorEffect: 'non-scaling-stroke' as const,
  };
  return (
    <g transform={`translate(${symbol.x} ${symbol.y}) rotate(${rotation}) scale(${scale})`} onPointerDown={onPointerDown} style={{ cursor: 'pointer' }}>
      <circle r="15" fill="transparent" />
      {symbol.type === 'valve' ? (
        <g {...common}>
          <path d="M-11 -7 L0 0 L-11 7 Z" />
          <path d="M11 -7 L0 0 L11 7 Z" />
          <path d="M0 0 L0 -12" />
        </g>
      ) : symbol.type === 'meter' ? (
        <g {...common}>
          <circle r="10" />
          <path d="M-4 3 L0 -5 L4 3" />
        </g>
      ) : symbol.type === 'regulator' ? (
        <g {...common}>
          <rect x="-10" y="-10" width="20" height="20" rx="2" />
          <path d="M-10 0 H10" />
        </g>
      ) : symbol.type === 'consumer' ? (
        <g {...common}>
          <rect x="-11" y="-8" width="22" height="16" rx="2" />
          <path d="M-5 0 H5" />
        </g>
      ) : symbol.type === 'riser' ? (
        <g {...common}>
          <path d="M0 11 V-9" />
          <path d="M-5 -4 L0 -11 L5 -4" />
        </g>
      ) : symbol.type === 'filter' ? (
        <g {...common}>
          <path d="M0 -11 L11 0 L0 11 L-11 0 Z" />
        </g>
      ) : symbol.type === 'callout' ? (
        <g {...common}>
          <circle r="8" />
          <circle r="2" fill={common.stroke} />
        </g>
      ) : (
        <g {...common} strokeDasharray="3 3">
          <circle r="10" />
        </g>
      )}
      {symbol.label ? (
        <text x="14" y="4" fontSize="10" fill="#0f172a" fontFamily="Inter, system-ui, sans-serif">{symbol.label}</text>
      ) : null}
    </g>
  );
}

export function CadEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { notify } = useToast();
  const svgRef = useRef<SVGSVGElement>(null);
  const [project, setProject] = useState<ManualCadProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [symbolType, setSymbolType] = useState<ManualCadSymbol['type']>('valve');
  const [selection, setSelection] = useState<Selection>(null);
  const [draft, setDraft] = useState<number[][]>([]);
  const [zoom, setZoom] = useState(1);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showSource, setShowSource] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const loadToken = useRef(0);
  const dragRef = useRef<{ type: Selection extends null ? never : NonNullable<Selection>['type']; id: string; start: { x: number; y: number }; original: unknown } | null>(null);

  const load = useCallback(async () => {
    const token = ++loadToken.current;
    setLoading(true);
    try {
      const result = await cadApi.get(id);
      if (token !== loadToken.current) return;
      setProject(result.project);
      setError(null);
    } catch (cause) {
      if (token !== loadToken.current) return;
      setError(cause instanceof Error ? cause.message : 'Не удалось открыть чертёж');
    } finally {
      if (token === loadToken.current) setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = useCallback((updater: (current: ManualCadProject) => ManualCadProject) => {
    setProject(current => (current ? updater(current) : current));
    setDirty(true);
  }, []);

  const save = useCallback(async () => {
    if (!project) return;
    setSaving(true);
    try {
      const result = await cadApi.save(project.id, project);
      setProject(result.project);
      setDirty(false);
      notify('Чертёж сохранён', 'success');
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось сохранить чертёж', 'error');
    } finally {
      setSaving(false);
    }
  }, [project, notify]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
      if (event.key === 'Escape') {
        setDraft([]);
        setSelection(null);
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        const target = event.target as HTMLElement;
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
        event.preventDefault();
        removeSelection();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const onLeave = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  const pointFromEvent = (event: React.PointerEvent | React.MouseEvent): { x: number; y: number } | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * (project?.width || 1600);
    const y = ((event.clientY - rect.top) / rect.height) * (project?.height || 1000);
    return { x: Math.max(0, Math.min(project?.width || 1600, round(x))), y: Math.max(0, Math.min(project?.height || 1000, round(y))) };
  };

  const removeSelection = () => {
    if (!selection) return;
    patch(current => {
      if (selection.type === 'pipe') return { ...current, pipes: current.pipes.filter(item => item.id !== selection.id) };
      if (selection.type === 'symbol') return { ...current, symbols: current.symbols.filter(item => item.id !== selection.id) };
      if (selection.type === 'label') return { ...current, labels: current.labels.filter(item => item.id !== selection.id) };
      if (selection.type === 'dimension') return { ...current, dimensions: current.dimensions.filter(item => item.id !== selection.id) };
      return { ...current, junctions: current.junctions.filter(item => item.id !== selection.id) };
    });
    setSelection(null);
  };

  const addAt = (point: { x: number; y: number }) => {
    if (tool === 'pipe' || tool === 'dimension') {
      setDraft(current => [...current, [point.x, point.y]]);
      return;
    }
    if (tool === 'node') {
      const junction: ManualCadJunction = { id: uid(), x: point.x, y: point.y, pipeIds: [] };
      patch(current => ({ ...current, junctions: [...current.junctions, junction] }));
      setSelection({ type: 'junction', id: junction.id });
      return;
    }
    if (tool === 'label') {
      const text = window.prompt('Текст подписи', 'Ду32');
      if (!text) return;
      const label: ManualCadLabel = { id: uid(), text, x: point.x, y: point.y, size: 12 };
      patch(current => ({ ...current, labels: [...current.labels, label] }));
      setSelection({ type: 'label', id: label.id });
      return;
    }
    if (tool === 'symbol') {
      const symbol: ManualCadSymbol = { id: uid(), type: symbolType, x: point.x, y: point.y, rotation: 0, label: '' };
      patch(current => ({ ...current, symbols: [...current.symbols, symbol] }));
      setSelection({ type: 'symbol', id: symbol.id });
    }
  };

  const finishDraft = () => {
    if (!project) return;
    if (tool === 'pipe' && draft.length >= 2) {
      const pipe = { id: uid(), name: ` Труба ${project.pipes.length + 1}`.trim(), diameter: 'Ду32', kind: 'pipe' as const, points: draft, visible: true };
      patch(current => ({ ...current, pipes: [...current.pipes, pipe] }));
      setSelection({ type: 'pipe', id: pipe.id });
      notify('Труба добавлена', 'success');
    }
    if (tool === 'dimension' && draft.length >= 2) {
      const text = window.prompt('Размер', `${Math.round(Math.hypot(draft[1][0] - draft[0][0], draft[1][1] - draft[0][1]))} мм`);
      if (text) {
        const dimension: ManualCadDimension = { id: uid(), a: draft[0], b: draft[1], text };
        patch(current => ({ ...current, dimensions: [...current.dimensions, dimension] }));
        setSelection({ type: 'dimension', id: dimension.id });
      }
    }
    setDraft([]);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    if (!project) return;
    if (event.button !== 0) return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (tool !== 'select') {
      addAt(point);
      return;
    }
    setSelection(null);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!dragRef.current) return;
    const point = pointFromEvent(event);
    if (!point) return;
    const drag = dragRef.current;
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (drag.type === 'symbol') {
      const original = drag.original as ManualCadSymbol;
      patch(current => ({ ...current, symbols: current.symbols.map(item => item.id === drag.id ? { ...item, x: round(original.x + dx), y: round(original.y + dy) } : item) }));
    } else if (drag.type === 'label') {
      const original = drag.original as ManualCadLabel;
      patch(current => ({ ...current, labels: current.labels.map(item => item.id === drag.id ? { ...item, x: round(original.x + dx), y: round(original.y + dy) } : item) }));
    } else if (drag.type === 'junction') {
      const original = drag.original as ManualCadJunction;
      patch(current => ({ ...current, junctions: current.junctions.map(item => item.id === drag.id ? { ...item, x: round(original.x + dx), y: round(original.y + dy) } : item) }));
    } else if (drag.type === 'pipe') {
      const original = drag.original as ManualCadProject['pipes'][number];
      patch(current => ({ ...current, pipes: current.pipes.map(item => item.id === drag.id ? { ...item, points: original.points.map(([x, y]) => [round(x + dx), round(y + dy)]) } : item) }));
    } else if (drag.type === 'dimension') {
      const original = drag.original as ManualCadDimension;
      patch(current => ({ ...current, dimensions: current.dimensions.map(item => item.id === drag.id ? { ...item, a: [round(original.a[0] + dx), round(original.a[1] + dy)], b: [round(original.b[0] + dx), round(original.b[1] + dy)] } : item) }));
    }
  };

  const startDrag = (event: React.PointerEvent, type: NonNullable<Selection>['type'], itemId: string, original: unknown) => {
    if (tool !== 'select') return;
    event.stopPropagation();
    setSelection({ type, id: itemId });
    const point = pointFromEvent(event);
    if (!point) return;
    dragRef.current = { type, id: itemId, start: point, original };
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const uploadSource = async (file: File) => {
    if (!project) return;
    const form = new FormData();
    form.append('source', file, file.name);
    form.append('width', String(project.width));
    form.append('height', String(project.height));
    try {
      const response = await fetch(`/api/manual-cad/projects/${encodeURIComponent(project.id)}/source`, { method: 'POST', body: form, credentials: 'same-origin' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error((payload as { error?: string }).error || `HTTP ${response.status}`);
      notify('Подложка загружена', 'success');
      await load();
    } catch (cause) {
      notify(cause instanceof Error ? cause.message : 'Не удалось загрузить подложку', 'error');
    }
  };

  const selectedPipe = selection?.type === 'pipe' ? project?.pipes.find(item => item.id === selection.id) : null;
  const selectedSymbol = selection?.type === 'symbol' ? project?.symbols.find(item => item.id === selection.id) : null;
  const selectedLabel = selection?.type === 'label' ? project?.labels.find(item => item.id === selection.id) : null;
  const selectedDimension = selection?.type === 'dimension' ? project?.dimensions.find(item => item.id === selection.id) : null;

  const canvasWidth = project ? Math.round(project.width * zoom) : 0;
  const canvasHeight = project ? Math.round(project.height * zoom) : 0;

  const counts = useMemo(() => project ? {
    pipes: project.pipes.length,
    symbols: project.symbols.length,
    labels: project.labels.length,
  } : null, [project]);

  if (loading) return <Card><Loading>Открываем чертёж…</Loading></Card>;
  if (error) {
    return (
      <div className="alert alert--danger">
        <Icon name="alert" />
        <div><div style={{ fontWeight: 650 }}>{error}</div><div className="row" style={{ marginTop: 8 }}><Button size="sm" onClick={() => void load()}>Повторить</Button><Link className="btn btn--sm" to="/cad">К списку</Link></div></div>
      </div>
    );
  }
  if (!project) return null;

  return (
    <>
      <nav className="breadcrumbs">
        <Link to="/cad">CAD-редактор</Link>
        <span>/</span>
        <span aria-current="page">{project.title}</span>
      </nav>
      <header className="page__header">
        <div>
          <p className="page__eyebrow">Чертёж</p>
          <h1 className="page__title">
            {project.title}
            {dirty ? <Badge tone="warn">Есть изменения</Badge> : <Badge tone="success">Сохранено</Badge>}
          </h1>
          <p className="page__subtitle">{project.siteAddress || 'Адрес не указан'} · труб: {counts?.pipes} · символов: {counts?.symbols}</p>
        </div>
        <div className="page__actions">
          <Button icon="save" variant="primary" onClick={() => void save()} disabled={saving}>{saving ? <Spinner light /> : null} Сохранить</Button>
          <a className="btn" href={`/api/manual-cad/projects/${encodeURIComponent(project.id)}/export.svg`}><Icon name="download" /> SVG</a>
          <a className="btn" href={`/api/manual-cad/projects/${encodeURIComponent(project.id)}/export.dxf`}><Icon name="download" /> DXF</a>
          <a className="btn" href={`/api/manual-cad/projects/${encodeURIComponent(project.id)}/preview.svg`} target="_blank" rel="noopener"><Icon name="external" /> Открыть</a>
        </div>
      </header>

      <div className="cad-shell">
        <aside className="cad-panel cad-panel--projects">
          <h4>Чертежи</h4>
          <Button size="sm" icon="plus" onClick={async () => {
            const title = window.prompt('Название чертежа', 'Новая схема');
            if (!title) return;
            try {
              const result = await cadApi.create(title);
              navigate(`/cad/${result.project.id}`);
            } catch (cause) {
              notify(cause instanceof Error ? cause.message : 'Ошибка', 'error');
            }
          }}>Новый</Button>
          <Link to="/cad" className="btn btn--sm btn--ghost">Все чертежи</Link>
          <div className="divider" />
          <h4>Лист</h4>
          <Field label="Формат">
            <select className="select select--sm" value={project.paperSize} onChange={event => patch(current => ({ ...current, paperSize: event.target.value as 'A4' | 'A3' }))}>
              <option value="A4">A4</option>
              <option value="A3">A3</option>
            </select>
          </Field>
          <Field label="Ориентация">
            <select className="select select--sm" value={project.page} onChange={event => patch(current => ({ ...current, page: event.target.value as 'portrait' | 'landscape' }))}>
              <option value="portrait">Книжная</option>
              <option value="landscape">Альбомная</option>
            </select>
          </Field>
          <Field label="Стиль">
            <select className="select select--sm" value={project.drawingStyle} onChange={event => patch(current => ({ ...current, drawingStyle: event.target.value as 'standard' | 'lpgcad-r1' }))}>
              <option value="standard">Стандартный</option>
              <option value="lpgcad-r1">ЛПГКАД R1</option>
            </select>
          </Field>
          <div className="divider" />
          <h4>Подложка</h4>
          <label className="btn btn--sm" style={{ cursor: 'pointer' }}>
            <Icon name="upload" /> Загрузить
            <input type="file" accept="image/jpeg,image/png,image/webp,image/tiff" hidden onChange={event => {
              const file = event.target.files?.[0];
              if (file) void uploadSource(file);
              event.target.value = '';
            }} />
          </label>
          {project.sourceUrl ? <Button size="sm" variant="ghost" onClick={() => setShowSource(value => !value)}>{showSource ? 'Скрыть подложку' : 'Показать подложку'}</Button> : <span className="field__hint">Подложка не загружена</span>}
          <div className="divider" />
          <h4>Слои</h4>
          <label className="check"><input type="checkbox" checked={showGrid} onChange={event => setShowGrid(event.target.checked)} /><span>Сетка</span></label>
        </aside>

        <div className="stack stack--sm" style={{ minWidth: 0 }}>
          <div className="cad-tools">
            {TOOLS.map(item => (
              <button key={item.id} type="button" className="cad-tool" aria-pressed={tool === item.id} onClick={() => { setTool(item.id); setDraft([]); }}>
                <Icon name={item.icon} /> {item.label}
              </button>
            ))}
            <span className="grow" />
            <Button size="sm" variant="ghost" icon="zoomOut" onClick={() => setZoom(value => Math.max(0.4, Math.round((value - 0.15) * 100) / 100))} />
            <Badge plain>{Math.round(zoom * 100)}%</Badge>
            <Button size="sm" variant="ghost" icon="zoomIn" onClick={() => setZoom(value => Math.min(3, Math.round((value + 0.15) * 100) / 100))} />
          </div>

          {tool === 'pipe' || tool === 'dimension' ? (
            <div className="alert alert--info">
              <Icon name="info" />
              <span>
                {tool === 'pipe' ? 'Кликайте по точкам трассы. Двойной клик или Enter завершает трубу.' : 'Укажите две точки. Введите размер после второй точки.'}
                {draft.length ? ` Точек: ${draft.length}.` : ''}
              </span>
              {draft.length ? <Button size="sm" onClick={finishDraft}>Завершить</Button> : null}
            </div>
          ) : null}

          {tool === 'symbol' ? (
            <div className="row row--wrap">
              {SYMBOLS.map(symbol => (
                <button key={symbol.type} type="button" className="cad-tool" aria-pressed={symbolType === symbol.type} onClick={() => setSymbolType(symbol.type)}>{symbol.label}</button>
              ))}
            </div>
          ) : null}

          <div className="cad-canvas-wrap">
            <svg
              ref={svgRef}
              className="cad-canvas"
              width={canvasWidth}
              height={canvasHeight}
              viewBox={`0 0 ${project.width} ${project.height}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerLeave={endDrag}
              onDoubleClick={finishDraft}
              role="application"
              aria-label="Холст чертежа"
            >
              <defs>
                <pattern id="cad-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#e6eaf2" strokeWidth="1" />
                </pattern>
              </defs>
              <rect width={project.width} height={project.height} fill="#fff" />
              {showGrid ? <rect width={project.width} height={project.height} fill="url(#cad-grid)" /> : null}
              {project.sourceUrl && showSource ? (
                <image href={project.sourceUrl} width={project.width} height={project.height} opacity="0.55" preserveAspectRatio="none" />
              ) : null}

              {project.pipes.map(pipe => (
                <g key={pipe.id} onPointerDown={event => startDrag(event, 'pipe', pipe.id, pipe)}>
                  <polyline
                    points={pipe.points.map(point => point.join(',')).join(' ')}
                    fill="none"
                    stroke={selection?.id === pipe.id ? '#f59e0b' : pipe.kind === 'branch' ? '#0f9d58' : pipe.kind === 'riser' ? '#d97706' : '#1f6feb'}
                    strokeWidth={selection?.id === pipe.id ? 4 : 2.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={pipe.visible === false ? 0.25 : 1}
                  />
                  {pipe.name ? (
                    <text x={pipe.points[0][0] + 8} y={pipe.points[0][1] - 8} fontSize="11" fill="#334155" fontFamily="Inter, system-ui, sans-serif">{pipe.name}</text>
                  ) : null}
                </g>
              ))}

              {project.junctions.map(junction => (
                <circle
                  key={junction.id}
                  cx={junction.x}
                  cy={junction.y}
                  r={selection?.id === junction.id ? 8 : 6}
                  fill={selection?.id === junction.id ? '#f59e0b' : '#fff'}
                  stroke="#1f4e8c"
                  strokeWidth="2"
                  onPointerDown={event => startDrag(event, 'junction', junction.id, junction)}
                  style={{ cursor: 'pointer' }}
                />
              ))}

              {project.symbols.map(symbol => (
                <SymbolShape
                  key={symbol.id}
                  symbol={symbol}
                  selected={selection?.id === symbol.id}
                  onPointerDown={event => startDrag(event, 'symbol', symbol.id, symbol)}
                />
              ))}

              {project.labels.map(label => (
                <text
                  key={label.id}
                  x={label.x}
                  y={label.y}
                  fontSize={label.size || 12}
                  fill={selection?.id === label.id ? '#b45309' : '#0f172a'}
                  fontFamily="Inter, system-ui, sans-serif"
                  textAnchor={label.anchor || 'start'}
                  transform={label.rotation ? `rotate(${label.rotation} ${label.x} ${label.y})` : undefined}
                  onPointerDown={event => startDrag(event, 'label', label.id, label)}
                  style={{ cursor: 'pointer' }}
                >
                  {label.text}
                </text>
              ))}

              {project.dimensions.map(dimension => {
                const [ax, ay] = dimension.a;
                const [bx, by] = dimension.b;
                return (
                  <g key={dimension.id} onPointerDown={event => startDrag(event, 'dimension', dimension.id, dimension)} style={{ cursor: 'pointer' }}>
                    <line x1={ax} y1={ay} x2={bx} y2={by} stroke={selection?.id === dimension.id ? '#f59e0b' : '#7c3aed'} strokeWidth="1.6" />
                    <line x1={ax - 5} y1={ay - 5} x2={ax + 5} y2={ay + 5} stroke="#7c3aed" strokeWidth="1.6" />
                    <line x1={bx - 5} y1={by - 5} x2={bx + 5} y2={by + 5} stroke="#7c3aed" strokeWidth="1.6" />
                    <text x={(ax + bx) / 2} y={(ay + by) / 2 - 6} fontSize="11" fill="#5b21b6" textAnchor="middle" fontFamily="Inter, system-ui, sans-serif">{dimension.text}</text>
                  </g>
                );
              })}

              {draft.length ? (
                <g>
                  <polyline points={draft.map(point => point.join(',')).join(' ')} fill="none" stroke="#f59e0b" strokeWidth="2" strokeDasharray="5 4" />
                  {draft.map((point, index) => <circle key={index} cx={point[0]} cy={point[1]} r="4" fill="#f59e0b" />)}
                </g>
              ) : null}
            </svg>
            {!project.sourceUrl && project.pipes.length === 0 ? (
              <div className="cad-empty" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
                Выберите инструмент «Труба» и постройте первый участок
              </div>
            ) : null}
          </div>
        </div>

        <aside className="cad-panel">
          <h4>Свойства</h4>
          {!selection ? <p className="field__hint">Выберите объект на холсте, чтобы изменить свойства.</p> : null}

          {selectedPipe ? (
            <div className="stack stack--sm">
              <Field label="Наименование">
                <input className="input input--sm" value={selectedPipe.name || ''} onChange={event => patch(current => ({ ...current, pipes: current.pipes.map(item => item.id === selectedPipe.id ? { ...item, name: event.target.value } : item) }))} />
              </Field>
              <Field label="Диаметр">
                <input className="input input--sm" value={selectedPipe.diameter || ''} onChange={event => patch(current => ({ ...current, pipes: current.pipes.map(item => item.id === selectedPipe.id ? { ...item, diameter: event.target.value } : item) }))} />
              </Field>
              <Field label="Тип">
                <select className="select select--sm" value={selectedPipe.kind || 'pipe'} onChange={event => patch(current => ({ ...current, pipes: current.pipes.map(item => item.id === selectedPipe.id ? { ...item, kind: event.target.value as 'pipe' | 'branch' | 'riser' } : item) }))}>
                  <option value="pipe">Труба</option>
                  <option value="branch">Отвод</option>
                  <option value="riser">Стояк</option>
                </select>
              </Field>
              <label className="check"><input type="checkbox" checked={selectedPipe.visible !== false} onChange={event => patch(current => ({ ...current, pipes: current.pipes.map(item => item.id === selectedPipe.id ? { ...item, visible: event.target.checked } : item) }))} /><span>Видима на печати</span></label>
              <Button size="sm" variant="danger" icon="trash" onClick={removeSelection}>Удалить трубу</Button>
            </div>
          ) : null}

          {selectedSymbol ? (
            <div className="stack stack--sm">
              <Field label="Тип">
                <select className="select select--sm" value={selectedSymbol.type} onChange={event => patch(current => ({ ...current, symbols: current.symbols.map(item => item.id === selectedSymbol.id ? { ...item, type: event.target.value as ManualCadSymbol['type'] } : item) }))}>
                  {SYMBOLS.map(symbol => <option key={symbol.type} value={symbol.type}>{symbol.label}</option>)}
                </select>
              </Field>
              <Field label="Подпись">
                <input className="input input--sm" value={selectedSymbol.label || ''} onChange={event => patch(current => ({ ...current, symbols: current.symbols.map(item => item.id === selectedSymbol.id ? { ...item, label: event.target.value } : item) }))} />
              </Field>
              <Field label={`Поворот: ${selectedSymbol.rotation || 0}°`}>
                <input className="input input--sm" type="range" min={0} max={345} step={15} value={selectedSymbol.rotation || 0} onChange={event => patch(current => ({ ...current, symbols: current.symbols.map(item => item.id === selectedSymbol.id ? { ...item, rotation: Number(event.target.value) } : item) }))} />
              </Field>
              <Button size="sm" variant="danger" icon="trash" onClick={removeSelection}>Удалить символ</Button>
            </div>
          ) : null}

          {selectedLabel ? (
            <div className="stack stack--sm">
              <Field label="Текст">
                <textarea className="textarea" value={selectedLabel.text} onChange={event => patch(current => ({ ...current, labels: current.labels.map(item => item.id === selectedLabel.id ? { ...item, text: event.target.value } : item) }))} />
              </Field>
              <Field label="Размер шрифта">
                <input className="input input--sm" type="number" min={6} max={48} value={selectedLabel.size || 12} onChange={event => patch(current => ({ ...current, labels: current.labels.map(item => item.id === selectedLabel.id ? { ...item, size: Number(event.target.value) } : item) }))} />
              </Field>
              <Button size="sm" variant="danger" icon="trash" onClick={removeSelection}>Удалить подпись</Button>
            </div>
          ) : null}

          {selectedDimension ? (
            <div className="stack stack--sm">
              <Field label="Размер">
                <input className="input input--sm" value={selectedDimension.text} onChange={event => patch(current => ({ ...current, dimensions: current.dimensions.map(item => item.id === selectedDimension.id ? { ...item, text: event.target.value } : item) }))} />
              </Field>
              <Button size="sm" variant="danger" icon="trash" onClick={removeSelection}>Удалить размер</Button>
            </div>
          ) : null}

          <div className="divider" />
          <h4>Штамп</h4>
          <div className="stack stack--sm">
            <Field label="Адрес объекта">
              <input className="input input--sm" value={project.siteAddress} onChange={event => patch(current => ({ ...current, siteAddress: event.target.value }))} />
            </Field>
            <Field label="Подъезд / вход">
              <input className="input input--sm" value={project.entrance} onChange={event => patch(current => ({ ...current, entrance: event.target.value }))} />
            </Field>
            <Field label="Исполнил">
              <input className="input input--sm" value={project.preparedBy} onChange={event => patch(current => ({ ...current, preparedBy: event.target.value }))} />
            </Field>
            <Field label="Проверил">
              <input className="input input--sm" value={project.schemeChecker} onChange={event => patch(current => ({ ...current, schemeChecker: event.target.value }))} />
            </Field>
            <Field label="Примечание">
              <textarea className="textarea" style={{ minHeight: 60 }} value={project.notes} onChange={event => patch(current => ({ ...current, notes: event.target.value }))} />
            </Field>
          </div>
        </aside>
      </div>
    </>
  );
}