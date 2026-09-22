# Installation

## Ziel

Am Ende läuft das Gateway, die Admin-Oberfläche ist erreichbar und der
Testmonitor kann eine Anfrage verarbeiten.

## Belegbare Voraussetzungen

- Node.js `22` oder neuer
- npm
- Schreibbarer Speicher für SQLite
- Erreichbare OpenAI-kompatible Chat-Completions-Schnittstelle
- Ein langes, zufälliges Gateway-Token
- Optional Docker für externe Dienste wie HA-MCP oder SearXNG
- Für Alexa später: öffentliche HTTPS-Adresse sowie Amazon- und AWS-Zugang

## Gateway-Umgebung

Diese Variablen liest der Gateway-Code beim Start:

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `AUTH_TOKEN` | ja | schützt Admin- und API-Zugriffe |
| `LLM_BASE_URL` | ja | Basis-URL der OpenAI-kompatiblen Schnittstelle |
| `LLM_API_KEY` | ja | API-Schlüssel; der Prozess verlangt einen Wert |
| `PORT` | nein | Gateway-Port, Standard `3000` |
| `DB_PATH` | nein | SQLite-Datei, Standard `./data/meinhelfer.db` |
| `LLM_MODEL` | nein | Startmodell, Standard `chat-fast` |
| `LLM_MAX_TOKENS` | nein | Ausgabe-Budget, Standard `2000` |
| `ALEXA_SKILL_ID` | für Alexa | erwartete Skill-ID |
| `ALEXA_VERIFY_MODE` | nein | `off`, `warn` oder `enforce`; Code-Standard `enforce` |

## Vorläufiger Node.js-Weg

Dieser Weg folgt direkt aus `gateway/package.json`. Er ist noch nicht als
offizieller Produktionsweg festgelegt.

1. Wechsle in das Verzeichnis `gateway`.
2. Führe `npm ci` aus.
3. Lege dort eine `.env` mit den Pflichtwerten an.
4. Prüfe mit `npm run build`.
5. Starte mit `npm start`.
6. Öffne den konfigurierten Host auf Port `3000` beziehungsweise `PORT`.

Beispiel `.env`:

```dotenv
AUTH_TOKEN=<langen-zufälligen-wert-eintragen>
LLM_BASE_URL=http://<llm-host>:<port>/v1
LLM_API_KEY=<api-key-oder-lokaler-platzhalter>
LLM_MODEL=<modellname>
PORT=3000
DB_PATH=./data/meinhelfer.db
```

**Prüfung:** Der Prozess meldet keine fehlende Umgebungsvariable. Die
Admin-Oberfläche öffnet sich und akzeptiert `AUTH_TOKEN`.

## Docker- oder Compose-Installation

Für das Gateway ist im Repository keine vollständige Dockerfile- oder
Compose-Definition sichtbar. Eine konkrete Anleitung wäre daher Spekulation.

### Was noch fehlt

- Image-Quelle oder Dockerfile und Build-Kontext
- Startbefehl und Arbeitsverzeichnis
- persistentes Volume für `DB_PATH`
- Port-Mapping
- Übergabe von Secrets
- Container-Benutzer und Dateirechte
- Pakete für lokale stdio-MCP-Server
- Healthcheck und Neustartstrategie

### So wird das Kapitel vervollständigt

1. Den aktuell produktiv verwendeten Compose-Service exportieren.
2. Hostnamen, Tokens und lokale Pfade durch Platzhalter ersetzen.
3. Mit leerem Datenvolume starten.
4. Admin-Login, Neustart mit erhaltener Datenbank und stdio-MCP testen.
5. Nur die reproduzierbar getestete Fassung übernehmen.

## LLM-Schnittstelle

Das Gateway erwartet eine OpenAI-kompatible `chat/completions`-Schnittstelle.
Der konkrete Modellserver ist austauschbar und nicht Teil des Repositories.

### Was noch fehlt

- unterstützte Anbieter oder lokale Server
- korrektes Format der jeweiligen `LLM_BASE_URL`
- getestete Modellnamen
- Referenzwerte für Tokenbudget und Timeouts
- Installation eines optionalen Tool-Modells

### Mindestprüfung

Das Modell muss Tool-Aufrufe beherrschen und finales JSON entsprechend dem
Agent-Prompt liefern. Ein reiner Chat-Endpunkt ohne Tool-Calling genügt für
Agent-Vorgänge nicht.

## Netzwerk und HTTPS

Der Testmonitor funktioniert lokal. Alexa benötigt einen öffentlich
erreichbaren HTTPS-Weg zum Skill-Endpunkt.

### Was noch fehlt

- unterstützter Reverse Proxy
- TLS- und Weiterleitungsbeispiel
- öffentlicher Pfad für `/alexa`
- LAN-Beschränkung für Admin-Oberfläche und `/admin/*`
- Firewall- und Rate-Limit-Regeln

### Sicherheitsziel

Nur der Alexa-Endpunkt soll öffentlich erreichbar sein. Admin-Oberfläche und
Admin-API gehören ins lokale Netz. Für öffentliche Deployments muss die
Alexa-Signaturprüfung auf `enforce` stehen.

## Abnahme

- Gateway startet mit dokumentiertem Befehl.
- SQLite-Daten bleiben nach Neustart erhalten.
- Admin-Token schützt Oberfläche und API.
- Testmonitor liefert eine Antwort.
- Logs zeigen Route, Dauer und Antwort.
- Bei Alexa-Nutzung ist nur der notwendige Endpoint öffentlich exponiert.
