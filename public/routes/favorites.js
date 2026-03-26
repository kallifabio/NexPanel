'use strict';
/**
 * routes/favorites.js — Server-Favoriten & Console-Aliases
 *
 *  Favoriten:
 *   PATCH  /api/servers/:id/favorite        — Favorit umschalten
 *   PATCH  /api/servers/:id/sort-order      — Reihenfolge setzen
 *
 *  Console-Aliases (pro Server + User):
 *   GET    /api/servers/:id/aliases         — Alle Aliases abrufen
 *   POST   /api/servers/:id/aliases         — Alias anlegen
 *   PATCH  /api/servers/:id/aliases/:aliasId — Alias bearbeiten
 *   DELETE /api/servers/:id/aliases/:aliasId — Alias löschen
 *   GET    /api/servers/:id/aliases/expand  — Alias auflösen (name → command)
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, canAccessServer } = require('./auth');

const router = express.Router({ mergeParams: true });

// ── Hilfsfunktion: Zugriffsprüfung ───────────────────────────────────────────
function getServer(id) {
  return db.prepare('SELECT * FROM servers WHERE id=?').get(id);
}

// ══════════════════════════════════════════════════════════════════════════════
// FAVORITEN
// ══════════════════════════════════════════════════════════════════════════════

// PATCH /api/servers/:id/favorite
router.patch('/:id/favorite', authenticate, canAccessServer, (req, res) => {
  const srv = req.targetServer || getServer(req.params.id);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });

  const newVal = req.body.favorite !== undefined
    ? (req.body.favorite ? 1 : 0)
    : (srv.is_favorite ? 0 : 1);   // Toggle wenn kein Wert übergeben

  db.prepare("UPDATE servers SET is_favorite=?, updated_at=datetime('now') WHERE id=?")
    .run(newVal, srv.id);

  auditLog(req.user.id, newVal ? 'SERVER_FAVORITE' : 'SERVER_UNFAVORITE',
    'server', srv.id, {}, req.ip);

  res.json({ id: srv.id, is_favorite: newVal === 1 });
});

// PATCH /api/servers/:id/sort-order
router.patch('/:id/sort-order', authenticate, canAccessServer, (req, res) => {
  const { sort_order } = req.body;
  if (typeof sort_order !== 'number') return res.status(400).json({ error: 'sort_order (number) erforderlich' });

  db.prepare("UPDATE servers SET sort_order=?, updated_at=datetime('now') WHERE id=?")
    .run(Math.round(sort_order), req.params.id);

  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CONSOLE ALIASES
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/servers/:id/aliases
router.get('/:id/aliases', authenticate, canAccessServer, (req, res) => {
  const aliases = db.prepare(
    `SELECT * FROM console_aliases
     WHERE server_id=? AND user_id=?
     ORDER BY name ASC`
  ).all(req.params.id, req.user.id);
  res.json(aliases);
});

// POST /api/servers/:id/aliases
router.post('/:id/aliases', authenticate, canAccessServer, (req, res) => {
  const { name, command } = req.body;
  if (!name?.trim())    return res.status(400).json({ error: 'name erforderlich' });
  if (!command?.trim()) return res.status(400).json({ error: 'command erforderlich' });

  // Name: nur Buchstaben, Zahlen, -, _ (max 32 Zeichen)
  const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  if (!cleanName) return res.status(400).json({ error: 'Ungültiger Alias-Name (nur a-z, 0-9, -, _)' });
  if (cleanName.length > 32) return res.status(400).json({ error: 'Name zu lang (max 32 Zeichen)' });

  // Reservierte Namen
  if (['help', 'list', 'clear', 'history'].includes(cleanName)) {
    return res.status(400).json({ error: `"${cleanName}" ist ein reservierter Name` });
  }

  const id = uuidv4();
  try {
    db.prepare(
      'INSERT INTO console_aliases (id, server_id, user_id, name, command) VALUES (?,?,?,?,?)'
    ).run(id, req.params.id, req.user.id, cleanName, command.trim());
  } catch (e) {
    if (e.message?.includes('UNIQUE')) {
      return res.status(409).json({ error: `Alias "${cleanName}" existiert bereits` });
    }
    throw e;
  }

  res.status(201).json(
    db.prepare('SELECT * FROM console_aliases WHERE id=?').get(id)
  );
});

// PATCH /api/servers/:id/aliases/:aliasId
router.patch('/:id/aliases/:aliasId', authenticate, canAccessServer, (req, res) => {
  const alias = db.prepare(
    'SELECT * FROM console_aliases WHERE id=? AND server_id=? AND user_id=?'
  ).get(req.params.aliasId, req.params.id, req.user.id);

  if (!alias) return res.status(404).json({ error: 'Alias nicht gefunden' });

  const { name, command } = req.body;
  const updates = {};
  if (name !== undefined) {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!cleanName) return res.status(400).json({ error: 'Ungültiger Name' });
    updates.name = cleanName;
  }
  if (command !== undefined) updates.command = command.trim();

  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Keine Änderungen' });

  try {
    db.prepare(
      `UPDATE console_aliases SET ${Object.keys(updates).map(k => `${k}=?`).join(',')} WHERE id=?`
    ).run(...Object.values(updates), alias.id);
  } catch (e) {
    if (e.message?.includes('UNIQUE')) return res.status(409).json({ error: 'Alias-Name bereits vergeben' });
    throw e;
  }

  res.json(db.prepare('SELECT * FROM console_aliases WHERE id=?').get(alias.id));
});

// DELETE /api/servers/:id/aliases/:aliasId
router.delete('/:id/aliases/:aliasId', authenticate, canAccessServer, (req, res) => {
  const alias = db.prepare(
    'SELECT * FROM console_aliases WHERE id=? AND server_id=? AND user_id=?'
  ).get(req.params.aliasId, req.params.id, req.user.id);

  if (!alias) return res.status(404).json({ error: 'Alias nicht gefunden' });

  db.prepare('DELETE FROM console_aliases WHERE id=?').run(alias.id);
  res.json({ success: true });
});

// GET /api/servers/:id/aliases/expand?name=restart
router.get('/:id/aliases/expand', authenticate, canAccessServer, (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name erforderlich' });

  const alias = db.prepare(
    'SELECT * FROM console_aliases WHERE server_id=? AND user_id=? AND name=?'
  ).get(req.params.id, req.user.id, name.toLowerCase());

  if (!alias) return res.status(404).json({ error: 'Alias nicht gefunden', found: false });
  res.json({ found: true, name: alias.name, command: alias.command });
});

module.exports = router;
