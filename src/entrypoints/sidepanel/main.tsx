import { createRoot } from 'react-dom/client';
import App from '../../sidepanel/App';
import ErrorBoundary from '../../sidepanel/components/ErrorBoundary';
import '../../sidepanel/styles/index.css';

const root = createRoot(document.getElementById('root')!);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
