'use strict';

const express = require('express');

// Demo-only control: advance the domain clock so budget consumption that
// would take hours can be shown in seconds. Advance-only — time never goes back.
module.exports = function timewarpRoutes({ auth, clock, audit, broadcast }) {
  const router = express.Router();

  router.get('/', auth.requireAdmin, (_req, res) => {
    res.json({ offset_ms: clock.offsetMs(), now_ms: clock.now() });
  });

  router.post('/', auth.requireAdmin, async (req, res, next) => {
    try {
      const MAX_ADVANCE_MS = 365 * 24 * 3_600_000; // one year per call
      const advance = Number(req.body?.advance_ms);
      if (!Number.isInteger(advance) || advance < 0 || advance > MAX_ADVANCE_MS) {
        return res.status(400).json({ error: 'advance_ms must be an integer between 0 and one year' });
      }
      await clock.advance(advance);
      audit(req, 'timewarp.advance', 'clock', null, { advance_ms: advance, offset_ms: clock.offsetMs() });
      broadcast();
      res.json({ offset_ms: clock.offsetMs(), now_ms: clock.now() });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
