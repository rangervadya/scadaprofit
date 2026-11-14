import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Button } from './ui';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * Last line of defence for render failures.
 *
 * Without a boundary a single bad API payload (for example a scheme whose
 * `nodes` is missing) unmounts the whole SPA and leaves a white page. The
 * fallback keeps the shell reachable and records the error once so it can be
 * correlated with the browser console.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('Frontend render failed', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="error-screen" role="alert">
        <h1>Раздел не отрисовался</h1>
        <p className="muted">
          Не удалось отобразить этот экран. Обнови страницу — данные на сервере не затронуты.
        </p>
        <pre className="error-screen__detail">{error.message}</pre>
        <div className="row">
          <Button variant="primary" onClick={() => window.location.reload()}>
            Обновить страницу
          </Button>
          <Button onClick={this.reset}>Попробовать снова</Button>
        </div>
      </div>
    );
  }
}