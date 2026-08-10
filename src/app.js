'use strict';

const path = require('path');
const express = require('express');
const { createAuth } = require('./auth');
const { createStore } = require('./store');
const { createSseHub } = require('./sse');

// Async factory — the same seam serves production (SystemClock + Supabase or
// SQLite data layer) and tests (FakeClock + ':memory:' SQLite data layer).
async function createApp({ data, clock }) {
  const app = express();
  const auth = await createAuth(data);
  const store = createStore(data, clock);
  const sse = createSseHub(store);
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

  const deps = { data, store, auth, clock, broadcast };
  app.use('/api', require('./routes/auth.routes')(deps));
  app.use('/api/employees', require('./routes/employees.routes')(deps));
  app.use('/api/tasks', require('./routes/tasks.routes')(deps));
  app.use('/api/tasks', require('./routes/clock.routes')(deps));
  app.use('/api/timewarp', require('./routes/timewarp.routes')(deps));
  app.get('/api/events', auth.requireAuth, sse.handler);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  });

  return app;
}

module.exports = { createApp };
