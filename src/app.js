'use strict';

const path = require('path');
const express = require('express');
const { createAuth } = require('./auth');
const { createStore } = require('./store');
const { createSseHub } = require('./sse');
const { createOrgSettings } = require('./org');
const { createAudit } = require('./audit');

// Async factory — the same seam serves production (SystemClock + Supabase or
// SQLite data layer) and tests (FakeClock + ':memory:' SQLite data layer).
async function createApp({ data, clock, enableTimewarp }) {
  const app = express();
  const auth = await createAuth(data);
  const org = createOrgSettings(data);
  const audit = createAudit(data);
  const store = createStore(data, clock, org);
  const sse = createSseHub(store, { data, org, audit });
  const broadcast = sse.broadcast;

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'"
    );
    next();
  });
  // static assets need no auth — keep them off the data backend entirely
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.json({ limit: '50kb' }));
  app.use(auth.attachUser);

  const deps = { data, store, auth, clock, org, audit, broadcast };
  app.use('/api', require('./routes/auth.routes')(deps));
  app.use('/api/employees', require('./routes/employees.routes')(deps));
  app.use('/api/tasks', require('./routes/tasks.routes')(deps));
  app.use('/api/tasks', require('./routes/clock.routes')(deps));
  app.use('/api/projects', require('./routes/projects.routes')(deps));
  app.use('/api/settings', require('./routes/settings.routes')(deps));
  app.use('/api/reports', require('./routes/reports.routes')(deps));
  // demo/training control — must be explicitly enabled in production
  const timewarpOn =
    enableTimewarp ?? (process.env.NODE_ENV !== 'production' || process.env.ENABLE_TIMEWARP === '1');
  if (timewarpOn) {
    app.use('/api/timewarp', require('./routes/timewarp.routes')(deps));
  }
  app.get('/api/events', auth.requireAuth, sse.handler);
  app.get('/api/features', auth.requireAuth, (_req, res) => res.json({ timewarp: timewarpOn }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
