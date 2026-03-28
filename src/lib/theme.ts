export const THEME_STORAGE_KEY = "oceanking.theme-preference.v1";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;

export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_OPTION_LABELS: Record<ThemePreference, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export const RESOLVED_THEME_LABELS: Record<ResolvedTheme, string> = {
  light: "浅色",
  dark: "深色",
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.includes(value as ThemePreference);
}

export function resolveThemePreference(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }

  return preference;
}

export function getThemeInitScript(): string {
  return [
    "(function(){",
    "var root=document.documentElement;",
    `var storageKey=${JSON.stringify(THEME_STORAGE_KEY)};`,
    `var mediaQuery=${JSON.stringify(THEME_MEDIA_QUERY)};`,
    "var preference='system';",
    "try {",
    "var stored=window.localStorage.getItem(storageKey);",
    "preference=stored==='light'||stored==='dark'||stored==='system'?stored:'system';",
    "} catch (error) {",
    "preference='system';",
    "}",
    "var prefersDark=false;",
    "try {",
    "prefersDark=Boolean(window.matchMedia&&window.matchMedia(mediaQuery).matches);",
    "} catch (error) {",
    "prefersDark=false;",
    "}",
    "var resolved=preference==='system'?(prefersDark?'dark':'light'):preference;",
    "root.dataset.themePreference=preference;",
    "root.dataset.theme=resolved;",
    "root.style.colorScheme=resolved;",
    "})();",
  ].join("");
}
