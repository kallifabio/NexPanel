'use strict';
/**
 * routes/files.js — File-Manager
 * Dateien im Container lesen, schreiben, erstellen, löschen, umbenennen
 * Routing über node-router (lokal oder daemon)
 */

const express = require('express');
const { db, auditLog } = require('../db');
const { authenticate } = require('./auth');
const { routeToNode } = require('../node-router');
const { checkDiskBeforeWrite } = require('../resource-limits');

const router = express.Router({ mergeParams: true });

function canAccess(req, res, next) {
  const srv = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.serverId);
  if (!srv) return res.status(404).json({ error: 'Server nicht gefunden' });
  if (req.user.role !== 'admin' && srv.user_id !== req.user.id)
    return res.status(403).json({ error: 'Kein Zugriff' });
  if (!srv.container_id) return res.status(400).json({ error: 'Container nicht bereit' });
  req.srv = srv;
  next();
}

// ─── VERZEICHNIS LISTEN ───────────────────────────────────────────────────────
router.get('/list', authenticate, canAccess, async (req, res) => {
  try {
    const isItzg = (req.srv.image||'').includes('itzg')||(req.srv.image||'').includes('minecraft-server');
    const path = req.query.path || (isItzg ? '/data' : '/home/container');
    const result = await routeToNode(req.srv.node_id, {
      type: 'files.list',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      path,
    }, 10_000);
    res.json(result.files || []);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATEI LESEN ──────────────────────────────────────────────────────────────
router.get('/read', authenticate, canAccess, async (req, res) => {
  try {
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: 'path erforderlich' });
    const result = await routeToNode(req.srv.node_id, {
      type: 'files.read',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      path,
    }, 15_000);
    res.json({ content: result.content || '', size: result.size || 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATEI SCHREIBEN ─────────────────────────────────────────────────────────
router.post('/write', authenticate, canAccess, async (req, res) => {
  try {
    const { path, content } = req.body;
    if (!path) return res.status(400).json({ error: 'path erforderlich' });
    if (content === undefined) return res.status(400).json({ error: 'content erforderlich' });

    // ── Disk-Limit prüfen ──────────────────────────────────────────────────
    const diskCheck = await checkDiskBeforeWrite(
      req.srv.id, req.srv.node_id, req.srv.container_id,
      req.srv.work_dir, req.srv.disk_limit
    );
    if (!diskCheck.allowed) {
      return res.status(507).json({ error: diskCheck.error, pct: diskCheck.pct });
    }

    const result = await routeToNode(req.srv.node_id, {
      type: 'files.write',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      path,
      content,
    }, 15_000);
    auditLog(req.user.id, 'FILE_WRITE', 'server', req.srv.id, { path }, req.ip);
    res.json({ success: result.success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATEI / ORDNER ERSTELLEN ─────────────────────────────────────────────────
router.post('/create', authenticate, canAccess, async (req, res) => {
  try {
    const { path, type = 'file' } = req.body; // type: 'file' | 'directory'
    if (!path) return res.status(400).json({ error: 'path erforderlich' });
    const result = await routeToNode(req.srv.node_id, {
      type: 'files.create',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      path,
      file_type: type,
    }, 10_000);
    res.json({ success: result.success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATEI / ORDNER LÖSCHEN ───────────────────────────────────────────────────
router.delete('/delete', authenticate, canAccess, async (req, res) => {
  try {
    const { path } = req.body;
    if (!path) return res.status(400).json({ error: 'path erforderlich' });
    if (path === '/' || path === '/home/container' || path === '/data') return res.status(400).json({ error: 'Root nicht löschbar' });
    const result = await routeToNode(req.srv.node_id, {
      type: 'files.delete',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      path,
    }, 10_000);
    auditLog(req.user.id, 'FILE_DELETE', 'server', req.srv.id, { path }, req.ip);
    res.json({ success: result.success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATEI UMBENENNEN / VERSCHIEBEN ──────────────────────────────────────────
router.post('/rename', authenticate, canAccess, async (req, res) => {
  try {
    const { from, to } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from und to erforderlich' });
    const result = await routeToNode(req.srv.node_id, {
      type: 'files.rename',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      from, to,
    }, 10_000);
    res.json({ success: result.success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DATEI KOMPRIMIEREN / EXTRAHIEREN ────────────────────────────────────────
router.post('/compress', authenticate, canAccess, async (req, res) => {
  try {
    const { paths, destination } = req.body;
    if (!paths?.length) return res.status(400).json({ error: 'paths erforderlich' });
    const result = await routeToNode(req.srv.node_id, {
      type: 'files.compress',
      server_id: req.srv.id,
      container_id: req.srv.container_id,
      paths, destination,
    }, 30_000);
    res.json({ success: result.success });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
