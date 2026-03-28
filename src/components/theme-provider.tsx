"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  THEME_MEDIA_QUERY,
  THEME_STORAGE_KEY,
  isThemePreference,
  resolveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from "@/lib/theme";

interface ThemeContextValue {
  mounted: boolean;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  systemTheme: ResolvedTheme;
  setThemePreference: (value: ThemePreference) => void;
}

interface ThemeSnapshot {
  mounted: boolean;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  systemTheme: ResolvedTheme;
}

const THEME_CHANGE_EVENT = "oceanking:theme-change";
const SERVER_THEME_SNAPSHOT_KEY = "server|system|light";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredThemePreference(): ThemePreference {
  if (typeof window === "undefined") {
    return "system";
  }

  try {
    const storedValue = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(storedValue) ? storedValue : "system";
  } catch {
    return "system";
  }
}

function readDocumentThemePreference(): ThemePreference {
  if (typeof document === "undefined") {
    return "system";
  }

  const datasetValue = document.documentElement.dataset.themePreference;
  return isThemePreference(datasetValue) ? datasetValue : readStoredThemePreference();
}

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light";
  }

  return window.matchMedia(THEME_MEDIA_QUERY).matches ? "dark" : "light";
}

function applyTheme(preference: ThemePreference, resolvedTheme: ResolvedTheme) {
  if (typeof document === "undefined") {
    return;
  }

  const root = document.documentElement;
  root.dataset.themePreference = preference;
  root.dataset.theme = resolvedTheme;
  root.style.colorScheme = resolvedTheme;
}

function getThemeSnapshot(): ThemeSnapshot {
  const themePreference = readDocumentThemePreference();
  const systemTheme = getSystemTheme();

  return {
    mounted: true,
    themePreference,
    resolvedTheme: resolveThemePreference(themePreference, systemTheme === "dark"),
    systemTheme,
  };
}

function getThemeSnapshotKey(): string {
  const snapshot = getThemeSnapshot();
  return `${snapshot.mounted ? "client" : "server"}|${snapshot.themePreference}|${snapshot.systemTheme}`;
}

function getServerThemeSnapshotKey(): string {
  return SERVER_THEME_SNAPSHOT_KEY;
}

function parseThemeSnapshotKey(snapshotKey: string): ThemeSnapshot {
  if (snapshotKey === SERVER_THEME_SNAPSHOT_KEY) {
    return {
      mounted: false,
      themePreference: "system",
      resolvedTheme: "light",
      systemTheme: "light",
    };
  }

  const [, themePreferenceValue, systemThemeValue] = snapshotKey.split("|");
  const themePreference = isThemePreference(themePreferenceValue) ? themePreferenceValue : "system";
  const systemTheme: ResolvedTheme = systemThemeValue === "dark" ? "dark" : "light";

  return {
    mounted: true,
    themePreference,
    resolvedTheme: resolveThemePreference(themePreference, systemTheme === "dark"),
    systemTheme,
  };
}

function subscribeToThemeChanges(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  const mediaQueryList = typeof window.matchMedia === "function" ? window.matchMedia(THEME_MEDIA_QUERY) : null;
  const handleMediaChange = () => {
    onStoreChange();
  };
  const handleStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY) {
      onStoreChange();
    }
  };
  const handleThemeChange = () => {
    onStoreChange();
  };

  if (mediaQueryList) {
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", handleMediaChange);
    } else {
      mediaQueryList.addListener(handleMediaChange);
    }
  }

  window.addEventListener("storage", handleStorage);
  window.addEventListener(THEME_CHANGE_EVENT, handleThemeChange);

  return () => {
    if (mediaQueryList) {
      if (typeof mediaQueryList.removeEventListener === "function") {
        mediaQueryList.removeEventListener("change", handleMediaChange);
      } else {
        mediaQueryList.removeListener(handleMediaChange);
      }
    }

    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(THEME_CHANGE_EVENT, handleThemeChange);
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const snapshotKey = useSyncExternalStore(subscribeToThemeChanges, getThemeSnapshotKey, getServerThemeSnapshotKey);
  const snapshot = useMemo(() => parseThemeSnapshotKey(snapshotKey), [snapshotKey]);

  useEffect(() => {
    applyTheme(snapshot.themePreference, snapshot.resolvedTheme);

    if (!snapshot.mounted) {
      return;
    }

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, snapshot.themePreference);
    } catch {
      // Ignore browsers that block storage access.
    }
  }, [snapshot.mounted, snapshot.resolvedTheme, snapshot.themePreference]);

  const setThemePreference = useCallback((value: ThemePreference) => {
    const systemTheme = getSystemTheme();
    const resolvedTheme = resolveThemePreference(value, systemTheme === "dark");

    applyTheme(value, resolvedTheme);

    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, value);
    } catch {
      // Ignore browsers that block storage access.
    }

    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mounted: snapshot.mounted,
      themePreference: snapshot.themePreference,
      resolvedTheme: snapshot.resolvedTheme,
      systemTheme: snapshot.systemTheme,
      setThemePreference,
    }),
    [setThemePreference, snapshot.mounted, snapshot.resolvedTheme, snapshot.systemTheme, snapshot.themePreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside ThemeProvider.");
  }

  return context;
}
