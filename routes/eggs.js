'use strict';
/**
 * routes/eggs.js — Egg/Template-System (wie Pterodactyl)
 * Vordefinierte Server-Vorlagen mit Docker-Image, ENV-Vars, Startup-Command
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db, auditLog } = require('../src/core/db');
const { authenticate, requireAdmin } = require('./auth');

const router = express.Router();

// ─── ALLE EGGS ABRUFEN ────────────────────────────────────────────────────────
router.get('/', authenticate, (req, res) => {
  const eggs = db.prepare('SELECT * FROM eggs ORDER BY category ASC, name ASC').all();
  res.json(eggs.map(e => ({
    ...e,
    env_vars: JSON.parse(e.env_vars || '[]'),
    features: JSON.parse(e.features || '[]'),
    config_files: JSON.parse(e.config_files || '{}'),
  })));
});

// ─── EIN EGG ABRUFEN ─────────────────────────────────────────────────────────
router.get('/:id', authenticate, (req, res) => {
  const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
  if (!egg) return res.status(404).json({ error: 'Egg nicht gefunden' });
  res.json({
    ...egg,
    env_vars:    JSON.parse(egg.env_vars    || '[]'),
    features:    JSON.parse(egg.features    || '[]'),
    config_files: JSON.parse(egg.config_files || '{}'),
  });
});

// ─── EGG ERSTELLEN (Admin) ────────────────────────────────────────────────────
router.post('/', authenticate, requireAdmin, (req, res) => {
  try {
    const {
      name, description = '', author = req.user.username,
      docker_image, startup_command = '', config_stop = '',
      env_vars = [], features = [], config_files = {},
      category = 'other', icon = '🐣', port_range = '',
    } = req.body;
    if (!name || !docker_image)
      return res.status(400).json({ error: 'Name und docker_image erforderlich' });

    const id = uuidv4();
    db.prepare(`INSERT INTO eggs
      (id,name,description,author,docker_image,startup_command,config_stop,
       env_vars,features,config_files,category,icon,port_range)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, name, description, author, docker_image, startup_command, config_stop,
           JSON.stringify(env_vars), JSON.stringify(features),
           JSON.stringify(config_files), category, icon, port_range);
    auditLog(req.user.id, 'EGG_CREATE', 'egg', id, { name }, req.ip);
    const created = db.prepare('SELECT * FROM eggs WHERE id=?').get(id);
    res.status(201).json({ ...created, env_vars, features });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EGG BEARBEITEN (Admin) ────────────────────────────────────────────────────
router.patch('/:id', authenticate, requireAdmin, (req, res) => {
  try {
    const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
    if (!egg) return res.status(404).json({ error: 'Egg nicht gefunden' });

    const {
      name, description, docker_image, startup_command, config_stop,
      env_vars, features, config_files, category, icon, port_range,
    } = req.body;
    const upd = {};
    if (name           !== undefined) upd.name           = name;
    if (description    !== undefined) upd.description    = description;
    if (docker_image   !== undefined) upd.docker_image   = docker_image;
    if (startup_command!== undefined) upd.startup_command= startup_command;
    if (config_stop    !== undefined) upd.config_stop    = config_stop;
    if (env_vars       !== undefined) upd.env_vars       = JSON.stringify(env_vars);
    if (features       !== undefined) upd.features       = JSON.stringify(features);
    if (config_files   !== undefined) upd.config_files   = JSON.stringify(config_files);
    if (category       !== undefined) upd.category       = category;
    if (icon           !== undefined) upd.icon           = icon;
    if (port_range     !== undefined) upd.port_range     = port_range;
    upd.updated_at = new Date().toISOString();

    if (Object.keys(upd).length > 1) {
      db.prepare(`UPDATE eggs SET ${Object.keys(upd).map(k=>`${k}=?`).join(',')} WHERE id=?`)
        .run(...Object.values(upd), req.params.id);
    }
    auditLog(req.user.id, 'EGG_UPDATE', 'egg', req.params.id, {}, req.ip);
    const updated = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
    res.json({ ...updated, env_vars: JSON.parse(updated.env_vars), features: JSON.parse(updated.features) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EGG LÖSCHEN (Admin, nur nicht built-in) ──────────────────────────────────
router.delete('/:id', authenticate, requireAdmin, (req, res) => {
  const egg = db.prepare('SELECT * FROM eggs WHERE id=?').get(req.params.id);
  if (!egg) return res.status(404).json({ error: 'Egg nicht gefunden' });
  if (egg.is_builtin) return res.status(400).json({ error: 'Built-in Eggs können nicht gelöscht werden' });
  db.prepare('DELETE FROM eggs WHERE id=?').run(req.params.id);
  auditLog(req.user.id, 'EGG_DELETE', 'egg', req.params.id, { name: egg.name }, req.ip);
  res.json({ success: true });
});

module.exports = router;
