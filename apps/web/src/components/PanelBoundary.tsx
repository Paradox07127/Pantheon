import { Component, type ReactNode } from 'react';
import { t } from '../i18n';
import { LoadError } from './LoadError';
import { Skeleton as LoadingBlock } from './Skeleton';
import './panel-boundary.css';

export function Failure({ error, onRetry }: { error: string; onRetry: () => void }) {
  return <LoadError message={error} onRetry={onRetry} />;
}

interface PanelBoundaryProps {
  /** Absent where the place keeps its own heading: the failure line then stands alone. */
  title?: string;
  className?: string;
  /** A new value clears the failure. */
  model?: unknown;
  onRetry?: () => void;
  /** Shown after the failure line, for what other panels still need from the failed one. */
  withFailure?: ReactNode;
  children: ReactNode;
}

interface PanelBoundaryState {
  error: Error | null;
  model: unknown;
}

/** Puts one failure line in place of a panel that throws while rendering. */
export class PanelBoundary extends Component<PanelBoundaryProps, PanelBoundaryState> {
  state: PanelBoundaryState = { error: null, model: this.props.model };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(
    props: PanelBoundaryProps,
    state: PanelBoundaryState,
  ): PanelBoundaryState | null {
    return props.model === state.model ? null : { error: null, model: props.model };
  }

  retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const line = (
      <Failure
        error={
          error.message || t({ id: 'board.panel.renderFailed', defaultMessage: 'Failed to render' })
        }
        onRetry={this.retry}
      />
    );
    const failure = this.props.title ? (
      <section className={`bd-pn${this.props.className ? ` ${this.props.className}` : ''}`}>
        <div className="bd-ph">
          <h2>{this.props.title}</h2>
        </div>
        {line}
      </section>
    ) : (
      line
    );
    return this.props.withFailure ? (
      <>
        {failure}
        {this.props.withFailure}
      </>
    ) : (
      failure
    );
  }
}

export function Skeleton() {
  return (
    <div className="bd-sk" aria-busy="true">
      <LoadingBlock style={{ height: 10, width: '60%' }} />
      <LoadingBlock style={{ height: 10, width: '40%' }} />
    </div>
  );
}
