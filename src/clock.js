'use strict';

// Single source of domain time. Nothing else in src/ may call Date.now() for
// domain timestamps — everything goes through clock.now() so the demo
// time-warp (an advance-only offset) applies uniformly. SSE heartbeats and
// other infrastructure timing use real time and are exempt.

// offset is persisted in the settings table so a restart never moves time backwards.
function createSystemClock(db) {
  const getRow = db.prepare("SELECT value FROM settings WHERE key = 'timewarp_offset_ms'");
  const setRow = db.prepare(
    "INSERT INTO settings (key, value) VALUES ('timewarp_offset_ms', ?) " +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );

  let offsetMs = Number(getRow.get()?.value ?? 0);

  return {
    now() {
      return Date.now() + offsetMs;
    },
    offsetMs() {
      return offsetMs;
    },
    // advance-only: monotonic time is what makes open sessions safe across warps
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) throw new Error('advance_ms must be a non-negative integer');
      offsetMs += ms;
      setRow.run(String(offsetMs));
      return offsetMs;
    },
  };
}

// Test clock: same interface, fully controlled.
function createFakeClock(startMs = 0) {
  let nowMs = startMs;
  return {
    now() {
      return nowMs;
    },
    offsetMs() {
      return 0;
    },
    advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) throw new Error('advance_ms must be a non-negative integer');
      nowMs += ms;
      return nowMs;
    },
    set(ms) {
      nowMs = ms;
    },
  };
}

module.exports = { createSystemClock, createFakeClock };
