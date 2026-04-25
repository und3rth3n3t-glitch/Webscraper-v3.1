import { Component, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; }

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[Blueberry] UI crash:', error, errorInfo);
  }

  handleReload = () => { window.location.reload(); };

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <div className="error-boundary-content">
            <AlertTriangle size={32} />
            <h2>Something went wrong</h2>
            <p>The extension hit an unexpected error. Click below to reload.</p>
            <button className="btn btn-primary" onClick={this.handleReload}>
              Reload Extension
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
