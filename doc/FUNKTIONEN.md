# Funktionen & Templates (Gateway)

Dokumentiert das Funktionen-/Template-System des Gateways: die Bausteine, die
Funktionen-Registry, parameterisierte LLM-Tools und die Vorgänge. Beispiele
sind anonymisiert (`sensor.wohnzimmer_temperatur`, `sensor.tankstelle_e10`, …).

## Die drei Ebenen (Mentalmodell)

```text
Ebene 1 – Daten-Bausteine (Code im Gateway, generisch)
   index.state · index.find · index.get · mcp.call · shell · http · fn · now · args
        │
Ebene 2 – Funktionen (Datenbank, im Admin-UI pflegbar und testbar)
   benannte Pipelines aus den Bausteinen, z. B. „hausstatus_gw"
        │
Ebene 3 – Verbraucher
   a) Vorgänge: rendern eine Funktion als Antwort (deterministic/hybrid)
   b) Agent (LLM): bekommt Funktionen als Tools (fn_*) plus alle rohen MCP-Tools
```

Gelöschte Altlasten: Die frühere „Facade" (fest einkodierte LLM-Tools wie
`control_device`, `search_web`, `get_house_status`) und Inline-Templates in
Vorgängen sind entfernt. Vorgänge beziehen ihre Daten ausschließlich über
Funktionen (`function_ref`); beim Gateway-Start migriert das Gateway
bestehende Einträge automatisch.

## Funktionen-Registry (Admin-Tab „Funktionen")

| Feld | Bedeutung |
|------|-----------|
| Name | Aufrufname, `a-z 0-9 _`; als `{{ fn('name') }}` in Templates bzw. als LLM-Tool `fn_name` |
| Beschreibung | Für die Übersicht; bei LLM-Tools zusätzlich die Tool-Beschreibung für das Modell |
| Template | Jinja/Nunjucks-Vorlage mit den Bausteinen unten |
| Parameter | Optionales JSON-Schema; macht die Funktion zu einem LLM-Tool **mit Argumenten** |
| Aktiv | Inaktive Funktionen werden nicht gerendert und nicht als Tool angeboten |

Der **Ausführen**-Button rendert das Template live (echter HA-/MCP-Kontext)
und zeigt Ergebnis + Trace-Schritte — ohne zu speichern.

## Template-Bausteine (Referenz)

### Originäre Bausteine (generisch, kein Systembezug im Code)

| Baustein | Wirkung | Hinweise |
|----------|---------|----------|
| `index.find('stichworte')` | Fuzzy-Suche über den Entity-Index (Aliase, Räume, Scoring), max. 8 Treffer | Scoring lokal im RAM; Aliase/Domain-Hints/Stopwords sind Parameter (Settings) |
| `index.state('id')` | Zustand eines Eintrags als String | aus dem gecachten Index |
| `index.get('id')` | Zustand + Attribute eines konkreten Eintrags | aus dem selben Index |
| `shell('befehl')` | Shell im Gateway-Container | Timeout 5 s, Output auf 4000 Zeichen begrenzt |
| `http('url')` / `http('url', ttlMs)` | GET-Request auf eine URL; zweites Argument = TTL-Cache in ms | Timeout 5 s (Setting `http_timeout_ms`), 100 KB (`http_body_cap`); JSON wird geparst → direkter Feldzugriff |
| `fn('name')` | Andere Funktion einbetten | Verschachtelung bis Tiefe 3, Zyklus-Schutz |
| `args` | Argumente eines LLM-Tool-Aufrufs | nur bei parameterisierten Funktionen (siehe unten) |
| `now` | `now.hour`, `now.weekday`, `now.date`, `now.time` | Gateway-Zeit |

### Der Entity-Index ist parametriert, nicht verdrahtet

Woher der Index kommt, steht ausschließlich in den Settings (Admin-UI,
Schlüssel `entity_index`, JSON — `args` ist das freie Argument-Objekt des
Index-Tools, das Extraktions-Template steckt im arg, das der Server erwartet):

```json
{
  "tool": "ha_eval_template",
  "args": {
    "template": "{% for e in states %}{{ e.entity_id }}|{{ area_name(e.entity_id) }}|{{ e.state }}|...{% endfor %}",
    "timeout": 15
  },
  "ttlMs": 60000,
  "aliases": { "draußen": "aussen", "temperatur": "temperature" },
  "domainHints": [{ "re": "temperatur|warm", "domains": ["sensor", "climate"] }],
  "stopwords": ["wie", "ist"]
}
```

- **Datenvertrag** (vom Tool geliefert): eine Zeile je Eintrag im
  Format `id|area|state|unit|name|key=value;...`
- **1 MCP-Call pro TTL-Fenster**, Lookups/Scoring danach lokal (< 1 ms)
- **Kein Systembezug im Code**: Der Default bindet Home Assistant
  (ha-mcp `ha_eval_template`); Music Assistant o. Ä. = anderes Setting,
  kein Code. Die generischen Lesetools heißen entsprechend neutral
  `fn_find_entities` / `fn_get_entity`.

### Index-Quellen (Multi-Index, universal)

Der Entity-Index ist eine Instanz eines universalen Konzepts: **benannte
Snapshot-Indexe**. Beliebig viele Quellen — jede beschreibt Tool + Argumente +
TTL + Aliase/Stopwords/Domain-Hints in einer Setting-Zeile:

- `entity_index` = Standard-Key `''` (Haus); `entity_index_<key>` = benannte
  Quelle (z. B. `entity_index_ma` für Music-Assistant-Player)
- Templates greifen per 2. Argument zu: `index.find('lautsprecher küche', 'ma')`,
  ohne Key gilt der Standard-Index
- `fn_find_entities` / `fn_get_entity` akzeptieren optional `args.index`
  (z. B. `{"query": "lautsprecher", "index": "ma"}`) — der Agent kann damit
  jede benannte Quelle durchsuchen
- **Verwaltung**: Tab „Index-Quellen" in der Admin-UI (links neben Vorgänge/
  Funktionen): Liste (Key, Tool, TTL, Beschreibung), Editor mit JSON-Config,
  Beschreibung und Probe-Abfrage mit Live-„Ausführen"; `desc` liegt als Feld
  im Config-JSON (vom Loader ignoriert). Nur benannte Indexe löschbar.
- Fällt der Index-Key erst zur Renderzeit aus `args` (z. B.
  `index.find(args.query, args.index | default(''))`), werden **alle
  konfigurierten Keys** vorgewärmt (Preheat-Erweiterung)

### Index-Assistent (LLM-gestütztes Einbinden, Phase 2)

Neue Quelle anbinden, ohne Template selbst zu schreiben — zwei
Admin-Endpoints:

1. `POST /admin/api/index/assist` `{ "goal": "…" }` — das LLM liest den
   Tool-Katalog der MCP-Registry und entwirft ein Draft (Tool, Argumente,
   Aliase, Probefragen). Der **deterministische Validator** führt das Draft
   probehalber aus (nur erkennbar lesende Tools, nur Toolnamen-Klassifikation,
   da Beschreibungen Beispiel-Code enthalten), prüft den Datenvertrag
   (≥ 5 Einträge) und lässt das LLM bei Fehlern nachbessern (max. 3 Iterationen).
   Antwort: `{ draft, validation, iterations }`.
2. `POST /admin/api/index/apply` `{ "draft": … }` — validiert erneut und
   speichert nach Admin-Prüfung das Draft als `entity_index`-Setting
   (Human-in-the-Loop; Cache wird invalidiert).

### MCP-Bindung: `mcp.call('tool', {args})`

Weiterleitung an ein beliebiges MCP-Tool (exakter Name) aus den Templates —
für deterministische Vorgänge ohne LLM. Der Agent ruft MCP-Tools dagegen
direkt im Toolloop.

```jinja
{{ mcp.call('ha_get_state', {'entity_id': 'sun.sun'}) }}
```

- Args als **flaches JSON-Literal in einer Zeile**; identische Aufrufe
  (Tool + Args) werden dedupliziert; Ergebnis als Text
- **Dynamische Argumente**: Objekt-Argumente dürfen `args.`/`now.` enthalten
  — der Ausdruck wird zu einem JSON-Objekt ausgewertet und live gecallt
  (Trace `template.mcp.dyn`):

```jinja
{{ mcp.call('searxng_web_search', {'query': args.query, 'num_results': 5}) }}
{{ mcp.call('web_url_read', {'url': 'https://' ~ args.url ~ '/rss', 'maxLength': 6000}) }}
```

  Filter direkt im Objekt-Literal funktionieren (`args.lang | default('de')`);
  Template-lokale `set`-Variablen sind im Auswertungskontext **nicht**
  sichtbar (der Eval-Kontext enthält nur `args`/`now`) — Defaults also
  direkt im Literal selbst auswerten.

Alle Bausteine werden **vor** dem Rendern parallel aufgelöst („preheat") und
dedupliziert — zwei gleiche Aufrufe = ein Request. Helfer geben **Text**
zurück, keine Objekte (verhindert `[object Object]` in Antworten).

### HTTP: TTL-Cache und dynamische URLs

- **TTL-Cache** (zweites Argument in ms): `http('https://www.tagesschau.de/rss', 60000)`
  hält das Ergebnis 60 s pro URL im Prozess (Trace `template.http.cache`).
  Ohne TTL = frischer Call pro Render; mit TTL = ein Call pro TTL-Fenster.
- **Dynamische URLs**: Der URL-Ausdruck darf `args`/`now` konkatenieren —
  er wird zuerst aufgelöst, das Ergebnis wird normal gefetcht/gecached:

```jinja
{{ http('https://query1.finance.yahoo.com/v8/finance/chart/' ~ args.ticker, 60000) }}
```

- **Grenze**: JSON über `http_body_cap` (Default 100 KB) kann nicht geparst
  werden — `http()` liefert dann den Rohtext als String (kein Feldzugriff);
  bei großen APIs lieber einen schlanken Endpunkt/Feed wählen.

### Beispiele (anonymisiert)

```jinja
{{ index.state('sensor.wohnzimmer_temperatur') }}
   → 23.4

{{ index.find('garage temperatur') }}
   → sensor.garage_temperatur | Garage Temperatur: 17.8 °C [Garage]

{{ shell('cat /proc/uptime | cut -d . -f1') }}
   → 1451146

{{ http('https://api.example.com/v1/status').version }}
   → 2.1   (JSON-Feldzugriff; Text-Endpunkte liefern den Rohtext)
```

Nunjucks-Logik ist voll verfügbar (Filter, `if`, `for`, `macro`, `set`):

```jinja
{{ index.state('sensor.tankstelle_e10') | replace('.', ',') }} Euro
{{ (shell('cat /proc/uptime | cut -d . -f1') | int / 86400) | round(1) }} Tagen
```

## Parameterisierte Funktionen (LLM-Tools mit Argumenten)

Hat eine Funktion ein **Parameter-Schema**, erscheint sie dem Agenten als
Tool `fn_<name>` mit genau diesem Schema. Die Argumente des Aufrufs stehen
im Template als `args` bereit.

Beispiel „find_entities" (ersetzt den früheren statischen Such-Helper):

- Parameter: `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`
- Template: `{{ index.find(args.query) }}`
- Agent ruft: `fn_find_entities {"query": "garage temperatur"}`

Damit lassen sich beliebige eigene Tools bauen — z. B. eine Datei- oder
Mediensuche über einen eigenen HTTP-Endpunkt (URL mit `args`-Konkatenation,
Filterung per Jinja).

**Pitfall**: Ohne Parameter-Schema ruft das Modell das Tool gern mit
**leeren Argumenten** (`{}`) — argumentierte Tools brauchen ein Schema mit
`required`-Feldern. Parameterlose Tools bekommen `{"type":"object","properties":{}}`.

## Vorgänge (Admin-Tab „Vorgänge")

- **Modus `deterministic`**: rendert die gewählte Funktion und spricht das
  Ergebnis direkt — kein LLM-Aufruf. **Pflichtfeld „Daten aus Funktion".**
- **Modus `hybrid`**: Funktion liefert die Daten, das LLM formuliert die
  sprechbare Antwort.
- **Modus `llm`**: kein Datenbezug; der Agent antwortet frei. Hier steuert
  der **Tool-Picker** („Erlaubte Tools"), welche Werkzeuge der Agent in
  diesem Vorgang sieht — leer = alle (Funktionen erscheinen als `fn_*`).
- **Trigger-Phrasen** + Fuzzy-Schwellwert bestimmen das Routing; ohne
  Treffer geht die Frage an den Agenten.
- **`function_args`** (Vorgangsfeld): feste Argumente für die zugewiesene
  Funktion (z. B. `{"road": "A24"}` beim Stau-Report) — das Template liest
  sie als `args`; ein Schema in der Funktion beschreibt, welche Argumente
  es gibt.
- **Action-PUT ist Full-Replace**: Ein PUT ohne Feld wipt dieses Feld
  (System-Prompt, Trigger, Tools) — beim Editieren immer den vollständigen
  Body mitschicken. Trigger-Phrasen werden als Array oder JSON-String
  akzeptiert; `tools: []` heißt bewusst **ohne Tools** (z. B. Hilfe-Action),
  fehlendes Feld = unverändert.

## Werkzeuge des Agenten

Das LLM sieht pro Frage:

1. **MCP-Tools laut Allowlist**: das Setting `agent_tools` (Komma-Liste)
   schränkt die Tools ein und halbiert damit Prompt-Größe und Rundenzeit
   (gemessen ~58k → ~10k Token); leer/fehlend = alle rohen MCP-Tools
   (Junk-Einträge über Blockliste gefiltert).
2. **Alle aktiven Funktionen** als `fn_<name>` — parameterisierte mit ihrem
   Schema, parameterlose ohne Argumente.

Budgets pro Frage verhindern Schleifen:

- **MCP-Tools**: Setting `tool_budgets` (JSON), z. B.
  `{"searxng_web_search":3,"brave_web_search":2,"web_url_read":3}`
- **Funktionen**: Spalte `budget` in der Funktionen-Registry
- Erschöpft = `tool.budget_hit` im Trace, das Tool liefert einen
  Budget-Fehler ans Modell statt still weiterzulaufen

Weitere Laufzeit-Schrauben (Settings, Admin-UI):

| Setting | Wirkung |
|---------|---------|
| `llm_model` | Primärmodell (Reasoner beachten: `llm_max_tokens` ≥ 800, sonst leeres `content`) |
| `tool_model` | Modell nur für Tool-Runden (leer = überall dasselbe) |
| `llm_max_tokens` | Output-Budget pro Call |
| `max_tool_iterations` | Runden gesamt; die **letzte Runde** bekommt eine „formuliere jetzt"-Anweisung (Formulierungs-Garantie) |
| `tool_deadline_ms` | Deadline für den Agent-Loop |
| `http_timeout_ms` / `http_body_cap` | Grenzen des http()-Bausteins |
| `alexa_progress_after_ms` | Warteton-Grenze beim Alexa-Einstieg |

Die Prompts (`agent_system`, `agent_inventory`) werden zu
`## Tool-Inventory` zusammengeführt und lehren das Modell die Nutzung;
`{assistant_name}` wird ersetzt. **Auch Action-Prompts (mode `llm`) können
`{agent_inventory}` enthalten** — die Engine fügt das live gepflegte
Nachschlagewerk ein (Muster der Hilfe-Action: System-Prompt als Regel +
Inventory als Datenquelle, `tools: []`, Single Source of Truth).

## Praxis-Rezepte

**Bericht mit Zahlenformatierung (Funktion „benzinpreis"):**

```jinja
Super E10 an der Tankstelle kostet {{ index.state('sensor.tankstelle_e10') | replace('.', ',') }} Euro.
```

**Lokale Systemdaten (Funktion „gateway_uptime"):**

```jinja
Das Gateway läuft seit {{ (shell('cat /proc/uptime | cut -d . -f1') | int / 86400) | round(1) }} Tagen.
```

**Sprachreport mit SSML (Ausschnitt „hausstatus_gw"):**

```jinja
{%- macro gfmt(val, dec=2) -%}
{%- if val in ['unknown','unavailable','','unbekannt'] -%}unbekannt{%- else -%}{{ val | float(0) | round(dec) | replace('.', ',') }}{%- endif -%}
{%- endmacro -%}
{%- set gr = 'Guten Morgen' if (now.hour >= 5 and now.hour < 11) else ('Guten Abend' if (now.hour >= 17 and now.hour < 22) else 'Hallo') -%}
<speak>
{{ gr }} hier ist Smart Pilot!
<break time="300ms"/>
Der Akkustand beträgt {{ gfmt(index.state('sensor.batterie_soc'),0) }} Prozent.
{%- if (index.state('group.fenster_tueren') | lower) != 'off' %}
<break time="200ms"/> Es sind Fenster oder Türen geöffnet.
{%- endif %}
</speak>
```

Beginnt das Ergebnis mit `<speak>`, wird es als SSML gesprochen. Warm rendert
die Gateway-Variante in ~10 ms; der Entity-Index kostet 1 MCP-Call pro TTL-
Fenster (gemessen ~0,6 s für ~1200 Einträge) und wird 60 s gecacht — für
deterministische Funktionen ist das billiger als einzelne MCP-Lookups.

**Kombination (Funktion „morgen_brief"):**

```jinja
Guten Morgen! {{ fn('hausstatus_gw') }}
Außerdem: {{ fn('benzinpreis') }}
```

`fn()`-Ergebnisse werden vorab gerendert und als Text eingefügt; bei Zyklen
oder Tiefe > 3 greift der Schutz (leerer Einschub + Trace-Eintrag).

**Eigene REST-API (Funktion „dienst_status"):**

```jinja
Mein Dienst läuft in Version {{ http('http://dienst-intern:8080/api/status').version }}
mit {{ http('http://dienst-intern:8080/api/status').offene_aufgaben }} offenen Aufgaben.
```

Zwei Aufrufe derselben URL = ein einziger Request (Deduplizierung).

**Ghostfolio-Depotreport (Funktionen „boerse_portfolio"/„boerse_woche", live aktiv):**
Der eigene Ghostfolio-Endpunkt liefert Top 5 / Flop 5 / Benchmarks — mit
`format=ssml` sogar als fertigen Alexa-Sprachtext. Die Funktion ist deshalb
nur ein dünner Wrapper; `_stale` wird als Hinweis angehängt. Perioden: `1d|1w|1m|1y`.

```jinja
{%- set d = http('https://<ghostfolio-host>/cgi-bin/gf_holdings.py?action=alexa_portfolio&period=1d&format=ssml') -%}
{%- if d and d.ssml -%}
{{ d.ssml }}{%- if d._stale %} Hinweis: Die Depotdaten sind nicht mehr tagesaktuell.{% endif %}
{%- else -%}
<speak>Ich konnte den Depot-Report gerade nicht abrufen.</speak>
{%- endif -%}
```

**Kurs-Report über Yahoo Finance (generisches REST-Beispiel):** Chart-API ohne
API-Key; pro Position ein wörtlicher http()-Block, Formatierung per Makro.

```jinja
{%- set d_sap = http('https://query1.finance.yahoo.com/v8/finance/chart/SAP.DE') -%}
{%- macro pos(name, d, stueck) -%}
{%- if d and d.chart -%}{%- set m = d.chart.result[0].meta -%}
{{ name }}: {{ m.regularMarketPrice | round(2) | replace('.', ',') }} Euro,
{{ 'plus' if m.regularMarketPrice >= m.chartPreviousClose else 'minus' }}
{{ (((m.regularMarketPrice - m.chartPreviousClose) / m.chartPreviousClose * 100) if m.chartPreviousClose else 0) | round(1) | replace('.', ',') }} Prozent.
{%- else -%}{{ name }}: keine Kursdaten.{%- endif -%}
{%- endmacro -%}
{{ pos('SAP', d_sap, 40) }}
```

Dynamische Ticker-Abfragen funktionieren mit `args`-Konkatenation im
`http()`-URL-Ausdruck (siehe „HTTP: TTL-Cache und dynamische URLs") —
z. B. einer Funktion mit Schema `ticker`:

```jinja
{%- set d = http('https://query1.finance.yahoo.com/v8/finance/chart/' ~ args.ticker, 60000) -%}
```

**Recherche in einem Aufruf (Funktion „recherche", live aktiv):**
Websuche (Brave) + optionaler Feed-Lese in einem Tool-Call; der Agent
formuliert daraus. Budget 2 (Feed-Discovery-Schritt inbegriffen).

```jinja
{%- set s = mcp.call('brave_web_search', {'query': args.query, 'count': 5}) -%}{{ s }}
{%- if args.url -%}
--- FEED-PROBE ---
{{ mcp.call('web_url_read', {'url': 'https://' ~ args.url ~ '/rss', 'maxLength': 6000}) }}
{%- endif %}
```

- Parameter: `query` (required, konkrete Suchphrase) und `url` (optional,
  Domain ohne https:// — löst den deterministischen `/rss`-Probe-Lese aus)
- Der an das Ergebnis angehängte Hinweis lehrt die Lese-Leiter (Treffer →
  ein `web_url_read` → Feed-Suche) und verbietet Erfindung/Rückfragen
- Für Quellen mit Bot-Schutz (z. B. CNN) oder JS-Rendering (z. B. chefkoch)
  bleibt nur, was die Suchtreffer/Snippets hergeben — dann sagt der Agent
  ehrlich „nicht lesbar" statt zu erfinden

**Music-Assistant-Player in einem Call (Funktion „ma_players", live aktiv):**
Ein `players_list_players`-Call, im Template auf
`player_id | name | state | vol=` kompakt gesplittet; der Agent steuert
danach Playback-Tools mit der richtigen `player_id`:

```jinja
{%- set raw = mcp.call('players_list_players') -%}
{%- set parts = raw.split('{"player_id":"') -%}
{%- for p in parts -%}
{%- if not loop.first and p.split('"available":')[1].split(',')[0] == 'true' -%}
{{ p.split('"')[0] }} | {{ p.split('"name":"')[1].split('"')[0] }} | {{ p.split('"state":"')[1].split('"')[0] }} | vol={{ p.split('"volume_level":')[1].split(',')[0] }}
{% endif -%}{%- endfor -%}
```

**Hilfe-Action (Hybrid-Muster, live aktiv):**
Vorgang „hilfe", mode `llm`, Trigger `hilfe`/`was kannst du`, `tools: []`
(keine Tools). Der System-Prompt enthält `{agent_inventory}` — die Engine
fügt das live gepflegte Nachschlagewerk ein. Die Hilfe ist damit immer so
aktuell wie das Inventory (Single Source of Truth), kostet ~1 s und hält
die Session offen (`keep_open`), damit Detailfragen im Folgeturn laufen.

## Konfiguration: drei Ebenen

| Ebene | Was liegt dort | Beispiele |
|-------|----------------|-----------|
| `.env` | Secrets + Start-Infra (nur was vor dem Prozessstart feststeht) | `AUTH_TOKEN`, `ALEXA_SKILL_ID`, `LLM_BASE_URL`/`LLM_API_KEY`, `LLM_MODEL` (Fallback-Default) |
| Settings (Admin-UI) | Betriebs-Tuning zur Laufzeit | `llm_model`, `llm_max_tokens`, `tool_model`, `max_tool_iterations`, `tool_deadline_ms`, `tool_budgets`, `agent_tools`, `http_timeout_ms`, `http_body_cap`, `alexa_progress_after_ms`; Index-Quellen über den eigenen Tab (nicht mehr als Settings-Felder) |
| DB-Tabellen | Inhalte | `actions` (Vorgänge), `tpl_functions` (Funktionen), `prompts` (`agent_system`, `agent_inventory`), `mcp_servers`, `logs` |

Settings mit leerem Wert fallen auf `.env`-/Code-Default zurück
(`getSettingNum`/`getSetting`-Fallback-Kette).

## Grenzen & Fallstricke

- `http()`-URLs: wörtlich **oder** `args`/`now`-Konkatenation (Preheat wertet
  den Ausdruck vorgängig aus); Template-lokale `set`-Variablen sind im
  Auswertungskontext von `http()` und `mcp.call()` **nicht sichtbar** —
  dynamische Werte immer über `args` transportieren.
- `mcp.call`/`http` mit TTL: JSON über dem Body-Cap wird nicht geparst
  (`http()` → Rohtext-String); große APIs (z. B. Tagesschau-API > 600 KB)
  brauchen einen schlanken Endpunkt oder Feed.
- Helfer liefern Text — für Rohdaten in Variablen den Snapshot über
  `index.find`/`index.get`-Ergebnisse parsen oder `| dump` nutzen.
- `shell` und `http` sind Admin-only editierbar und laufen im Gateway-Container;
  Timeouts und Caps verhindern hängende Antworten.
- Hauswerte-Scoring (Aliase wie „warm" → Temperatur, Raum-Matching) lebt in
  `index.find` — für gesprochene Fragen deutlich treffsicherer als reines
  Substring-Matching.
- **Reasoner-Modelle** (gpt-oss-*, deepseek-v4-flash): Output-Budget unter
  ~400 Token wird vom Denken aufgefressen → leeres `content`; daher
  `llm_max_tokens` ≥ 800. Ein `usage.model` weicht gern vom angefragten
  Namen ab (LiteLLM-Mapping-Artefakt) — Latenz/Verhalten sind die Wahrheit.
- **Prompt-Caching** wirkt auf identische Requests (auch Agent-Runden,
  <100 ms) — wiederholte Test-Queries mit identischem Text liefern gefälscht
  schnelle/kurze Messwerte; Sessions und Formulierungen variieren.
- **Quellen-Schutz**: Bot-Schutz (CNN: auch RSS-SSL-Kill) und
  JS-Rendering (chefkoch: Feeds 403/404) machen Quellen für
  `web_url_read` unlesbar; Feeds (`<domain>/rss`) decken den Rest. Die
  SearXNG-Instanz hat aktuell nur `google cse` als Engine — Portal-Metas
  bei generischen Queries sind die Folge (Mehrwert durch eigene
  News-Engines in der SearXNG-Config).
