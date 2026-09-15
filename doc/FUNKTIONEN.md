# Funktionen & Templates (Gateway)

Dokumentiert das Funktionen-/Template-System des Gateways: die Bausteine, die
Funktionen-Registry, parameterisierte LLM-Tools und die Vorgänge. Beispiele
sind anonymisiert (`sensor.wohnzimmer_temperatur`, `sensor.tankstelle_e10`, …).

## Die drei Ebenen (Mentalmodell)

```text
Ebene 1 – Daten-Bausteine (Code im Gateway, generisch)
   ha.state · ha.find · ha.get · ha.call · ha.entities · shell · http · fn · now · args
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

| Baustein | Wirkung | Hinweise |
|----------|---------|----------|
| `ha.state('entity_id')` | Zustand einer Entity als String | HA-REST-Snapshot, 60 s Cache |
| `ha.find('stichworte')` | Fuzzy-Suche über alle Entities (Aliase, Räume, Scoring), max. 8 Treffer | liefert sprechbare Textzeilen |
| `ha.get('entity_id')` | Zustand + Attribute einer konkreten Entity | aus dem selben Snapshot |
| `ha.entities('domain')` | Entities einer Domain | benötigt ein MCP-Tool, dessen Name auf `search/lookup/entit` passt |
| `ha.call('toolname')` | MCP-Tool **ohne Argumente** aufrufen | Ergebnis als Text |
| `shell('befehl')` | Shell im Gateway-Container | Timeout 5 s, Output auf 4000 Zeichen begrenzt |
| `http('url')` | GET-Request auf eine REST-URL | Timeout 5 s, 100 KB; JSON wird geparst → direkter Feldzugriff |
| `fn('name')` | Andere Funktion einbetten | Verschachtelung bis Tiefe 3, Zyklus-Schutz |
| `args` | Argumente eines LLM-Tool-Aufrufs | nur bei parameterisierten Funktionen (siehe unten) |
| `now` | `now.hour`, `now.weekday`, `now.date`, `now.time` | Gateway-Zeit |

Alle Bausteine werden **vor** dem Rendern parallel aufgelöst („preheat") und
dedupliziert — zwei gleiche Aufrufe = ein Request. Helfer geben **Text**
zurück, keine Objekte (verhindert `[object Object]` in Antworten).

### Beispiele (anonymisiert)

```jinja
{{ ha.state('sensor.wohnzimmer_temperatur') }}
   → 23.4

{{ ha.find('garage temperatur') }}
   → sensor.garage_temperatur | Garage Temperatur: 17.8 °C [Garage]

{{ shell('cat /proc/uptime | cut -d . -f1') }}
   → 1451146

{{ http('https://api.example.com/v1/status').version }}
   → 2.1   (JSON-Feldzugriff; Text-Endpunkte liefern den Rohtext)
```

Nunjucks-Logik ist voll verfügbar (Filter, `if`, `for`, `macro`, `set`):

```jinja
{{ ha.state('sensor.tankstelle_e10') | replace('.', ',') }} Euro
{{ (shell('cat /proc/uptime | cut -d . -f1') | int / 86400) | round(1) }} Tagen
```

## Parameterisierte Funktionen (LLM-Tools mit Argumenten)

Hat eine Funktion ein **Parameter-Schema**, erscheint sie dem Agenten als
Tool `fn_<name>` mit genau diesem Schema. Die Argumente des Aufrufs stehen
im Template als `args` bereit.

Beispiel „ha_find" (ersetzt den früheren statischen Such-Helper):

- Parameter: `{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}`
- Template: `{{ ha.find(args.query) }}`
- Agent ruft: `fn_ha_find {"query": "garage temperatur"}`

Damit lassen sich beliebige eigene Tools bauen — z. B. eine Datei- oder
Mediensuche über einen eigenen HTTP-Endpunkt (URL wörtlich im Template,
Filterung per Jinja; dynamische URLs stattdessen über `shell('curl …')`).

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

## Werkzeuge des Agenten

Das LLM sieht pro Frage:

1. **Alle rohen MCP-Tools** der aktivierten Server (Junk-Einträge sind über
   eine Blockliste gefiltert; Namenskollisionen erhalten das Präfix des
   Servers, z. B. `SearXNG__web_url_read`).
2. **Alle aktiven Funktionen** als `fn_<name>` — parameterisierte mit ihrem
   Schema, parameterlose ohne Argumente.

Budgets pro Frage verhindern Schleifen: z. B. Websuche 1×, `fn_ha_find` 2×,
`fn_ha_get` 3×, Hausstatus-Bericht 1×.

Die beiden Prompts (`agent_system`, `agent_inventory`, im Admin-UI
editierbar) lehren das Modell die Nutzung; `{assistant_name}` wird ersetzt.

## Praxis-Rezepte

**Bericht mit Zahlenformatierung (Funktion „benzinpreis"):**

```jinja
Super E10 an der Tankstelle kostet {{ ha.state('sensor.tankstelle_e10') | replace('.', ',') }} Euro.
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
Der Akkustand beträgt {{ gfmt(ha.state('sensor.batterie_soc'),0) }} Prozent.
{%- if (ha.state('group.fenster_tueren') | lower) != 'off' %}
<break time="200ms"/> Es sind Fenster oder Türen geöffnet.
{%- endif %}
</speak>
```

Beginnt das Ergebnis mit `<speak>`, wird es als SSML gesprochen. Die
Gateway-Variante rendert in ~10 ms (kalter Snapshot einmal pro Minute
eingerechnet) — ein vergleichbares HA-Script brauchte ~180 ms Rundreise.

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

Dynamische Ticker-Abfragen („wie steht eigentlich Apple?") gehen noch nicht —
`http()`-URLs sind wörtlich; Ad-hoc-Abfragen wären eine Erweiterung
(URL-Template mit `args`).

## Grenzen & Fallstricke

- `http()`-URLs müssen **wörtlich** im Template stehen (Vorladen);
  dynamische URLs über `shell('curl …')`.
- Helfer liefern Text — für Rohdaten in Variablen den Snapshot über
  `ha.find`/`ha.get`-Ergebnisse parsen oder `| dump` nutzen.
- `shell` und `http` sind Admin-only editierbar und laufen im Gateway-Container;
  Timeouts und Caps verhindern hängende Antworten.
- Hauswerte-Scoring (Aliase wie „warm" → Temperatur, Raum-Matching) lebt in
  `ha.find` — für gesprochene Fragen deutlich treffsicherer als reines
  Substring-Matching.
