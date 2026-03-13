<div align="center">

# NexPanel

**Dein selbst gehostetes Server-Management-Panel der nächsten Generation.**

Verwalte Docker-Container über mehrere Nodes, überwache Ressourcen in Echtzeit, installiere und aktualisiere Mods automatisch, plane Aufgaben und vergib gezielten Zugriff an dein Team — alles in einer modernen Oberfläche.

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![SQLite](https://img.shields.io/badge/SQLite-3-003B57?logo=sqlite&logoColor=white)](https://sqlite.org)
[![Docker](https://img.shields.io/badge/Docker-required-2496ED?logo=docker&logoColor=white)](https://docker.com)
[![License](https://img.shields.io/badge/Lizenz-MIT-blue)](LICENSE)

</div>

---

## Inhaltsverzeichnis

- [Features](#features)
- [Systemvoraussetzungen](#systemvoraussetzungen)
- [Schnellstart](#schnellstart)
- [Konfiguration](#konfiguration)
- [Betriebsmodi](#betriebsmodi)
- [Remote-Node einrichten](#remote-node-einrichten)
- [SFTP-Zugang](#sftp-zugang)
- [Prometheus & Grafana](#prometheus--grafana)
- [OAuth / Social Login](#oauth--social-login)
- [Mod Auto-Update](#mod-auto-update)
- [Auto-Scaling](#auto-scaling)
- [API-Dokumentation](#api-dokumentation)
- [WebSocket-Protokoll](#websocket-protokoll)
- [Dateistruktur](#dateistruktur)
- [Tech Stack](#tech-stack)
- [Docker Compose](#docker-compose)
- [Sicherheitshinweise](#sicherheitshinweise)
- [FAQ](#faq)

---

## Features

### 🖥️ Server-Management
- Server erstellen, bearbeiten, klonen und löschen
- Power-Actions: Start, Stop, Restart, Kill
- Live-Konsole via WebSocket (Minecraft: RCON-basiert)
- Ressourcen-Monitoring: CPU, RAM, Netzwerk-I/O, Prozesse als Live-Graphen
- Bulk-Aktionen: mehrere Server gleichzeitig starten/stoppen
- Konsolen-Verlauf persistent gespeichert

### 🌐 Multi-Node Architektur
- Lokales Docker + beliebig viele Remote-Nodes über Daemon
- Auto-Scaling: Node-Scoring nach CPU, RAM, Disk-Auslastung
- Node-Ressourcen-Übersicht mit Live-Status
- Token-Rotation pro Node

### 📁 Datei-Manager
- Verzeichnisse durchsuchen, Dateien lesen, bearbeiten, erstellen, löschen
- Umbenennen, verschieben, komprimieren (tar.gz)
- SFTP-Zugang auf Port 2022 (Standard-SSH-Client kompatibel)

### 💾 Backups
- Server-Backups direkt im Panel erstellen
- Download, Wiederherstellung und Löschung
- Speicherverbrauch pro Server einsehen

### 🧩 Mod / Plugin Installer
- Modrinth, CurseForge, GitHub Releases, direkte URLs
- **SHA1-basierte Update-Erkennung** — exakte Versionsidentifikation ohne Dateinamen-Heuristik
- Changelog-Anzeige direkt im Panel (Markdown-Rendering)
- Einzelne Mods oder alle Updates auf einmal installieren
- **Mod Auto-Update**: konfigurierbares Intervall (1 h – 168 h), Benachrichtigungen, Update-Verlauf

### 📅 Geplante Tasks
- Cronjobs pro Server: Start, Stop, Restart, Kill, Befehl
- Manuelles Ausführen per Klick
- Letztes Ergebnis und Ausführungszeit gespeichert

### 👥 Benutzer & Zugriffsmanagement
- Multi-User mit Rollen (`admin`, `user`)
- Sub-User pro Server mit granularen Berechtigungen
- Session-Verwaltung: alle aktiven Sitzungen einsehen und widerrufen

### 🔐 Authentifizierung & Sicherheit
- JWT-basierte Authentifizierung (24 h Gültigkeit)
- **Zwei-Faktor-Authentifizierung (TOTP)** — QR-Code-Setup, Backup-Codes, Account-Recovery
- **OAuth / Social Login** — GitHub und Discord (Popup-Flow, Account-Verknüpfung)
- API Keys für programmatischen Zugriff
- Rate Limiting (Auth: 10 req/15 min, API: 300 req/min)
- Vollständiges Audit-Log aller Aktionen

### 🔔 Benachrichtigungen & Alerts
- Discord Webhook + E-Mail pro Server
- **Ressourcen-Alerts**: CPU/RAM/Disk Schwellenwerte (Warn/Critical) mit Cooldown
- Test-Button für alle Benachrichtigungskanäle
- Ausgehende Webhooks mit HMAC-Signatur und konfigurierbaren Events

### 📊 Monitoring & Metriken
- Echtzeit-Statistiken via WebSocket
- Stats-Verlauf (bis 7 Tage) in der Datenbank
- Tägliche Uptime-Snapshots
- **Prometheus-Exporter**: 16 Metriken, Bearer-Token-Auth, `GET /metrics`
- Fertiges Grafana-Dashboard JSON zum Download

### 🛠️ Admin-Tools
- Benutzer anlegen, bearbeiten, sperren, löschen
- Docker-Images auf allen Nodes verwalten
- Eggs / Server-Templates mit Icons und Standardwerten
- Port-Allokationen (einzeln oder als Range)
- Maintenance-Modus pro Server + Server-Transfer zwischen Nodes
- Compose-Import (Docker Compose → NexPanel Server)
- **API-Dokumentation**: Swagger UI unter `/api/docs` (98 Endpunkte, interaktiv testbar)

---

## Systemvoraussetzungen

| Komponente | Mindestversion |
|---|---|
| Node.js | 18.x |
| Docker | 20.x |
| Betriebssystem | Linux (empfohlen), macOS, Windows (Docker Desktop) |
| RAM | 512 MB für das Panel + RAM der verwalteten Container |
| Disk | 1 GB für das Panel + Speicher für Container und Backups |

---

## Schnellstart

```bash
# 1. Projekt klonen oder ZIP entpacken
git clone https://github.com/nexpanel/nexpanel
cd nexpanel

# 2. Abhängigkeiten installieren
npm install

# 3. Optional: Konfiguration anlegen
cp .env.example .env
nano .env

# 4. Panel starten
npm start
```

NexPanel ist jetzt erreichbar unter **http://localhost:3000**

**Standard-Login:**
```
E-Mail:   admin@hostpanel.local
Passwort: admin123
```

> ⚠️ **Wichtig:** Ändere das Admin-Passwort direkt nach dem ersten Login unter Einstellungen → Passwort ändern.

---

## Konfiguration

Erstelle eine `.env`-Datei im Projektverzeichnis:

```env
# ── Panel ───────────────────────────────────────────────────────
PORT=3000
HOST=0.0.0.0

# ── Datenbank ───────────────────────────────────────────────────
DB_PATH=./nexpanel.db

# ── Admin-Konto (nur beim allerersten Start, danach ignoriert) ──
ADMIN_EMAIL=admin@example.com
ADMIN_PASS=SicheresPasswort123!

# ── JWT ─────────────────────────────────────────────────────────
# Wird beim ersten Start automatisch generiert und in der DB gespeichert.
# Nur setzen wenn du einen festen Secret brauchst (z.B. Zero-Downtime-Reload).
JWT_SECRET=

# ── Docker ──────────────────────────────────────────────────────
# Linux:
DOCKER_SOCKET=/var/run/docker.sock
# Windows (Docker Desktop):
# DOCKER_SOCKET=//./pipe/docker_engine

# ── Mod-Installer ───────────────────────────────────────────────
# CurseForge API Key (kostenlos auf curseforge.com/api)
CURSEFORGE_API_KEY=

# ── SFTP ────────────────────────────────────────────────────────
SFTP_PORT=2022
# SSH Host-Key wird beim ersten Start automatisch generiert
SFTP_HOST_KEY_PATH=./sftp_host_key

# ── E-Mail (für Benachrichtigungen) ─────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=nexpanel@example.com
SMTP_PASS=
SMTP_FROM=NexPanel <nexpanel@example.com>
```

---

## Betriebsmodi

### Modus 1 — Nur lokales Docker (Standard)

Kein Daemon nötig. NexPanel kommuniziert direkt mit Docker auf demselben Host.

```
[NexPanel :3000]
       └── [Docker (lokal, /var/run/docker.sock)]
```

### Modus 2 — Multi-Node mit Daemons

Beliebig viele Remote-Server werden über `daemon.js` angebunden. Die Kommunikation läuft über persistente WebSocket-Verbindungen — am Node-Server ist kein eingehender Port nötig.

```
[NexPanel :3000]
  ├── [Node EU-1: daemon.js] ── Docker
  ├── [Node EU-2: daemon.js] ── Docker
  └── [Node US-1: daemon.js] ── Docker
```

### Modus 3 — Hybrid

Lokaler Node (kein Daemon) + beliebig viele Remote-Nodes gleichzeitig. Empfohlen für Produktionsumgebungen.

---

## Remote-Node einrichten

### 1. Node im Panel registrieren

**Admin → Nodes → „Node hinzufügen"**

- Name, FQDN/IP und Standort eintragen
- Token einmalig kopieren (wird danach nicht mehr angezeigt)

### 2. Daemon auf dem Remote-Server starten

```bash
# Abhängigkeiten auf dem Remote-Server installieren
npm install ws dockerode

# Daemon starten
NODE_ID="<node-id-aus-dem-panel>" \
NODE_TOKEN="hpd_<token-aus-dem-panel>" \
PANEL_URL="ws://deine-panel-ip:3000" \
node daemon.js
```

### 3. Als systemd-Service (empfohlen)

```ini
# /etc/systemd/system/nexpanel-daemon.service
[Unit]
Description=NexPanel Node Daemon
After=network.target docker.service
Requires=docker.service

[Service]
User=root
WorkingDirectory=/opt/nexpanel
Environment=NODE_ID=<node-id>
Environment=NODE_TOKEN=hpd_<token>
Environment=PANEL_URL=ws://panel-ip:3000
ExecStart=/usr/bin/node /opt/nexpanel/daemon.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now nexpanel-daemon

# Status prüfen
systemctl status nexpanel-daemon
journalctl -u nexpanel-daemon -f
```

### Token rotieren

Im Panel unter **Admin → Nodes → ⋮ → Token rotieren**. Der Daemon muss danach mit dem neuen Token neu gestartet werden.

---

## SFTP-Zugang

NexPanel stellt einen integrierten SFTP-Server auf Port **2022** bereit. Verbinde dich mit deinen Panel-Zugangsdaten:

```bash
sftp -P 2022 deinbenutzername@panel-ip
```

Navigiere im SFTP-Client mit der Server-UUID als Verzeichnis:

```bash
cd 550e8400-e29b-41d4-a716-446655440000
ls
get server.properties
put plugins/MyPlugin.jar
```

Die Server-ID steht in der Panel-URL: `https://panel.example.com/#server/<uuid>`

Kompatibel mit: FileZilla, WinSCP, Cyberduck, `sftp`-CLI, VS Code Remote — SSH.

---

## Prometheus & Grafana

### Metriken aktivieren

1. **Admin → Prometheus Metrics → Token generieren**
2. Den Token einmalig kopieren und sicher speichern

### Prometheus konfigurieren

```yaml
# prometheus.yml
scrape_configs:
  - job_name: nexpanel
    scrape_interval: 30s
    static_configs:
      - targets: ['panel-ip:3000']
    metrics_path: /metrics
    authorization:
      credentials: '<dein-token>'
```

### Verfügbare Metriken

| Metrik | Typ | Beschreibung |
|---|---|---|
| `nexpanel_server_status` | Gauge | Server-Status (1 = running) |
| `nexpanel_server_cpu_percent` | Gauge | CPU-Auslastung % |
| `nexpanel_server_memory_mb` | Gauge | RAM-Verbrauch MB |
| `nexpanel_server_memory_limit_mb` | Gauge | RAM-Limit MB |
| `nexpanel_server_memory_percent` | Gauge | RAM-Auslastung % |
| `nexpanel_server_disk_limit_mb` | Gauge | Disk-Limit MB |
| `nexpanel_server_network_rx_bytes` | Counter | Netzwerk empfangen (Bytes) |
| `nexpanel_server_network_tx_bytes` | Counter | Netzwerk gesendet (Bytes) |
| `nexpanel_server_pids` | Gauge | Prozess-Anzahl |
| `nexpanel_node_server_count` | Gauge | Server pro Node |
| `nexpanel_node_running_count` | Gauge | Laufende Server pro Node |
| `nexpanel_total_servers` | Gauge | Gesamtanzahl Server |
| `nexpanel_running_servers` | Gauge | Laufende Server gesamt |
| `nexpanel_total_users` | Gauge | Anzahl Benutzer |
| `nexpanel_total_nodes` | Gauge | Anzahl Nodes |
| `nexpanel_info` | Gauge | Panel-Version + Uptime-Sekunden |

### Grafana Dashboard

Das fertige Dashboard-JSON ist unter **Admin → Prometheus Metrics → Dashboard herunterladen** verfügbar. Es enthält 4 Stat-Panels (Totals), CPU- und RAM-Zeitreihen, Netzwerk RX/TX sowie eine Server-Status-Tabelle mit Farbkodierung.

### Prometheus + Grafana per Docker Compose

```yaml
version: '3.8'
services:
  prometheus:
    image: prom/prometheus:latest
    ports: ['9090:9090']
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:latest
    ports: ['3001:3000']
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=admin
    volumes:
      - grafana_data:/var/lib/grafana

volumes:
  grafana_data:
```

---

## OAuth / Social Login

NexPanel unterstützt Login via **GitHub** und **Discord** ohne zusätzliche npm-Pakete.

### GitHub einrichten

1. [GitHub Developer Settings](https://github.com/settings/developers) → **New OAuth App**
2. **Authorization callback URL**: `https://deine-panel-domain/api/auth/oauth/github/callback`
3. Client ID und Secret in **Admin → OAuth / Social Login** eintragen

### Discord einrichten

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application → OAuth2**
2. **Redirect URI**: `https://deine-panel-domain/api/auth/oauth/discord/callback`
3. Client ID und Secret in **Admin → OAuth / Social Login** eintragen

### Account-Matching-Logik

| Situation | Aktion |
|---|---|
| OAuth-Account bereits verknüpft | Direkter Login |
| Gleiche E-Mail wie bestehender Account | Automatische Verknüpfung |
| Neue E-Mail | Neuen Account anlegen |

Benutzer verwalten ihre verknüpften Konten unter **Einstellungen → Verknüpfte Konten**.

---

## Mod Auto-Update

NexPanel kann installierte Mods automatisch aktuell halten.

### Funktionsweise

1. SHA1-Hashes aller JARs im Container werden berechnet (`sha1sum`)
2. Batch-Lookup gegen die [Modrinth API](https://docs.modrinth.com) (`/v2/version_files`)
3. Exakte Versions- und Projektzuordnung — keine fehleranfällige Dateinamen-Heuristik
4. Neuere Versionen werden heruntergeladen, alte Dateien gelöscht

### Konfiguration pro Server

**Server → Mods-Tab → Auto-Update:**

| Einstellung | Optionen |
|---|---|
| Auto-Update | Ein / Aus |
| Prüfintervall | 1 h, 3 h, 6 h, 12 h, 24 h, 48 h, 168 h (1 Woche) |
| Bei Update benachrichtigen | Discord / E-Mail |

### Manueller Update-Check

**Server → Mods → „Updates prüfen"** zeigt alle verfügbaren Updates mit alter/neuer Version, Changelog-Vorschau (Markdown) und Dateigröße. Einzeln oder alle auf einmal installierbar.

---

## Auto-Scaling

Beim Erstellen eines Servers ohne expliziten Node wählt NexPanel automatisch den optimalen Node.

### Scoring-Algorithmus

```
Score = (RAM_frei / RAM_gesamt  × 40)
      + (CPU_Kerne_frei         × 30)
      + (Disk_frei / Disk_gesamt × 20)
      + (Server_Anzahl_Faktor   × 10)
```

Nodes mit zu wenig freiem RAM oder Disk für den neuen Server werden vorab ausgeschlossen.

### Konfiguration

**Admin → Auto-Scaling** — Mindest-Ressourcen-Schwellen und Gewichtungsfaktoren anpassen. Die Scoring-Vorschau zeigt den aktuellen Score aller Nodes in Echtzeit.

### Auto-Register (für Cloud-Deployments)

```bash
NODE_AUTO_REGISTER_KEY="<key-aus-dem-panel>" \
PANEL_URL="https://panel.example.com" \
node daemon.js --auto-register --name="Node-DE-1" --location="Frankfurt"
```

---

## API-Dokumentation

NexPanel enthält eine vollständige interaktive Dokumentation auf Basis von **Swagger UI / OpenAPI 3.0**.

**Erreichbar unter:** `http://panel-ip:3000/api/docs`

**98 dokumentierte Endpunkte** in 16 Kategorien: Auth, OAuth, Servers, Files, Backups, Schedule, Subusers, Notifications, Alerts, Mods, Nodes, Allocations, Groups, Webhooks, Admin, Metrics.

### Token in der Swagger UI setzen

1. `/api/docs` öffnen
2. JWT aus dem Login in das Token-Feld oben einfügen
3. „Anwenden" klicken — alle „Try it out"-Requests laufen dann authentifiziert

Der Token wird in `localStorage` gespeichert und beim nächsten Aufruf automatisch wiederhergestellt.

### OpenAPI Spec importieren

```
GET /api/docs/openapi.json
```

Die JSON-Spec kann direkt in Postman, Insomnia oder OpenAPI-Code-Generatoren importiert werden.

---

## WebSocket-Protokoll

### Browser → Panel (`/ws`)

```jsonc
// Authentifizierung — muss zuerst gesendet werden
{ "type": "auth", "token": "<jwt>" }

// Live-Stats abonnieren
{ "type": "subscribe_stats", "server_id": "<uuid>" }

// Konsole abonnieren
{ "type": "console.subscribe", "server_id": "<uuid>" }

// Befehl in Konsole senden
{ "type": "console.input", "server_id": "<uuid>", "data": "say Hallo Welt" }

// Abo beenden
{ "type": "unsubscribe", "server_id": "<uuid>" }
```

### Panel → Browser

```jsonc
// Stats-Update (alle ~2 Sekunden)
{ "type": "stats", "server_id": "<uuid>",
  "data": { "cpu": 34.5, "memory_mb": 1024, "network_rx": 102400, "pids": 12 } }

// Konsolen-Output
{ "type": "console.output", "server_id": "<uuid>", "data": "[Server] Done (2.3s)!\n" }

// Status-Änderung
{ "type": "server_status", "server_id": "<uuid>", "status": "running" }

// Ressourcen-Alert
{ "type": "resource_alert", "server_id": "<uuid>",
  "level": "critical", "metric": "cpu", "value": 96.2 }
```

### Daemon → Panel (`/daemon`)

```
WebSocket-Header:
  x-node-id:    <node-uuid>
  x-node-token: hpd_<token>
```

---

## Dateistruktur

```
nexpanel/
│
├── server.js               ← Express-Server, alle Router-Mounts, Rate-Limiter
├── daemon.js               ← Remote-Node-Daemon (auf anderen Servern ausführen)
├── daemon-hub.js           ← WebSocket-Manager für Daemon-Verbindungen
├── node-router.js          ← Routing: Daemon WS oder lokales Docker
├── docker-local.js         ← Lokaler Docker-Client (dockerode)
├── ws-panel.js             ← Browser-WebSocket: Konsole, Stats, Auth
├── db.js                   ← SQLite-Schema + automatische Migrationen
├── scheduler.js            ← Hintergrund-Cron-Runner + Mod-Auto-Update-Tick
├── notifications.js        ← Discord Webhook + E-Mail + ausgehende Webhooks
├── resource-limits.js      ← Disk-Scan alle 5 min, WS-Warnungen
├── resource-alerts.js      ← CPU/RAM/Disk Schwellenwert-Engine + Cooldown
├── stats-collector.js      ← Container-Stats alle 30 s → server_stats_log
├── status-uptime.js        ← Tägliche Uptime-Snapshots (23:55 Uhr)
├── scaling.js              ← Node-Scoring-Engine, getBestNode()
├── mod-auto-updater.js     ← Hintergrund-Mod-Update-Engine (SHA1 → Modrinth)
├── sftp-server.js          ← SSH2-SFTP-Gateway auf Port 2022
│
├── routes/
│   ├── auth.js             ← Login, Register, JWT, 2FA/TOTP, API-Keys, Sessions
│   ├── oauth.js            ← Social Login: GitHub + Discord (Popup-Flow)
│   ├── servers.js          ← Server CRUD, Power-Actions, Logs, Stats, Clone
│   ├── nodes.js            ← Node-Verwaltung, Token-Rotation, Images
│   ├── allocations.js      ← Port-Allokationen (einzeln + Range)
│   ├── eggs.js             ← Server-Templates / Eggs
│   ├── files.js            ← Datei-Manager (list, read, write, rename, compress)
│   ├── backups.js          ← Backups erstellen, herunterladen, wiederherstellen
│   ├── mods.js             ← Mod-Installer + SHA1-Update-Check + Changelog
│   ├── schedule.js         ← Geplante Aufgaben (Cronjobs)
│   ├── subusers.js         ← Sub-User + granulare Berechtigungen
│   ├── notifications.js    ← Discord/E-Mail-Einstellungen pro Server
│   ├── alerts.js           ← Ressourcen-Alert-Regeln pro Server
│   ├── groups.js           ← Server-Gruppen und Tags
│   ├── webhooks.js         ← Ausgehende Webhooks (HMAC-signiert)
│   ├── sessions.js         ← JWT-Session-Verwaltung + Widerruf
│   ├── status.js           ← Status-Page + Uptime-History
│   ├── maintenance.js      ← Maintenance-Modus + Server-Transfer
│   ├── bulk.js             ← Bulk Power-Actions, Console-History, Stats-History
│   ├── compose.js          ← Docker Compose Import + Server-Reinstall
│   ├── scaling.js          ← Auto-Scaling-Konfiguration + Scoring-Preview
│   ├── metrics.js          ← Prometheus /metrics + Token-Verwaltung
│   ├── admin.js            ← Benutzer, Audit-Log, Docker-Images, Admin-Stats
│   └── docs.js             ← Swagger UI + OpenAPI 3.0 Spec (/api/docs)
│
├── public/
│   └── index.html          ← Single-Page-App (~6500 Zeilen, Vanilla JS)
│
├── package.json
├── .env.example
└── README.md
```

---

## Sub-User Berechtigungen

| Berechtigung | Beschreibung |
|---|---|
| `console` | Konsole lesen und Befehle senden |
| `files.read` | Dateien und Verzeichnisse lesen |
| `files.write` | Dateien schreiben, erstellen, löschen |
| `power` | Server starten, stoppen, neustarten |
| `startup` | Startup-Befehl und Umgebungsvariablen ändern |
| `allocations` | Ports verwalten |
| `schedule` | Geplante Tasks erstellen und ausführen |
| `backups` | Backups erstellen, herunterladen, wiederherstellen |
| `mods` | Mods installieren und entfernen |

---

## Cron-Format (Geplante Tasks)

```
┌──────────── Minute      (0–59)
│ ┌────────── Stunde      (0–23)
│ │ ┌──────── Tag         (1–31)
│ │ │ ┌────── Monat       (1–12)
│ │ │ │ ┌──── Wochentag   (0–7,  0 und 7 = Sonntag)
│ │ │ │ │
* * * * *
```

| Ausdruck | Bedeutung |
|---|---|
| `0 4 * * *` | Täglich um 04:00 Uhr |
| `0 */6 * * *` | Alle 6 Stunden |
| `*/30 * * * *` | Alle 30 Minuten |
| `0 0 * * 0` | Jeden Sonntag um Mitternacht |
| `0 4 * * 1-5` | Montag bis Freitag um 04:00 |
| `0 2 1 * *` | Jeden 1. des Monats um 02:00 |

---

## Minecraft-Server

NexPanel unterstützt `itzg/minecraft-server` nativ:

```
Empfohlene ENV-Variablen:
  EULA=TRUE
  TYPE=PAPER         (oder VANILLA, FABRIC, FORGE, SPIGOT, ...)
  VERSION=1.21.1
  MEMORY=1500M
  ENABLE_RCON=true
  RCON_PASSWORD=     (wird von NexPanel automatisch gesetzt)

Verzeichnis:  /data
Konsole:      RCON (Port 25575, automatisch erkannt)
```

> 💡 Das RAM-Limit des Containers sollte `MEMORY` + ~300 MB Overhead betragen, z.B. `MEMORY=1500M` → Container-Limit `1800 MB`.

---

## Tech Stack

| Schicht | Technologie | Zweck |
|---|---|---|
| Runtime | Node.js 18+ | Server und Daemon |
| Web-Framework | Express 4 | REST API + Static Serving |
| Datenbank | SQLite (better-sqlite3) | Synchron, keine externe DB nötig |
| Authentifizierung | jsonwebtoken | Zustandslose JWT-Sessions |
| 2FA | speakeasy + qrcode | TOTP-Generierung und QR-Codes |
| Docker | dockerode | Container-Management |
| WebSocket | ws | Echtzeit-Konsole und Stats |
| SFTP | ssh2 | Datei-Gateway auf Port 2022 |
| Backups | archiver | tar.gz-Komprimierung |
| Passwort-Hashing | bcryptjs | Sicheres Passwort-Speichern |
| Rate-Limiting | express-rate-limit | DDoS / Brute-Force-Schutz |
| Frontend | Vanilla JS SPA | Kein Framework, kein Build-Step |
| Charts | Chart.js 4 | Ressourcen-Graphen |
| Icons | Lucide Icons (CDN) | SVG-Icon-System |
| API-Docs | Swagger UI 5 + OpenAPI 3.0 | Interaktive Dokumentation |
| Metrics | Prometheus text format | Monitoring-Integration |

---

## Docker Compose

NexPanel selbst in einem Container betreiben:

```yaml
version: '3.8'
services:
  nexpanel:
    image: node:20-alpine
    working_dir: /app
    volumes:
      - ./:/app
      - /var/run/docker.sock:/var/run/docker.sock
      - nexpanel_data:/app/data
    ports:
      - '3000:3000'
      - '2022:2022'     # SFTP
    environment:
      - PORT=3000
      - DB_PATH=/app/data/nexpanel.db
      - DOCKER_SOCKET=/var/run/docker.sock
    command: ['node', 'server.js']
    restart: unless-stopped

volumes:
  nexpanel_data:
```

```bash
docker compose up -d
docker compose logs -f nexpanel
```

---

## Sicherheitshinweise

**Admin-Passwort** direkt nach dem ersten Login ändern.

**JWT_SECRET** auf einen langen, zufälligen Wert setzen:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**TLS / Reverse-Proxy** — NexPanel sollte nie direkt im Internet exponiert werden. Beispiel-Konfiguration mit nginx:

```nginx
server {
    listen 443 ssl;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass         http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600;
    }
}
```

**Weitere Hinweise:**
- SFTP-Port 2022 in der Firewall nur für vertrauenswürdige IPs freigeben
- Prometheus `/metrics` **nie ohne Token** exponieren
- Docker-Socket-Zugriff ist Root-äquivalent — Panel nur auf vertrauenswürdigen Hosts betreiben
- `trust proxy` in `server.js` korrekt setzen wenn hinter Load-Balancer

---

## FAQ

**Warum werden keine Icons oder Schriften geladen?**
NexPanel lädt Lucide Icons und Google Fonts von externen CDNs. Ohne Internetverbindung auf dem Client erscheinen Fallback-Symbole. Für Offline-Setups die Assets lokal einbinden.

**Kann ich mehrere NexPanel-Instanzen auf einem Server betreiben?**
Ja — unterschiedliche Ports (`PORT=3001`) und separate `DB_PATH`-Werte genügen.

**Was passiert wenn ein Node offline geht?**
Alle Server auf dem Node zeigen Status `offline`. Sobald der Daemon reconnected, werden die Status automatisch aktualisiert. Ausstehende Aktionen werden nicht wiederholt.

**Wie sichere ich die Datenbank?**
```bash
# Laufendes Panel — SQLite WAL-Mode erlaubt Hot-Backup
sqlite3 nexpanel.db ".backup nexpanel_backup_$(date +%Y%m%d_%H%M).db"
```
Für automatische Backups: täglichen Cron-Job oder `restic` / `rclone` einrichten.

**Unterstützt NexPanel IPv6?**
Der Express-Server lauscht standardmäßig auf `0.0.0.0` (IPv4). Für IPv6 `HOST=::` in der `.env` setzen.

**Wie migriere ich von Pterodactyl?**
Ein Pterodactyl-Import-Tool ist geplant. Aktuell können Server manuell neu erstellt oder über den Compose-Import übernommen werden.

**Werden Windows-Container unterstützt?**
Aktuell nur Linux-Container getestet. Windows-Container (Hyper-V Isolation) sind nicht offiziell unterstützt.

---

## Lizenz

MIT License

---

<div align="center">
  <sub>NexPanel — gebaut mit Node.js, SQLite und zu viel Koffein</sub>
</div>
