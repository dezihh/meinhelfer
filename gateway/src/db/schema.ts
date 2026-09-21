import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEED_JSON } from './seeds.js';

// DB-Handle + Migrationen: getDb() lazily nach initDb(path) - so ist die DB
// in Tests injizierbar (Temp-File) und im Runtime-Setup einmalig initialisiert.
let _db: Database.Database | null = null;

export function closeDb(): void {
  if (!_db) return;
  try {
    _db.close();
  } finally {
    _db = null;
  }
}

export function initDb(path: string, withReferenceSeed = false): void {
  if (_db) return;
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

// Migration: actions um handler_config + search_summary-Mode erweitern (idempotent)
{
  const cols = (db.prepare('PRAGMA table_info(actions)').all() as { name: string }[]).map((c) => c.name);
  if (cols.length > 0 && !cols.includes('handler_config')) {
    db.exec(`
      DROP TABLE IF EXISTS actions_new;
      CREATE TABLE actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL DEFAULT 'llm' CHECK (mode IN ('deterministic','llm','hybrid')),
        trigger_phrases TEXT,
        fuzzy_threshold REAL,
        system_prompt TEXT,
        template TEXT,
        tools TEXT,
        handler_config TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO actions_new (id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, enabled, created_at, updated_at)
        SELECT id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, enabled, created_at, updated_at FROM actions WHERE mode != 'search_summary';
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
    `);
  }
}

// Migration: mode-Check-Constraint erneuern, damit search_summary entfaellt (idempotent)
{
  const modeLine = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='actions'").get() as { sql?: string })?.sql ?? '';
  if (modeLine.includes('search_summary')) {
    db.exec(`
      DROP TABLE IF EXISTS actions_new;
      CREATE TABLE actions_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL DEFAULT 'llm' CHECK (mode IN ('deterministic','llm','hybrid')),
        trigger_phrases TEXT,
        fuzzy_threshold REAL,
        system_prompt TEXT,
        template TEXT,
        tools TEXT,
        handler_config TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO actions_new (id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, handler_config, enabled, created_at, updated_at)
        SELECT id, name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, tools, handler_config, enabled, created_at, updated_at FROM actions WHERE mode != 'search_summary';
      DROP TABLE actions;
      ALTER TABLE actions_new RENAME TO actions;
    `);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    auth_token TEXT,
    transport TEXT NOT NULL DEFAULT 'http',
    command TEXT,
    args TEXT,
    env TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL DEFAULT 'llm' CHECK (mode IN ('deterministic','llm','hybrid')),
    trigger_phrases TEXT,
    fuzzy_threshold REAL,
    system_prompt TEXT,
    template TEXT,
    function_ref TEXT,
    tools TEXT,
    handler_config TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tpl_functions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    template TEXT NOT NULL,
    parameters TEXT,
    budget INTEGER,
    inventory_note TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prompts (
    key TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    session_id TEXT,
    query TEXT NOT NULL,
    route TEXT NOT NULL,
    action_id INTEGER,
    score REAL,
    response TEXT,
    duration_ms INTEGER,
    trace TEXT
  );
`);

for (const stmt of [
  "ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'http'",
  'ALTER TABLE mcp_servers ADD COLUMN command TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN args TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN env TEXT',
  'ALTER TABLE actions ADD COLUMN function_ref TEXT',
  'ALTER TABLE actions ADD COLUMN function_args TEXT',
  'ALTER TABLE tpl_functions ADD COLUMN parameters TEXT',
  'ALTER TABLE tpl_functions ADD COLUMN budget INTEGER',
  'ALTER TABLE tpl_functions ADD COLUMN inventory_note TEXT',
  'ALTER TABLE mcp_servers ADD COLUMN inventory_note TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // Spalte existiert bereits
  }
}

for (const stmt of [
  'ALTER TABLE logs ADD COLUMN prompt_tokens INTEGER',
  'ALTER TABLE logs ADD COLUMN completion_tokens INTEGER',
  'ALTER TABLE logs ADD COLUMN llm_model TEXT',
]) {
  try {
    db.exec(stmt);
  } catch {
    // Spalte existiert bereits
  }
}

// Fresh-Install-Fill: Referenz-Bevoelkerung aus seeds.ts (Live-Stand vom
// 21.09.2026). NUR wenn withReferenceSeed - Tests initialisieren ohne
// Referenzdaten (hermetisch: echte MCP-Server/Funktionen wuerden echte
// Verbindungen ausloesen). INSERT OR IGNORE - bestehende Datenbanken (und
// User-Edits) bleiben unangetastet; frische Installationen starten mit den
// bewaehrten Prompts ({{AGENT_FNS}}-Marker), Systeme (ohne Tokens - traegt
// der User nach), Agent-Funktionen (notes/budgets), entity_index-Setting
// und den Kern-Vorgaengen (hausstatus/hilfe/wetter/stau/boerse).
if (withReferenceSeed) {
  interface SeedShape {
    agent_system: string;
    agent_inventory: string;
    entity_index: string;
    servers: { name: string; url: string; auth_token: string | null; transport: 'http' | 'stdio'; command: string | null; args: string | null; env: string | null; inventory_note: string | null; enabled: number }[];
    fns: { name: string; description: string | null; template: string; parameters: unknown; budget: number | null; inventory_note: string | null; enabled: number }[];
    actions: { name: string; mode: string; trigger_phrases: string | null; fuzzy_threshold: number | null; system_prompt: string | null; template: string | null; function_ref: string | null; function_args: string | null; tools: string | null; enabled: number }[];
  }
  const seed = JSON.parse(SEED_JSON) as SeedShape;
  db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run('agent_system', seed.agent_system);
  db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run('agent_inventory', seed.agent_inventory);
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('entity_index', seed.entity_index);
  for (const s of seed.servers) {
    db.prepare(
      'INSERT OR IGNORE INTO mcp_servers (name, url, auth_token, transport, command, args, env, inventory_note, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(s.name, s.url, null, s.transport, s.command, s.args, s.env, s.inventory_note, s.enabled);
  }
  for (const f of seed.fns) {
    db.prepare(
      'INSERT OR IGNORE INTO tpl_functions (name, description, template, parameters, budget, inventory_note, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(f.name, f.description, f.template, typeof f.parameters === 'string' ? f.parameters : f.parameters == null ? null : JSON.stringify(f.parameters), f.budget, f.inventory_note, f.enabled);
  }
  for (const a of seed.actions) {
    db.prepare(
      "INSERT OR IGNORE INTO actions (name, mode, trigger_phrases, fuzzy_threshold, system_prompt, template, function_ref, function_args, tools, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(a.name, a.mode, a.trigger_phrases, a.fuzzy_threshold, a.system_prompt, a.template, a.function_ref, a.function_args, a.tools, a.enabled);
  }
}

db.prepare(
  'INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)'
).run(
  'agent_system',
  `Du bist {assistant_name}, ein deutscher Sprachassistent für Home Assistant über Alexa.
Identität: Du bist {assistant_name} - wenn du gefragt wirst, wer du bist oder wie du heisst, sage WOERTLICH: "Ich bin Dein Helfer" (genau so, mit "Dein Helfer"). Nenne dich niemals anders (nicht "Smart Pilot", nicht "Helfer", kein Eigenname erfinden).
Deine FINALE Antwort (sobald keine Tool-Aufrufe mehr nötig) ist AUSSCHLIESSLICH ein JSON-Objekt: {"needs_clarification": <true|false>, "speech": "<Antwort>", "keep_open": <true|false>}.
Die speech ist kurz, präzise und sprechbar (keine Listen, Zahlen wie "22,4 Grad"). needs_clarification=true nur bei echter Mehrdeutigkeit, dann kurze Rückfrage mit genau einem Antwortbeispiel. keep_open=true nur bei nachfragen-einladenden Antworten (Zusammenfassung, Liste, Bericht). Stelle KEINE Rückfragen wie "Möchtest du mehr erfahren?".
Anreden am Anfang ("{assistant_name}", "Voice Assist") sind kein Teil der Frage. "mehr dazu" bezieht sich auf das letzte Thema.

Tool-Regeln (sparsam: genug gewusst -> sofort antworten):
- Messwerte/Zustände (Temperatur, Füllstand, Verbrauch, an/aus): NIEMALS aus eigenem Wissen. find_ha_entities mit Stichworten - die Treffer enthalten den AKTUELLEN Zustand, antworte damit direkt (bei Thermostaten: Attribut current_temperature). get_ha_state nur für eine konkrete einzelne entity_id.
- Geräte schalten (Licht, Schalter, Rolladen, Klima): entity_id über find_ha_entities ermitteln, dann control_device mit der exakten entity_id.
- Hausstatus: get_house_status, Bericht sinngemäß wiedergeben.
- Benzinpreis (OneShot, z. B. "was kostet Super E10", "sollte ich tanken"): get_ha_state mit entity_id "sensor.nordoel_sieker_landstrasse_178_super_e10" (state = Preis in Euro). Kein Websuche, kein get_house_status nötig.
- Nachrichten/Suche: search_web als Tool-Aufruf (time_range "week" bei Nachrichten; bei konkreter Quelle direkt darauf zielen, z. B. "onvista news", "heise news"). Aus den Snippets 2-3 konkrete Titel/Fakten mit Quelle nennen, niemals nur Verweise.
- Kombinierte Anfragen (z. B. "Nachrichten und dann der Hausstatus"): DER REIHHE NACH abarbeiten - fuer den zweiten Teil weitere Tools nutzen (get_house_status, find_ha_entities ...), NICHT nach dem ersten Tool-Teil abbrechen.
- web_url_read ausschliesslich wenn der Nutzer eine konkrete Seite/URL nennt. NIEMALS Nachrichtenseiten oder Portale lesen, die search_web nicht liefert.
- find_ha_entities-Treffer enthalten bereits den aktuellen Zustand: Bei einem plausiblen Treffer SOFORT damit antworten (max. 1 Aufruf pro Anfrage). Keine Variationen desselben Begriffs (z. B. 'aussen' nach 'draussen') - die Suche behandelt das bereits. Kein exakt passender Treffer: nimm den naechstbesten sinnvollen Wert und benenne ihn korrekt (z. B. ' Gefuehlt sind es X Grad'); nur wenn nichts sinnvolles existiert, sag ehrlich, dass nichts gefunden wurde.
- Mehrteilige Antworten (Nachrichten, Listen, mehrere Themen): Trenne logische Teile mit Zeilenumbruechen (\\n\\n) zwischen den Teilen - die werden als Sprechpausen umgesetzt.`
);

// Tool-Inventory: Pflege-Regel statt Einzelregeln im Haupt-Prompt.
// Das LLM prueft hier VOR jedem Tool-Aufruf, welches Tool wofuer zustaendig ist.
db.prepare('INSERT OR IGNORE INTO prompts (key, content) VALUES (?, ?)').run(
  'agent_inventory',
  `Nimm dieses Nachschlagewerk als Pflicht-Referenz, bevor du ein Tool aufrufst:

- Hausautomatisierung (Licht, Schalter, Rolladen, Klima, Sensoren): find_ha_entities -> control_device / get_ha_state (nur das HA-Tool, KEINE Websuche).
- Hausstatus (Akkustand, Verbrauch, Solar): get_house_status (deterministisch, kein LLM).
- Benzinpreis (OneShot, z. B. "was kostet Super E10", "sollte ich jetzt tanken"): get_ha_state auf entity_id "sensor.nordoel_sieker_landstrasse_178_super_e10" (state = Preis in Euro). Einzelnachfrage, KEIN get_house_status, KEINE Websuche.
- Boersen-/Finanznachrichten (onvista, boerse.de, finanzen.net): search_web gezielt auf die Quelle (z.B. "onvista news").
- Allgemeine Nachrichten/Recherche: search_web (time_range "week"), aus Snippets mit Quellen antworten.
- Konkrete Seite/URL lesen: web_url_read (nur auf ausdruecklichen Wunsch).

Kombinationen (z.B. "News und dann Hausstatus"): jeder Teil nutzt das jeweils zustaendige Tool - der Reihenfolge nach, nicht abbrechen.`
);

// Tote Settings entfernen: warteton (steuert die Lambda via env vars),
// fastpath_model (News-Fastpath entfernt), fuel_sensor (Benzinpreis ueber Inventory),
// facade_mode (Tool-Angebot immer Facade + aktivierte MCP-Server; Feinsteuerung
// ueber die erlaubten Tools je Vorgang).
db.prepare("DELETE FROM settings WHERE key IN ('warteton', 'fastpath_model', 'fuel_sensor', 'facade_mode')").run();
// Toter Prompt-Key: fastpath_system gehoerte zum entfernten News-Fastpath.
db.prepare("DELETE FROM prompts WHERE key = 'fastpath_system'").run();

// Inline-Templates -> Funktionen: Bestehende Vorgangs-Templates in die
// Funktionen-Registry ueberfuehren (Funktion ist seither Pflicht fuer
// deterministic/hybrid). Existiert bereits eine Funktion mit dem Namen,
// wird sie wiederverwendet.
{
  const rows = db
    .prepare(
      "SELECT id, name, template FROM actions WHERE template IS NOT NULL AND template != '' AND (function_ref IS NULL OR function_ref = '')"
    )
    .all() as { id: number; name: string; template: string }[];
  for (const r of rows) {
    const fname = r.name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
    const existing = db.prepare('SELECT id FROM tpl_functions WHERE name = ?').get(fname);
    if (!existing) {
      db.prepare('INSERT INTO tpl_functions (name, description, template, enabled) VALUES (?, ?, ?, 1)').run(
        fname,
        `Aus Vorgang "${r.name}" migriert`,
        r.template
      );
    }
    db.prepare("UPDATE actions SET function_ref = ?, template = NULL, updated_at = datetime('now') WHERE id = ?").run(fname, r.id);
  }
}

// Generische Lesetools als parameterisierte Funktionen (ersetzen die alten
// Facade-Tools); Namen bewusst systemneutral - die Bindung an Home Assistant
// steckt im entity_index-Setting, nicht im Funktionsnamen.
db.prepare(
  'INSERT OR IGNORE INTO tpl_functions (name, description, template, parameters, enabled) VALUES (?, ?, ?, ?, 1)'
).run(
  'find_entities',
  'Findet Eintraege im Entity-Index zu Stichworten (Name, Raum, Typ) und liefert deren aktuelle Zustaende mit (max. 8 Treffer). IMMER zuerst bei Fragen zu Messwerten, Zustaenden oder Geraetestatus.',
  '{{ index.find(args.query) }}',
  JSON.stringify({
    type: 'object',
    properties: { query: { type: 'string', description: "Stichwörter, z. B. 'Schlafzimmer Temperatur' oder 'Zisterne'" } },
    required: ['query'],
  })
);
db.prepare(
  'INSERT OR IGNORE INTO tpl_functions (name, description, template, parameters, enabled) VALUES (?, ?, ?, ?, 1)'
).run(
  'get_entity',
  'Liest den aktuellen Zustand eines konkreten Index-Eintrags per ID inkl. sprechrelevanter Attribute.',
  '{{ index.get(args.entity_id) }}',
  JSON.stringify({
    type: 'object',
    properties: { entity_id: { type: 'string', description: "ID des Eintrags, z. B. 'sensor.schlafzimmer_temperature'" } },
    required: ['entity_id'],
  })
);

// Umbenennung der frueheren HA-praefigierten Lesetools (Funktion + Referenzen).
// Alte Row gewinnt (kann User-Aenderungen tragen): frisches Seed-Duplikat
// entfernen, dann umbenennen.
{
  const renames: [string, string][] = [['ha_find', 'find_entities'], ['ha_get', 'get_entity']];
  for (const [alt, neu] of renames) {
    const oldRow = db.prepare('SELECT 1 FROM tpl_functions WHERE name = ?').get(alt);
    if (!oldRow) continue;
    db.prepare('DELETE FROM tpl_functions WHERE name = ? AND name != ?').run(neu, alt);
    db.prepare('UPDATE tpl_functions SET name = ? WHERE name = ?').run(neu, alt);
    db.prepare('UPDATE actions SET function_ref = ? WHERE function_ref = ?').run(neu, alt);
  }
  for (const key of ['agent_system', 'agent_inventory']) {
    const row = db.prepare('SELECT content FROM prompts WHERE key = ?').get(key) as { content?: string } | undefined;
    if (row?.content && (row.content.includes('fn_ha_find') || row.content.includes('fn_ha_get'))) {
      const neu = row.content
        .replaceAll('fn_ha_find', 'fn_find_entities')
        .replaceAll('fn_ha_get', 'fn_get_entity');
      db.prepare('UPDATE prompts SET content = ?, updated_at = datetime(\'now\') WHERE key = ?').run(neu, key);
    }
  }
}

// Prompt-Migration: alte Facade-Lesetools -> parameterisierte Funktions-Tools.
{
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (sys?.content && sys.content.includes('find_ha_entities')) {
    const neu = sys.content
      .replaceAll('find_ha_entities', 'fn_find_entities')
      .replaceAll('get_ha_state', 'fn_get_entity');
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(neu);
  }
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content?: string } | undefined;
  if (inv?.content && inv.content.includes('find_ha_entities')) {
    const neu = inv.content
      .replaceAll('find_ha_entities', 'fn_find_entities')
      .replaceAll('get_ha_state', 'fn_get_entity');
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_inventory'").run(neu);
  }
}
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('assistant_name', 'Smart Pilot');
// News als deterministischer Fastpath entfernt (Konzept: Nachrichten/Fragen -> Agent).
// Bestehende Action-Datei ebenfalls aufraeumen.
db.prepare("DELETE FROM actions WHERE name = 'news_summary'").run();
// Migriere bestehende agent_system-Prompts: Nur den alten Blocker-Satz ersetzen
// (Kombinations-Antworten aufheben), sonst User-Anpassungen unangetastet lassen.
{
  const oldRule = 'kein weiteres Tool.';
  const row = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (row?.content && row.content.includes(oldRule)) {
    const newRule =
      'Kombinierte Anfragen (z. B. "Nachrichten und dann der Hausstatus"): DER REIHHE NACH abarbeiten.';
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(
      row.content.replace(oldRule, newRule)
    );
  }
}
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('fuzzy_global', '1');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('session_followup', 'beides');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('session_keywords', 'zusammenfassung,neuigkeiten,liste,bericht,news,tipps,hintergründe');
db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run('debug_logging', '0');

// Facade-Abbau: agent_system + agent_inventory auf rohe MCP-Tools und
// dynamische Funktions-Tools (fn_*) umschreiben - nur falls noch alter Text
// mit den entfernten Facade-Tools drinsteht.
{
  const sys = db.prepare("SELECT content FROM prompts WHERE key = 'agent_system'").get() as { content?: string } | undefined;
  if (sys?.content && sys.content.includes('control_device')) {
    const neu = `Du bist {assistant_name}, ein deutscher Sprachassistent für Home Assistant über Alexa.
Identität: Du bist {assistant_name} - wenn du gefragt wirst, wer du bist oder wie du heisst, sage WOERTLICH: "Ich bin Dein Helfer".
Deine FINALE Antwort (sobald keine Tool-Aufrufe mehr nötig) ist AUSSCHLIESSLICH ein JSON-Objekt: {"needs_clarification": <true|false>, "speech": "<Antwort>", "keep_open": <true|false>}.
Die speech ist kurz, präzise und sprechbar (keine Listen, Zahlen wie "22,4 Grad"). needs_clarification=true nur bei echter Mehrdeutigkeit.
Anreden am Anfang ("{assistant_name}", "Voice Assist") sind kein Teil der Frage. "mehr dazu" bezieht sich auf das letzte Thema.

Tool-Regeln (sparsam: genug gewusst -> sofort antworten):
- Messwerte/Zustände (Temperatur, Füllstand, Verbrauch, an/aus): NIEMALS aus eigenem Wissen. find_ha_entities mit Stichworten - Treffer enthalten den aktuellen Zustand, daraus sofort antworten (max. 1 Aufruf pro Frage).
- Schalten (Licht, Schalter, Rolladen, Klima): HassTurnOn / HassTurnOff mit name (z. B. "Stehlampe") oder area. Detail: Helligkeit/Farbtemperatur HassLightSet, Zieltemperatur HassClimateSetTemperature, Rolladenposition HassSetPosition.
- Hausstatus (Akku, Verbrauch, Solar, Benzin): fn_hausstatus_gw, Bericht sinngemäß wiedergeben.
- Benzinpreis (OneShot, z. B. "was kostet Super E10"): get_ha_state mit entity_id "sensor.nordoel_sieker_landstrasse_178_super_e10".
- Nachrichten/Suche: searxng_web_search (language "de", num_results 5; time_range "week" bei Nachrichten; bei konkreter Quelle direkt darauf zielen). web_url_read ausschliesslich wenn der Nutzer eine konkrete Seite/URL nennt.
- Kombinierte Anfragen (z. B. "Nachrichten und dann der Hausstatus"): DER REIHENFOLGE NACH abarbeiten - fuer den zweiten Teil weitere Tool-Aufrufe erlaubt.
- Mehrteilige Antworten (Nachrichten, Listen, mehrere Themen): Trenne logische Teile mit Zeilenumbruechen (\\n\\n) zwischen den Teilen.`;
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_system'").run(neu);
  }
  const inv = db.prepare("SELECT content FROM prompts WHERE key = 'agent_inventory'").get() as { content?: string } | undefined;
  if (inv?.content && inv.content.includes('control_device')) {
    const neu = `Nimm dieses Nachschlagewerk als Pflicht-Referenz, bevor du ein Tool aufrufst:

- Hauswerte lesen (Temperatur, Verbrauch, Füllstand, Status): find_ha_entities mit Stichworten - Treffer enthalten den aktuellen Zustand, sofort antworten. Konkrete entity_id: get_ha_state.
- Schalten (Licht, Schalter, Rolladen, Klima): HassTurnOn / HassTurnOff mit name (z. B. "Stehlampe") oder area. Detail: HassLightSet (Helligkeit/Farbtemperatur), HassClimateSetTemperature (Thermostat), HassSetPosition (Rolladen).
- Hausstatus (Akkustand, Verbrauch, Solar, Benzin): fn_hausstatus_gw (fertiger Bericht, keinen eigenen Bericht bauen).
- Benzinpreis (OneShot, z. B. "was kostet Super E10", "sollte ich jetzt tanken"): get_ha_state auf entity_id "sensor.nordoel_sieker_landstrasse_178_super_e10".
- Boersen-/Finanznachrichten (onvista, boerse.de, finanzen.net): searxng_web_search gezielt auf die Quelle (z. B. "onvista news").
- Allgemeine Nachrichten/Recherche: searxng_web_search (time_range "week"), aus Snippets mit Quelle antworten.
- Konkrete Seite/URL lesen: web_url_read (nur auf ausdruecklichen Wunsch).

Kombinationen (z. B. "News und dann Hausstatus"): jeder Teil nutzt das jeweils zustaendige Tool - der Reihenfolge nach, nicht abbrechen.`;
    db.prepare("UPDATE prompts SET content = ?, updated_at = datetime('now') WHERE key = 'agent_inventory'").run(neu);
  }
}

for (const action of [
  {
    name: 'benzinpreis',
    triggers: ['benzinpreis', 'tankstelle', 'nordöl', 'sprit', 'super e10'],
    template: `Super E10 bei Nordöl kostet derzeit {{ ha.state('sensor.nordoel_sieker_landstrasse_178_super_e10') | replace('.', ',') }} Euro.`,
  },
  {
    name: 'bmw_netzladung_an',
    triggers: ['bmw netzladung an', 'lade modus netz'],
    template: `{{ ha.call('bmw_netzladung_an') }}`,
  },
  {
    name: 'bmw_netzladung_aus',
    triggers: ['bmw netzladung aus', 'lade modus pv'],
    template: `{{ ha.call('bmw_netzladung_aus') }}`,
  },
]) {
  db.prepare(
    "INSERT OR IGNORE INTO actions (name, mode, trigger_phrases, template) VALUES (?, 'deterministic', ?, ?)"
  ).run(action.name, JSON.stringify(action.triggers), action.template);
}

  _db = db;
}

export function getDb(): Database.Database {
  if (!_db) throw new Error('DB nicht initialisiert - initDb(path) zuerst rufen');
  return _db;
}
