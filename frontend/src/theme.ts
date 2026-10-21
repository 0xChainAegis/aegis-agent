// Appearance preference only. It never touches wallet, draft or API state.
import { z } from 'zod';

const themeSchema = z.enum(['light', 'dark']);
export type Theme = z.infer<typeof themeSchema>;
export const THEME_KEY = 'aegis.ui.theme.v1';

function stored(): Theme | null {
  try {
    const value: unknown = localStorage.getItem(THEME_KEY);
    const parsed = themeSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch { return null; } // storage can be unavailable (private mode, policy)
}

export function currentTheme(): Theme {
  const parsed = themeSchema.safeParse(document.documentElement.dataset.theme);
  return parsed.success ? parsed.data : 'light';
}

export function applyTheme(theme: Theme): void {
  const parsed = themeSchema.safeParse(theme);
  const value = parsed.success ? parsed.data : 'light';
  document.documentElement.dataset.theme = value;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', value === 'dark' ? '#121314' : '#f4f3ef');
}

/** Default is light unless a valid saved choice exists. */
export function initTheme(): void { applyTheme(stored() ?? 'light'); }

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* the choice still applies for this page view */ }
  return next;
}
