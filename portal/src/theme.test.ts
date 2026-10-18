import { describe, expect, it } from "vitest";
import { otherTheme, parseTheme, resolveTheme, THEME_KEY } from "./theme";

describe("theme", () => {
  it("shares the storage key with the Paperclip board", () => {
    expect(THEME_KEY).toBe("paperclip.theme");
  });

  it("accepts only the two known values", () => {
    expect(parseTheme("dark")).toBe("dark");
    expect(parseTheme("light")).toBe("light");
    for (const bad of [null, undefined, "", "system", "Dark", 1, {}]) expect(parseTheme(bad)).toBeNull();
  });

  it("a stored choice wins over the operating system; otherwise the system decides", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme(null, true)).toBe("dark");
    expect(resolveTheme(null, false)).toBe("light");
    expect(resolveTheme("garbage", true)).toBe("dark");
  });

  it("toggles between the two", () => {
    expect(otherTheme("light")).toBe("dark");
    expect(otherTheme("dark")).toBe("light");
  });
});
