'use strict';

const express = require('express');

// Demo-only control: advance the domain clock so budget consumption that
// would take hours can be shown in seconds. Advance-only — time never goes back.
module.exports = function timewarpRoutes({ auth, clock, broadcast }) {
  const router = express.Router();

  router.get('/', auth.requireAdmin, (_req, res) => {
    res.json({ offset_ms: clock.offsetMs(), now_ms: clock.now() });
  });

  router.post('/', auth.requireAdmin, (req, res) => {
    const advance = Number(req.body?.advance_ms);
    if (!Number.isInteger(advance) || advance < 0) {
      return res.status(400).json({ error: 'advance_ms must be a non-negative integer' });
    }
    clock.advance(advance);
    broadcast();
    res.json({ offset_ms: clock.offsetMs(), now_ms: clock.now() });
  });

  return router;
};
