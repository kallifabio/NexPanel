/**
 * routes/docs.js — Swagger / OpenAPI 3.0 Dokumentation
 *
 *   GET /api/docs           → Swagger UI (interaktiv, Bearer-Auth)
 *   GET /api/docs/openapi.json → rohe OpenAPI 3.0 Spec
 *
 * Die Spec wird zur Laufzeit generiert (Base-URL aus Request),
 * sodass sie auch hinter Reverse-Proxies korrekt funktioniert.
 */

'use strict';

const express = require('express');
const router  = express.Router();

// ─── Shared Schema-Definitionen ───────────────────────────────────────────────
const SCHEMAS = {
  Error: {
    type: 'object',
    properties: {
      error: { type: 'string', example: 'Fehlermeldung' },
    },
    required: ['error'],
  },

  User: {
    type: 'object',
    properties: {
      id:           { type: 'string', format: 'uuid' },
      username:     { type: 'string', example: 'john_doe' },
      email:        { type: 'string', format: 'email' },
      role:         { type: 'string', enum: ['admin', 'user'] },
      is_suspended: { type: 'integer', enum: [0, 1] },
      created_at:   { type: 'string', format: 'date-time' },
      updated_at:   { type: 'string', format: 'date-time' },
    },
  },

  Server: {
    type: 'object',
    properties: {
      id:              { type: 'string', format: 'uuid' },
      name:            { type: 'string', example: 'Minecraft SMP' },
      description:     { type: 'string' },
      user_id:         { type: 'string', format: 'uuid' },
      node_id:         { type: 'string', format: 'uuid', nullable: true },
      container_id:    { type: 'string', nullable: true },
      image:           { type: 'string', example: 'itzg/minecraft-server:latest' },
      cpu_limit:       { type: 'number', example: 2 },
      cpu_percent:     { type: 'integer', example: 100 },
      memory_limit:    { type: 'integer', example: 2048, description: 'MB' },
      swap_limit:      { type: 'integer', example: 0 },
      disk_limit:      { type: 'integer', example: 10240, description: 'MB' },
      ports:           { type: 'array', items: { type: 'object' } },
      env_vars:        { type: 'object', additionalProperties: { type: 'string' } },
      startup_command: { type: 'string' },
      work_dir:        { type: 'string', example: '/home/container' },
      network:         { type: 'string', example: 'bridge' },
      status:          { type: 'string', enum: ['installing', 'offline', 'running', 'starting', 'stopping', 'error'] },
      created_at:      { type: 'string', format: 'date-time' },
      updated_at:      { type: 'string', format: 'date-time' },
    },
  },

  ServerCreate: {
    type: 'object',
    required: ['name', 'image'],
    properties: {
      name:            { type: 'string', example: 'Minecraft SMP' },
      description:     { type: 'string', example: '' },
      image:           { type: 'string', example: 'itzg/minecraft-server:latest' },
      node_id:         { type: 'string', format: 'uuid', description: 'Leer lassen für Auto-Scaling' },
      cpu_limit:       { type: 'number', example: 2 },
      cpu_percent:     { type: 'integer', example: 100 },
      memory_limit:    { type: 'integer', example: 2048 },
      swap_limit:      { type: 'integer', example: 0 },
      disk_limit:      { type: 'integer', example: 10240 },
      ports:           { type: 'array', items: { type: 'object', properties: { host: { type: 'integer' }, container: { type: 'integer' }, proto: { type: 'string', enum: ['tcp','udp'] } } }, example: [{ host: 25565, container: 25565, proto: 'tcp' }] },
      env_vars:        { type: 'object', additionalProperties: { type: 'string' }, example: { EULA: 'TRUE', TYPE: 'PAPER', VERSION: 'LATEST' } },
      startup_command: { type: 'string' },
      work_dir:        { type: 'string', example: '/home/container' },
      network:         { type: 'string', example: 'bridge' },
      user_id:         { type: 'string', format: 'uuid', description: 'Nur für Admins: Server einem anderen User zuweisen' },
    },
  },

  Node: {
    type: 'object',
    properties: {
      id:         { type: 'string', format: 'uuid' },
      name:       { type: 'string', example: 'EU-DE-1' },
      fqdn:       { type: 'string', example: 'node1.example.com' },
      location:   { type: 'string', example: 'Frankfurt' },
      is_local:   { type: 'integer', enum: [0, 1] },
      is_default: { type: 'integer', enum: [0, 1] },
      status:     { type: 'string', enum: ['online', 'offline', 'unknown'] },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  Backup: {
    type: 'object',
    properties: {
      id:         { type: 'string', format: 'uuid' },
      server_id:  { type: 'string', format: 'uuid' },
      name:       { type: 'string' },
      size:       { type: 'integer', description: 'Bytes' },
      status:     { type: 'string', enum: ['creating', 'ready', 'failed'] },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  Allocation: {
    type: 'object',
    properties: {
      id:         { type: 'string', format: 'uuid' },
      node_id:    { type: 'string', format: 'uuid' },
      ip:         { type: 'string', example: '0.0.0.0' },
      port:       { type: 'integer', example: 25565 },
      server_id:  { type: 'string', format: 'uuid', nullable: true },
      is_primary: { type: 'integer', enum: [0, 1] },
      notes:      { type: 'string' },
    },
  },

  ScheduleTask: {
    type: 'object',
    properties: {
      id:          { type: 'string', format: 'uuid' },
      server_id:   { type: 'string', format: 'uuid' },
      name:        { type: 'string', example: 'Nightly Restart' },
      cron:        { type: 'string', example: '0 4 * * *' },
      action:      { type: 'string', enum: ['start', 'stop', 'restart', 'kill', 'command'] },
      payload:     { type: 'string', description: 'Befehl bei action=command' },
      enabled:     { type: 'integer', enum: [0, 1] },
      last_run:    { type: 'string', format: 'date-time', nullable: true },
      last_result: { type: 'string', nullable: true },
    },
  },

  WebhookRule: {
    type: 'object',
    properties: {
      id:          { type: 'string', format: 'uuid' },
      server_id:   { type: 'string', format: 'uuid', nullable: true },
      name:        { type: 'string' },
      url:         { type: 'string', format: 'uri' },
      events:      { type: 'array', items: { type: 'string' } },
      enabled:     { type: 'integer', enum: [0, 1] },
      secret:      { type: 'string', description: 'HMAC-Signatur Secret' },
      created_at:  { type: 'string', format: 'date-time' },
    },
  },

  ApiKey: {
    type: 'object',
    properties: {
      id:           { type: 'string', format: 'uuid' },
      name:         { type: 'string' },
      key_prefix:   { type: 'string', example: 'npk_abc123' },
      permissions:  { type: 'array', items: { type: 'string' } },
      last_used_at: { type: 'string', format: 'date-time', nullable: true },
      created_at:   { type: 'string', format: 'date-time' },
    },
  },

  ServerStats: {
    type: 'object',
    properties: {
      cpu:              { type: 'number', example: 34.5, description: 'CPU % (0–100×cores)' },
      memory_mb:        { type: 'number', example: 1024 },
      memory_limit_mb:  { type: 'number', example: 2048 },
      network_rx:       { type: 'integer', description: 'Bytes empfangen' },
      network_tx:       { type: 'integer', description: 'Bytes gesendet' },
      pids:             { type: 'integer' },
      status:           { type: 'string' },
    },
  },

  Group: {
    type: 'object',
    properties: {
      id:         { type: 'string', format: 'uuid' },
      name:       { type: 'string' },
      color:      { type: 'string', example: '#6366f1' },
      user_id:    { type: 'string', format: 'uuid' },
      created_at: { type: 'string', format: 'date-time' },
    },
  },

  AlertRule: {
    type: 'object',
    properties: {
      server_id:       { type: 'string', format: 'uuid' },
      enabled:         { type: 'integer', enum: [0, 1] },
      cpu_warn:        { type: 'integer', example: 80 },
      cpu_crit:        { type: 'integer', example: 95 },
      ram_warn:        { type: 'integer', example: 80 },
      ram_crit:        { type: 'integer', example: 95 },
      disk_warn:       { type: 'integer', example: 80 },
      disk_crit:       { type: 'integer', example: 95 },
      cooldown_minutes:{ type: 'integer', example: 30 },
      last_fired:      { type: 'string', description: 'JSON-Map letzte Alerts' },
    },
  },

  NotificationSettings: {
    type: 'object',
    properties: {
      discord_webhook: { type: 'string', format: 'uri', nullable: true },
      email_to:        { type: 'string', format: 'email', nullable: true },
      events:          { type: 'array', items: { type: 'string' }, example: ['server_start', 'server_stop', 'server_crash'] },
    },
  },

  OAuthConnection: {
    type: 'object',
    properties: {
      id:          { type: 'string', format: 'uuid' },
      provider:    { type: 'string', enum: ['github', 'discord'] },
      username:    { type: 'string' },
      email:       { type: 'string' },
      avatar_url:  { type: 'string' },
      created_at:  { type: 'string', format: 'date-time' },
    },
  },

  LoginRequest: {
    type: 'object',
    required: ['email', 'password'],
    properties: {
      email:    { type: 'string', format: 'email', example: 'admin@nexpanel.local' },
      password: { type: 'string', example: 'admin123' },
    },
  },

  LoginResponse: {
    type: 'object',
    properties: {
      token:         { type: 'string', description: 'JWT Bearer Token (24h gültig)' },
      user:          { $ref: '#/components/schemas/User' },
      requires_totp: { type: 'boolean', description: 'True wenn 2FA aktiv — totp_token zur Verifizierung nötig' },
      totp_token:    { type: 'string', description: 'Kurzlebiger Pending-Token für 2FA-Schritt 2 (5 min)' },
    },
  },

  Success: {
    type: 'object',
    properties: {
      success: { type: 'boolean', example: true },
    },
  },
};

// ─── Parameter-Helpers ────────────────────────────────────────────────────────
const pathParam = (name, desc) => ({
  name, in: 'path', required: true,
  schema: { type: 'string' },
  description: desc,
});

const SERVER_ID_PARAM = pathParam('id', 'Server UUID');
const SERVERID_PARAM  = pathParam('serverId', 'Server UUID');

// ─── Security Schemes ─────────────────────────────────────────────────────────
const BEARER_AUTH = [{ BearerAuth: [] }];

// ─── Response Helpers ─────────────────────────────────────────────────────────
const jsonResponse = (description, schemaOrRef) => ({
  [description.startsWith('2') ? description : '200']: {
    description: description.startsWith('2') ? 'OK' : description,
    content: { 'application/json': { schema: schemaOrRef } },
  },
  401: { description: 'Nicht authentifiziert', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  403: { description: 'Keine Berechtigung',    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  500: { description: 'Serverfehler',          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
});

const resp200 = (schema)  => ({ 200: { description: 'OK', content: { 'application/json': { schema } } }, 401: { description: 'Nicht authentifiziert' }, 500: { description: 'Serverfehler' } });
const resp201 = (schema)  => ({ 201: { description: 'Erstellt', content: { 'application/json': { schema } } }, 400: { description: 'Ungültige Eingabe' }, 401: { description: 'Nicht authentifiziert' }, 500: { description: 'Serverfehler' } });
const respOK  = ()        => resp200({ $ref: '#/components/schemas/Success' });
const respArr = (ref)     => resp200({ type: 'array', items: { $ref: ref } });
const respRef = (ref)     => resp200({ $ref: ref });

// ─── OpenAPI Spec Builder ─────────────────────────────────────────────────────
function buildSpec(baseUrl) {
  return {
    openapi: '3.0.3',
    info: {
      title:       'NexPanel API',
      version:     '3.0.0',
      description: `## NexPanel — Next-Gen Server Management Panel

Vollständige REST API für Server-Verwaltung, Multi-Node Deployment, Benutzer-Management und mehr.

### Authentifizierung
Alle geschützten Endpunkte erwarten einen **Bearer JWT Token** im \`Authorization\`-Header:
\`\`\`
Authorization: Bearer <token>
\`\`\`
Token erhältst du über \`POST /api/auth/login\`.

### API Keys
Alternativ können **API Keys** (erstellt unter \`/api/account/api-keys\`) als Bearer Token verwendet werden.

### Rate Limits
- Auth-Endpunkte: **10 Requests/15 min** pro IP
- Alle anderen API-Endpunkte: **300 Requests/min** pro IP

### Rollen
- \`user\` — eigene Server verwalten
- \`admin\` — alle Ressourcen, Admin-Endpunkte`,
      contact: {
        name:  'NexPanel',
        url:   'https://github.com/nexpanel',
        email: 'support@nexpanel.local',
      },
      license: { name: 'MIT', url: 'https://opensource.org/licenses/MIT' },
    },
    servers: [
      { url: `${baseUrl}/api`, description: 'Diese Instanz' },
    ],
    tags: [
      { name: 'Auth',          description: 'Login, Registrierung, 2FA, Passwort' },
      { name: 'OAuth',         description: 'Social Login (GitHub, Discord)' },
      { name: 'Servers',       description: 'Server CRUD, Power-Actions, Logs, Stats' },
      { name: 'Files',         description: 'Datei-Manager im Container' },
      { name: 'Backups',       description: 'Server-Backups erstellen, herunterladen, wiederherstellen' },
      { name: 'Schedule',      description: 'Geplante Aufgaben (Cron)' },
      { name: 'Subusers',      description: 'Server-Zugriffsberechtigungen teilen' },
      { name: 'Notifications', description: 'Discord/E-Mail Benachrichtigungen pro Server' },
      { name: 'Alerts',        description: 'CPU/RAM/Disk Schwellenwert-Alerts' },
      { name: 'Mods',          description: 'Mod/Plugin Installer (Modrinth, CurseForge, GitHub)' },
      { name: 'Nodes',         description: 'Multi-Node Daemon Verwaltung' },
      { name: 'Allocations',   description: 'Port-Allokationen' },
      { name: 'Groups',        description: 'Server-Gruppen und Tags' },
      { name: 'Webhooks',      description: 'Ausgehende Webhook-Regeln' },
      { name: 'Admin',         description: 'Admin-only: Benutzer, Audit, Docker, Scaling' },
      { name: 'Metrics',       description: 'Prometheus Metrics Export' },
    ],
    components: {
      schemas: SCHEMAS,
      securitySchemes: {
        BearerAuth: {
          type:         'http',
          scheme:       'bearer',
          bearerFormat: 'JWT',
          description:  'JWT Token aus /api/auth/login oder API Key aus /api/account/api-keys',
        },
      },
    },
    paths: buildPaths(),
  };
}

function buildPaths() {
  return {

    // ══════════════════════════════════════════════════════════════
    // AUTH
    // ══════════════════════════════════════════════════════════════
    '/auth/login': {
      post: {
        tags: ['Auth'], operationId: 'login', summary: 'Login (E-Mail + Passwort)',
        description: 'Gibt bei aktivierter 2FA `requires_totp: true` + `totp_token` zurück. Danach `POST /auth/totp/verify` aufrufen.',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
        responses: resp200({ $ref: '#/components/schemas/LoginResponse' }),
      },
    },
    '/auth/register': {
      post: {
        tags: ['Auth'], operationId: 'register', summary: 'Account registrieren',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username','email','password'], properties: { username: { type: 'string', example: 'john_doe' }, email: { type: 'string', format: 'email' }, password: { type: 'string', minLength: 8 } } } } } },
        responses: resp201({ type: 'object', properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } }),
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'], operationId: 'getMe', summary: 'Eigenes Profil abrufen',
        security: BEARER_AUTH,
        responses: respRef('#/components/schemas/User'),
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'], operationId: 'changePassword', summary: 'Passwort ändern',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['current_password','new_password'], properties: { current_password: { type: 'string' }, new_password: { type: 'string', minLength: 8 } } } } } },
        responses: respOK(),
      },
    },
    '/auth/totp/verify': {
      post: {
        tags: ['Auth'], operationId: 'totpVerify', summary: '2FA Login (Schritt 2) — TOTP Code',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['totp_token','code'], properties: { totp_token: { type: 'string', description: 'Pending Token aus /auth/login' }, code: { type: 'string', example: '123456' } } } } } },
        responses: resp200({ type: 'object', properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } }),
      },
    },
    '/auth/totp/recover': {
      post: {
        tags: ['Auth'], operationId: 'totpRecover', summary: '2FA Login via Backup-Code',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['totp_token','backup_code'], properties: { totp_token: { type: 'string' }, backup_code: { type: 'string', example: 'ABCDEF-123456' } } } } } },
        responses: resp200({ type: 'object', properties: { token: { type: 'string' }, user: { $ref: '#/components/schemas/User' } } }),
      },
    },
    '/auth/totp/status': {
      get: {
        tags: ['Auth'], operationId: 'totpStatus', summary: '2FA Status abrufen',
        security: BEARER_AUTH,
        responses: resp200({ type: 'object', properties: { enabled: { type: 'boolean' }, backup_codes_remaining: { type: 'integer' } } }),
      },
    },
    '/auth/totp/setup': {
      post: {
        tags: ['Auth'], operationId: 'totpSetup', summary: '2FA einrichten (QR-Code generieren)',
        security: BEARER_AUTH,
        responses: resp200({ type: 'object', properties: { secret: { type: 'string' }, qr_code: { type: 'string', description: 'Data-URL PNG' }, manual_entry: { type: 'string' } } }),
      },
    },
    '/auth/totp/confirm': {
      post: {
        tags: ['Auth'], operationId: 'totpConfirm', summary: '2FA aktivieren (Code bestätigen)',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['code'], properties: { code: { type: 'string', example: '123456' } } } } } },
        responses: resp200({ type: 'object', properties: { success: { type: 'boolean' }, backup_codes: { type: 'array', items: { type: 'string' }, description: '8 Einmal-Backup-Codes — nur jetzt einsehbar!' } } }),
      },
    },
    '/auth/totp/disable': {
      post: {
        tags: ['Auth'], operationId: 'totpDisable', summary: '2FA deaktivieren',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' }, code: { type: 'string', description: 'Optional TOTP Code' } } } } } },
        responses: respOK(),
      },
    },
    '/auth/totp/backup-codes/regen': {
      post: {
        tags: ['Auth'], operationId: 'totpRegenBackup', summary: 'Backup-Codes neu generieren',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['password'], properties: { password: { type: 'string' } } } } } },
        responses: resp200({ type: 'object', properties: { backup_codes: { type: 'array', items: { type: 'string' } } } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // OAuth
    // ══════════════════════════════════════════════════════════════
    '/auth/oauth/{provider}/url': {
      get: {
        tags: ['OAuth'], operationId: 'oauthUrl', summary: 'OAuth Authorization-URL abrufen',
        description: 'Gibt die Provider-URL zum Öffnen in einem Popup zurück. `provider` = `github` oder `discord`.',
        parameters: [pathParam('provider', 'OAuth Provider: github | discord'), { name: 'link_token', in: 'query', schema: { type: 'string' }, description: 'JWT zum Verknüpfen mit bestehendem Account' }],
        responses: resp200({ type: 'object', properties: { url: { type: 'string', format: 'uri' }, state: { type: 'string' } } }),
      },
    },
    '/auth/oauth/connections': {
      get: {
        tags: ['OAuth'], operationId: 'oauthConnections', summary: 'Verknüpfte OAuth-Konten abrufen',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/OAuthConnection'),
      },
    },
    '/auth/oauth/{provider}/unlink': {
      delete: {
        tags: ['OAuth'], operationId: 'oauthUnlink', summary: 'OAuth-Verknüpfung trennen',
        security: BEARER_AUTH,
        parameters: [pathParam('provider', 'github | discord')],
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // SERVERS
    // ══════════════════════════════════════════════════════════════
    '/servers': {
      get: {
        tags: ['Servers'], operationId: 'listServers', summary: 'Alle Server auflisten',
        description: 'Admins sehen alle Server, User nur ihre eigenen.',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/Server'),
      },
      post: {
        tags: ['Servers'], operationId: 'createServer', summary: 'Server erstellen',
        description: 'Erstellt Server + Docker Container. `node_id` leer lassen für Auto-Scaling.',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ServerCreate' } } } },
        responses: resp201({ $ref: '#/components/schemas/Server' }),
      },
    },
    '/servers/{id}': {
      get: {
        tags: ['Servers'], operationId: 'getServer', summary: 'Server abrufen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respRef('#/components/schemas/Server'),
      },
      patch: {
        tags: ['Servers'], operationId: 'updateServer', summary: 'Server aktualisieren',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, cpu_limit: { type: 'number' }, memory_limit: { type: 'integer' }, env_vars: { type: 'object' }, startup_command: { type: 'string' } } } } } },
        responses: respRef('#/components/schemas/Server'),
      },
      delete: {
        tags: ['Servers'], operationId: 'deleteServer', summary: 'Server löschen (inkl. Container)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },
    '/servers/{id}/power/start': {
      post: { tags: ['Servers'], operationId: 'serverStart', summary: 'Server starten', security: BEARER_AUTH, parameters: [SERVER_ID_PARAM], responses: respOK() },
    },
    '/servers/{id}/power/stop': {
      post: { tags: ['Servers'], operationId: 'serverStop', summary: 'Server stoppen', security: BEARER_AUTH, parameters: [SERVER_ID_PARAM], responses: respOK() },
    },
    '/servers/{id}/power/restart': {
      post: { tags: ['Servers'], operationId: 'serverRestart', summary: 'Server neustarten', security: BEARER_AUTH, parameters: [SERVER_ID_PARAM], responses: respOK() },
    },
    '/servers/{id}/power/kill': {
      post: { tags: ['Servers'], operationId: 'serverKill', summary: 'Server hart beenden (kill)', security: BEARER_AUTH, parameters: [SERVER_ID_PARAM], responses: respOK() },
    },
    '/servers/{id}/logs': {
      get: {
        tags: ['Servers'], operationId: 'serverLogs', summary: 'Container-Logs abrufen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM, { name: 'tail', in: 'query', schema: { type: 'integer', default: 100 } }],
        responses: resp200({ type: 'object', properties: { logs: { type: 'string' } } }),
      },
    },
    '/servers/{id}/command': {
      post: {
        tags: ['Servers'], operationId: 'serverCommand', summary: 'Befehl in Container senden',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['command'], properties: { command: { type: 'string', example: 'say Hello World' } } } } } },
        responses: resp200({ type: 'object', properties: { output: { type: 'string' } } }),
      },
    },
    '/servers/{id}/stats': {
      get: {
        tags: ['Servers'], operationId: 'serverStats', summary: 'Live-Stats (CPU, RAM, Netzwerk)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respRef('#/components/schemas/ServerStats'),
      },
    },
    '/servers/{id}/clone': {
      post: {
        tags: ['Servers'], operationId: 'serverClone', summary: 'Server klonen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'Klon von Server' } } } } } },
        responses: resp201({ $ref: '#/components/schemas/Server' }),
      },
    },
    '/servers/{serverId}/stats/history': {
      get: {
        tags: ['Servers'], operationId: 'serverStatsHistory', summary: 'Stats-Verlauf (bis 7 Tage)',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, { name: 'hours', in: 'query', schema: { type: 'integer', default: 6 } }],
        responses: resp200({ type: 'array', items: { $ref: '#/components/schemas/ServerStats' } }),
      },
    },
    '/servers/bulk/power': {
      post: {
        tags: ['Servers'], operationId: 'bulkPower', summary: 'Mehrere Server gleichzeitig starten/stoppen',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['server_ids','action'], properties: { server_ids: { type: 'array', items: { type: 'string' } }, action: { type: 'string', enum: ['start','stop','restart','kill'] } } } } } },
        responses: resp200({ type: 'object', properties: { results: { type: 'array', items: { type: 'object' } } } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // FILES
    // ══════════════════════════════════════════════════════════════
    '/servers/{serverId}/files/list': {
      get: {
        tags: ['Files'], operationId: 'fileList', summary: 'Verzeichnis auflisten',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, { name: 'path', in: 'query', required: true, schema: { type: 'string', example: '/home/container' } }],
        responses: resp200({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', enum: ['file','directory'] }, size: { type: 'integer' }, modified: { type: 'string' } } } }),
      },
    },
    '/servers/{serverId}/files/read': {
      get: {
        tags: ['Files'], operationId: 'fileRead', summary: 'Datei lesen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, { name: 'path', in: 'query', required: true, schema: { type: 'string', example: '/home/container/server.properties' } }],
        responses: resp200({ type: 'object', properties: { content: { type: 'string' } } }),
      },
    },
    '/servers/{serverId}/files/write': {
      post: {
        tags: ['Files'], operationId: 'fileWrite', summary: 'Datei schreiben/überschreiben',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path','content'], properties: { path: { type: 'string' }, content: { type: 'string' } } } } } },
        responses: respOK(),
      },
    },
    '/servers/{serverId}/files/create': {
      post: {
        tags: ['Files'], operationId: 'fileCreate', summary: 'Datei oder Ordner erstellen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path','type'], properties: { path: { type: 'string' }, type: { type: 'string', enum: ['file','directory'] } } } } } },
        responses: respOK(),
      },
    },
    '/servers/{serverId}/files/delete': {
      delete: {
        tags: ['Files'], operationId: 'fileDelete', summary: 'Datei/Ordner löschen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } } },
        responses: respOK(),
      },
    },
    '/servers/{serverId}/files/rename': {
      post: {
        tags: ['Files'], operationId: 'fileRename', summary: 'Datei umbenennen/verschieben',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['old_path','new_path'], properties: { old_path: { type: 'string' }, new_path: { type: 'string' } } } } } },
        responses: respOK(),
      },
    },
    '/servers/{serverId}/files/compress': {
      post: {
        tags: ['Files'], operationId: 'fileCompress', summary: 'Dateien komprimieren (tar.gz)',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['paths','dest'], properties: { paths: { type: 'array', items: { type: 'string' } }, dest: { type: 'string' } } } } } },
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // BACKUPS
    // ══════════════════════════════════════════════════════════════
    '/servers/{serverId}/backups': {
      get: {
        tags: ['Backups'], operationId: 'listBackups', summary: 'Backups auflisten',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: respArr('#/components/schemas/Backup'),
      },
      post: {
        tags: ['Backups'], operationId: 'createBackup', summary: 'Backup erstellen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', example: 'Pre-Update Backup' }, ignore: { type: 'string', description: 'Kommagetrennte Ausschlussmuster' } } } } } },
        responses: resp201({ $ref: '#/components/schemas/Backup' }),
      },
    },
    '/servers/{serverId}/backups/{backupId}': {
      get: {
        tags: ['Backups'], operationId: 'getBackup', summary: 'Backup-Details',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('backupId', 'Backup UUID')],
        responses: respRef('#/components/schemas/Backup'),
      },
      delete: {
        tags: ['Backups'], operationId: 'deleteBackup', summary: 'Backup löschen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('backupId', 'Backup UUID')],
        responses: respOK(),
      },
    },
    '/servers/{serverId}/backups/{backupId}/download': {
      get: {
        tags: ['Backups'], operationId: 'downloadBackup', summary: 'Backup herunterladen',
        description: 'Gibt eine temporäre Download-URL zurück.',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('backupId', 'Backup UUID')],
        responses: resp200({ type: 'object', properties: { url: { type: 'string', format: 'uri' } } }),
      },
    },
    '/servers/{serverId}/backups/{backupId}/restore': {
      post: {
        tags: ['Backups'], operationId: 'restoreBackup', summary: 'Backup wiederherstellen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('backupId', 'Backup UUID')],
        responses: respOK(),
      },
    },
    '/servers/{serverId}/backups/disk-usage': {
      get: {
        tags: ['Backups'], operationId: 'backupDiskUsage', summary: 'Backup-Speicherverbrauch',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'object', properties: { total_bytes: { type: 'integer' }, count: { type: 'integer' } } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // SCHEDULE
    // ══════════════════════════════════════════════════════════════
    '/servers/{serverId}/schedule': {
      get: {
        tags: ['Schedule'], operationId: 'listTasks', summary: 'Geplante Aufgaben auflisten',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: respArr('#/components/schemas/ScheduleTask'),
      },
      post: {
        tags: ['Schedule'], operationId: 'createTask', summary: 'Aufgabe erstellen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','cron','action'], properties: { name: { type: 'string' }, cron: { type: 'string', example: '0 4 * * *' }, action: { type: 'string', enum: ['start','stop','restart','kill','command'] }, payload: { type: 'string' }, enabled: { type: 'integer', enum: [0,1], default: 1 } } } } } },
        responses: resp201({ $ref: '#/components/schemas/ScheduleTask' }),
      },
    },
    '/servers/{serverId}/schedule/{taskId}': {
      patch: {
        tags: ['Schedule'], operationId: 'updateTask', summary: 'Aufgabe aktualisieren',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('taskId', 'Task UUID')],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, cron: { type: 'string' }, action: { type: 'string' }, payload: { type: 'string' }, enabled: { type: 'integer' } } } } } },
        responses: respOK(),
      },
      delete: {
        tags: ['Schedule'], operationId: 'deleteTask', summary: 'Aufgabe löschen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('taskId', 'Task UUID')],
        responses: respOK(),
      },
    },
    '/servers/{serverId}/schedule/{taskId}/run': {
      post: {
        tags: ['Schedule'], operationId: 'runTask', summary: 'Aufgabe sofort ausführen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, pathParam('taskId', 'Task UUID')],
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // SUBUSERS
    // ══════════════════════════════════════════════════════════════
    '/servers/{serverId}/subusers': {
      get: {
        tags: ['Subusers'], operationId: 'listSubusers', summary: 'Subuser auflisten',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, user_id: { type: 'string' }, username: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } } }),
      },
      post: {
        tags: ['Subusers'], operationId: 'addSubuser', summary: 'Subuser hinzufügen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' }, permissions: { type: 'array', items: { type: 'string' }, example: ['console', 'files.read', 'files.write', 'power'] } } } } } },
        responses: resp201({ type: 'object' }),
      },
    },
    '/servers/{serverId}/subusers/permissions': {
      get: {
        tags: ['Subusers'], operationId: 'listPermissions', summary: 'Verfügbare Berechtigungen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'array', items: { type: 'string' } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // NOTIFICATIONS
    // ══════════════════════════════════════════════════════════════
    '/servers/{serverId}/notifications': {
      get: {
        tags: ['Notifications'], operationId: 'getNotifications', summary: 'Benachrichtigungseinstellungen abrufen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: respRef('#/components/schemas/NotificationSettings'),
      },
      put: {
        tags: ['Notifications'], operationId: 'saveNotifications', summary: 'Benachrichtigungseinstellungen speichern',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/NotificationSettings' } } } },
        responses: respOK(),
      },
    },
    '/servers/{serverId}/notifications/test': {
      post: {
        tags: ['Notifications'], operationId: 'testNotification', summary: 'Test-Benachrichtigung senden',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { event: { type: 'string', example: 'server_start' } } } } } },
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // ALERTS
    // ══════════════════════════════════════════════════════════════
    '/servers/{id}/alerts': {
      get: {
        tags: ['Alerts'], operationId: 'getAlertRule', summary: 'Alert-Regel abrufen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respRef('#/components/schemas/AlertRule'),
      },
      put: {
        tags: ['Alerts'], operationId: 'saveAlertRule', summary: 'Alert-Regel speichern',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AlertRule' } } } },
        responses: respOK(),
      },
    },
    '/servers/{id}/alerts/reset-cooldown': {
      post: {
        tags: ['Alerts'], operationId: 'resetAlertCooldown', summary: 'Alert-Cooldown zurücksetzen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },
    '/servers/{id}/alerts/test': {
      post: {
        tags: ['Alerts'], operationId: 'testAlert', summary: 'Test-Alert auslösen (CPU 96%, RAM 97%)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // MODS
    // ══════════════════════════════════════════════════════════════
    '/servers/{serverId}/mods/platform': {
      get: {
        tags: ['Mods'], operationId: 'modPlatform', summary: 'Server-Plattform erkennen (game, loader)',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'object', properties: { game: { type: 'string', example: 'minecraft' }, loader: { type: 'string', example: 'paper' }, has_curseforge: { type: 'boolean' }, container_ready: { type: 'boolean' } } }),
      },
    },
    '/servers/{serverId}/mods/modrinth/search': {
      get: {
        tags: ['Mods'], operationId: 'modrinthSearch', summary: 'Modrinth durchsuchen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
        responses: resp200({ type: 'object', properties: { hits: { type: 'array', items: { type: 'object' } }, total: { type: 'integer' } } }),
      },
    },
    '/servers/{serverId}/mods/install': {
      post: {
        tags: ['Mods'], operationId: 'modInstall', summary: 'Mod installieren',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, filename: { type: 'string' }, dest_dir: { type: 'string' }, source: { type: 'string', enum: ['modrinth','curseforge','github','generic','workshop'] }, mod_name: { type: 'string' } } } } } },
        responses: resp200({ type: 'object', properties: { success: { type: 'boolean' }, filename: { type: 'string' }, dest: { type: 'string' }, file_size: { type: 'integer' } } }),
      },
    },
    '/servers/{serverId}/mods/installed': {
      get: {
        tags: ['Mods'], operationId: 'modListInstalled', summary: 'Installierte Mods auflisten',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, size: { type: 'integer' }, date: { type: 'string' }, dir: { type: 'string' }, ext: { type: 'string' } } } }),
      },
      delete: {
        tags: ['Mods'], operationId: 'modDelete', summary: 'Installierten Mod entfernen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } } } } },
        responses: respOK(),
      },
    },
    '/servers/{serverId}/mods/check-updates': {
      post: {
        tags: ['Mods'], operationId: 'modCheckUpdates', summary: 'Mod-Updates prüfen (Modrinth SHA1-Lookup)',
        description: 'Berechnet SHA1-Hashes aller JARs im Container und gleicht sie mit Modrinth ab.',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'object', properties: { updates: { type: 'array', items: { type: 'object' } }, checked: { type: 'integer' }, has_updates: { type: 'integer' } } }),
      },
    },
    '/servers/{serverId}/mods/update': {
      post: {
        tags: ['Mods'], operationId: 'modUpdate', summary: 'Einzelnen Mod aktualisieren',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['download_url','dir','filename'], properties: { old_path: { type: 'string' }, old_version: { type: 'string' }, new_version: { type: 'string' }, download_url: { type: 'string', format: 'uri' }, filename: { type: 'string' }, dir: { type: 'string' } } } } } },
        responses: resp200({ type: 'object', properties: { success: { type: 'boolean' }, file_size: { type: 'integer' } } }),
      },
    },
    '/servers/{serverId}/mods/update-all': {
      post: {
        tags: ['Mods'], operationId: 'modUpdateAll', summary: 'Alle verfügbaren Mod-Updates installieren',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['updates'], properties: { updates: { type: 'array', items: { type: 'object' } } } } } } },
        responses: resp200({ type: 'object', properties: { results: { type: 'array', items: { type: 'object' } }, updated: { type: 'integer' }, total: { type: 'integer' } } }),
      },
    },
    '/servers/{serverId}/mods/update-settings': {
      get: {
        tags: ['Mods'], operationId: 'getModUpdateSettings', summary: 'Auto-Update Einstellungen abrufen',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        responses: resp200({ type: 'object', properties: { auto_update: { type: 'integer' }, check_interval_h: { type: 'integer' }, last_check_at: { type: 'string', nullable: true } } }),
      },
      put: {
        tags: ['Mods'], operationId: 'saveModUpdateSettings', summary: 'Auto-Update Einstellungen speichern',
        security: BEARER_AUTH, parameters: [SERVERID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { auto_update: { type: 'integer', enum: [0,1] }, check_interval_h: { type: 'integer', example: 6 }, notify_on_update: { type: 'integer', enum: [0,1] } } } } } },
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // NODES
    // ══════════════════════════════════════════════════════════════
    '/nodes': {
      get: {
        tags: ['Nodes'], operationId: 'listNodes', summary: 'Nodes auflisten',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/Node'),
      },
      post: {
        tags: ['Nodes'], operationId: 'createNode', summary: 'Node registrieren (Admin)',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','fqdn'], properties: { name: { type: 'string' }, fqdn: { type: 'string' }, location: { type: 'string' }, is_local: { type: 'integer', enum: [0,1] }, is_default: { type: 'integer', enum: [0,1] } } } } } },
        responses: resp201({ $ref: '#/components/schemas/Node' }),
      },
    },
    '/nodes/{id}': {
      patch: {
        tags: ['Nodes'], operationId: 'updateNode', summary: 'Node aktualisieren (Admin)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, fqdn: { type: 'string' }, location: { type: 'string' } } } } } },
        responses: respOK(),
      },
      delete: {
        tags: ['Nodes'], operationId: 'deleteNode', summary: 'Node entfernen (Admin)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },
    '/nodes/{id}/rotate-token': {
      post: {
        tags: ['Nodes'], operationId: 'rotateNodeToken', summary: 'Node-Daemon Token rotieren (Admin)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: resp200({ type: 'object', properties: { token: { type: 'string' }, token_prefix: { type: 'string' } } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // ALLOCATIONS
    // ══════════════════════════════════════════════════════════════
    '/allocations': {
      get: {
        tags: ['Allocations'], operationId: 'listAllocations', summary: 'Port-Allokationen auflisten',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/Allocation'),
      },
      post: {
        tags: ['Allocations'], operationId: 'createAllocation', summary: 'Port-Allokation anlegen (Admin)',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['node_id','ip','port'], properties: { node_id: { type: 'string' }, ip: { type: 'string', example: '0.0.0.0' }, port: { type: 'integer', example: 25565 } } } } } },
        responses: resp201({ $ref: '#/components/schemas/Allocation' }),
      },
    },
    '/allocations/bulk': {
      post: {
        tags: ['Allocations'], operationId: 'bulkCreateAllocations', summary: 'Port-Range anlegen (Admin)',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['node_id','port_start','port_end'], properties: { node_id: { type: 'string' }, ip: { type: 'string' }, port_start: { type: 'integer' }, port_end: { type: 'integer' } } } } } },
        responses: resp201({ type: 'object', properties: { created: { type: 'integer' }, skipped: { type: 'integer' } } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // GROUPS
    // ══════════════════════════════════════════════════════════════
    '/groups': {
      get: {
        tags: ['Groups'], operationId: 'listGroups', summary: 'Server-Gruppen auflisten',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/Group'),
      },
      post: {
        tags: ['Groups'], operationId: 'createGroup', summary: 'Gruppe erstellen',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, color: { type: 'string', example: '#6366f1' } } } } } },
        responses: resp201({ $ref: '#/components/schemas/Group' }),
      },
    },
    '/groups/{id}': {
      patch: {
        tags: ['Groups'], operationId: 'updateGroup', summary: 'Gruppe umbenennen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, color: { type: 'string' } } } } } },
        responses: respOK(),
      },
      delete: {
        tags: ['Groups'], operationId: 'deleteGroup', summary: 'Gruppe löschen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },
    '/groups/{id}/servers': {
      post: {
        tags: ['Groups'], operationId: 'addServerToGroup', summary: 'Server zur Gruppe hinzufügen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['server_id'], properties: { server_id: { type: 'string' } } } } } },
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // WEBHOOKS
    // ══════════════════════════════════════════════════════════════
    '/webhooks': {
      get: {
        tags: ['Webhooks'], operationId: 'listWebhooks', summary: 'Webhook-Regeln auflisten',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/WebhookRule'),
      },
      post: {
        tags: ['Webhooks'], operationId: 'createWebhook', summary: 'Webhook erstellen',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name','url','events'], properties: { name: { type: 'string' }, url: { type: 'string', format: 'uri' }, events: { type: 'array', items: { type: 'string' } }, server_id: { type: 'string', nullable: true, description: 'null = alle Server' }, secret: { type: 'string' }, enabled: { type: 'integer', enum: [0,1] } } } } } },
        responses: resp201({ $ref: '#/components/schemas/WebhookRule' }),
      },
    },
    '/webhooks/{id}/test': {
      post: {
        tags: ['Webhooks'], operationId: 'testWebhook', summary: 'Test-Event an Webhook senden',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: resp200({ type: 'object', properties: { status: { type: 'integer' }, ok: { type: 'boolean' } } }),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // ADMIN
    // ══════════════════════════════════════════════════════════════
    '/admin/stats': {
      get: {
        tags: ['Admin'], operationId: 'adminStats', summary: 'Panel-Statistiken (Admin)',
        security: BEARER_AUTH,
        responses: resp200({ type: 'object', properties: { total_servers: { type: 'integer' }, running_servers: { type: 'integer' }, total_users: { type: 'integer' }, total_nodes: { type: 'integer' }, memory_total_mb: { type: 'integer' }, memory_used_mb: { type: 'integer' } } }),
      },
    },
    '/admin/audit-log': {
      get: {
        tags: ['Admin'], operationId: 'auditLog', summary: 'Audit-Log abrufen (Admin)',
        security: BEARER_AUTH,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }],
        responses: resp200({ type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, user_id: { type: 'string' }, action: { type: 'string' }, resource_type: { type: 'string' }, resource_id: { type: 'string' }, meta: { type: 'string' }, ip: { type: 'string' }, created_at: { type: 'string' } } } }),
      },
    },
    '/admin/users': {
      get: {
        tags: ['Admin'], operationId: 'listUsers', summary: 'Alle Benutzer auflisten (Admin)',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/User'),
      },
      post: {
        tags: ['Admin'], operationId: 'createUser', summary: 'Benutzer anlegen (Admin)',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['username','email','password'], properties: { username: { type: 'string' }, email: { type: 'string', format: 'email' }, password: { type: 'string' }, role: { type: 'string', enum: ['user','admin'], default: 'user' } } } } } },
        responses: resp201({ $ref: '#/components/schemas/User' }),
      },
    },
    '/admin/users/{id}': {
      patch: {
        tags: ['Admin'], operationId: 'updateUser', summary: 'Benutzer bearbeiten (Admin)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { username: { type: 'string' }, email: { type: 'string' }, role: { type: 'string', enum: ['user','admin'] }, is_suspended: { type: 'integer', enum: [0,1] }, password: { type: 'string' } } } } } },
        responses: respOK(),
      },
      delete: {
        tags: ['Admin'], operationId: 'deleteUser', summary: 'Benutzer löschen (Admin)',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },
    '/admin/scaling/config': {
      get: {
        tags: ['Admin'], operationId: 'getScalingConfig', summary: 'Auto-Scaling Konfiguration abrufen',
        security: BEARER_AUTH,
        responses: resp200({ type: 'object' }),
      },
      put: {
        tags: ['Admin'], operationId: 'saveScalingConfig', summary: 'Auto-Scaling Konfiguration speichern',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // API KEYS
    // ══════════════════════════════════════════════════════════════
    '/account/api-keys': {
      get: {
        tags: ['Auth'], operationId: 'listApiKeys', summary: 'API Keys auflisten',
        security: BEARER_AUTH,
        responses: respArr('#/components/schemas/ApiKey'),
      },
      post: {
        tags: ['Auth'], operationId: 'createApiKey', summary: 'API Key erstellen',
        description: 'Der vollständige Key wird **nur einmal** zurückgegeben.',
        security: BEARER_AUTH,
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', example: 'CI/CD Pipeline' }, permissions: { type: 'array', items: { type: 'string' }, example: ['servers:read'] } } } } } },
        responses: resp201({ type: 'object', properties: { key: { type: 'string', description: 'Vollständiger Key — nur jetzt sichtbar!' }, ...SCHEMAS.ApiKey.properties } }),
      },
    },
    '/account/api-keys/{id}': {
      delete: {
        tags: ['Auth'], operationId: 'deleteApiKey', summary: 'API Key löschen',
        security: BEARER_AUTH, parameters: [SERVER_ID_PARAM],
        responses: respOK(),
      },
    },

    // ══════════════════════════════════════════════════════════════
    // METRICS
    // ══════════════════════════════════════════════════════════════
    '/admin/metrics/token': {
      get: {
        tags: ['Metrics'], operationId: 'getMetricsToken', summary: 'Prometheus Token-Status (Admin)',
        security: BEARER_AUTH,
        responses: resp200({ type: 'object', properties: { configured: { type: 'boolean' }, preview: { type: 'string', nullable: true } } }),
      },
      post: {
        tags: ['Metrics'], operationId: 'generateMetricsToken', summary: 'Prometheus Token generieren (Admin)',
        security: BEARER_AUTH,
        responses: resp200({ type: 'object', properties: { token: { type: 'string', description: 'Einmalig angezeigt!' }, preview: { type: 'string' } } }),
      },
      delete: {
        tags: ['Metrics'], operationId: 'deleteMetricsToken', summary: 'Prometheus Token löschen (Admin)',
        security: BEARER_AUTH,
        responses: respOK(),
      },
    },
  };
}

// ─── GET /api/docs/openapi.json ───────────────────────────────────────────────
router.get('/openapi.json', (req, res) => {
  const proto   = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host    = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
  const baseUrl = `${proto}://${host}`;
  res.set('Content-Type', 'application/json');
  res.set('Access-Control-Allow-Origin', '*');
  res.json(buildSpec(baseUrl));
});

// ─── GET /api/docs  →  Swagger UI ────────────────────────────────────────────
router.get('/', (req, res) => {
  const proto   = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host    = req.headers['x-forwarded-host']  || req.headers.host || 'localhost:3000';
  const baseUrl = `${proto}://${host}`;

  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NexPanel API — Dokumentation</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJnIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwZDRmZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwMGY1YTAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiIgcng9IjciIGZpbGw9InVybCgjYmcpIi8+CiAgPHBvbHlnb24gcG9pbnRzPSIxOSwzIDExLDE3IDE1LjUsMTcgMTMsMjkgMjEsMTUgMTYuNSwxNSIgZmlsbD0iIzAwMGIxOCIgb3BhY2l0eT0iMC44OCIvPgo8L3N2Zz4="/>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui.min.css" crossorigin="anonymous"/>
  <style>
    /* ── Reset panel chrome ── */
    body { margin: 0; background: #0f172a; }
    .swagger-ui .topbar { display: none !important; }

    /* ── Dark theme overrides ── */
    .swagger-ui,
    .swagger-ui .wrapper,
    .swagger-ui .information-container,
    .swagger-ui .scheme-container { background: #0f172a !important; }
    .swagger-ui .info { margin: 24px 0 8px !important; }
    .swagger-ui .info .title { color: #f1f5f9 !important; font-size: 28px !important; }
    .swagger-ui .info p,
    .swagger-ui .info li,
    .swagger-ui .info td  { color: #94a3b8 !important; }
    .swagger-ui .info code { background: #1e293b !important; color: #7dd3fc !important; }
    .swagger-ui .info a   { color: #7dd3fc !important; }

    /* Sections */
    .swagger-ui .opblock-tag { background: #1e293b !important; border-radius: 8px !important; border: 1px solid #334155 !important; margin-bottom: 6px !important; color: #e2e8f0 !important; }
    .swagger-ui .opblock-tag:hover { background: #263348 !important; }
    .swagger-ui .opblock     { border-radius: 6px !important; border: 1px solid #334155 !important; margin-bottom: 6px !important; }
    .swagger-ui .opblock .opblock-summary { background: #1e293b !important; border-radius: 6px !important; }
    .swagger-ui .opblock .opblock-summary-path,
    .swagger-ui .opblock .opblock-summary-operation-id { color: #f1f5f9 !important; }
    .swagger-ui .opblock .opblock-summary-description { color: #94a3b8 !important; }
    .swagger-ui .opblock-body { background: #111827 !important; }
    .swagger-ui .opblock-section-header { background: #1e293b !important; }
    .swagger-ui .opblock-section-header h4 { color: #94a3b8 !important; }

    /* Method badges */
    .swagger-ui .opblock.opblock-get    { background: rgba(59,130,246,.08) !important; border-color: rgba(59,130,246,.3) !important; }
    .swagger-ui .opblock.opblock-post   { background: rgba(34,197,94,.08)  !important; border-color: rgba(34,197,94,.3)  !important; }
    .swagger-ui .opblock.opblock-put    { background: rgba(251,191,36,.08) !important; border-color: rgba(251,191,36,.3) !important; }
    .swagger-ui .opblock.opblock-patch  { background: rgba(168,85,247,.08) !important; border-color: rgba(168,85,247,.3) !important; }
    .swagger-ui .opblock.opblock-delete { background: rgba(239,68,68,.08)  !important; border-color: rgba(239,68,68,.3)  !important; }

    /* Text / inputs */
    .swagger-ui label,
    .swagger-ui .parameter__name,
    .swagger-ui .response-col_status,
    .swagger-ui table thead tr th { color: #e2e8f0 !important; }
    .swagger-ui .parameter__type { color: #7dd3fc !important; }
    .swagger-ui .renderedMarkdown p { color: #94a3b8 !important; }
    .swagger-ui textarea,
    .swagger-ui input[type=text],
    .swagger-ui input[type=email],
    .swagger-ui input[type=password],
    .swagger-ui select {
      background: #1e293b !important; color: #f1f5f9 !important;
      border: 1px solid #475569 !important; border-radius: 4px !important;
    }
    .swagger-ui .model-box,
    .swagger-ui .model       { background: #1e293b !important; color: #cbd5e1 !important; }
    .swagger-ui .model-title { color: #7dd3fc !important; }

    /* Buttons */
    .swagger-ui .btn          { border-radius: 6px !important; font-weight: 600 !important; }
    .swagger-ui .btn.authorize {
      background: #3b82f6 !important; color: #fff !important;
      border-color: #3b82f6 !important;
    }
    .swagger-ui .btn.execute  { background: #6366f1 !important; color: #fff !important; border-color: #6366f1 !important; }
    .swagger-ui .btn.cancel   { background: transparent !important; color: #94a3b8 !important; border-color: #475569 !important; }

    /* Response */
    .swagger-ui .responses-table .response-col_description { color: #cbd5e1 !important; }
    .swagger-ui .response-col_status { color: #7dd3fc !important; }
    .swagger-ui .highlight-code { background: #1e293b !important; }
    .swagger-ui .microlight { background: #1e293b !important; color: #7dd3fc !important; }


    /* ── Additional clarity fixes ── */
    .swagger-ui .parameter__name { color: #f1f5f9 !important; font-weight: 600 !important; }
    .swagger-ui .parameter__in   { color: #7dd3fc !important; font-size: 11px !important; }
    .swagger-ui .response-col_description code { background: #0f172a !important; color: #7dd3fc !important; padding: 2px 6px !important; border-radius: 4px !important; }
    .swagger-ui .opblock-description-wrapper p { color: #94a3b8 !important; }
    .swagger-ui .scheme-container .schemes > label { color: #94a3b8 !important; }
    .swagger-ui section.models { background: #1e293b !important; border: 1px solid #334155 !important; border-radius: 8px !important; }
    .swagger-ui section.models h4 { color: #f1f5f9 !important; }
    .swagger-ui .model-toggle:after { color: #7dd3fc !important; }
    .swagger-ui .prop-type { color: #7dd3fc !important; }
    .swagger-ui .prop-format { color: #a5b4fc !important; }
    .swagger-ui table.model tr.property-row td { color: #cbd5e1 !important; border-color: #334155 !important; }
    .swagger-ui .filter-container input { background: #1e293b !important; color: #f1f5f9 !important; border-color: #475569 !important; }
    /* Fix white flash on load */
    #swagger-ui { min-height: 100vh; }
    .swagger-ui .wrapper { padding: 0 16px !important; }
    /* Scrollbar */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0f172a; }
    ::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }

    /* Header bar */
    #nexpanel-header {
      background: #1e293b;
      border-bottom: 1px solid #334155;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      gap: 14px;
      position: sticky;
      top: 0;
      z-index: 1000;
    }
    #nexpanel-header .logo {
      display: flex; align-items: center; gap: 8px;
      font-weight: 700; font-size: 17px; color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      text-decoration: none;
    }
    #nexpanel-header .logo span { color: #6366f1; }
    #nexpanel-header .badge {
      font-size: 10px; background: #6366f1; color: #fff;
      padding: 2px 8px; border-radius: 10px; font-weight: 600;
    }
    #nexpanel-header .actions { margin-left: auto; display: flex; gap: 8px; }
    #nexpanel-header a.btn-back {
      font-size: 12px; color: #94a3b8; text-decoration: none;
      padding: 5px 12px; border: 1px solid #334155; border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    #nexpanel-header a.btn-back:hover { background: #263348; color: #f1f5f9; }
    #nexpanel-header .token-quick {
      display: flex; gap: 6px; align-items: center;
    }
    #nexpanel-header #token-input {
      background: #0f172a; border: 1px solid #334155; color: #f1f5f9;
      border-radius: 6px; padding: 5px 10px; font-size: 12px;
      font-family: monospace; width: 260px;
    }
    #nexpanel-header #token-input::placeholder { color: #475569; }
    #nexpanel-header button.btn-auth {
      background: #6366f1; color: #fff; border: none; border-radius: 6px;
      padding: 5px 14px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    #nexpanel-header button.btn-auth:hover { background: #4f46e5; }
    #nexpanel-header button.btn-auth.active { background: #16a34a; }
  </style>
</head>
<body>

<!-- NexPanel Header -->
<div id="nexpanel-header">
  <a href="/" class="logo">
    <img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+CiAgPGRlZnM+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJnIiB4MT0iMCUiIHkxPSIwJSIgeDI9IjEwMCUiIHkyPSIxMDAlIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzAwZDRmZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMwMGY1YTAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICA8bGluZWFyR3JhZGllbnQgaWQ9ImJvbHQiIHgxPSIwJSIgeTE9IjAlIiB4Mj0iMTAwJSIgeTI9IjEwMCUiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjMDAwYjE4Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzAwMWEyZSIvPgogICAgPC9saW5lYXJHcmFkaWVudD4KICA8L2RlZnM+CiAgPCEtLSBSb3VuZGVkIHNxdWFyZSBiYWNrZ3JvdW5kIC0tPgogIDxyZWN0IHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgcng9IjE0IiBmaWxsPSJ1cmwoI2JnKSIvPgogIDwhLS0gTGlnaHRuaW5nIGJvbHQgLyB6YXAgc2hhcGUgLS0+CiAgPHBvbHlnb24gcG9pbnRzPSIzOCw2IDIyLDM0IDMxLDM0IDI2LDU4IDQyLDMwIDMzLDMwIiBmaWxsPSJ1cmwoI2JvbHQpIiBvcGFjaXR5PSIwLjkiLz4KICA8IS0tIFNtYWxsIGFjY2VudCBkb3QgLS0+CiAgPGNpcmNsZSBjeD0iNDgiIGN5PSIxOCIgcj0iNCIgZmlsbD0iIzAwMGIxOCIgb3BhY2l0eT0iMC4zNSIvPgo8L3N2Zz4=" width="20" height="20" style="border-radius:6px;flex-shrink:0" alt="NexPanel"/>
    Nex<span>Panel</span>
    <span class="badge">API v3.0</span>
  </a>
  <div class="token-quick">
    <input id="token-input" type="password" placeholder="JWT Token zum Testen einfügen…" autocomplete="off"/>
    <button class="btn-auth" id="btn-auth-apply" onclick="window.applyToken()">Anwenden</button>
  </div>
  <div class="actions">
    <a href="${baseUrl}/api/docs/openapi.json" target="_blank" class="btn-back">OpenAPI JSON</a>
    <a href="${baseUrl}" class="btn-back">← Zurück zum Panel</a>
  </div>
</div>

<div id="swagger-ui"></div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-bundle.min.js" crossorigin="anonymous"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14/swagger-ui-standalone-preset.min.js" crossorigin="anonymous"></script>
<script>
  const specUrl = '${baseUrl}/api/docs/openapi.json';

  // ui declared in outer scope so applyToken can reference it
  let ui;

  function authorizeUi(token) {
    if (!ui) return;
    ui.preauthorizeApiKey('BearerAuth', token);
  }

  window.applyToken = function() {
    const token = document.getElementById('token-input').value.trim();
    if (!token) return;
    authorizeUi(token);
    localStorage.setItem('nexpanel_docs_token', token);
    const btn = document.getElementById('btn-auth-apply');
    btn.classList.add('active');
    btn.textContent = '✓ Aktiv';
  };

  // Wait for both scripts to load before initializing
  window.addEventListener('load', () => {
    if (typeof SwaggerUIBundle === 'undefined') {
      document.getElementById('swagger-ui').innerHTML =
        '<div style="color:#f87171;padding:32px;font-family:sans-serif">Swagger UI konnte nicht geladen werden — bitte Internetverbindung prüfen.</div>';
      return;
    }

    ui = SwaggerUIBundle({
      url:            specUrl,
      dom_id:         '#swagger-ui',
      presets:        [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      layout:         'StandaloneLayout',
      deepLinking:    true,
      displayRequestDuration: true,
      filter:         true,
      tryItOutEnabled: true,
      requestSnippetsEnabled: true,
      persistAuthorization: true,
      tagsSorter:     'alpha',
      operationsSorter: 'alpha',
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 2,
      docExpansion:   'none',
      onComplete: () => {
        // Restore saved token after UI is fully ready
        const saved = localStorage.getItem('nexpanel_docs_token');
        if (saved) {
          document.getElementById('token-input').value = saved;
          authorizeUi(saved);
          const btn = document.getElementById('btn-auth-apply');
          btn.classList.add('active');
          btn.textContent = '✓ Aktiv';
        }
      },
    });
  });

  // Enter key in token input
  document.getElementById('token-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') window.applyToken();
  });

  // Clear indicator on input change
  document.getElementById('token-input').addEventListener('input', () => {
    const btn = document.getElementById('btn-auth-apply');
    btn.classList.remove('active');
    btn.textContent = 'Anwenden';
  });
</script>
</body>
</html>`);
});

module.exports = router;
