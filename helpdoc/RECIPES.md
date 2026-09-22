# Praxisrezepte

Jedes Rezept folgt derselben Reihenfolge: **Ergebnis**, **Voraussetzungen**,
**Einrichtung**, **Prüfung**, **Hintergrund**.

## Home Assistant verbinden

### Ergebnis

Das Gateway sieht die Werkzeuge des HA-MCP-Servers und kann daraus einen
lokalen Entity-Index aufbauen.

### Voraussetzungen

- laufendes Home Assistant
- entweder HA-MCP Custom Component oder separater HA-MCP-Dienst
- bei der Docker-Variante ein Home-Assistant-Long-Lived-Access-Token

### HA-MCP als Docker-Dienst

```yaml
ha-mcp:
  image: ghcr.io/homeassistant-ai/ha-mcp:latest
  container_name: ha-mcp
  restart: unless-stopped
  command: ha-mcp-web
  ports:
    - "8086:8086"
  env_file:
    - ./mcp.env
  volumes:
    - ./data:/home/mcpuser/.ha-mcp
    - /etc/timezone:/etc/timezone:ro
    - /etc/localtime:/etc/localtime:ro
  environment:
    - TZ=Europe/Berlin
  healthcheck:
    test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://localhost:8086/mcp/settings', timeout=5)"]
    interval: 60s
    timeout: 10s
    retries: 3
    start_period: 30s
```

`mcp.env` enthält den Home-Assistant-Token. Alternativ läuft die HA-MCP
Custom Component in Home Assistant selbst. Verwende nur eine Variante.

### Gateway einrichten

Unter **Tool-Registry**:

| Feld | Wert |
|---|---|
| Name | `Home Assistant MCP` |
| Transport | `Streamable HTTP` |
| URL | `http://<ha-host>:8086/mcp` |
| Auth-Token | bei obiger Variante leer |
| Aktiv | an |

Wähle **Tools abfragen**.

### Prüfung

Die Liste zeigt `ha_*`-Werkzeuge. Lege anschließend den Standard-Index aus
dem [Schnellstart](QUICKSTART.md#3-standard-index-anlegen) an und teste die
Probe `Sonne`.

### Hintergrund

Der Index lädt alle Zustände in einem Snapshot und durchsucht sie lokal.
Schreibende Aktionen laufen weiterhin über konkrete HA-MCP-Werkzeuge.

## Sonnenstand

### Ergebnis

„Ist die Sonne schon untergegangen?“ liefert eine feste Antwort ohne LLM.

### Voraussetzungen

- Home Assistant und Standard-Index sind eingerichtet
- `sun.sun` ist im Index sichtbar

### Einrichtung

Funktion `sonnenstand`:

```jinja
Die Sonne ist gerade {{ 'über' if index.state('sun.sun') == 'above_horizon' else 'unter' }} dem Horizont.
```

Vorgang:

| Feld | Wert |
|---|---|
| Name | `Sonnenstand` |
| Modus | `deterministic` |
| Trigger | `sonne`, `sonnenstand`, `geht die sonne unter` |
| Funktion | `sonnenstand` |

### Prüfung

Führe erst die Funktion aus und frage danach im Monitor `Sonnenstand`.

### Hintergrund

Der Zustand ist `above_horizon` oder `below_horizon`. Auf- und
Untergangszeiten sind Attribute und benötigen einen gezielten Tool-Aufruf.

## Ist jemand zuhause?

Dieses Rezept ist vollständig im [Schnellstart](QUICKSTART.md) beschrieben.
Es verwendet `zone.home` und den Modus `deterministic`.

## Wetter über HTTP

### Ergebnis

Ein fester Drei-Tage-Bericht wird direkt aus einer strukturierten Wetter-API
erzeugt.

### Voraussetzungen

- öffentlich erreichbare, schlanke JSON-Wetter-API
- eigene Koordinaten und Zeitzone

### Einrichtung

Funktion `wetter`:

```jinja
{%- set d = http('https://<wetter-api>/v1/forecast?latitude=<breite>&longitude=<länge>&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FBerlin&forecast_days=3', 600000) -%}
{%- macro wt(c) -%}{%- if c == 0 %}klar{%- elif c <= 3 %}wolkig{%- elif c <= 65 %}Regen{%- else %}Schnee{%- endif -%}{%- endmacro -%}
{%- for i in range(d.daily.time | length) -%}
{{ d.daily.time[i] }}: {{ wt(d.daily.weather_code[i]) }}, bis {{ d.daily.temperature_2m_max[i] | round(0) }} Grad.
{% endfor -%}
```

Vorgang `Wetter`, Modus `deterministic`, Trigger `wetter` und
`wetterbericht`, Funktion `wetter`.

### Prüfung

**Ausführen** muss drei Zeilen mit Datum, Wetter und Temperatur liefern.

### Hintergrund und Grenzen

`http()` parst JSON automatisch. Der zweite Parameter cached die Antwort in
Millisekunden. Antworten über dem konfigurierten Body-Limit werden als Rohtext
geliefert. Die Platzhalter-URL ist bewusst nicht direkt ausführbar; die
konkrete API-Auswahl fehlt noch.

## Gateway-Laufzeit

### Ergebnis

„Wie lange läuft der Server schon?“ liest Linux-Systemdaten ohne LLM.

### Einrichtung

Funktion `gateway_uptime`:

```jinja
Das Gateway läuft seit {{ (shell('cat /proc/uptime | cut -d . -f1') | int / 86400) | round(1) }} Tagen.
```

Vorgang im Modus `deterministic`, Trigger `uptime` und `läuft der server`.

### Prüfung

Die Funktion liefert über **Ausführen** eine plausible Tageszahl.

### Grenze

Der Befehl läuft in der Umgebung des Gateways. In einem Container ist das die
Container-Laufzeit, nicht zwingend die Host-Laufzeit. `shell()` ist auf kurze,
administrativ gepflegte Befehle mit Timeout und Output-Limit beschränkt.

## Hausstatus-Bericht

### Ergebnis

Mehrere Zustände werden als fester, sprechbarer Bericht mit Fallbacks und
Pausen ausgegeben.

### Voraussetzungen

Die im Template verwendeten Entity-IDs müssen durch echte Einträge aus dem
eigenen Index ersetzt werden.

### Einrichtung

```jinja
{%- macro gfmt(val, dec=2) -%}
{%- if val in ['unknown','unavailable',''] -%}unbekannt{%- else -%}{{ val | float(0) | round(dec) | replace('.', ',') }}{%- endif -%}
{%- endmacro -%}
<speak>
Der Akkustand beträgt {{ gfmt(index.state('sensor.beispiel_pv_akkustand'), 0) }} Prozent.
<break time="300ms"/>
Der Verbrauch liegt bei {{ gfmt(index.state('sensor.beispiel_verbrauch'), 0) }} Watt.
</speak>
```

Funktion `hausstatus`, Vorgang im Modus `deterministic`, Trigger
`hausstatus` und `wie ist der hausstatus`.

### Prüfung

Teste zuerst verfügbare Werte und danach mindestens einen Sensor im Zustand
`unknown` oder `unavailable`.

### Hintergrund

Das Makro verhindert irreführende Nullwerte. Ein Ergebnis mit `<speak>` wird
als SSML behandelt. Für Display-Inhalte wird daraus Klartext erzeugt.

## Außentemperatur als Hybrid-Antwort

### Ergebnis

Home Assistant liefert die Temperatur; das LLM formuliert eine natürliche
Einordnung.

### Einrichtung

Funktion `aussen_temperatur`:

```jinja
Aussentemperatur: {{ mcp.call('ha_eval_template', {'template': "states.weather.home.attributes.temperature"}) }} Grad.
```

Vorgang im Modus `hybrid`, Trigger `wie warm draußen` und
`außentemperatur`, Funktion `aussen_temperatur`. Das eigene System-Prompt kann
leer bleiben.

### Prüfung

Die Funktionsprobe zeigt zuerst den Rohwert. Der Monitor formuliert daraus
einen kurzen Satz.

### Hintergrund

Das Attribut `temperature` ist nicht zwingend der State von `weather.home`.
Der gezielte Template-Aufruf liest deshalb das Attribut. In dynamischen
`mcp.call`-Objekten sind `args` und `now`, aber keine lokalen `set`-Variablen
verfügbar.

## Licht schalten

### Ergebnis

„Schalte das Küchenlicht ein“ sucht zunächst eine echte Entity-ID und führt
danach den passenden Service aus.

### Voraussetzungen

- HA-MCP und Standard-Index
- aktive Funktion `find_entities` als Agent-Werkzeug
- Such- und Service-Werkzeug in der Allowlist

### Einrichtung

Im Agent-Inventory-Prompt des Home-Assistant-MCP-Servers:

```text
Schalten: zuerst fn_find_entities mit dem Namen aufrufen. Die gelieferte
entity_id anschließend mit dem passenden HA-Service verwenden. Keine ID
raten oder erfinden. Bei mehreren passenden Treffern kurz nachfragen und
keinen Service ausführen.
```

Vorgang im Modus `llm` oder allgemeine Agent-Route verwenden.

### Prüfung

1. Teste ein eindeutig benanntes Licht.
2. Prüfe im Trace zuerst `fn_find_entities`, danach den Service-Aufruf.
3. Teste absichtlich einen mehrdeutigen Namen; es darf nichts geschaltet
   werden.

### Hintergrund

Der Suchtreffer enthält ID und Zustand. Ein zusätzlicher Lesecall ist nicht
nötig. Erfolg darf erst nach dem tatsächlichen Service-Aufruf bestätigt werden.

## Music Assistant verbinden und Musik starten

### Ergebnis

Der Agent findet einen Player, sucht Künstler, Album oder Playlist und startet
die Wiedergabe.

### Voraussetzungen

- laufender Music Assistant
- aktiviertes MCP-Server-Plugin `ma-provider-mcp`
- Client-Token mit Steuerrechten

### Einrichtung

In Music Assistant das MCP-Plugin aktivieren und über **Open Connect Wizard**
einen Client-Token erzeugen. Danach unter **Tool-Registry**:

| Feld | Wert |
|---|---|
| Name | `Music Assistant` |
| Transport | `Streamable HTTP` |
| URL | `http://<ma-host>:8095/mcp/v1` |
| Auth-Token | erzeugter Client-Token |
| Aktiv | an |

**Tools abfragen** muss `search_tools`, `get_tool_schema` und `call_tool`
zeigen.

Ergänze als Systemregel:

```text
Musiksteuerung: zuerst den gewünschten Player samt player_id ermitteln. Dann
search_tools für den benötigten Katalogbefehl, get_tool_schema für dessen
Parameter und call_tool zur Ausführung verwenden. Für Wiedergabe passende
Playlist oder passendes Album bevorzugen; sonst Künstler-URI verwenden.
Interne IDs nie raten.
```

### Prüfung

Prüfe im Trace die Reihenfolge Player-Suche, Katalogsuche, Schema und
Ausführung. Teste außerdem einen absichtlich falsch erkannten Künstlernamen.

### Offene Angabe

Das vollständige Template und Parameter-Schema der erwähnten Funktion
`ma_players` ist in der bisherigen Dokumentation nicht enthalten und muss aus
der aktiven Installation exportiert oder neu reproduzierbar definiert werden.

## Websuche mit SearXNG

### Ergebnis

Der Agent sucht aktuelle Treffer und liest höchstens eine konkrete Quelle.

### Voraussetzungen

- SearXNG mit aktivierter JSON-Ausgabe
- Paket `mcp-searxng` in der Gateway-Laufzeitumgebung

SearXNG-Konfiguration:

```yaml
search:
  formats:
    - html
    - json
```

Tool-Registry:

| Feld | Wert |
|---|---|
| Name | `SearXNG` |
| Transport | `stdio` |
| Befehl | `node_modules/.bin/mcp-searxng` |
| Umgebung | `SEARXNG_URL=http://<searxng-host>:8080/search` |
| Aktiv | an |

Agent-Inventory-Regel:

```text
Nur konkrete Treffer-URLs oder ausdrücklich gewünschte URLs lesen. Nach der
Lese-Runde sofort antworten und keine zweite URL öffnen.
```

### Prüfung

**Tools abfragen** zeigt die Suchwerkzeuge. Eine Agentenanfrage muss zuerst
suchen und darf anschließend höchstens eine konkrete Treffer-URL lesen.

## Websuche mit Brave

### Ergebnis

Brave dient als alternative oder zweite Suchquelle.

### Einrichtung

| Feld | Wert |
|---|---|
| Name | `Brave` |
| Transport | `stdio` |
| Befehl | `npx` |
| Argumente | `-y @brave/brave-search-mcp-server` |
| Umgebung | `BRAVE_API_KEY=<key>` |
| Aktiv | an |

### Prüfung

**Tools abfragen** zeigt `brave_web_search`. Das Paket muss in der
Gateway-Laufzeit ausführbar sein.

## Recherche-Funktion

### Ergebnis

Eine parametrisierte Agentenfunktion liefert Suchtreffer und optional einen
RSS-Feed.

### Einrichtung

Parameter-Schema mit erforderlichem `query` und optionalem `url`; Budget `2`.

```jinja
{%- set s = mcp.call('<such-tool>', {'query': args.query, 'count': 5}) -%}{{ s }}
{%- if args.url -%}
--- FEED-PROBE ---
{{ mcp.call('web_url_read', {'url': 'https://' ~ args.url ~ '/rss', 'maxLength': 6000}) }}
{%- endif %}
```

### Prüfung

Teste die Funktion einmal nur mit `query` und einmal mit einer erlaubten
öffentlichen `url`.

### Grenzen

`<such-tool>` ist durch den realen Toolnamen zu ersetzen. Dynamische URLs
dürfen nicht ins private Netz zeigen. Nach einer Leserunde soll der Agent
antworten, statt weitere Quellen einzukaufen.
