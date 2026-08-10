'use strict';

// Single source of domain time. Nothing else in src/ may call Date.now() for
// domain timestamps — everything goes through clock.now() so the demo
// time-warp (an advance-only offset) applies uniformly. SSE heartbeats and
// other infrastructure timing use real time and are exempt.

// offset is persisted in the settings table so a restart never moves time backwards.
async function createSystemClock(data) {
  let offsetMs = Number((await data.getSetting('timewarp_offset_ms')) ?? 0);

  return {
    now() {
      return Date.now() + offsetMs;
    },
    offsetMs() {
      return offsetMs;
    },
    // advance-only: monotonic time is what makes open sessions safe across warps
    async advance(ms) {
      if (!Number.isInteger(ms) || ms < 0) throw new Error('advance_ms must be a non-negative integer');
      offsetMs += ms;
      await data.setSetting('timewarp_offset_ms', String(offsetMs));
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
    async advance(ms) {
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
