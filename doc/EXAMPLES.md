# Praxisbeispiele: Vorgänge, Funktionen und Agent-Kaskaden

Sammlung realer Muster aus dem Betrieb  Alle Beispiele können nach
Grundinstallation übernommen und direkt getestet werden: Bei Home Assistant
genügen die Entities, die jede Basisinstallation mitbringt (`sun.sun`,
`weather.home`, `zone.home`, `person.*` — siehe unten).

Technische Grundlagen (Bausteine, Registry, Index-Konfiguration) stehen in
`FUNKTIONEN.md` — hier geht es um die **Praxis**: welchen Modus man wählt,
welche Quelle herhält und **warum** die Schritte in dieser Reihenfolge laufen.

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
stehen an ihrem System (MCP-Server-Prompt), Werkzeug-Eigenheiten an der
Funktion (`inventory_prompt`). Dritte können mit eigenem System + eigenen Promps
arbeiten, ohne den Agent-Prompt anzufassen.

## 2. Quellen (Connectoren)

Jede Quelle braucht hier mindestens einen Fall — die Kapitel 3–5 zeigen sie
in Aktion.

| Quelle | Anbindung | Kernregeln (in der Systemnotiz pflegbar) |
|--------|-----------|------------------------------------------|
| **Home Assistant** | MCP-Server (URL + Token), Tools: Service-Calls + ein Template-Tool für Attribute/Index-Extraktion; Lesekanal ist der **Entity-Index** (Kanal-Config im Admin-UI) | Lesen: `fn_find_entities` (Treffer enthalten den Zustand, sofort antworten, max. 1 Aufruf). Schalten: erst entity_id ermitteln, dann Service-Call — **niemals raten**, bei Mehrdeutigkeit im Echo nachfragen |
| **Music Assistant** | MCP-Server; Tools: `library_search_*`, `playback_*`, `volume_*` | Wiedergabe-Kaskade: Player ermitteln → Suchen → Abspielen (Playlist/Album bevorzugen); ASR-Falscherkennungen mit Schreibweisen-Varianten behandeln |
| **Websuche** | MCP-Connector (z. B. ein SearXNG- oder Brave-Server) | Kaskade: Suchen → Treffer nennen; Portal-Übersichten nicht als Meldungen verkaufen |
| **Kaskadierte Suche** | derselbe Connector + `web_url_read` (URL-Lesen mit Längen-Cap) | Wenn Treffer nur Portal-Übersichten liefern: GENAU EINMAL die passende Treffer-URL (oder den `/rss`-Feed) lesen, dann sofort antworten |
| **HTTP-Direkt** | `http()`-Baustein in Funktions-Templates (JSON wird geparst) | SSRF: dynamische URLs (mit `args`) nie ins private Netz; literale URLs im Admin-Template sind vertrauenswürdig |
| **Shell-Direkt** | `shell()`-Baustein | Admin-only editierbar, Timeout 5 s, Output-Cap 4000 — kleine Systemabfragen, keine Langläufer |
| **Entity-Index (Zweit-Index)** | eigene Index-Quelle pro System (z. B. Musik-Player) | gleiche Bausteine, zweites Argument `index.find(q, 'key')` |
| **Zeit** | `now` (`now.hour`, `now.weekday`) | für Begrüßungen und Tageszeit-Verzweigungen |

## 3. Deterministische Vorgänge

### 3.1 Sonnenstand (`sun.sun`)

- **Ziel**: „Ist die Sonne schon unter?" → sprechbare Aussage.
- **Modus**: `deterministic` — der Zustand ist ein fester Text, kein LLM nötig.
- **Quelle**: Home Assistant über den Entity-Index (`sun.sun` — mit der
  Basisinstallation vorhanden, die sun-Integration ist per Default aktiv).
- **Ablauf**: 1. Index-Quelle konfigurieren, so dass `sun.sun` geliefert wird
  (Admin-UI, Index-Tab) — weil der Index der Lesekanal ist. 2. Vorgang
  `sonnenstand` mit Trigger `sonnenstand` auf eine Funktion mit:
  ```jinja
  Die Sonne ist gerade {{ 'über' if index.state('sun.sun') == 'above_horizon' else 'unter' }} dem Horizont.
  ```
- **Hinweise**: der State der Sonnen-Entity ist `above_horizon`/
  `below_horizon`. Attribute (Auf-/Untergangszeiten) stehen nicht im
  Index-Pipe-Text — dafür den Template-Tool-Fall (4.1) nutzen.

### 3.2 Ist jemand zuhause? (`zone.home`)

- **Ziel**: „Ist jemand zuhause?" → Personenzahl gesprochen.
- **Modus**: `deterministic`.
- **Quelle**: Home Assistant Index (`zone.home` — mit der Basisinstallation
  vorhanden; State = Personenzahl in der Zone).
- **Ablauf**: wie 3.1, Funktion:
  ```jinja
  {%- set n = index.state('zone.home') | int -%}
  {{ 'Niemand ist zuhause.' if n == 0 else ('Eine Person ist zuhause.' if n == 1 else n ~ ' Personen sind zuhause.') }}
  ```
- **Hinweise**: `person.<name>`-Entities stehen ebenfalls im Index, wenn die
  Index-Quelle sie einschließt — für Namen genügt ein Suffix-Muster in der
  Index-Config.

### 3.3 Wetter-Übersicht (HTTP-Direkt)

- **Ziel**: „Wie wird das Wetter?" → mehrteiliger Bericht für die nächsten
  Tage.
- **Modus**: `deterministic` — die API liefert fertig strukturierte Daten,
  das Template formatiert.
- **Quelle**: öffentliche Wetter-API via `http()` (z. B. open-meteo mit
  `latitude=<breite>&longitude=<laenge>` — Platzhalter einsetzen; URL ist
  **literale** im Template, kein SSRF-Risiko).
- **Ablauf**: 1. `http()` holt JSON — weil `http()` JSON automatisch parst,
  greift das Template direkt auf Felder zu. 2. Ein Jinja-Macro übersetzt den
  numerischen Wettercode (`weather_code`) in sprechbare Begriffe — weil die
  API-Codes nicht sprechbar sind. 3. Tägliche Extremwerte aus dem
  `daily`-Block — weil ein Bericht Extremwerte, nicht Stundendaten sprechen
  soll.
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

- **Ziel**: „Wie lange läuft der Gateway schon?" → Uptime in Tagen.
- **Modus**: `deterministic`.
- **Quelle**: `shell()` im Gateway-Container.
- **Ablauf**: eine Zeile Template — weil `/proc/uptime` Sekunden liefert und
  das Template rechnet:
  ```jinja
  Das Gateway läuft seit {{ (shell('cat /proc/uptime | cut -d . -f1') | int / 86400) | round(1) }} Tagen.
  ```
- **Hinweise**: Shell-Befehle sind Admin-only editierbar und haben Timeout +
  Output-Cap — nur kurze Befehle, keine Langläufer oder Eingabeketten.

### 3.5 Tageszeit-Begrüßung (`now`)

- **Ziel**: Berichte mit passender Begrüßung statt nüchterner Ansage.
- **Modus**: `deterministic` (Baustein für andere Berichte).
- **Quelle**: Gateway-Zeit (`now.hour`).
- **Ablauf**: ein `set` vor dem Speak-Block — weil die Begrüßung an den
  Stundenwert gebunden ist:
  ```jinja
  {%- set gr = 'Guten Morgen' if (now.hour >= 5 and now.hour < 11) else ('Guten Abend' if (now.hour >= 17 and now.hour < 22) else 'Hallo') -%}
  ```
- **Hinweise**: `now` liefert Gateway-Zeit; Zeitzonen-Fallstricke gibt es
  bei Log-Timestamps, nicht hier.

### 3.6 Komplexfall: Hausstatus-Bericht (Makros + Fallbacks)

- **Ziel**: „Wie ist der Hausstatus?" → Sprechpausen-getakter SSML-Bericht
  (Akkustand, Verbrauch, Produktionswerte).
- **Modus**: `deterministic` — die Struktur ist fest, nur Zahlen variieren.
- **Quelle**: Home Assistant Index (mehrere Sensor-IDs).
- **Ablauf**: 1. Ein Makro `gfmt` normalisiert Zahlen und ersetzt
  `unknown`/`unavailable` durch „unbekannt" — weil Sensoren bei Basis-Setup
  (oder Stromausfall) unbelegt sein können. 2. `set`-Variablen holen alle
  Werte über `index.state(...)` — weil der Index bereits die aktuellen
  Zustände gecacht hat (keine Einzel-Roundtrips). 3. Ein
  `<speak>`-Block mit `<break time="..."/>` baut die Sprechpausen — weil
  Stichpunkte im Sprachdialog sonst weggespielt werden.
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
  Echo-Display-Pfad (APL) ist reiner Text die Basis, SSML-Detail entscheidet
  die Ausgabeschicht.

## 4. Hybrid-Vorgänge

### 4.1 Einzelwert mit Attribut (Template-Tool des HA-Connectors)

- **Ziel**: „Wie warm ist es im Garten?" → Wert **und** sprechende Einordnung.
- **Modus**: `hybrid` — die Zahl kommt aus einer Funktion, das LLM formuliert
  die Einordnung („Es sind X Grad, eher frisch…").
- **Quelle**: HA-Connector über das Template-Tool (`ha_eval_template`-Typ):
  `mcp.call('<template-tool>', { template: "states.weather.home.attributes.temperature" })`
  — `weather.home` ist mit der Basisinstallation vorhanden.
- **Ablauf**: 1. Die Funktion ruft das Template-Tool — weil das
  Index-Pipe-Format nur den State zeigt, nicht beliebige Attribute. 2. Der
  Hybrid-Anteil formuliert — weil die natürliche Einordnung (kalt/mild/warm)
  das LLM besser spricht als eine if-Kaskade im Template.
- **Hinweise**: Im Template-Tool-Call nur **wörtliche** Templates
  verwenden; mit `args` dynamisch gebaute Ausdrücke brauchen die
  Preheat-Regeln aus `FUNKTIONEN.md` (set-Variablen sind im
  Auswertungskontext nicht sichtbar).

### 4.2 Verkehrsmeldungen (Liste variabler Länge)

- **Ziel**: „Wie ist der Stau?" → 2–3 konkrete Meldungen gesprochen.
- **Modus**: `hybrid` — die API liefert eine variable Liste, das LLM wählt
  und formuliert.
- **Quelle**: öffentliche Verkehrs-API via `http()` (ohne personale Daten —
  reine Meldungslisten).
- **Ablauf**: 1. Die Funktion holt je Autobahn-Streifen eine
  Bauarbeiten-Liste (`http()` je URL) und komprimiert in einen
  Stichpunkte-Text — weil der LLM-Kontext schlank bleiben soll. 2. Der
  Hybrid-Anteil formuliert 2–3 Meldungen mit Ort und Grund — weil Sprachdialog
  keine Tabellen will.
- **Hinweise**: öffentliche APIs mit großem Feed brauchen einen schlanken
  Endpunkt (Body-Cap) — siehe Grenzen in `FUNKTIONEN.md`.

## 5. LLM-Vorgänge / Agent-Kaskaden

### 5.1 Licht schalten (HA-Kaskade)

- **Ziel**: „Schalte das Küchenlicht ein" → Ausführung + Bestätigung.
- **Modus**: `llm` — der Agent ermittelt entity_id und Service-Call.
- **Quelle**: Home Assistant MCP.
- **Ablauf** (warum in dieser Reihenfolge): 1. `fn_find_entities("küche
  licht")` — weil die Treffer bereits die `entity_id` **und** den aktuellen
  Zustand enthalten; ein zweiter Lesecall wäre Rundenverschwendung. 2.
  Service-Call (`light/turn_on`) mit der exakten entity_id — weil der Agent
  **niemals ratet** und eine Erfolgsbestätigung nur für Aufrufe gibt, die in
  dieser Antwort auch gelaufen sind. 3. Bei Mehrdeutigkeit (zwei Lichter im
  Raum): Rückfrage im Echo — weil eine falsche entity_id unbeobachtbar
  falsch schaltet.
- **Konfiguration**: Agent-Vorgang oder offene Frage; `fn_find_entities` mit
  `parameters`-Schema (`query`); Allowlist im Agent-Tool-Tab.
- **Hinweise**: die Kaskade steht in der Systemnotiz des HA-Connectors —
  nicht im Agent-Prompt (dort nur generisches Verhalten).

### 5.2 Musik abspielen (Music-Assistant-Kaskade)

- **Ziel**: „Spiele Musik von <Künstler>" → Wiedergabe auf dem Player.
- **Modus**: `llm`.
- **Quelle**: Music Assistant MCP.
- **Ablauf**: 1. `fn_ma_players` — weil `playback_play_media` eine
  `player_id` braucht und der Player-State (Lautstärke, gerade laufend) aus
  einem Call kommt. 2. `library_search_artists` — weil der Name-URI für den
  Play-Call her muss; ASR-Falscherkennungen zuerst gegen bekannte
  Verwechslungen prüfen, dann plausible Schreibweisen (2–3 Varianten) —
  **bevor** „nicht gefunden" antwortet. 3. `playback_play_media` mit URI +
  player_id; Playlist/Album bevorzugen — weil sie vollständig gespielt
  werden; nach dem letzten Titel endet die Queue (Hinweis nur auf Nachfrage).
- **Konfiguration**: `fn_ma_players` mit `parameters`-Schema (Player-Query)
  — die Player-Liste kommt aus einem **Zweit-Index** (eigene Index-Quelle,
  hier `ma`); die Kaskade steht in der MA-Systemnotiz.
- **Hinweise**: die Musik-Falscherkennung ist ein **BEVOR**-Regel-Fall — sie
  steht deshalb am System, nicht als nachladbarer Hinweis.

### 5.3 Nachrichten zu einer Quelle (Such-Kaskade)

- **Ziel**: „Neuigkeiten bei <Quelle>" → 4–5 einzelne Meldungen mit Quelle.
- **Modus**: `llm`.
- **Quelle**: Such-Connector (z. B. SearXNG- oder Brave-MCP) + `web_url_read`.
- **Ablauf**: 1. Eine parametrisierte Funktion (`query`, optional `url`)
  ruft den Such-Call mit `count 5` — weil Treffer die Quellen liefern. 2.
  Liefert die Quelle einen verlinkten Treffer, liest dieselbe Funktion den
  `/rss`-Feed der Seite (`web_url_read`, maxLength 6000) — weil Portale ihre
  Meldungen als Feed-Titel tragen und die Feed-Prüfe deutlich konkreter ist
  als Portal-Übersichten. 3. Der Agent formuliert eine **Aufzählung** von
  4–5 EINZELNEN Meldungen („Erstens… Außerdem… Schließlich…") — weil die
  Quellenregel verlangt: nur Inhalte aus den Tool-Ergebnissen dieser
  Antwort, niemals Vorwissen oder Gesprächsverlauf. Nach der Lese-Runde
  SOFORT antworten — keine zweite URL.
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

- **Ziel**: „Was gibt es Neues zu <Thema>?" → konkrete Meldungen, auch wenn
  Treffer nur Portal-Übersichten sind.
- **Modus**: `llm`.
- **Quelle**: Such-Connector (Beispiel Brave-MCP) + `web_url_read`.
- **Ablauf**: 1. Erste Such-Runde — weil die Suche die Kandidaten-URLs
  liefert. 2. Sind die Treffer nur Portal-Übersichten (Meta-Beschreibungen
  statt Meldungen): GENAU EINMAL die passende Treffer-URL mit
  `web_url_read` lesen (mit maxLength) — weil Portal-Übersichten keine
  Meldungstexte enthalten. 3. SOFORT danach antworten — weil jede weitere
  Runde Such-/Read-Budget verbraucht und die Antwortfrist sprengen kann.
- **Konfiguration**: wie 5.3; der Unterschied ist der Fallback-Weg (Feed
  vs. Treffer-URL) — beide Muster sind in einer Funktion kombinierbar.
- **Hinweise**: `web_url_read` ausschließlich für konkrete Treffer-URLs
  oder auf ausdrücklichen Wunsch — niemals Portale wahllos lesen.

### 5.5 Messwerte fragen („wie hell ist es im Wohnzimmer")

- **Ziel**: offene Zustands-Fragen über das ganze Zuhause.
- **Modus**: `llm` — kein Trigger deckt die Phrasenvielfalt ab.
- **Quelle**: Home Assistant Index via `fn_find_entities`.
- **Ablauf**: 1. `fn_find_entities` mit Stichworten — weil die Treffer den
  aktuellen Zustand enthalten und die Suche Fuzzy/Aliase/Räume bereits
  behandelt. 2. SOFORT aus dem Treffer antworten (max. 1 Aufruf) — weil
  Variationen desselben Begriffs die Suche schon aufklärt und jede
  weitere Runde nur Latenz ist. 3. Kein passender Treffer: ehrlich sagen,
  nichts erfinden.
- **Konfiguration**: offene Agent-Route; Regeln in der `find_entities`-Prompts.
- **Hinweise**: Kombinierte Anfragen („Nachrichten und dann der Hausstatus")
  laufen der Reihenfolge nach — jede Teilfrage nutzt ihr zuständiges Tool,
  kein Abbruch nach dem ersten Teil.

## 6. Anhang

### Anonymisierung

- Keine echten Entity-IDs, Hostnamen, URLs, Koordinaten oder Namen. Muster:
  `sensor.beispiel_*`, `50.00/10.00` als Platzhalterkoordinaten,
  „Küchenlicht" statt konkreter Gerätenamen.
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
