// ============================================================================
// Google Calendar — Create Event start / end handling.
//
// A Manual trigger has no {{triggeredAt}}, so the node used to send empty
// start/end datetimes and Google answered a bare "HTTP 400 Bad Request". Blank
// values now default to now / one hour later, plain dates make all-day events,
// and bad input fails here with a clear message instead of at Google.
//
// Run: node --test tests/calendar-times.test.js
// ============================================================================
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers/node-harness.js";

const { calendarEventTimes, graphEventTimes } = await import("../server/executor.js");

test("blank start is now and blank end is one hour later", () => {
  const before = Date.now();
  const t = calendarEventTimes("", "", "Europe/Berlin");
  const start = Date.parse(t.start.dateTime);
  assert.ok(start >= before - 1000 && start <= Date.now() + 1000);
  assert.equal(Date.parse(t.end.dateTime) - start, 3600_000);
  assert.equal(t.start.timeZone, "Europe/Berlin");
});

test("a datetime without an offset keeps that form for the computed end", () => {
  const t = calendarEventTimes("2026-01-01T10:00:00", "", "Europe/Berlin");
  assert.deepEqual(t, {
    start: { dateTime: "2026-01-01T10:00:00", timeZone: "Europe/Berlin" },
    end: { dateTime: "2026-01-01T11:00:00", timeZone: "Europe/Berlin" },
  });
});

test("a plain date makes an all-day event ending the next day", () => {
  assert.deepEqual(calendarEventTimes("2026-01-31", ""), { start: { date: "2026-01-31" }, end: { date: "2026-02-01" } });
});

test("an explicit end is kept and the time zone defaults to UTC", () => {
  const t = calendarEventTimes("2026-01-01T10:00:00Z", "2026-01-01T12:30:00Z");
  assert.equal(t.end.dateTime, "2026-01-01T12:30:00Z");
  assert.equal(t.start.timeZone, "UTC");
});

test("bad input fails with BF-2001 before calling Google", () => {
  for (const [start, end] of [
    ["tomorrow", ""],
    ["2026-01-01T10:00:00", "soon"],
    ["2026-01-01T10:00:00", "2026-01-01T09:00:00"],
    ["2026-01-01", "2026-01-01T09:00:00"],
  ]) {
    assert.throws(() => calendarEventTimes(start, end), (e) => e._bfCode === 2001, `${start} → ${end}`);
  }
});

// ---- Outlook 365 (Microsoft Graph) ----
// Had the same {{triggeredAt}} defaults and the same bare HTTP 400.

test("Outlook: blank start and end become now and one hour later, without an offset", () => {
  const t = graphEventTimes("", "", "Europe/Berlin");
  assert.equal(t.start.timeZone, "UTC");
  assert.match(t.start.dateTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  assert.equal(Date.parse(`${t.end.dateTime}Z`) - Date.parse(`${t.start.dateTime}Z`), 3600_000);
});

test("Outlook: a local datetime keeps the node's time zone", () => {
  assert.deepEqual(graphEventTimes("2026-01-01T10:00:00", "", "Europe/Berlin"), {
    start: { dateTime: "2026-01-01T10:00:00", timeZone: "Europe/Berlin" },
    end: { dateTime: "2026-01-01T11:00:00", timeZone: "Europe/Berlin" },
  });
});

test("Outlook: a plain date is an all-day event from midnight to midnight", () => {
  assert.deepEqual(graphEventTimes("2026-01-31", "", "Europe/Berlin"), {
    isAllDay: true,
    start: { dateTime: "2026-01-31T00:00:00", timeZone: "Europe/Berlin" },
    end: { dateTime: "2026-02-01T00:00:00", timeZone: "Europe/Berlin" },
  });
});

test("Outlook: an offset is converted to UTC", () => {
  assert.deepEqual(graphEventTimes("2026-01-01T10:00:00+02:00", "").start, { dateTime: "2026-01-01T08:00:00", timeZone: "UTC" });
});
