import assert from "node:assert/strict";
import test from "node:test";
import { isThemePreference, resolveThemePreference } from "@/lib/theme";

test("theme preference guard only accepts supported values", () => {
  assert.equal(isThemePreference("system"), true);
  assert.equal(isThemePreference("light"), true);
  assert.equal(isThemePreference("dark"), true);
  assert.equal(isThemePreference("auto"), false);
  assert.equal(isThemePreference(""), false);
  assert.equal(isThemePreference(null), false);
});

test("theme resolution follows system when preference is system", () => {
  assert.equal(resolveThemePreference("system", false), "light");
  assert.equal(resolveThemePreference("system", true), "dark");
});

test("theme resolution respects explicit manual preference", () => {
  assert.equal(resolveThemePreference("light", true), "light");
  assert.equal(resolveThemePreference("dark", false), "dark");
});
