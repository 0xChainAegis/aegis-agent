// Appearance preference only. It never touches wallet, draft or API state.
export type Theme = 'light' | 'dark';
export const THEME_KEY = 'aegis.ui.theme.v1';

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch { return null; } // storage can be unavailable (private mode, policy)
}

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#121314' : '#f4f3ef');
}

/** Default is light unless a valid saved choice exists. */
export function initTheme(): void { applyTheme(stored() ?? 'light'); }

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice still applies for this page view */ }
  return next;
}
