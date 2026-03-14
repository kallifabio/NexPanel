<div align="center">

# NexPanel

**Dein selbst gehostetes Server-Management-Panel der nächsten Generation.**

Verwalte Docker-Container über mehrere Nodes, überwache Ressourcen in Echtzeit, installiere und aktualisiere Mods automatisch, plane Aufgaben und vergib gezielten Zugriff an dein Team — alles in einer modernen Oberfläche mit Client- und Admin-Bereich.

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
- [Auto-Backup Zeitpläne](#auto-backup-zeitpläne)
- [Server-Broadcast](#server-broadcast)
- [Console Aliases](#console-aliases)
- [Server-Favoriten](#server-favoriten)
- [Pterodactyl Import](#pterodactyl-import)
- [Auto-Scaling](#auto-scaling)
- [Client- & Admin-Bereich](#client---admin-bereich)
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
- **Server-Favoriten**: Server anpinnen und in der Liste priorisieren
- **Console Aliases**: eigene Shortcuts für häufige Befehle (z.B. `/restart` → `say Restarting...`)
- **Server-Broadcast**: einen Befehl mit einem Klick an alle laufenden Server senden

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
- **Auto-Backup Zeitpläne**: Cron-basiert, konfigurierbares Namens-Template, automatische Retention

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
- **Pterodactyl Import**: Eggs + Server aus Pterodactyl PTDL_v1/v2 JSON importieren
- **API-Dokumentation**: Swagger UI unter `/api/docs` (98 Endpunkte, interaktiv testbar)

### 🎨 UI / UX
- Modernes Dark-Theme mit Cyan-Akzenten, vollständiges Light-Mode-Theme
- **Client- & Admin-Bereich** — getrennte Navigation wie bei Pterodactyl
- Alle Icons als Lucide SVG (einheitlich 16–20 px)
- Responsive Layout für mobile Geräte
- Globale Suche (Strg+K)

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

# 3. Konfiguration anlegen
cp .env.example .env
nano .env          # mindestens ADMIN_EMAIL und ADMIN_PASS setzen

# 4. Panel starten
npm start
```

NexPanel ist jetzt erreichbar unter **http://localhost:3000**

**Standard-Login:**
```
E-Mail:   admin@nexpanel.local
Passwort: admin123
```

> ⚠️ **Wichtig:** Ändere das Admin-Passwort direkt nach dem ersten Login unter Einstellungen → Passwort ändern.

### Daemon separat starten

```bash
# Wenn der Daemon auf einem anderen Server läuft:
NODE_ID="..." NODE_TOKEN="hpd_..." PANEL_URL="ws://..." npm run daemon
# oder direkt:
node src/daemon/daemon.js
```

---

## Konfiguration

Erstelle eine `.env`-Datei (Vorlage: `.env.example`):

```env
# ── Panel ───────────────────────────────────────────────────────
PORT=3000
HOST=0.0.0.0

# ── Datenbank ───────────────────────────────────────────────────
# Wird in data/ gespeichert — Verzeichnis wird automatisch erstellt
DB_PATH=./data/nexpanel.db

# ── Admin-Konto (nur beim allerersten Start, danach ignoriert) ──
ADMIN_EMAIL=admin@nexpanel.local
ADMIN_PASS=admin123

# ── JWT ─────────────────────────────────────────────────────────
# Wird beim ersten Start automatisch generiert.
# Nur setzen wenn du einen festen Secret brauchst.
JWT_SECRET=

# ── Docker ──────────────────────────────────────────────────────
# Linux:
DOCKER_SOCKET=/var/run/docker.sock
# Windows (Docker Desktop):
# DOCKER_SOCKET=//./pipe/docker_engine

# ── Backups ─────────────────────────────────────────────────────
BACKUP_PATH=./backups

# ── SFTP ────────────────────────────────────────────────────────
SFTP_PORT=2022
# SSH Host-Key wird beim ersten Start automatisch in data/ generiert
SFTP_HOST_KEY_PATH=./data/sftp_host_key

# ── Mod-Installer ───────────────────────────────────────────────
CURSEFORGE_API_KEY=   # optional, kostenlos auf curseforge.com/api

# ── E-Mail (für Benachrichtigungen) ─────────────────────────────
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=nexpanel@example.com
SMTP_PASS=
SMTP_FROM=NexPanel <nexpanel@example.com>
```

### Wichtige Hinweise

- `data/` und `backups/` werden beim ersten Start automatisch erstellt.
- Der SFTP Host-Key wird einmalig in `data/sftp_host_key` generiert — diese Datei nicht löschen, sonst ändern sich die Fingerprints für alle Clients.
- `DB_PATH` kann absolut oder relativ zum Projektverzeichnis angegeben werden.

---

## Betriebsmodi

### Modus 1 — Nur lokales Docker (Standard)

Kein Daemon nötig. NexPanel kommuniziert direkt mit Docker auf demselben Host.

```
[NexPanel :3000]
       └── [Docker (lokal, /var/run/docker.sock)]
```

### Modus 2 — Multi-Node mit Daemons

Beliebig viele Remote-Server über `src/daemon/daemon.js`. Kommunikation via persistenter WebSocket-Verbindung — kein eingehender Port am Node nötig.

```
[NexPanel :3000]
  ├── [Node EU-1: daemon.js] ── Docker
  ├── [Node EU-2: daemon.js] ── Docker
  └── [Node US-1: daemon.js] ── Docker
```

### Modus 3 — Hybrid

Lokaler Node + beliebig viele Remote-Nodes gleichzeitig. Empfohlen für Produktionsumgebungen.

---

## Remote-Node einrichten

### 1. Node im Panel registrieren

**Admin-Bereich → Nodes → „Node hinzufügen"**

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
node src/daemon/daemon.js
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
ExecStart=/usr/bin/node /opt/nexpanel/src/daemon/daemon.js
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
journalctl -u nexpanel-daemon -f
```

### Token rotieren

**Admin-Bereich → Nodes → ⋮ → Token rotieren** — Daemon danach neu starten.

---

## SFTP-Zugang

NexPanel stellt einen integrierten SFTP-Server auf Port **2022** bereit. Verbinde dich mit deinen Panel-Zugangsdaten:

```bash
# Format: <panel-benutzername>.<server-id-prefix>@<panel-ip>
sftp -P 2022 admin.a1b2c3@panel-ip
```

Der Benutzername besteht aus Panel-Username + `.` + den ersten 6 Zeichen der Server-UUID. Die Server-ID steht in der Panel-URL: `/#server/a1b2c3d4-...`

```bash
# Beispiele im SFTP-Client:
ls                         # Wurzelverzeichnis des Containers
get server.properties      # Datei herunterladen
put plugins/MyPlugin.jar   # Datei hochladen
mkdir world_backup         # Verzeichnis erstellen
```

Kompatibel mit: FileZilla, WinSCP, Cyberduck, `sftp`-CLI, VS Code Remote.

> Der SSH Host-Key wird beim ersten Start automatisch in `data/sftp_host_key` generiert. Der Pfad kann über `SFTP_HOST_KEY_PATH` angepasst werden.

---

## Prometheus & Grafana

### Token generieren

**Admin-Bereich → Prometheus Metrics → Token generieren** — einmalig angezeigt, sicher speichern.

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

### Verfügbare Metriken (16 Stück)

| Metrik | Typ | Beschreibung |
|---|---|---|
| `nexpanel_server_status` | Gauge | Server-Status (1 = running) |
| `nexpanel_server_cpu_percent` | Gauge | CPU-Auslastung % |
| `nexpanel_server_memory_mb` | Gauge | RAM-Verbrauch MB |
| `nexpanel_server_memory_limit_mb` | Gauge | RAM-Limit MB |
| `nexpanel_server_memory_percent` | Gauge | RAM-Auslastung % |
| `nexpanel_server_disk_limit_mb` | Gauge | Disk-Limit MB |
| `nexpanel_server_network_rx_bytes` | Counter | Netzwerk empfangen |
| `nexpanel_server_network_tx_bytes` | Counter | Netzwerk gesendet |
| `nexpanel_server_pids` | Gauge | Prozess-Anzahl |
| `nexpanel_node_server_count` | Gauge | Server pro Node |
| `nexpanel_node_running_count` | Gauge | Laufende Server pro Node |
| `nexpanel_total_servers` | Gauge | Gesamtanzahl Server |
| `nexpanel_running_servers` | Gauge | Laufende Server gesamt |
| `nexpanel_total_users` | Gauge | Anzahl Benutzer |
| `nexpanel_total_nodes` | Gauge | Anzahl Nodes |
| `nexpanel_info` | Gauge | Panel-Version + Uptime |

### Grafana Dashboard

Unter **Admin-Bereich → Prometheus Metrics → Dashboard herunterladen** gibt es ein fertiges Dashboard-JSON mit 4 Stat-Panels, CPU/RAM-Zeitreihen, Netzwerk RX/TX und einer farbkodierten Server-Status-Tabelle.

### Docker Compose (Prometheus + Grafana)

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

### GitHub einrichten

1. [GitHub Developer Settings](https://github.com/settings/developers) → **New OAuth App**
2. **Authorization callback URL**: `https://deine-panel-domain/api/auth/oauth/github/callback`
3. Client ID + Secret in **Admin-Bereich → OAuth / Social Login** eintragen

### Discord einrichten

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application → OAuth2**
2. **Redirect URI**: `https://deine-panel-domain/api/auth/oauth/discord/callback`
3. Client ID + Secret in **Admin-Bereich → OAuth / Social Login** eintragen

### Account-Matching

| Situation | Aktion |
|---|---|
| OAuth-Account bereits verknüpft | Direkter Login |
| Gleiche E-Mail wie bestehender Account | Automatische Verknüpfung |
| Neue E-Mail | Neuen Account anlegen |

Verknüpfte Konten verwalten unter **Einstellungen → Verknüpfte Konten**.

---

## Mod Auto-Update

### Funktionsweise

1. SHA1-Hashes aller JARs im Container werden berechnet
2. Batch-Lookup gegen die [Modrinth API](https://docs.modrinth.com) (`/v2/version_files`)
3. Exakte Versionsidentifikation — keine fehleranfällige Dateinamen-Heuristik
4. Neuere Versionen werden heruntergeladen, alte Dateien gelöscht

### Konfiguration

**Server → Mods-Tab → Auto-Update:**

| Einstellung | Optionen |
|---|---|
| Auto-Update | Ein / Aus |
| Prüfintervall | 1 h · 3 h · 6 h · 12 h · 24 h · 48 h · 168 h |
| Bei Update benachrichtigen | Discord / E-Mail |

### Manueller Check

**Server → Mods → „Updates prüfen"** — zeigt alle Updates mit Changelog-Vorschau, alter/neuer Version und Dateigröße.

---

## Auto-Backup Zeitpläne

Automatische Backups laufen im Hintergrund ohne manuelle Eingriffe.

### Konfiguration

**Server → Backups-Tab → Automatisches Backup → Konfigurieren:**

| Feld | Beschreibung |
|---|---|
| Cron-Ausdruck | Zeitplan (z.B. `0 4 * * *` = täglich 04:00) |
| Aufbewahrung | Anzahl Backups die behalten werden (1–50) |
| Name-Template | `{date}` · `{time}` · `{server}` als Platzhalter |

Älteste Backups werden automatisch gelöscht sobald das Limit erreicht ist. Mit **„Jetzt"**-Button kann der Zeitplan auch manuell ausgelöst werden.

### Beispiel-Konfiguration

```
Cron:       0 3 * * *           (täglich 03:00 Uhr)
Aufbewahren: 7                   (eine Woche Verlauf)
Template:   Auto {date} {time}   → z.B. "Auto 2025-01-15 03-00"
```

---

## Server-Broadcast

Sendet einen Befehl gleichzeitig an mehrere Server — nützlich für Wartungsankündigungen oder Server-weite Aktionen.

### Verwendung

**Client-Bereich → Broadcast:**

1. Befehl eingeben (z.B. `say Wartung in 10 Minuten!`)
2. Ziel wählen: alle laufenden Server, alle Server, oder manuelle Auswahl
3. Optional: Verzögerung zwischen Servern (0–2000 ms)
4. **„Broadcast senden"** klicken

### API

```bash
curl -X POST http://panel-ip:3000/api/servers/broadcast \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"command":"say Hello","target":"running","delay_ms":500}'
```

---

## Console Aliases

Eigene Shortcuts für häufig genutzte Befehle — pro Server und pro Benutzer.

### Erstellen

**Server → Console-Tab → Hash-Icon (Aliases) → Neuer Alias:**

| Feld | Beispiel |
|---|---|
| Name | `restart` |
| Befehl | `say Restarting in 10s` |

### Verwenden

In der Console einfach `/aliasname` eingeben statt des vollständigen Befehls:

```
/restart    →  say Restarting in 10s
/save       →  save-all
/players    →  list
```

Aliases sind benutzerspezifisch — jeder Benutzer hat seine eigenen Shortcuts pro Server.

---

## Server-Favoriten

Server können als Favorit markiert werden, um sie in der Liste zu priorisieren.

Klicke auf das **Stern-Icon** rechts in einem Server-Eintrag. Favorisierte Server werden gelb hervorgehoben. Die Favoriten-Einstellung ist benutzerspezifisch und wird serverseitig persistiert.

---

## Pterodactyl Import

Bestehende Pterodactyl-Infrastruktur kann direkt in NexPanel importiert werden — ohne manuelle Neuerstellung.

### Eggs importieren

**Admin-Bereich → Eggs / Templates → „Pterodactyl Import":**

- **JSON einfügen**: PTDL_v1 oder PTDL_v2 JSON direkt einfügen
- **Datei hochladen**: `.json`-Datei per Drag & Drop
- **Bulk**: mehrere Eggs als JSON-Array oder mehrere Dateien gleichzeitig

Unterstützte Formate: `PTDL_v1`, `PTDL_v2`, NexPanel Re-Export.

Die Import-Engine erkennt das Format automatisch und konvertiert:
- `{{VARIABLE}}` → `${VARIABLE}` (Startup-Command)
- Laravel Validation Rules → NexPanel ENV-Variablen-Schema
- `docker_images`-Map → primäres Image + Beschreibungsanhang
- Kategorie und Icon werden automatisch aus dem Egg-Namen erkannt

### Server importieren

**Admin-Bereich → Ptero Server Import** (oder Sidebar-Link):

JSON aus dem Pterodactyl Application API (`GET /api/application/servers`) einfügen. Unterstützt Einzel-Server und Arrays. Der Ziel-Node und -Benutzer können frei gewählt werden.

### Eggs exportieren

In der Egg-Detailansicht gibt es einen **„Exportieren"**-Button der ein PTDL_v1-kompatibles JSON zum Download erzeugt — kompatibel mit anderen Pterodactyl-Instanzen.

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

Nodes mit zu wenig Ressourcen für den neuen Server werden ausgeschlossen.

### Konfiguration

**Admin-Bereich → Auto-Scaling** — Schwellenwerte und Gewichtungsfaktoren anpassen. Die Scoring-Vorschau zeigt den aktuellen Score aller Nodes in Echtzeit.

### Auto-Register für Cloud-Deployments

```bash
NODE_AUTO_REGISTER_KEY="<key-aus-dem-panel>" \
PANEL_URL="https://panel.example.com" \
node src/daemon/daemon.js --auto-register --name="Node-DE-1" --location="Frankfurt"
```

---

## Client- & Admin-Bereich

NexPanel trennt die Navigation wie Pterodactyl in zwei Bereiche:

### Client-Bereich
Für alle Benutzer zugänglich:
- Dashboard, Server-Liste, Server-Gruppen
- Compose Import, Broadcast
- Webhooks, Sessions, API Keys, Einstellungen

### Admin-Bereich
Nur für Admins (automatisch per Klick auf „Admin" im Sidebar-Switcher):
- Infrastruktur: Nodes, Port Allocations, Node Ressourcen, Auto-Scaling
- Management: Benutzer, Eggs/Templates, Docker Images, Ptero Import
- System: Audit Log, OAuth, Prometheus, Status-Page, API Docs

Der Bereich-Switcher sitzt direkt unter dem Brand-Logo. Die gewählte Area wird in `localStorage` gespeichert. Beim direkten Aufruf einer Admin-Seite (z.B. per Deeplink) wechselt das Panel automatisch in den Admin-Bereich.

---

## API-Dokumentation

**Erreichbar unter:** `http://panel-ip:3000/api/docs`

**98 dokumentierte Endpunkte** in 16 Kategorien: Auth, OAuth, Servers, Files, Backups, Schedule, Subusers, Notifications, Alerts, Mods, Nodes, Allocations, Groups, Webhooks, Admin, Metrics.

### Token setzen

1. `/api/docs` öffnen
2. JWT Token in das Feld oben einfügen → „Anwenden"
3. Alle „Try it out"-Requests laufen automatisch authentifiziert

Token wird in `localStorage` gespeichert und beim nächsten Aufruf wiederhergestellt.

### OpenAPI Spec

```
GET /api/docs/openapi.json
```

Importierbar in Postman, Insomnia, oder OpenAPI-Code-Generatoren.

---

## WebSocket-Protokoll

### Browser → Panel (`/ws`)

```jsonc
{ "type": "auth",              "token": "<jwt>" }
{ "type": "subscribe_stats",   "server_id": "<uuid>" }
{ "type": "console.subscribe", "server_id": "<uuid>" }
{ "type": "console.input",     "server_id": "<uuid>", "data": "say Hallo" }
{ "type": "unsubscribe",       "server_id": "<uuid>" }
```

### Panel → Browser

```jsonc
{ "type": "stats",         "server_id": "<uuid>", "data": { "cpu": 34.5, "memory_mb": 1024 } }
{ "type": "console.output","server_id": "<uuid>", "data": "[Server] Done!\n" }
{ "type": "server_status", "server_id": "<uuid>", "status": "running" }
{ "type": "resource_alert","server_id": "<uuid>", "level": "critical", "metric": "cpu" }
```

### Daemon → Panel (`/daemon`)

```
Header: x-node-id:    <node-uuid>
Header: x-node-token: hpd_<token>
```

---

## Dateistruktur

```
nexpanel/
│
├── server.js                   ← Express-Server, Router-Mounts, Rate-Limiter
├── package.json                ← v3.0.0 — scripts: start / dev / daemon
├── .env.example                ← vollständig dokumentierte Konfigurationsvorlage
├── .gitignore
├── README.md
│
├── src/                        ← Backend-Module
│   ├── core/                   ← Kernel-Module
│   │   ├── db.js               ← SQLite-Schema, Migrationen, Seed-Daten
│   │   ├── ws-panel.js         ← Browser-WebSocket: Konsole, Stats, Auth
│   │   ├── scheduler.js        ← Cron-Runner + Mod-Update-Tick + Backup-Tick
│   │   ├── notifications.js    ← Discord Webhook + E-Mail + ausgehende Webhooks
│   │   ├── resource-alerts.js  ← CPU/RAM/Disk Schwellenwert-Engine + Cooldown
│   │   ├── resource-limits.js  ← Disk-Scan alle 5 min, WS-Warnungen
│   │   ├── stats-collector.js  ← Container-Stats alle 30 s → server_stats_log
│   │   ├── status-uptime.js    ← Tägliche Uptime-Snapshots (23:55 Uhr)
│   │   └── scaling.js          ← Node-Scoring-Engine, getBestNode()
│   │
│   ├── docker/                 ← Docker-Abstraktion
│   │   ├── docker-local.js     ← Lokaler Docker-Client (dockerode)
│   │   ├── node-router.js      ← Routing: Daemon-WS oder lokales Docker
│   │   └── daemon-hub.js       ← WebSocket-Manager für Daemon-Verbindungen
│   │
│   ├── mods/                   ← Mod- & Backup-Automatisierung
│   │   ├── mod-auto-updater.js        ← SHA1 → Modrinth → Download
│   │   └── auto-backup-scheduler.js  ← Cron-basierte Auto-Backups + Retention
│   │
│   ├── sftp/
│   │   └── sftp-server.js      ← SSH2-SFTP-Gateway auf Port 2022
│   │
│   └── daemon/
│       └── daemon.js           ← Eigenständiger Node-Daemon (Remote-Server)
│
├── routes/                     ← Express-Router (27 Dateien)
│   ├── auth.js                 ← Login, Register, JWT, 2FA/TOTP, API-Keys
│   ├── oauth.js                ← GitHub + Discord Social Login
│   ├── servers.js              ← Server CRUD, Power, Logs, Stats, Clone
│   ├── nodes.js                ← Node-Verwaltung, Token-Rotation
│   ├── allocations.js          ← Port-Allokationen
│   ├── eggs.js                 ← Server-Templates / Eggs
│   ├── files.js                ← Datei-Manager
│   ├── backups.js              ← Backups + Auto-Backup-Zeitpläne
│   ├── mods.js                 ← Mod-Installer + Update-Check + Changelog
│   ├── schedule.js             ← Geplante Aufgaben (Cronjobs)
│   ├── subusers.js             ← Sub-User + Berechtigungen
│   ├── notifications.js        ← Benachrichtigungs-Einstellungen
│   ├── alerts.js               ← Ressourcen-Alert-Regeln
│   ├── groups.js               ← Server-Gruppen + Tags
│   ├── webhooks.js             ← Ausgehende Webhooks (HMAC-signiert)
│   ├── sessions.js             ← JWT-Session-Verwaltung
│   ├── status.js               ← Öffentliche Status-Page
│   ├── maintenance.js          ← Maintenance-Modus + Server-Transfer
│   ├── bulk.js                 ← Bulk Power-Actions, Console/Stats-History
│   ├── compose.js              ← Docker Compose Import + Reinstall
│   ├── scaling.js              ← Auto-Scaling-Config + Scoring-Preview
│   ├── metrics.js              ← Prometheus /metrics + Token-Verwaltung
│   ├── admin.js                ← Benutzer, Audit-Log, Docker, Admin-Stats
│   ├── broadcast.js            ← Server-Broadcast
│   ├── favorites.js            ← Server-Favoriten + Console-Aliases
│   ├── pterodactyl.js          ← Pterodactyl Egg/Server-Import + Export
│   └── docs.js                 ← Swagger UI + OpenAPI 3.0 Spec
│
├── public/                     ← Frontend
│   ├── index.html              ← App-Shell (218 Zeilen — lädt CSS + JS)
│   ├── css/
│   │   ├── variables.css       ← CSS Custom Properties, Dark/Light Theme
│   │   ├── layout.css          ← Sidebar, Topbar, Auth, Area-Switcher
│   │   ├── components.css      ← Buttons, Forms, Cards, Modals, Badges
│   │   ├── pages.css           ← Server, Console, Files, Mods, Backups, Admin
│   │   └── utils.css           ← Animationen, Keyframes, Responsive Breakpoints
│   └── js/
│       ├── core.js             ← State, API-Client, Utilities, Formatierung
│       ├── auth.js             ← Login, Register, 2FA/TOTP, OAuth
│       ├── ws.js               ← WebSocket-Verbindung, Status-Polling
│       ├── nav.js              ← Navigation, Area-Switcher, App-Bootstrap
│       ├── dashboard.js        ← Dashboard-Seite
│       ├── servers.js          ← Server-Liste, Erstellen, Klonen, Bulk
│       ├── server-detail.js    ← Server-Detail, Console, Live-Charts
│       ├── files.js            ← File Manager
│       ├── mods.js             ← Mod-Manager + Pterodactyl Import UI
│       ├── server-tabs.js      ← Backups, Schedule, Subusers, Alerts, SFTP…
│       ├── admin.js            ← Alle Admin-Seiten
│       └── account.js         ← Settings, API Keys, Groups, Webhooks, Broadcast
│
├── data/                       ← Runtime-Daten (DB, SFTP-Key) — in .gitignore
└── backups/                    ← Backup-Dateien — in .gitignore
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

## Cron-Format (Geplante Tasks & Auto-Backup)

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

> RAM-Limit des Containers = `MEMORY` + ~300 MB, z.B. `MEMORY=1500M` → Container-Limit `1800 MB`.

---

## Tech Stack

| Schicht | Technologie | Zweck |
|---|---|---|
| Runtime | Node.js 18+ | Server und Daemon |
| Web-Framework | Express 4 | REST API + Static Serving |
| Datenbank | SQLite (better-sqlite3) | Synchron, keine externe DB nötig |
| Auth | jsonwebtoken + bcryptjs | JWT-Sessions, Passwort-Hashing |
| 2FA | speakeasy + qrcode | TOTP-Generierung und QR-Codes |
| Docker | dockerode | Container-Management |
| WebSocket | ws | Echtzeit-Konsole und Stats |
| SFTP | ssh2 | Datei-Gateway auf Port 2022 |
| Backups | archiver | tar.gz-Komprimierung |
| Rate-Limiting | express-rate-limit | DDoS / Brute-Force-Schutz |
| Frontend | Vanilla JS SPA | Kein Framework, kein Build-Step |
| Charts | Chart.js 4 | Ressourcen-Graphen |
| Icons | Lucide Icons (CDN) | SVG-Icon-System (16–20 px) |
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
      - nexpanel_backups:/app/backups
    ports:
      - '3000:3000'
      - '2022:2022'
    environment:
      - PORT=3000
      - DB_PATH=/app/data/nexpanel.db
      - BACKUP_PATH=/app/backups
      - SFTP_HOST_KEY_PATH=/app/data/sftp_host_key
      - DOCKER_SOCKET=/var/run/docker.sock
    command: ['node', 'server.js']
    restart: unless-stopped

volumes:
  nexpanel_data:
  nexpanel_backups:
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

**Reverse-Proxy mit TLS** — NexPanel nie direkt im Internet exponieren:

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
- `data/` und `backups/` mit restriktiven Dateisystem-Rechten absichern (`chmod 700`)
- SFTP Host-Key (`data/sftp_host_key`) sichern — Verlust erzwingt Fingerprint-Änderung bei allen Clients

---

## FAQ

**Warum werden keine Icons oder Schriften geladen?**
NexPanel lädt Lucide Icons und Google Fonts von externen CDNs. Ohne Internetverbindung erscheinen Fallback-Symbole. Für Offline-Setups die Assets lokal in `public/` einbinden und die CDN-Links in `public/index.html` anpassen.

**Kann ich mehrere NexPanel-Instanzen auf einem Server betreiben?**
Ja — unterschiedliche `PORT`-Werte und separate `DB_PATH`-Pfade genügen.

**Was passiert wenn ein Node offline geht?**
Alle Server auf dem Node zeigen Status `offline`. Sobald der Daemon reconnected, werden die Status automatisch aktualisiert. Ausstehende Aktionen werden nicht wiederholt.

**Wie sichere ich die Datenbank?**
```bash
# Hot-Backup bei laufendem Panel (WAL-Mode erlaubt das)
sqlite3 data/nexpanel.db ".backup data/nexpanel_$(date +%Y%m%d_%H%M).db"
```
Für automatisierte Backups: täglichen Cron-Job oder `restic` / `rclone` einrichten.

**Wo werden Auto-Backups gespeichert?**
Unter `backups/<server-id>/` als `.tar.gz`-Dateien. Der Pfad kann über `BACKUP_PATH` in der `.env` angepasst werden.

**Wo liegt der SFTP Host-Key?**
Standardmäßig in `data/sftp_host_key`. Pfad über `SFTP_HOST_KEY_PATH` konfigurierbar. Die Datei beim ersten Start automatisch erstellt.

**Was bedeutet der Console Alias `/`-Prefix?**
In der Server-Console erkennt NexPanel Eingaben die mit `/` beginnen als Alias-Aufruf. `/restart` löst den definierten Alias aus statt den Buchstaben `/restart` an den Server zu senden.

**Unterstützt NexPanel IPv6?**
Der Express-Server lauscht standardmäßig auf `0.0.0.0`. Für IPv6 `HOST=::` in der `.env` setzen.

**Wie migriere ich von Pterodactyl?**
Eggs können direkt per PTDL_v1/v2 JSON importiert werden (**Admin → Eggs → Pterodactyl Import**). Server können über den Pterodactyl Application API Export migriert werden (**Admin → Ptero Server Import**). Eine vollständige Datenbank-Migration ist nicht notwendig.

**Werden Windows-Container unterstützt?**
Aktuell nur Linux-Container getestet. Windows-Container (Hyper-V Isolation) sind nicht offiziell unterstützt.

---

## Lizenz

MIT License

---

<div align="center">
  <sub>NexPanel v3.0 — gebaut mit Node.js, SQLite und zu viel Koffein</sub>
</div>
