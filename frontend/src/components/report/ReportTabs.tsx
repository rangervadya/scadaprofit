import type { ReportSection } from '../../types';

interface ReportTabsProps {
  sections: ReportSection[];
  activeSection: string;
  progress: Record<string, { filled: number; total: number }>;
  onSectionClick: (id: string) => void;
}

export function ReportTabs({
  sections,
  activeSection,
  progress,
  onSectionClick,
}: ReportTabsProps) {
  return (
    <nav className="report-tabs" aria-label="Разделы заключения">
      {sections.map(([id, label], index) => (
        <button
          key={id}
          aria-current={activeSection === id ? 'location' : undefined}
          onClick={() => onSectionClick(id)}
        >
          <span>{index + 1}</span>
          <div>
            {label}
            {progress[id]?.total > 0 && (
              <small className="section-progress" data-complete={progress[id].filled === progress[id].total}>
                {progress[id].filled}/{progress[id].total}
                <span className="visually-hidden"> обязательных полей заполнено</span>
              </small>
            )}
          </div>
        </button>
      ))}
    </nav>
  );
}
