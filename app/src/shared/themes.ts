// The app themes from the brand book (v2). The full token sets live in renderer/styles.css; these hex
// values are for the places that can't use CSS variables: Monaco, the window background, and previews.

export type ThemeId = 'night' | 'day' | 'broth' | 'receipt';
/** "system" follows Windows between Night (dark) and Day (light). */
export type ThemeSetting = 'system' | ThemeId;

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  description: string;
  dark: boolean;
  colors: { bg: string; chrome: string; panel: string; surface: string; border: string; text: string; muted: string; accent: string; tint: string };
}

export const THEMES: ThemeInfo[] = [
  {
    id: 'night',
    name: 'Night',
    description: 'Blue-grey dark. The default.',
    dark: true,
    colors: { bg: '#161826', chrome: '#12131f', panel: '#191b29', surface: '#232532', border: '#2c2e3d', text: '#e9e9ed', muted: '#91919b', accent: '#9184d9', tint: '#302e50' },
  },
  {
    id: 'day',
    name: 'Day',
    description: 'Night’s light twin.',
    dark: false,
    colors: { bg: '#fafafc', chrome: '#eff0f4', panel: '#f5f5f8', surface: '#eaebf0', border: '#dadae0', text: '#1e1e29', muted: '#62626c', accent: '#6358ba', tint: '#e5e5ff' },
  },
  {
    id: 'broth',
    name: 'Broth',
    description: 'Warm browns with an amber accent. Easy on the eyes at night.',
    dark: true,
    colors: { bg: '#18130e', chrome: '#110c09', panel: '#1d1713', surface: '#27201b', border: '#342c26', text: '#ece7df', muted: '#9a9085', accent: '#e8a95c', tint: '#432e14' },
  },
  {
    id: 'receipt',
    name: 'Receipt',
    description: 'Paper cream with a ballpoint-blue accent. Good in daylight and for screen-sharing.',
    dark: false,
    colors: { bg: '#f6f3eb', chrome: '#eee9de', panel: '#f2eee5', surface: '#e7e3d7', border: '#d6d1c4', text: '#29231c', muted: '#6a6257', accent: '#006692', tint: '#c9e2f2' },
  },
];

export const THEME_SETTINGS: ThemeSetting[] = ['system', ...THEMES.map((t) => t.id)];

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return typeof value === 'string' && (THEME_SETTINGS as string[]).includes(value);
}

export function resolveTheme(setting: ThemeSetting, systemDark: boolean): ThemeInfo {
  const id = setting === 'system' ? (systemDark ? 'night' : 'day') : setting;
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}
