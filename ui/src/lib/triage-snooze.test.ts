import { describe, expect, it } from "vitest";
import { MAX_SNOOZE_DAYS, SNOOZE_PRESETS, backOnLabel, snoozeBlocker, vnDay } from "./triage-snooze";

// 2026-10-27 20:00 UTC is already 2026-10-28 03:00 in Vietnam.
const NOW = Date.parse("2026-10-27T20:00:00Z");

describe("triage snooze days", () => {
  it("counts days in Vietnam, not in UTC", () => {
    expect(vnDay(0, NOW)).toBe("2026-10-28");
    expect(vnDay(1, NOW)).toBe("2026-10-29");
    expect(vnDay(7, NOW)).toBe("2026-11-04");
    expect(SNOOZE_PRESETS.map((p) => vnDay(p.days, NOW))).toEqual(["2026-10-29", "2026-11-04", "2026-11-27"]);
  });

  it("accepts a day after today up to 90 days ahead, and says why otherwise", () => {
    expect(snoozeBlocker(vnDay(1, NOW), NOW)).toBeNull();
    expect(snoozeBlocker(vnDay(MAX_SNOOZE_DAYS, NOW), NOW)).toBeNull();
    expect(snoozeBlocker(vnDay(0, NOW), NOW)).toMatch(/after today/);
    expect(snoozeBlocker(vnDay(-2, NOW), NOW)).toMatch(/after today/);
    expect(snoozeBlocker(vnDay(MAX_SNOOZE_DAYS + 1, NOW), NOW)).toMatch(/at most 90/);
    expect(snoozeBlocker("", NOW)).toMatch(/Pick a day/);
    expect(snoozeBlocker("2026-13-40", NOW)).toMatch(/valid day/);
  });

  it("words the return day", () => {
    expect(backOnLabel("2026-11-03T00:00:00+07:00")).toBe("Back on 3 Nov");
  });
});
