# Praxisbeispiele: Vorgänge, Funktionen und Agent-Kaskaden

Sammlung realer Muster aus dem Betrieb — anonymisiert, so dass nichts auf die
eigene Infrastruktur rückschließen lässt. Alle Beispiele sind nach
Grundinstallation **1:1 nachbaubar**: Bei Home Assistant genügen die
Entities, die jede Basisinstallation mitbringt (`sun.sun`, `weather.home`,
`zone.home` — siehe Werkzeuge-Kapitel).

Zentraler Zweck dieser Seite: **wo muss was angelegt werden.** Jedes Beispiel
listet deshalb die Anlage-Schritte (welcher Tab, welche Felder). Die
Grundanbindung der Werkzeuge steht einmal im Werkzeuge-Kapitel (Kapitel 2);
die Cases verweisen nur noch darauf. Technische Grundlagen (Bausteine,
Registry, Index-Konfiguration) stehen in `FUNKTIONEN.md`.

## 1. Einleitung

### Die drei Modi — wann welcher

| Modus | Was passiert | Wann wählen |
|-------|--------------|-------------|
| `deterministic` | Trigger rendert ein Funktions-Template, fertig — ohne LLM | Feste Antwortform: Messwert, Bericht, SSML-Report. Schnellste Antwort, keine Modellkosten |
| `hybrid` | Trigger rendert Funktions-Template (Daten), dann formuliert das LLM daraus die Sprache | Daten liegen vor, aber die Formulierung hängt vom Ergebnis ab (variable Anzahl von Meldungen) |
| `llm` | Trigger reicht die Frage an den Agenten (Tool-Loop über das Tool-Inventory) | Offene Fragen, die kein Trigger vorhersehen kann: der Agent liest die **freie Frage** und entscheidet selbst, welche Tools er nutzt — Kombinationen („Nachrichten und dann der Hausstatus", dafür gibt es unendlich viele Trigger-Varianten), ungepflegte Phrasenvielfalt („ist es draußen kälter als drinnen") und selbstständige Rückfragen („welchen Lautsprecher?") |

Faustregel: **so deterministisch wie möglich, so agentig wie nötig.** Ein
`deterministic`-Vorgang ist unschlagbar schnell und vorhersehbar; der Agent
kombiniert, was kein Trigger vorhersehen kann.

### Anlage-Reihenfolge (gilt für alle Beispiele)

1. **Werkzeuge anlegen** (Kapitel 2): MCP-Server, Index-Quellen — einmalig.
2. **Funktion anlegen** (Tab **Funktionen** → „Neue Funktion"): Name,
   Template, optional Parameter-Schema, `inventory_prompt`/Budget für
   Agent-Tools — mit dem **Ausführen**-Button live testen (echter Kontext).
3. **Vorgang anlegen** (Tab **Vorgänge** → „Neuer Vorgang"): Trigger-Phrasen
   (kommagetrennt), Modus, Funktions-Zuweisung bzw. Agent-Route — im
   **Monitor/Test** mit der echten Frage prüfen.

### Modellwahl — worauf es ankommt

Das Gateway läuft grundsätzlich mit **einem Modell** für Agent,
Hybrid-Formulierung und Index-Assistent — es gibt keine Fallback-Kaskade.
Optional erlaubt `tool_model` („Tool-Modell" in den Grundeinstellungen) ein
eigenes Modell **nur für die Tool-Runden des Agenten** (die latenzkritischen
Runden), während die finale Formulierung auf dem Hauptmodell bleibt; leer =
überall dasselbe. Sinnvoll als gestufte A/B-Schleuse beim Modellwechsel
(erst die Tool-Runden auf dem Kandidaten testen) oder wenn ein kleines
schnelles Tool-fähiges Modell die Runden drücken soll. Für den Komfort
steht und fällt das an:

- **Pflicht: Tool- und JSON-fähig.** Der Agent antwortet in strikt
  `{"needs_clarification", "speech", "keep_open"}`-JSON und steuert
  Tool-Aufrufe. Ohne das scheitern Agent-Antworten grundsätzlich.
- **Latenz vor Eleganz.** Die Alexa-Schicht begrenzt die Antwortzeit: läuft
  die Lambda-Schicht Alexa-hosted, greift Amazons Antwortfenster (ca. 8 s,
  der Warteton überbrückt es praktisch); eigene Varianten entbinden davon —
  Details hängen vom Hosting ab und sollten einmal real verifiziert werden.
  Eine AWS-gehostete Lambda-Implementation sollte der reinen
  Alexa-hosted-Variante bevorzugt werden — AWS handhabt Latenzen
  grundsätzlich großzügiger. Auch ohne harte Grenze: Modelle mit schnellem
  Time-to-First-Token fühlen sich bei Sprachdialogen deutlich besser an.
- **Reasoning-Trade-off.** Reasoner verstehen kombinierte Anfragen und
  Kaskaden besser, brauchen aber Decode-Zeit und längere Antworten
  (`llm_max_tokens` ≥ 800, sonst leere Antworten).
- **Nativ mitgebrachte Websuche?** Einige Modelle können Suchen nativ über
  ihren Anbieter-Stack. Ist das der Fall, kann der Such-Connector entfallen —
  der Gateway-Ansatz (Fähigkeiten als Funktionen/Tools abstrahieren, die
  Quelle bleibt austauschbar) ändert sich dadurch nicht.

### Wo die Regeln leben (ein Satz zur Architektur)

Zentral (`agent_system`) steht nur **generisches Verhalten**. Domänen-Kaskaden
stehen an ihrem System (MCP-Server-Prompt, Feld „Agent-Inventory-Prompt"),
Werkzeug-Eigenheiten an der Funktion (`inventory_prompt`). Dritte können mit
eigenem System + eigenen Noten arbeiten, ohne den Agent-Prompt anzufassen.

## 2. Werkzeuge (Grundanbindung — einmalig)

Jedes Beispiel baut auf diesen Werkzeugen auf. Hier steht einmal, **wo und
wie** man sie anlegt; die Cases nennen sie dann nur noch beim Namen.

### 2.1 Home Assistant (`ha-mcp`, Streamable HTTP)

- **Was es ist**: der offizielle MCP-Server des Home-Assistant-Ökosystems
  ([github.com/homeassistant-ai/ha-mcp](https://github.com/homeassistant-ai/ha-mcp),
  Image `ghcr.io/homeassistant-ai/ha-mcp`), als Container im HTTP-Modus
  (`ha-mcp-web`). Das Gateway verbindet sich per Streamable HTTP — kein
  stdio, kein HA-Supervisor-Endpoint.
- **Anlage (Server-Seite, docker-compose )**:
  ```yaml
  ha-mcp:
    image: ghcr.io/homeassistant-ai/ha-mcp:latest
    container_name: ha-mcp
    restart: unless-stopped
    command: ha-mcp-web          # HTTP-Modus (Streamable HTTP) statt stdio
    ports:
      - "8086:8086"              # Host-Port waehlen 
    env_file:
      - ./mcp.env                # enthaelt das Home-Assistant-Long-Living-Zugangs-Token
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
  (mcp.env: das Home-Assistant-**Long-Lived-Access-Token** — der ha-mcp
  nutzt es selbst, um HA zu bedienen. Es gehört NUR hierher, nicht in das
  Gateway-Feld.)
- **Anlage (Gateway-Seite)**: Tab **Tool-Registry** → Server hinzufügen:
  - Name: `Home Assistant MCP`
  - Transport: `http`
  - URL: `http://<ha-host>:8086/mcp`
  - Auth-Token: **leer** lassen — der ha-mcp verlangt in dieser Anleitung
    keinen Client-Token (Absicherung über das lokale Netz). Das
    Home-Assistant-Long-Living-Zugangs-Token liegt nur in der Container-Env
    (siehe compose oben). **Anders bei HA's eingebaurem `/api/mcp`**: der
    verlangt einen Client-Token im Gateway-Feld — deshalb steht in jedem
    Fall, WELCHER Server gemeint ist.
  - **Agent-Inventory-Prompt**: die Schalten-Kaskade (siehe Fall 5.1), Aktiv ✓.
- **Entity-Index (Lesekanal)**: Tab **Index-Quellen** → Standard-Index. Die
  Konfiguration, die in der Referenz-Installation produktiv läuft — der
  Nachbauer kann sie unverändert übernehmen (keine Platzhalter):
  ```json
  {
    "tool": "ha_eval_template",
    "args": {
      "template": "{% for e in states %}{% set area = area_name(e.entity_id) or '' %}{% set nm = e.attributes.get('friendly_name', e.entity_id) %}{% set extra = 'device_class=' ~ (e.attributes.get('device_class','') or '') ~ ';icon=' ~ (e.attributes.get('icon','') or '') ~ ';supported_features=' ~ (e.attributes.get('supported_features','') or '') %}{% if e.entity_id.startswith('climate.') and e.attributes.get('current_temperature') is not none %}{% set extra = extra ~ ';current_temperature=' ~ (e.attributes.get('current_temperature') or '') %}{% endif %}{{ e.entity_id }}|{{ area }}|{{ e.state }}|{{ e.attributes.get('unit_of_measurement','') or '' }}|{{ nm }}|{{ extra }}\n{% endfor %}",
      "timeout": 15,
      "report_errors": false
    },
    "ttlMs": 60000,
    "aliases": {
      "licht": "light",
      "lampe": "light",
      "steckdose": "switch",
      "temperatur": "temperature",
      "heizung": "climate",
      "klimaanlage": "climate",
      "fenster": "window",
      "tür": "door",
      "fernseher": "media_player",
      "musik": "media_player",
      "rolladen": "cover",
      "garage": "cover",
      "kamera": "camera",
      "bewegung": "motion",
      "luftfeuchtigkeit": "humidity",
      "batterie": "battery",
      "draußen": "aussen",
      "drinnen": "innen",
      "oben": "upstairs",
      "unten": "downstairs"
    }
  }
  ```
  Das Extraktions-Template listet **alle** States als Pipe-Zeilen
  (`entity_id|Raum|State|Einheit|Name|Extra`) — weil der Index-Score (fuzzy +
  Aliase + Domain-Hints) aus der Gesamtliste wählt, gibt es kein
  Wartungs-Einzel-Listing. `current_temperature` ist ausdrücklich im Extra
  (Klima), weil der Agent daraus sofort antwortet.
- **Aliases (Wort → Technikbegriff)**: die Map übersetzt das gesprochene
  deutsche Wort in den englischen Begriff, der in den Extraktionszeilen
  vorkommt — Domain aus der entity_id (`light`, `switch`, `climate`,
  `cover`, `media_player`), `device_class` im Extra-Feld (`window`, `door`,
  `motion`, `humidity`, `battery`, `camera`) oder Slug/Area
  (`aussen`, `innen`, `upstairs`, `downstairs`). Ohne den Alias findet der
  Score oft nichts: „Fernseher" taucht in `media_player.*`-Zeilen meist gar
  nicht auf. Die Paare innerhalb einer JSON-Zeile teilen sich nur den
  Zeilenumbruch — sie sind unabhängige Übersetzungen; `fenster` → `window`
  hat nichts mit `fernseher` → `media_player` zu tun.
- **Basis-Entities der Grundinstallation**: `sun.sun`, `weather.home`,
  `zone.home` sind mit jeder HA-Basisinstallation vorhanden und landen
  automatisch in dem Gesamt-Listing — die deterministischen Beispiele
  (Kapitel 3) laufen damit ohne Zusatz-Integration.

### 2.2 Music Assistant (MCP)

- **Wo**: Tab **Tool-Registry** → MCP-Server hinzufügen (Transport `http` oder
  `stdio` je nach Installation), Token falls nötig, **MCP-System-Prompt** (die
  Wiedergabe-Kaskade + Falscherkennungen), Aktiv ✓.
- **Werkzeuge**: `library_search_artists/albums/tracks`, `playback_play_media/
  pause/resume/stop`, `volume_volume_set`.
- **Zweit-Index für Player**: Tab **Index-Quellen** → zusätzlicher Index mit
  Key `ma` (die Player-Liste), damit `fn_ma_players` sie in einem Call
  liefert.

### 2.3 Websuche + URL-Lesen (MCP)

- **Wo**: Tab **Tool-Registry** → MCP-Server für einen Such-Connector (Beispiel:
  SearXNG-MCP, Beispiel: Brave-MCP) + ein URL-Lesen-Tool (`web_url_read` mit
  maxLength-Parameter). MCP-System-Prompt: die Lese-Regel (nur konkrete
  Treffer-URLs/Feeds oder auf Wunsch).
- **Bemerkung**: Kann dein Modell Websuche **nativ** über seinen
  Anbieter-Stack, entfällt der Such-Connector (siehe Einleitung).

### 2.4 HTTP- und Shell-Bausteine

- **Wo**: keine Anlage nötig — `http()` und `shell()` sind Template-Bausteine
  (Grenzen/Sicherheit: Kapitel 6 und `FUNKTIONEN.md`).

## 3. Deterministische Vorgänge

### 3.1 Sonnenstand (`sun.sun`)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, ist die Sonne schon untergegangen?"
- **Werkzeuge**: MCP Home-Assistant + Entity-Index (2.1).
- **Modus**: `deterministic` — der Zustand ist ein fester Text, kein LLM nötig.
- **Anlegen**:
  1. Index-Quelle liefert `sun.sun` (Werkzeuge 2.1 — einmalig).
  2. Tab **Funktionen** → Neue Funktion: Name `sonnenstand`, Template
     unten, Aktiv ✓, Speichern; mit **Ausführen** testen.
  3. Tab **Vorgänge** → Neuer Vorgang: Name `Sonnenstand`, Trigger
     `sonne,sonnenstand,geht die sonne unter`, Modus `deterministic`,
     Funktion `sonnenstand`, Speichern.
  4. **Monitor/Test**: „sonnenstand" → Sprechcheck.
- **Ablauf (warum)**: Der Index liest den Zustand — weil der Index der
  Lesekanal ist (gecacht, keine Einzel-Roundtrips).
- **Template**:
  ```jinja
  Die Sonne ist gerade {{ 'über' if index.state('sun.sun') == 'above_horizon' else 'unter' }} dem Horizont.
  ```
- **Hinweise**: der State ist `above_horizon`/`below_horizon`. Attribute
  (Auf-/Untergangszeiten) stehen nicht im Index-Pipe-Text — dafür den
  Template-Tool-Fall (4.1) nutzen.

### 3.2 Ist jemand zuhause? (`zone.home`)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, ist jemand zuhause?"
- **Werkzeuge**: MCP Home-Assistant + Entity-Index (2.1).
- **Modus**: `deterministic`.
- **Anlegen**: wie 3.1 (Funktion `zuhause`, Vorgang Trigger
  `zuhause,ist jemand zuhause`).
- **Ablauf (warum)**: `zone.home` liefert die Personenzahl im State — weil
  jede Basisinstallation eine Person- und Zonen-Verwaltung hat, ist das
  ohne Zusatz-Integration lauffähig.
- **Template**:
  ```jinja
  {%- set n = index.state('zone.home') | int -%}
  {{ 'Niemand ist zuhause.' if n == 0 else ('Eine Person ist zuhause.' if n == 1 else n ~ ' Personen sind zuhause.') }}
  ```
- **Hinweise**: `person.<name>`-Entities stehen ebenfalls im Index, wenn die
  Index-Quelle sie einschließt.

### 3.3 Wetter-Übersicht (HTTP-Direkt)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, wie wird das Wetter?"
- **Werkzeuge**: HTTP-Baustein (`http()`) — keine Anlage nötig (2.4).
- **Modus**: `deterministic` — die API liefert fertig strukturierte Daten,
  das Template formatiert.
- **Anlegen**:
  1. Tab **Funktionen** → Neue Funktion: Name `wetter`, Template unten
     (Platzhalter-Koordinaten anpassen!), Speichern, **Ausführen**-Test.
  2. Tab **Vorgänge** → Neuer Vorgang: Trigger `wetter,wetterbericht`,
     Modus `deterministic`, Funktion `wetter`.
- **Ablauf (warum)**: 1. `http()` holt JSON — weil `http()` JSON automatisch
  parst, greift das Template direkt auf Felder zu. 2. Ein Jinja-Macro
  übersetzt den numerischen Wettercode (`weather_code`) in sprechbare
  Begriffe — weil die API-Codes nicht sprechbar sind. 3. Tägliche Extremwerte
  aus dem `daily`-Block — weil ein Bericht Extremwerte, nicht Stundendaten
  sprechen soll.
- **Template**:
  ```jinja
  {%- set d = http('https://api.example-weather.org/v1/forecast?latitude=50.00&longitude=10.00&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Europe%2FBerlin&forecast_days=3') -%}
  {%- macro wt(c) -%}{%- if c == 0 %}klar{%- elif c <= 3 %}wolkig{%- elif c <= 65 %}Regen{%- else %}Schnee{%- endif -%}{%- endmacro -%}
  {%- for i in range(d.daily.time | length) -%}
  {{ d.daily.time[i] }}: {{ wt(d.daily.weather_code[i]) }}, bis {{ d.daily.temperature_2m_max[i] | round(0) }} Grad.
  {% endfor -%}
  ```
- **Hinweise**: TTL-Cache (`http('url', 600000)`) spart Rate-Limits; Antworten
  über 100 KB werden nicht geparst (Rohtext-String — APIs schlank wählen).

### 3.4 Systemdaten über Shell

- **Alexa-Frage**: „Alexa, frag MeinHelfer, wie lange läuft der Server schon?"
- **Werkzeuge**: Shell-Baustein (`shell()`) — keine Anlage nötig (2.4).
- **Modus**: `deterministic`.
- **Anlegen**: Funktion `gateway_uptime` (Template unten), Vorgang Trigger
  `uptime,laeuft der server`.
- **Ablauf (warum)**: eine Zeile Template — weil `/proc/uptime` Sekunden
  liefert und das Template rechnet:
  ```jinja
  Das Gateway läuft seit {{ (shell('cat /proc/uptime | cut -d . -f1') | int / 86400) | round(1) }} Tagen.
  ```
- **Hinweise**: Shell-Befehle sind Admin-only editierbar und haben Timeout +
  Output-Cap — nur kurze Befehle, keine Langläufer oder Eingabeketten.

### 3.5 Tageszeit-Begrüßung (`now`)

- **Alexa-Frage**: — (Baustein für Berichte; ausgespielt z. B. im
  Hausstatus-Bericht).
- **Werkzeuge**: Gateway-Zeit (`now`) — keine Anlage nötig.
- **Modus**: `deterministic` (Baustein).
- **Anlegen**: in eine bestehende Funktion einbauen (z. B. `hausstatus`).
- **Ablauf (warum)**: ein `set` vor dem Speak-Block — weil die Begrüßung an
  den Stundenwert gebunden ist:
  ```jinja
  {%- set gr = 'Guten Morgen' if (now.hour >= 5 and now.hour < 11) else ('Guten Abend' if (now.hour >= 17 and now.hour < 22) else 'Hallo') -%}
  ```

### 3.6 Komplexfall: Hausstatus-Bericht (Makros + Fallbacks)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, wie ist der Hausstatus?"
- **Werkzeuge**: MCP Home-Assistant + Entity-Index (2.1) mit PV-/Verbrauchs-
  Sensoren.
- **Modus**: `deterministic` — die Struktur ist fest, nur Zahlen variieren.
- **Anlegen**:
  1. Die Sensoren in die Index-Quelle aufnehmen (Index-Config-Template um die
     gewünschten entity_ids erweitern).
  2. Funktion `hausstatus` (Template unten, IDs auf die eigenen Index-Einträge
     anpassen), Vorgang Trigger `hausstatus,wie ist der hausstatus`.
- **Ablauf (warum)**: 1. Ein Makro `gfmt` normalisiert Zahlen und ersetzt
  `unknown`/`unavailable` durch „unbekannt" — weil Sensoren bei Basis-Setup
  (oder Stromausfall) unbelegt sein können. 2. `set`-Variablen holen alle
  Werte über `index.state(...)` — weil der Index bereits die aktuellen
  Zustände gecacht hat (keine Einzel-Roundtrips). 3. Ein
  `<speak>`-Block mit `<break time="..."/>` baut die Sprechpausen — weil
  Stichpunkte im Sprachdialog sonst weggespielt werden.
- **Template** (Kurzfassung — dieselbe Technik wie im echten Bericht):
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
- **Hinweise**: SSML gilt nur, wenn der Sprachpfad es unterstützt — für den
  Echo-Display-Pfad (APL) ist reiner Text die Basis.

## 4. Hybrid-Vorgänge

### 4.1 Einzelwert mit Attribut (Template-Tool des HA-Connectors)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, wie warm ist es draußen?"
- **Werkzeuge**: MCP Home-Assistant — das Template-Tool (`ha_eval_template`),
  nicht der Index (2.1).
- **Modus**: `hybrid` — die Zahl kommt aus einer Funktion, das LLM formuliert
  die Einordnung („Es sind X Grad, eher frisch…").
- **Anlegen**:
  1. Funktion `aussen_temperatur`, Template unten; **kein** Parameter-Schema
     nötig (Vorgang ohne Argumente).
  2. Vorgang Trigger `wie warm draussen,aussentemperatur`, Modus `hybrid`,
     Funktion `aussen_temperatur`; System-Prompt leer lassen (die
     Standard-Formulierung genügt).
- **Ablauf (warum)**: 1. Die Funktion ruft das Template-Tool — weil das
  Index-Pipe-Format nur den State zeigt, nicht beliebige Attribute
  (`temperature` ist ein Attribut von `weather.home`). 2. Der Hybrid-Anteil
  formuliert — weil die natürliche Einordnung (kalt/mild/warm) das LLM
  besser spricht als eine if-Kaskade im Template.
- **Template**:
  ```jinja
  Aussentemperatur: {{ mcp.call('ha_eval_template', {'template': "states.weather.home.attributes.temperature"}) }} Grad.
  ```
- **Hinweise**: Im Template-Tool-Call nur **wörtliche** Templates
  verwenden; mit `args` dynamisch gebaute Ausdrücke brauchen die
  Preheat-Regeln aus `FUNKTIONEN.md` (set-Variablen sind im
  Auswertungskontext nicht sichtbar).

### 4.2 Verkehrsmeldungen (Liste variabler Länge)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, wie ist der Stau?"
- **Werkzeuge**: HTTP-Baustein.
- **Modus**: `hybrid` — die API liefert eine variable Liste, das LLM wählt
  und formuliert.
- **Anlegen**:
  1. Funktion `verkehr`: Template holt je Autobahn-Streifen eine
     Bauarbeiten-Liste (`http()` je URL — die öffentliche Autobahn-App-API
     eignet sich für den Nachbau) und komprimiert zu Stichpunkten — weil der
     LLM-Kontext schlank bleiben soll.
  2. Vorgang Trigger `stau,verkehr`, Modus `hybrid`, Funktion `verkehr`;
     System-Prompt kann „Formuliere 2-3 konkrete Meldungen" enthalten.
- **Ablauf (warum)**: 1. Funktions-Daten (Stichpunkte). 2. Der Hybrid-Anteil
  formuliert 2–3 Meldungen mit Ort und Grund — weil Sprachdialog keine
  Tabellen will.
- **Hinweise**: öffentliche APIs mit großem Feed brauchen einen schlanken
  Endpunkt (Body-Cap) — siehe Grenzen in `FUNKTIONEN.md`.

## 5. LLM-Vorgänge / Agent-Kaskaden

### 5.1 Licht schalten (HA-Kaskade)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, schalte das Küchenlicht ein."
- **Werkzeuge**: MCP Home-Assistant (`fn_find_entities` + Service-Call).
- **Modus**: `llm` — der Agent ermittelt entity_id und Service-Call.
- **Anlegen**:
  1. Funktionen `find_entities`/`get_entity` existieren nach Grundinstallation
     (Schema-Basis); bei Bedarf eigene Lesefunktionen mit `parameters`-Schema
     (`query`) anlegen — das Schema macht sie zu Agent-Tools mit Argumenten.
  2. Die Schalten-Kaskade in der **MCP-System-Prompt** des HA-MCP-Servers (Tab
     Systeme) pflegen — Beispieltext: „Schalten: zuerst fn_find_entities mit
     dem Namen (liefert entity_id), dann ha_call_service mit passendem
     domain/service. Mehrdeutigkeit: NIEMALS raten — im Echo nachfragen."
  3. Allowlist: Grundeinstellungen → Agent-Tool-Allowlist (anhaken, was der
     Agent nutzen darf); leer in der DB = alle.
- **Ablauf (warum)**: 1. `fn_find_entities("küche licht")` — weil die Treffer
  bereits die `entity_id` **und** den aktuellen Zustand enthalten; ein
  zweiter Lesecall wäre Rundenverschwendung. 2. Service-Call
  (`light/turn_on`) mit der exakten entity_id — weil der Agent **niemals
  ratet** und eine Erfolgsbestätigung nur für Aufrufe gibt, die in dieser
  Antwort auch gelaufen sind. 3. Bei Mehrdeutigkeit (zwei Lichter im Raum):
  Rückfrage im Echo — weil eine falsche entity_id unbeobachtbar falsch
  schaltet.
- **Hinweise**: die Kaskade steht in der MCP-System-Prompt des HA-Connectors —
  nicht im Agent-Prompt (dort nur generisches Verhalten).

### 5.2 Musik abspielen (Music-Assistant-Kaskade)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, spiele Musik von <Künstler>."
- **Werkzeuge**: MCP Music Assistant + Zweit-Index `ma` (2.2).
- **Modus**: `llm`.
- **Anlegen**:
  1. Funktion `ma_players` mit Parameter-Schema (Player-Query) und Template
     `{{ index.find(args.query, 'ma') }}` — die Player-Liste kommt aus dem
     Zweit-Index.
  2. Die Wiedergabe-Kaskade (+ Falscherkennungs-Regel) in der **MCP-System-Prompt**
     des MA-MCP-Servers.
  3. Allowlist: MA-Tools anhaken (Grundeinstellungen → Agent-Tool-Allowlist).
- **Ablauf (warum)**: 1. `fn_ma_players` — weil `playback_play_media` eine
  `player_id` braucht und der Player-State (Lautstärke, gerade laufend) aus
  einem Call kommt. 2. `library_search_artists` — weil der Name-URI für den
  Play-Call her muss; ASR-Falscherkennungen zuerst gegen bekannte
  Verwechslungen prüfen, dann plausible Schreibweisen (2–3 Varianten) —
  **bevor** „nicht gefunden" antwortet. 3. `playback_play_media` mit URI +
  player_id; Playlist/Album bevorzugen — weil sie vollständig gespielt
  werden; nach dem letzten Titel endet die Queue (Hinweis nur auf Nachfrage).
- **Hinweise**: die Falscherkennung ist ein **BEVOR**-Regel-Fall — sie steht
  deshalb am System, nicht als nachladbarer Hinweis.

### 5.3 Nachrichten zu einer Quelle (Such-Kaskade)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, Neuigkeiten bei <Quelle>."
- **Werkzeuge**: Websuche-MCP (2.3) + `web_url_read`.
- **Modus**: `llm`.
- **Anlegen**:
  1. Funktion `recherche` mit Parameter-Schema (`query`, optional `url`),
     Budget 2, `inventory_prompt` mit der Kaskaden-Regel (Beispiel unten).
  2. Allowlist: Such-Tools + `web_url_read` + `fn_recherche` anhaken.
- **Ablauf (warum)**: 1. Die Funktion ruft den Such-Call mit `count 5` —
  weil Treffer die Quellen liefern. 2. Liefert die Quelle einen verlinkten
  Treffer, liest dieselbe Funktion den `/rss`-Feed der Seite
  (`web_url_read`, maxLength 6000) — weil Portale ihre Meldungen als
  Feed-Titel tragen und die Feed-Prüfe deutlich konkreter ist als
  Portal-Übersichten. 3. Der Agent formuliert eine **Aufzählung** von 4–5
  EINZELNEN Meldungen („Erstens… Außerdem… Schließlich…") — weil die
  Quellenregel verlangt: nur Inhalte aus den Tool-Ergebnissen dieser
  Antwort, niemals Vorwissen oder Gesprächsverlauf. Nach der Lese-Runde
  SOFORT antworten — keine zweite URL.
- **Template**:
  ```jinja
  {%- set s = mcp.call('<such-tool>', {'query': args.query, 'count': 5}) -%}{{ s }}
  {%- if args.url -%}
  --- FEED-PROBE ---
  {{ mcp.call('web_url_read', {'url': 'https://' ~ args.url ~ '/rss', 'maxLength': 6000}) }}
  {%- endif %}
  ```
- **Hinweise**: Budget für Such-/Read-Calls setzt die `budget`-Spalte der
  Funktion (Such-Shopping verhindern).

### 5.4 Kaskadierte Suche mit URL-Lesen (Brave-Muster)

- **Alexa-Frage**: „Alexa, frag MeinHelfer, was gibt es Neues zu <Thema>?"
- **Werkzeuge**: Websuche-MCP (Beispiel Brave-MCP) + `web_url_read`.
- **Modus**: `llm`.
- **Anlegen**: wie 5.3 — der Unterschied ist der Fallback-Weg (Treffer-URL
  statt Feed), beide Muster sind in einer Funktion kombinierbar.
- **Ablauf (warum)**: 1. Erste Such-Runde — weil die Suche die
  Kandidaten-URLs liefert. 2. Sind die Treffer nur Portal-Übersichten
  (Meta-Beschreibungen statt Meldungen): GENAU EINMAL die passende
  Treffer-URL mit `web_url_read` lesen (mit maxLength) — weil
  Portal-Übersichten keine Meldungstexte enthalten. 3. SOFORT danach
  antworten — weil jede weitere Runde Such-/Read-Budget verbraucht und die
  Antwortfrist sprengen kann.
- **Hinweise**: `web_url_read` ausschließlich für konkrete Treffer-URLs oder
  auf ausdrücklichen Wunsch — niemals Portale wahllos lesen.

### 5.5 Messwerte fragen („wie hell ist es im Wohnzimmer")

- **Alexa-Frage**: „Alexa, frag MeinHelfer, wie hell ist es im Wohnzimmer?"
- **Werkzeuge**: MCP Home-Assistant + Entity-Index via `fn_find_entities`.
- **Modus**: `llm` — kein Trigger deckt die Phrasenvielfalt ab.
- **Anlegen**: nur Werkzeuge (2.1) + Allowlist; die Lesefunktionen existieren
  nach Grundinstallation; Regeln in der `find_entities`-Note (Tab Funktionen
  → Feld Agent-Inventory-Prompt).
- **Ablauf (warum)**: 1. `fn_find_entities` mit Stichworten — weil die
  Treffer den aktuellen Zustand enthalten und die Suche Fuzzy/Aliase/Räume
  bereits behandelt. 2. SOFORT aus dem Treffer antworten (max. 1 Aufruf) —
  weil Variationen desselben Begriffs die Suche schon aufklärt und jede
  weitere Runde nur Latenz ist. 3. Kein passender Treffer: ehrlich sagen,
  nichts erfinden.
- **Hinweise**: Kombinierte Anfragen („Nachrichten und dann der Hausstatus")
  laufen der Reihenfolge nach — jede Teilfrage nutzt ihr zuständiges Tool,
  kein Abbruch nach dem ersten Teil.

## 6. Anhang

### Anonymisierung

- Keine echten Entity-IDs, Hostnamen, URLs, Koordinaten oder Namen. Muster:
  `sensor.beispiel_*`, `50.00/10.00` als Platzhalterkoordinaten,
  „Küchenlicht" statt konkreter Gerätenamen, `ha.example.org` als
  Beispiel-Endpunkt.
- Persönliche Ansage-Stile (Identität, Witz-Ebene) sind Betreiber-Sache und
  bewusst **nicht** Bestandteil dieser Beispiele.

### Sicherheitshinweise (Baustein-Niveau)

- `shell()`: Admin-only editierbar, Timeout 5 s, Output-Cap 4000 — im
  Gateway-Container laufend.
- `http()`: dynamische URLs (mit `args`-Anteil) dürfen niemals ins private
  Netz; literale URLs im Admin-Template sind vertrauenswürdig.
- Budgets: Call-Limits pro Tool über die `budget`-Spalte der Funktionen.

### Fehlermuster (Wiederholungswert)

- **Niemals raten**: entity_id/URI nur aus Tool-Ergebnissen; Mehrdeutigkeit
  → Rückfrage mit genau einem Antwortbeispiel.
- **Sofort antworten**: Treffer enthalten den Zustand — keine Prüf-Runden.
- **BEVOR-Regeln** (Falscherkennungen, Schalt-Kaskaden) stehen an ihrer
  Quelle, damit sie vor dem ersten Tool-Call wirken.
- **Zahlformate**: `| round(n) | replace('.', ',')` für gesprochene Zahlen.
- **Unbelegte Sensoren**: `unknown`/`unavailable` in Makros abfangen,
  „unbekannt" sprechen.
