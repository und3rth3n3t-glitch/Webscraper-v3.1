import brand from '@/themes';
import { useSettingsStore } from './stores/settingsStore';

/**
 * Runs once after the settings store hydrates. If the brand declares a
 * defaultServerUrl AND the user has never been bootstrapped before AND the
 * stored serverUrl is empty, populate it. Then mark bootstrapped — even if
 * we didn't fill anything — so we never run again.
 */
export function applyBrandDefaults(): void {
  const s = useSettingsStore.getState();
  if (s.brandBootstrapped) return;
  if (brand.defaultServerUrl && !s.serverUrl) {
    useSettingsStore.setState({ serverUrl: brand.defaultServerUrl });
  }
  s.markBrandBootstrapped();
}
