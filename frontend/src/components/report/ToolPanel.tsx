interface ToolPanelProps {
  file: File | null;
  zoom: number;
  onUploadClick: () => void;
  onPreviewBoth: () => void;
}

export function ToolPanel({ file, zoom, onUploadClick, onPreviewBoth }: ToolPanelProps) {
  return (
    <aside className="card tool-panel">
      <header>
        <h2>Инструменты</h2>
      </header>
      <a href="/manual-cad.html">↗　CAD-редактор</a>
      <a href="/">⌕　Распознавание</a>
      <button onClick={onPreviewBoth}>↔　Сравнение</button>
      <button onClick={onUploadClick}>↑　Загрузить эскиз</button>
      <div className="tool-properties">
        <h3>Чертёж</h3>
        <p>
          <i />{file ? 'Загруженный эскиз' : 'Демонстрационный'}
        </p>
        <p>Масштаб　{zoom}%</p>
      </div>
    </aside>
  );
}
