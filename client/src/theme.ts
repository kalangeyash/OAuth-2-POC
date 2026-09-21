/*
 * Theme state.
 *
 * The DOM is the source of truth: the boot script in index.html resolves
 * data-theme before React exists, so this module reads it synchronously at mount
 * rather than racing it with an effect.
 *
 * Only one thing is ever stored in the browser, and it is not a secret. The demo
 * makes a teaching point of this — see RUN-AND-DEMO.md, "Prove the browser holds
 * no tokens": one key, holding the word "light" or "dark".
 */
import { useCallback, useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

/** Shared with the boot script in client/index.html — change both together. */
const STORAGE_KEY = "smart-demo-theme";

const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // Follow the operating system until the presenter makes an explicit choice.
  const onSystemChange = () => {
    if (readStoredTheme() === null) {
      applyTheme(systemTheme());
      notify();
    }
  };
  media.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onSystemChange);
  };
}

export function readStoredTheme(): Theme | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : null;
  } catch {
    return null;
  }
}

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function useTheme(): { theme: Theme; setTheme: (theme: Theme) => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);

  const setTheme = useCallback((next: Theme) => {
    // Written synchronously inside the click handler so the screen flips on the
    // same frame: a presenter toggling live should see no lag.
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A browser with storage blocked still gets the theme for this session.
    }
    notify();
  }, []);

  return { theme, setTheme };
}
