import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Icon } from './Icon';

/** Toasts beyond this count are dropped instead of stacking off-screen. */
const MAX_TOASTS = 4;

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

export function Button({
  variant = 'default',
  size,
  block,
  icon,
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  block?: boolean;
  icon?: string;
}) {
  return (
    <button
      type="button"
      className={cx(
        'btn',
        variant === 'primary' && 'btn--primary',
        variant === 'ghost' && 'btn--ghost',
        variant === 'danger' && 'btn--danger',
        size === 'sm' && 'btn--sm',
        block && 'btn--block',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

export function Badge({
  children,
  tone = 'default',
  plain,
}: {
  children: ReactNode;
  tone?: 'default' | 'success' | 'warn' | 'danger' | 'info' | 'brand';
  plain?: boolean;
}) {
  return (
    <span className={cx('badge', tone !== 'default' && `badge--${tone}`, plain && 'badge--plain')}>{children}</span>
  );
}

export function Spinner({ light, label }: { light?: boolean; label?: string }) {
  return <span className={cx('spinner', light && 'spinner--light')} role="status" aria-label={label || 'Загрузка'} />;
}

export function Loading({ children = 'Загрузка…' }: { children?: ReactNode }) {
  return (
    <div className="loading">
      <Spinner />
      <span>{children}</span>
    </div>
  );
}

export function Empty({
  icon = 'info',
  title,
  children,
  action,
}: {
  icon?: string;
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__icon">
        <Icon name={icon} />
      </span>
      {title ? <p className="empty__title">{title}</p> : null}
      {children ? <p style={{ maxWidth: 380 }}>{children}</p> : null}
      {action}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
  footer,
  flush,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return (
    <section className={cx('card', className)}>
      {title || actions ? (
        <header className="card__header">
          <h3 className="card__title">{title}</h3>
          {actions ? <div className="row">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('card__body', flush && 'card__body--flush')}>{children}</div>
      {footer ? <footer className="card__footer">{footer}</footer> : null}
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  required,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label className="field">
      <span className="field__label">
        {label}
        {required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  hint,
}: {
  label: ReactNode;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className={cx('check')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} />
      <span>
        {label}
        {hint ? <span className="field__hint" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
    </label>
  );
}

export function Modal({
  title,
  children,
  footer,
  onClose,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={event => event.target === event.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__header">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" icon="x" aria-label="Закрыть" onClick={onClose} />
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  );
}

type ToastTone = 'success' | 'error' | 'info';
type Toast = { id: number; tone: ToastTone; message: string };

type ToastContextValue = {
  notify: (message: string, tone?: ToastTone) => void;
};

const ToastContext = createContext<ToastContextValue>({ notify: () => {} });

export function useToast(): ToastContextValue {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts(current => current.filter(item => item.id !== id));
  }, []);

  useEffect(() => () => {
    for (const timer of timers.current.values()) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  const notify = useCallback((message: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    // Errors carry a request id and are longer to read, so they stay up longer
    // and are never dropped silently when many arrive at once.
    const ttl = tone === 'error' ? 9000 : 5200;
    setToasts(current => {
      const next = [...current, { id, tone, message }];
      const overflow = next.slice(0, Math.max(0, next.length - MAX_TOASTS));
      for (const dropped of overflow) {
        const timer = timers.current.get(dropped.id);
        if (timer !== undefined) {
          window.clearTimeout(timer);
          timers.current.delete(dropped.id);
        }
      }
      return next.slice(-MAX_TOASTS);
    });
    timers.current.set(id, window.setTimeout(() => dismiss(id), ttl));
  }, [dismiss]);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={cx('toast', `toast--${toast.tone}`)}
            role={toast.tone === 'error' ? 'alert' : 'status'}
          >
            <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'info'} />
            <span className="toast__text">{toast.message}</span>
            <button type="button" className="toast__close" aria-label="Закрыть уведомление" onClick={() => dismiss(toast.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function Confirm({
  title,
  message,
  confirmLabel = 'Подтвердить',
  danger,
  onConfirm,
  onClose,
  busy,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>Отмена</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy ? <Spinner light={!danger} /> : null}
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}