'use strict';

// Append-only audit writer. Uses REAL time (not the warped domain clock) —
// the audit trail records when things actually happened. Fire-and-forget:
// an audit failure must never fail the user's action, but it is logged.

function createAudit(data) {
  return function audit(req, action, entity, entityId, details) {
    const row = {
      at_ms: Date.now(),
      actor_id: req?.user?.id ?? null,
      action,
      entity,
      entity_id: entityId ?? null,
      details: details ? JSON.stringify(details) : null,
    };
    data.insertAudit(row).catch((err) => console.error('audit write failed:', err.message));
  };
}

module.exports = { createAudit };
