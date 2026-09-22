# Referenz

Diese Seite ist zum Nachschlagen gedacht. Für den ersten Aufbau beginne mit
dem [Schnellstart](QUICKSTART.md).

## Admin-Tabs

| Tab | Aufgabe |
|---|---|
| Grundeinstellungen | Modelle, Laufzeitwerte und Agent-Prompts |
| Monitor / Test | Anfrage ohne Alexa ausführen und Trace ansehen |
| Vorgänge | Trigger und Antwortmodus konfigurieren |
| Funktionen | wiederverwendbare Templates erstellen und testen |
| Index-Quellen | gecachte Lesesichten konfigurieren |
| Tool-Registry | MCP-Server verbinden und Werkzeuge abfragen |
| Logs | Anfragen, Route, Laufzeit und Verbrauch prüfen |

## Funktionsfelder

| Feld | Bedeutung |
|---|---|
| Name | `a-z`, `0-9`, `_`; Agentenname wird `fn_<name>` |
| Beschreibung | Übersicht und Toolbeschreibung |
| Agent-Inventory-Zeile | wann und wie der Agent die Funktion nutzt |
| Template | Jinja/Nunjucks-Ausdruck, dessen Text das Ergebnis ist |
| Parameter | optionales JSON-Schema für Agentenargumente |
| Budget | maximale Aufrufe pro Anfrage |
| Aktiv | inaktive Funktionen werden nicht angeboten oder gerendert |

Parameterlose Agentenfunktionen verwenden ein leeres Objektschema.
Argumentierte Funktionen sollten erforderliche Felder in `required` nennen.

## Template-Bausteine

| Baustein | Wirkung | Grenze |
|---|---|---|
| `index.find(query, key?)` | lokale Fuzzy-Suche, maximal acht Treffer | Snapshot kann bis TTL-Ablauf älter sein |
| `index.state(id, key?)` | Zustand als Text | nur Daten des Index |
| `index.get(id, key?)` | Eintrag samt Zusatzdaten | nur Daten des Index |
| `mcp.call(tool, args)` | MCP-Werkzeug aufrufen | exakter Toolname und gültiges Schema |
| `http(url, ttlMs?)` | HTTP GET, JSON automatisch parsen | Timeout und Body-Limit |
| `shell(command)` | Befehl in Gateway-Laufzeit | 5 s, 4000 Zeichen |
| `fn(name)` | Funktion einbetten | Tiefe 3, Zyklusschutz |
| `args` | Funktionsargumente | Schema für Agentennutzung nötig |
| `now` | Stunde, Wochentag, Datum, Zeit | Gateway-Zeitzone |

Identische vorbereitete Aufrufe werden dedupliziert. Dynamische
Argumentobjekte von `mcp.call` kennen `args` und `now`, aber keine lokalen
`set`-Variablen des Templates.

## Index-Konfiguration

```json
{
  "tool": "<mcp-tool>",
  "args": {},
  "ttlMs": 60000,
  "aliases": { "gesprochen": "technisch" },
  "domainHints": [
    { "re": "temperatur|warm", "domains": ["sensor", "climate"] }
  ],
  "stopwords": ["wie", "ist"],
  "desc": "Beschreibung für die Oberfläche"
}
```

Datenformat:

```text
id|area|state|unit|name|key=value;key=value
```

Der leere Key bezeichnet den Standard-Index. Weitere Quellen verwenden einen
Namen wie `ma` und werden als zweites Argument übergeben.

## Vorgangsfelder

| Feld | Bedeutung |
|---|---|
| Name | interne Bezeichnung |
| Modus | `deterministic`, `hybrid` oder `llm` |
| Trigger-Phrasen | typische Nutzerfragen, eine pro Zeile |
| Fuzzy-Schwellwert | höhere Zahl bedeutet strengere Übereinstimmung |
| eigenes System-Prompt | ersetzt für diesen LLM-Weg das globale System-Prompt |
| Daten aus Funktion | Pflicht bei deterministisch und hybrid |
| erlaubte Tools | Tool-Schemas für LLM- und Hybrid-Weg |
| Aktiv | am Routing teilnehmen |

## Laufzeitkonfiguration

| Variable | Standard | Zweck |
|---|---:|---|
| `PORT` | `3000` | HTTP-Port |
| `DB_PATH` | `./data/meinhelfer.db` | SQLite-Datei |
| `LLM_MODEL` | `chat-fast` | Startmodell |
| `LLM_MAX_TOKENS` | `2000` | Ausgabe-Budget |
| `LLM_FALLBACK_AFTER_MS` | `7000` | Schwelle eines optionalen Fallbacks |
| `AGENT_CLARIFICATION_BUDGET` | `2` | Rückfragebudget |
| `MAX_TOOL_ITERATIONS` | `6` | maximale Tool-Runden |
| `LLM_TOOL_DEADLINE_MS` | `9000` | Deadline des Agent-Loops |
| `ALEXA_VERIFY_MODE` | `enforce` | Signaturprüfung laut aktuellem Code |

Pflichtvariablen: `AUTH_TOKEN`, `LLM_BASE_URL`, `LLM_API_KEY`.

Der aktuelle Code enthält optionale LLM-Fallback-Variablen, während die
bestehende Fachdokumentation von keiner Modell-Fallback-Kaskade spricht. Das
muss vor Übernahme in die endgültige Dokumentation geklärt werden.

## Budgets und Tool-Auswahl

MCP-Budgets werden als JSON-Einstellung gepflegt. Funktionen besitzen ein
eigenes Budget. Bei Erschöpfung erhält das Modell einen Fehler und der Trace
einen Budget-Eintrag.

Eine explizite Tool-Auswahl reduziert Promptgröße und Fehlwahl. Bei neuen
Installationen muss geprüft werden, ob eine leere Auswahl „keine Werkzeuge“
oder ein Kompatibilitäts-Fallback „alle Werkzeuge“ bedeutet; die aktuelle
Oberfläche beschreibt leer als keine Tool-Schemas.

## Antwortvertrag

Der Core liefert eine neutrale Antwort mit:

- `speech`: gesprochener Text
- `ssml`: Kennzeichen für bereits vorhandenes SSML
- `display`: optionaler Display-Inhalt
- `followUp` beziehungsweise `keepOpen`: Session für Rückfrage offen halten

Alexa-spezifisches Wrapping und APL liegen im Adapter, nicht in Funktionen.

## Sicherheitsgrenzen

- Admin-Oberfläche und `/admin/*` nur im vertrauenswürdigen Netz anbieten.
- Öffentlichen Alexa-Endpunkt mit Skill-ID und Signaturprüfung schützen.
- Secrets nur über lokale Konfiguration oder Secret Store übergeben.
- Dynamische HTTP-URLs nicht ins private Netz erlauben.
- Shell-Templates nur administrativ pflegen.
- Interne IDs nie vom Modell erfinden lassen.
- Schreibende Aktionen erst nach erfolgreichem Tool-Aufruf bestätigen.

## Weiterführende Originaldokumente

Dieser Entwurf ersetzt die Originale noch nicht. Vollständige technische
Hintergründe stehen weiterhin in:

- `../doc/ARCHITECTURE.md`
- `../doc/FUNKTIONEN.md`
- `../doc/DESIGN_SKILL_RUNTIME.md`
- `../doc/DESIGN_DISPLAY.md`
- `../doc/DESIGN_WEBUI.md`
- `../doc/EXAMPLES.md`
