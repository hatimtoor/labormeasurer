'use strict';

// Org-wide settings stored in the settings table, with parsed accessors and a
// short cache. All dollar-affecting knobs are audited at the route layer.

const DEFAULTS = {
  burden_percent: '0', // true labor cost = wage × (1 + burden/100)
  ot_threshold_hours: '0', // 0 disables overtime
  ot_multiplier_percent: '150',
  org_utc_offset_min: '0', // org-local timezone offset for OT day boundaries
  alert_webhook_url: '',
  alert_thresholds: '75,90,100', // % of budget consumed
};

const EDITABLE_KEYS = Object.keys(DEFAULTS);

function createOrgSettings(data) {
  let cache = null;
  let cacheAt = 0;

  async function raw() {
    if (cache && Date.now() - cacheAt < 10_000) return cache;
    const stored = await data.getAllSettings();
    cache = { ...DEFAULTS };
    for (const key of EDITABLE_KEYS) {
      if (stored[key] !== undefined) cache[key] = stored[key];
    }
    cacheAt = Date.now();
    return cache;
  }

  return {
    editableKeys: EDITABLE_KEYS,
    raw,
    invalidate() {
      cache = null;
    },
    async calcOrg() {
      const s = await raw();
      return {
        otThresholdMs: Math.max(0, Number(s.ot_threshold_hours) || 0) * 3_600_000,
        otMultiplierPct: Math.max(100, Number(s.ot_multiplier_percent) || 150),
        utcOffsetMin: Number(s.org_utc_offset_min) || 0,
      };
    },
    async burdenedRate(wageCents) {
      const s = await raw();
      const burden = Math.max(0, Number(s.burden_percent) || 0);
      return Math.round((wageCents * (100 + burden)) / 100);
    },
    async alertConfig() {
      const s = await raw();
      const thresholds = String(s.alert_thresholds)
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isFinite(x) && x > 0 && x <= 999)
        .sort((a, b) => a - b);
      return { thresholds, webhookUrl: String(s.alert_webhook_url || '') };
    },
  };
}

module.exports = { createOrgSettings, DEFAULTS };
