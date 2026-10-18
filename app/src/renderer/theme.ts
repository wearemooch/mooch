// Applies the chosen theme to the page (<html data-theme>) and keeps "system" in step with Windows.
import { resolveTheme, type ThemeSetting } from '../shared/themes';
import { useApp } from './store';

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(setting: ThemeSetting = useApp.getState().settings?.theme ?? 'system'): void {
  const theme = resolveTheme(setting, systemDark.matches);
  document.documentElement.dataset.theme = theme.id;
  if (useApp.getState().theme.id !== theme.id) useApp.setState({ theme });
}

// With "system", the main process lets Chromium follow Windows, so this fires when Windows switches.
systemDark.addEventListener('change', () => applyTheme());
