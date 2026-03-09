# NexPanel

> Dein selbst gehostetes Server-Management-Panel der nächsten Generation. Verwalte Docker-Container, überwache Ressourcen in Echtzeit, installiere Plugins, plane automatische Aufgaben und vergib gezielten Zugriff an dein Team — alles in einer modernen, übersichtlichen Oberfläche.

---

## Features

- **Multi-Node** — Lokales Docker + beliebig viele Remote-Nodes über Daemon-Architektur
- **Server-Management** — Erstellen, starten, stoppen, neustarten, klonen, löschen
- **Live-Konsole** — WebSocket-Echtzeit-Output + Befehlseingabe (Minecraft: RCON-basiert)
- **Ressourcen-Monitoring** — CPU, RAM, Netzwerk-I/O, Prozesse als Live-Graphen (Chart.js)
- **Datei-Manager** — Verzeichnisse durchsuchen, Dateien lesen/bearbeiten/erstellen/löschen
- **Mod/Plugin-Installer** — Modrinth, CurseForge, GitHub Releases, direkte URLs
- **Port-Verwaltung** — Mehrere Ports pro Server, primär/sekundär, Live-Update im Container
- **Geplante Tasks** — Cronjobs pro Server (Start, Stop, Restart, Befehl)
- **Sub-User** — Andere Nutzer mit granularen Berechtigungen einladen
- **Aktivitäts-Log** — Vollständige Audit-Trail pro Server
- **Eggs/Templates** — Wiederverwendbare Server-Vorlagen inkl. Minecraft, Valheim u.v.m.
- **API Keys** — Programmatischer Zugriff per Bearer-Token
- **Mobil-optimiert** — Responsive Layout für alle Bildschirmgrößen

---

## Dateistruktur

```
nexpanel/
├── server.js              ← Einstiegspunkt (Panel)
├── daemon.js              ← Node-Daemon (läuft auf Remote-Servern)
├── daemon-hub.js          ← Verwaltung von Daemon-WebSocket-Verbindungen
├── node-router.js         ← Intelligentes Routing: Daemon oder lokales Docker
├── docker-local.js        ← Lokaler Docker-Client
├── ws-panel.js            ← WebSocket für Browser-Clients
├── scheduler.js           ← Hintergrund-Cron-Runner
├── db.js                  ← SQLite-Datenbank, Schema, Migrationen
├── routes/
│   ├── auth.js            ← Login, Register, JWT-Middleware
│   ├── servers.js         ← Server-CRUD, Power, Logs, Clone
│   ├── nodes.js           ← Node-Management
│   ├── allocations.js     ← Port-Allokationen + Server-Port-Verwaltung
│   ├── eggs.js            ← Server-Templates
│   ├── files.js           ← Datei-Manager
│   ├── mods.js            ← Mod/Plugin-Installer
│   ├── schedule.js        ← Geplante Tasks (Cronjobs)
│   ├── subusers.js        ← Sub-User-Verwaltung pro Server
│   └── admin.js           ← Admin, Benutzer, Audit-Log, Docker-Images
└── public/
    └── index.html         ← Single-Page-App (vollständiges Frontend)
```

---

## Installation

```bash
# Repository klonen oder ZIP entpacken
cd nexpanel

# Abhängigkeiten installieren
npm install

# Panel starten
node server.js
```

Standardmäßig läuft NexPanel auf **http://localhost:3000**

**Standard-Login:**
```
E-Mail:   admin@hostpanel.local
Passwort: admin123
```

> ⚠️ Admin-Passwort nach dem ersten Login unbedingt ändern.

---

## Umgebungsvariablen

Erstelle eine `.env`-Datei im Projektverzeichnis:

```env
# Panel
PORT=3000
DB_PATH=./nexpanel.db

# Admin-Standardkonto (nur beim ersten Start)
ADMIN_EMAIL=admin@example.com
ADMIN_PASS=sicherespasswort

# JWT (wird automatisch generiert und in der DB gespeichert, falls nicht gesetzt)
JWT_SECRET=

# Docker-Socket
# Linux:
DOCKER_SOCKET=/var/run/docker.sock
# Windows (Docker Desktop):
DOCKER_SOCKET=//./pipe/docker_engine

# Mod-Installer
CURSEFORGE_API_KEY=   # optional, für CurseForge-Support
```

---

## Betriebsmodi

### Modus 1 — Nur lokales Docker
Kein Daemon nötig. NexPanel spricht direkt mit Docker auf dem gleichen Server.

```
NexPanel
  └── Docker (lokal)
```

### Modus 2 — Multi-Node mit Daemons

```
NexPanel
  ├── Node 1 (daemon.js) → Docker
  ├── Node 2 (daemon.js) → Docker
  └── Node 3 (daemon.js) → Docker
```

### Modus 3 — Hybrid
Lokaler Node + beliebig viele Remote-Nodes gleichzeitig.

---

## Remote-Node einrichten

### 1. Node im Panel anlegen
**Admin → Nodes → "Node hinzufügen"** → Token einmalig kopieren.

### 2. Daemon auf dem Remote-Server starten

```bash
npm install ws dockerode

NODE_ID="<node-id>" \
NODE_TOKEN="hpd_<token>" \
PANEL_URL="ws://deine-panel-ip:3000" \
node daemon.js
```

### 3. Als Systemd-Service (empfohlen)

```ini
# /etc/systemd/system/nexpanel-daemon.service
[Unit]
Description=NexPanel Node Daemon
After=docker.service

[Service]
Environment=NODE_ID=<node-id>
Environment=NODE_TOKEN=hpd_<token>
Environment=PANEL_URL=ws://panel-ip:3000
ExecStart=/usr/bin/node /opt/nexpanel/daemon.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now nexpanel-daemon
```

---

## Minecraft-Server

NexPanel unterstützt `itzg/minecraft-server` nativ:

- **Verzeichnis:** `/data` (automatisch erkannt)
- **Konsole:** Befehle via RCON (läuft automatisch auf Port 25575)
- **Kein Startup-Befehl** nötig — das Image steuert sich über ENV-Variablen
- **Empfohlene ENV-Variablen:**

```
EULA=TRUE
TYPE=PAPER
VERSION=1.21.1
MEMORY=1500M
ENABLE_RCON=true
```

> RAM-Limit des Containers ≥ `MEMORY` + 256 MB Reserve setzen.

---

## API-Endpunkte (Übersicht)

| Methode | Pfad | Beschreibung |
|---------|------|--------------|
| `POST` | `/api/auth/login` | Login → JWT |
| `POST` | `/api/auth/register` | Registrierung |
| `GET` | `/api/servers` | Server-Liste |
| `POST` | `/api/servers` | Server erstellen |
| `POST` | `/api/servers/:id/clone` | Server klonen |
| `POST` | `/api/servers/:id/power/start` | Starten |
| `POST` | `/api/servers/:id/power/stop` | Stoppen |
| `POST` | `/api/servers/:id/power/restart` | Neustarten |
| `GET` | `/api/servers/:id/files/list` | Verzeichnis auflisten |
| `GET` | `/api/servers/:id/ports` | Ports des Servers |
| `POST` | `/api/servers/:id/ports` | Port zuweisen |
| `PUT` | `/api/servers/:id/ports/:allocId/primary` | Primär-Port setzen |
| `GET` | `/api/servers/:id/schedule` | Geplante Tasks |
| `POST` | `/api/servers/:id/schedule` | Task erstellen |
| `GET` | `/api/servers/:id/subusers` | Sub-User auflisten |
| `POST` | `/api/servers/:id/subusers` | Sub-User einladen |
| `GET` | `/api/servers/:id/mods/search` | Mods suchen |
| `POST` | `/api/servers/:id/mods/install` | Mod installieren |
| `GET` | `/api/nodes` | Node-Liste |
| `POST` | `/api/nodes` | Node hinzufügen |
| `GET` | `/api/allocations` | Port-Allokationen |
| `GET` | `/api/admin/audit-log` | Globales Audit-Log |
| `GET` | `/api/admin/audit-log/server/:id` | Server-Aktivitäts-Log |
| `GET` | `/api/admin/users` | Benutzerverwaltung |

---

## WebSocket-Protokoll

**Browser → Panel** (`/ws`):
```json
{ "type": "auth",              "token": "<jwt>" }
{ "type": "subscribe_stats",   "server_id": "<id>" }
{ "type": "console.subscribe", "server_id": "<id>" }
{ "type": "console.input",     "server_id": "<id>", "data": "say Hallo" }
{ "type": "unsubscribe",       "server_id": "<id>" }
```

**Daemon → Panel** (`/daemon`):
```
Header: x-node-id: <node-id>
Header: x-node-token: hpd_<token>
```

---

## Sub-User Berechtigungen

| Berechtigung | Beschreibung |
|---|---|
| `console` | Konsole lesen und Befehle senden |
| `files` | Dateien lesen, bearbeiten und hochladen |
| `startup` | Startup-Befehl und Umgebungsvariablen ändern |
| `allocations` | Ports verwalten |
| `schedule` | Geplante Tasks erstellen und ausführen |
| `backups` | Backups erstellen und wiederherstellen |

---

## Cron-Format (Geplante Tasks)

```
┌───── Minute    (0–59)
│ ┌─── Stunde    (0–23)
│ │ ┌─── Tag     (1–31)
│ │ │ ┌─── Monat (1–12)
│ │ │ │ ┌─── Wochentag (0–7, 0/7 = Sonntag)
│ │ │ │ │
* * * * *
```

Beispiele:
```
0 4 * * *      → täglich um 04:00
0 */6 * * *    → alle 6 Stunden
*/30 * * * *   → alle 30 Minuten
0 0 * * 0      → jeden Sonntag um Mitternacht
0 4 * * 1-5    → Mo–Fr um 04:00
```

---

## Tech Stack

| Komponente | Technologie |
|---|---|
| Backend | Node.js, Express |
| Datenbank | SQLite (better-sqlite3) |
| Auth | JWT (jsonwebtoken) |
| Docker | dockerode |
| WebSocket | ws |
| Frontend | Vanilla JS SPA |
| Charts | Chart.js |
| Passwort-Hashing | bcryptjs |

---

## Lizenz

MIT
