'use strict';

const express = require('express');

module.exports = function projectRoutes({ data, auth, audit, broadcast }) {
  const router = express.Router();

  router.get('/', auth.requireAdmin, async (_req, res, next) => {
    try {
      res.json(await data.getProjects());
    } catch (err) {
      next(err);
    }
  });

  router.post('/', auth.requireAdmin, async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name required' });
      const id = await data.insertProject({ name });
      audit(req, 'project.create', 'project', id, { name });
      broadcast();
      res.status(201).json({ id });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', auth.requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid project id' });
      const project = await data.getProject(id);
      if (!project) return res.status(404).json({ error: 'no such project' });
      const fields = {};
      if (req.body?.name != null) fields.name = String(req.body.name);
      if (req.body?.status != null) {
        if (!['active', 'archived'].includes(req.body.status)) return res.status(400).json({ error: 'invalid status' });
        fields.status = req.body.status;
      }
      if (!Object.keys(fields).length) return res.status(400).json({ error: 'nothing to update' });
      await data.updateProject(id, fields);
      audit(req, 'project.update', 'project', id, fields);
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // tasks survive project deletion (project_id becomes null)
  router.delete('/:id', auth.requireAdmin, async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid project id' });
      const project = await data.getProject(id);
      if (!project) return res.status(404).json({ error: 'no such project' });
      await data.deleteProject(id);
      audit(req, 'project.delete', 'project', id, { name: project.name });
      broadcast();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
};
