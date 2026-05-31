/**
 * App-wide error boundary. Without this, any uncaught render exception unmounts
 * the whole React tree and the window goes black with no explanation. This
 * catches it, shows the error message + a recovery action, and lets the user
 * (and us) see what actually broke instead of a blank screen.
 */
import React from 'react';

interface State {
  error: Error | null;
  info: string | null;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to the main process log too, so packaged builds capture it.
    // eslint-disable-next-line no-console
    console.error('[Artha] Renderer crash:', error, info.componentStack);
    this.setState({ info: info.componentStack ?? null });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          height: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 16,
          padding: 32,
          background: '#0b0f1a',
          color: '#e5e7eb',
          fontFamily: 'Inter, system-ui, sans-serif',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 40 }}>⚠️</div>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Something went wrong</h1>
        <p style={{ color: '#9ca3af', maxWidth: 460, lineHeight: 1.5, margin: 0 }}>
          Artha hit an unexpected error and paused this view. Your data is safe —
          reloading usually fixes it. If it keeps happening, send us the details below.
        </p>
        <pre
          style={{
            maxWidth: 560,
            maxHeight: 180,
            overflow: 'auto',
            textAlign: 'left',
            fontSize: 11,
            lineHeight: 1.5,
            background: '#111827',
            border: '1px solid #1f2937',
            borderRadius: 8,
            padding: 12,
            color: '#f87171',
            whiteSpace: 'pre-wrap',
          }}
        >
          {String(error?.message ?? error)}
          {info ? `\n${info}` : ''}
        </pre>
        <div style={{ display: 'flex', gap: 12 }}>
          <button
            onClick={() => this.setState({ error: null, info: null })}
            style={{
              padding: '9px 18px',
              borderRadius: 8,
              border: '1px solid #374151',
              background: 'transparent',
              color: '#e5e7eb',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '9px 18px',
              borderRadius: 8,
              border: 'none',
              background: '#4f46e5',
              color: '#fff',
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Reload Artha
          </button>
        </div>
      </div>
    );
  }
}
