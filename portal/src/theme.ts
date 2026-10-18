// Light/dark theme shared with the Paperclip board: same storage key and the same `dark` class on <html>,
// so a choice made in either place applies to both (they share the origin). Without a stored choice the
// operating system preference decides. index.html runs the same decision before the first paint.

export type Theme = "light" | "dark";
export const THEME_KEY = "paperclip.theme";

export const parseTheme = (value: unknown): Theme | null => (value === "light" || value === "dark" ? value : null);
export const resolveTheme = (stored: unknown, systemDark: boolean): Theme => parseTheme(stored) ?? (systemDark ? "dark" : "light");
export const otherTheme = (theme: Theme): Theme => (theme === "dark" ? "light" : "dark");

export function storedTheme(): Theme | null {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return null; // storage can be blocked (private windows, site settings)
  }
}

export function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export const initialTheme = (): Theme => resolveTheme(storedTheme(), systemPrefersDark());

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  // Colours must change together: without this, elements with a colour transition fade while text snaps
  // (light text on a still-white card for a moment). Transitions are off for the frame of the switch.
  root.classList.add("theme-switching");
  root.classList.toggle("dark", theme === "dark");
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-switching")));
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#262626" : "#ffffff");
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* the choice still applies for this visit */
  }
}
