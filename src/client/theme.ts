// Theme preference: stored on this device and resolved against the system
// appearance. Only the library and lookup panel change colour; the player
// chrome stays dark. CSS custom properties on #stage carry the palette.

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'kotoba.theme';

export const THEME_LABELS: Record<ThemePreference, string> = {
  system: '跟随系统',
  light: '浅色',
  dark: '深色',
};

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function nextPreference(preference: ThemePreference): ThemePreference {
  if (preference === 'system') return 'light';
  return preference === 'light' ? 'dark' : 'system';
}

export interface Theme {
  preference(): ThemePreference;
  resolved(): ResolvedTheme;
  setPreference(next: ThemePreference): void;
  /** Notifies after the preference or the resolved theme changes. */
  onChange(listener: () => void): () => void;
}

export function createTheme(stage: HTMLElement): Theme {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set<() => void>();
  let preference = readPreference();
  let resolved = apply();

  function apply(): ResolvedTheme {
    const next = resolveTheme(preference, media.matches);
    stage.dataset.theme = next;
    return next;
  }

  function notify(): void {
    for (const listener of listeners) listener();
  }

  media.addEventListener('change', () => {
    if (preference !== 'system') return;
    const next = apply();
    if (next === resolved) return;
    resolved = next;
    notify();
  });

  return {
    preference: () => preference,
    resolved: () => resolved,
    setPreference(next) {
      if (next === preference) return;
      preference = next;
      writePreference(next);
      resolved = apply();
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'system' || stored === 'light' || stored === 'dark') return stored;
  } catch {
    // Storage can be unavailable; the system preference still works.
  }
  return 'system';
}

function writePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Persisting is best effort.
  }
}
