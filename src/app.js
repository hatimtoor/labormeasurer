'use strict';

const path = require('path');
const express = require('express');
const { createAuth } = require('./auth');
const { createStore } = require('./store');
const { createSseHub } = require('./sse');

// Factory — the same seam serves production (SystemClock + file db) and tests
// (FakeClock + ':memory:' db).
function createApp({ db, clock }) {
  const app = express();
  const auth = createAuth(db);
  const store = createStore(db, clock);
  const sse = createSseHub(store);
  const broadcast = sse.broadcast;

  app.use(express.json());
  app.use(auth.attachUser);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const deps = { db, store, auth, clock, broadcast };
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
