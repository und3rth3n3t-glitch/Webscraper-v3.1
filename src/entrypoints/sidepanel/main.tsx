import { createRoot } from 'react-dom/client';
import App from '../../sidepanel/App';
import ErrorBoundary from '../../sidepanel/components/ErrorBoundary';
import '../../sidepanel/styles/index.css';
import brand from '@/themes';
import { useSettingsStore } from '../../sidepanel/stores/settingsStore';
import { applyBrandDefaults } from '../../sidepanel/applyBrandDefaults';

document.title = brand.appName;

useSettingsStore.persist.onFinishHydration(applyBrandDefaults);

const root = createRoot(document.getElementById('root')!);
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);
