'use strict';

const express = require('express');

const VALIDATORS = {
  burden_percent: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 200,
  ot_threshold_hours: (v) => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 24,
  ot_multiplier_percent: (v) => Number.isFinite(Number(v)) && Number(v) >= 100 && Number(v) <= 300,
  org_utc_offset_min: (v) => Number.isInteger(Number(v)) && Math.abs(Number(v)) <= 14 * 60,
  alert_webhook_url: (v) => v === '' || /^https?:\/\//.test(String(v)),
  alert_thresholds: (v) =>
    String(v)
      .split(',')
      .every((x) => Number.isFinite(Number(x.trim())) && Number(x.trim()) > 0 && Number(x.trim()) <= 999),
};

module.exports = function settingsRoutes({ data, auth, org, audit, broadcast }) {
  const router = express.Router();

  router.get('/', auth.requireAdmin, async (_req, res, next) => {
    try {
      res.json(await org.raw());
    } catch (err) {
      next(err);
    }
  });

  router.patch('/', auth.requireAdmin, async (req, res, next) => {
    try {
      const body = req.body || {};
      const changes = {};
      for (const key of org.editableKeys) {
        if (body[key] === undefined) continue;
        const value = String(body[key]);
        if (!VALIDATORS[key](value)) return res.status(400).json({ error: `invalid value for ${key}` });
        changes[key] = value;
      }
      if (!Object.keys(changes).length) return res.status(400).json({ error: 'nothing to update' });
      const before = await org.raw();
      for (const [key, value] of Object.entries(changes)) {
        await data.setSetting(key, value);
      }
      org.invalidate();
      audit(
        req,
        'settings.update',
        'settings',
        null,
        Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, { from: before[k], to: v }]))
      );
      broadcast();
      res.json(await org.raw());
    } catch (err) {
      next(err);
    }
  });

  router.get('/audit', auth.requireAdmin, async (req, res, next) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      const [rows, employees] = await Promise.all([data.getAuditLog(limit), data.getEmployees()]);
      const names = new Map(employees.map((e) => [e.id, e.name]));
      res.json(
        rows.map((r) => ({
          ...r,
          actor_name: r.actor_id != null ? names.get(r.actor_id) || `#${r.actor_id}` : 'system',
        }))
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
};
