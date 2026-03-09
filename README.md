# HostPanel — Merged v1 + v2

Vereint **v1** (direktes lokales Docker) und **v2** (Multi-Node Daemon-Architektur) in einem System.

## Dateistruktur

```
hostpanel/
├── server.js          ← Einstiegspunkt (Panel)
├── daemon.js          ← Node-Daemon (läuft auf Remote-Servern)
├── db.js              ← Datenbank, Schema, Migrationen
├── docker-local.js    ← Lokaler Docker-Client (v1 Fallback)
├── daemon-hub.js      ← Verwaltung von Daemon-Verbindungen (v2)
├── node-router.js     ← Intelligentes Routing: Daemon oder lokales Docker
├── ws-panel.js        ← WebSocket für Browser-Clients
├── routes/
│   ├── auth.js        ← Login, Register, Middleware
│   ├── servers.js     ← Server-CRUD, Power, Logs, Commands
│   ├── nodes.js       ← Node-Management (v2)
│   └── admin.js       ← Admin, Benutzer, Audit, API-Keys, Docker
├── public/
│   └── index.html     ← Single-Page-App
└── package.json
```

## Installation

```bash
npm install
node server.js
```

## Umgebungsvariablen (Panel)

| Variable        | Standard                  | Beschreibung             |
|-----------------|---------------------------|--------------------------|
| `PORT`          | `3000`                    | HTTP/WS-Port             |
| `JWT_SECRET`    | zufällig generiert        | JWT-Geheimnis            |
| `ADMIN_EMAIL`   | `admin@hostpanel.local`   | Admin-E-Mail             |
| `ADMIN_PASS`    | `admin123`                | Admin-Passwort           |
| `DB_PATH`       | `./hostpanel.db`          | SQLite-Datenbankpfad     |
| `DOCKER_SOCKET` | `/var/run/docker.sock`    | Lokaler Docker-Socket    |

## Betriebsmodi

### Modus 1: Nur lokales Docker (v1-Kompatibilität)
Kein Daemon nötig. Der Panel-Server spricht direkt mit Docker.
```
Panel-Server
  └── Docker (lokal)
```

### Modus 2: Multi-Node mit Daemons (v2)
```
Panel-Server
  ├── Node 1 (daemon.js) → Docker
  ├── Node 2 (daemon.js) → Docker
  └── Node 3 (daemon.js) → Docker
```

### Modus 3: Hybrid (gemischt)
Lokaler Node + beliebig viele Remote-Nodes.

## Remote-Node einrichten

### 1. Neuen Node im Panel anlegen
Admin → Nodes → "Node hinzufügen" → Token einmalig kopieren

### 2. Daemon auf dem Node-Server starten

```bash
# Dependencies installieren
npm install ws dockerode

# Daemon starten
NODE_ID="<node-id>" \
NODE_TOKEN="hpd_<token>" \
PANEL_URL="ws://panel-ip:3000" \
node daemon.js
```

### 3. Systemd-Service (optional)

```ini
# /etc/systemd/system/hostpanel-daemon.service
[Unit]
Description=HostPanel Node Daemon
After=docker.service

[Service]
Environment=NODE_ID=<id>
Environment=NODE_TOKEN=<token>
Environment=PANEL_URL=ws://panel-ip:3000
ExecStart=/usr/bin/node /opt/hostpanel/daemon.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now hostpanel-daemon
```

## Migration von v1

Bestehende Installationen werden automatisch migriert:
- Fehlende Datenbankspalten werden ergänzt
- Bestehende Server werden dem lokalen Node zugewiesen
- Alle v1-API-Endpunkte bleiben kompatibel

## API-Endpunkte (Übersicht)

| Methode | Pfad                              | Beschreibung                  |
|---------|-----------------------------------|-------------------------------|
| POST    | `/api/auth/login`                 | Login                         |
| POST    | `/api/auth/register`              | Registrierung                 |
| GET     | `/api/servers`                    | Server-Liste                  |
| POST    | `/api/servers`                    | Server erstellen              |
| POST    | `/api/servers/:id/power/start`    | Server starten                |
| GET     | `/api/nodes`                      | Node-Liste                    |
| POST    | `/api/nodes`                      | Node hinzufügen               |
| POST    | `/api/nodes/:id/rotate-token`     | Daemon-Token rotieren         |
| GET     | `/api/admin/stats`                | Statistiken                   |
| GET     | `/api/admin/users`                | Benutzerverwaltung            |
| GET     | `/api/docker/images`              | Docker-Images (v1 Legacy)     |

## WebSocket-Protokoll

**Browser-Clients** → `/ws`
```json
{ "type": "auth", "token": "<jwt>" }
{ "type": "subscribe", "server_id": "<id>" }
{ "type": "subscribe_console", "server_id": "<id>" }
```

**Node-Daemons** → `/daemon`
```
Header: x-node-id: <node-id>
Header: x-node-token: <token>
```
