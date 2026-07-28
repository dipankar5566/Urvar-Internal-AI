import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] render error:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className="login-screen">
          <div className="login-card">
            <h2>Something went wrong</h2>
            <p className="muted">
              This page hit an unexpected error. Reloading usually fixes it.
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
