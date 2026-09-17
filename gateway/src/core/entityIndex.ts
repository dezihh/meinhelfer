import { getSetting } from '../db.js';
import { getMcpContext } from '../mcp/registry.js';

// Generischer Entity-Index: quelle = 1 parametrierter MCP-Call (Settings),
// Parsing/Scoring/Lookups laufen lokal im RAM (60 s TTL). Kein Systembezug im
// Code: Welches Tool die Liste liefert, wie sie aussieht (Datenvertrag
// id|area|state|unit|name|key=value;...), Aliase und Domain-Hints stehen in
// den Settings (JSON unter dem Schluessel "entity_index"). Die Defaults unten
// binden Home Assistant (ha-mcp, ha_eval_template) - ein anderes System wird
// ausschliesslich durch ein anderes Setting angebunden, nicht durch Code.

export interface IndexEntry {
  id: string;
  name: string;
  state: string;
  unit: string;
  area: string;
  attributes: Record<string, string>;
}

interface DomainHint {
  re: RegExp;
  domains: string[];
}

interface IndexConfig {
  tool: string;
  // Freies Argument-Objekt fuer den Index-Tool-Call; das Extraktions-Template
  // steckt in dem Argument, das der jeweilige Server erwartet (HA:
  // args.template). So bleibt die Bindung an JEDES System reine Konfiguration.
  args: Record<string, unknown>;
  ttlMs: number;
  aliases: Record<string, string>;
  domainHints: DomainHint[];
  stopwords: Set<string>;
}

const DEFAULT_SNAPSHOT_TEMPLATE = `{%- set KEYS = ['current_temperature', 'target_temperature', 'temperature', 'humidity', 'brightness', 'position', 'battery_level', 'hvac_mode', 'fan_mode', 'device_class'] -%}
{% for e in states %}{{ e.entity_id }}|{{ area_name(e.entity_id) }}|{{ e.state }}|{{ e.attributes.get('unit_of_measurement', '') }}|{{ e.attributes.get('friendly_name', e.entity_id) }}|{% for k in KEYS %}{% if k in e.attributes %}{{ k }}={{ e.attributes[k] }};{% endif %}{% endfor %}
{% endfor %}`;

// Speech-relevante Attribute, die im Pipe-Format mitgelesen werden (Filter
// beim Parsen; die Mitlieferung passiert im index.template-Parameter).
const RELEVANT_ATTRS = new Set([
  'current_temperature',
  'target_temperature',
  'temperature',
  'humidity',
  'brightness',
  'position',
  'battery_level',
  'unit_of_measurement',
  'friendly_name',
  'hvac_mode',
  'fan_mode',
  'device_class',
]);

function defaultConfig(): IndexConfig {
  return {
    tool: 'ha_eval_template',
    args: { template: DEFAULT_SNAPSHOT_TEMPLATE },
    ttlMs: 60_000,
    aliases: { draussen: 'aussen', drausen: 'aussen' },
    domainHints: [
      { re: /temperatur|warm|kalt|grad/, domains: ['sensor', 'climate', 'weather'] },
      { re: /feucht/, domains: ['sensor'] },
      { re: /verbrauch|leistung|energie|strom|kwh|watt/, domains: ['sensor'] },
      { re: /fullstand|zisterne|tank/, domains: ['sensor'] },
      { re: /licht|lampe|leuchte/, domains: ['light'] },
      { re: /steckdose|schalter/, domains: ['switch', 'light'] },
      { re: /rolladen|raffstore|jalousie/, domains: ['cover'] },
      { re: /thermostat|heizung|heizen/, domains: ['climate'] },
      { re: /lautsta|musik|radio|sprecher/, domains: ['media_player'] },
    ],
    stopwords: new Set([
      'wie', 'ist', 'es', 'im', 'in', 'der', 'den', 'das', 'die', 'von', 'am', 'an', 'um',
      'mein', 'meine', 'mir', 'bitte', 'sag', 'mal', 'derzeit', 'aktuell', 'aktuelle',
      'gibt', 'gib', 'den', 'dem', 'eine', 'einen', 'und', 'oder', 'für', 'mit',
    ]),
  };
}

function loadConfig(): IndexConfig {
  const cfg = defaultConfig();
  const raw = getSetting('entity_index');
  if (!raw) return cfg;
  try {
    const parsed = JSON.parse(raw) as {
      tool?: string;
      args?: Record<string, unknown>;
      template?: string; // Alt-Format (Kompatibilitaet)
      ttlMs?: number;
      aliases?: Record<string, string>;
      domainHints?: { re: string; domains: string[] }[];
      stopwords?: string[];
    };
    if (parsed.tool) cfg.tool = parsed.tool;
    if (parsed.args && typeof parsed.args === 'object') cfg.args = parsed.args;
    else if (parsed.template) cfg.args = { template: parsed.template };
    if (typeof parsed.ttlMs === 'number' && parsed.ttlMs > 0) cfg.ttlMs = parsed.ttlMs;
    if (parsed.aliases) {
      for (const [from, to] of Object.entries(parsed.aliases)) {
        cfg.aliases[fold(from)] = fold(to);
      }
    }
    if (parsed.domainHints) {
      cfg.domainHints = parsed.domainHints.map((h) => ({ re: new RegExp(h.re, 'i'), domains: h.domains }));
    }
    if (parsed.stopwords) cfg.stopwords = new Set(parsed.stopwords.map(fold));
  } catch (e) {
    console.error('entity_index-Setting ungueltig, nutze Defaults:', e);
  }
  return cfg;
}

// HA-Template-Helfer antworten mit JSON-Envelope {success, template, result,
// ...} - den Evaluierungs-Ergebnis-Text herausloesen, Rohtext durchreichen,
// falls kein Envelope kommt.
function unwrapToolText(result: unknown): string {
  const content = (result as { content?: { text?: unknown }[] })?.content;
  let text = String(result ?? '');
  if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { result?: unknown };
      if (typeof parsed.result === 'string') return parsed.result;
    } catch {
      // kein JSON-Envelope
    }
  }
  return text;
}

function parseLine(line: string): IndexEntry | null {
  const parts = line.split('|');
  if (parts.length < 6) return null;
  // Leere Felder sind gueltig (z. B. Eintraege ohne relevante Attribute haben
  // ein leeres extra-Feld) - nur voellig unvollstaendige Zeilen verwerfen.
  const id = parts[0];
  const area = parts[1] ?? '';
  const state = parts[2] ?? '';
  const unit = parts[3] ?? '';
  const name = parts[4] ?? '';
  const extra = parts[5] ?? '';
  if (!id) return null;
  const attributes: Record<string, string> = {};
  for (const pair of extra.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      if (RELEVANT_ATTRS.has(key)) attributes[key] = pair.slice(eq + 1).trim();
    }
  }
  // area_name() rendert ohne Zuordnung als Jinja-String "None"
  return { id, name, state, unit, area: area === 'None' ? '' : area, attributes };
}

let cache: { ts: number; entries: IndexEntry[] } | null = null;

export function invalidateIndex(): void {
  cache = null;
}

export async function getIndexSnapshot(force = false): Promise<IndexEntry[]> {
  const cfg = loadConfig();
  if (!force && cache && Date.now() - cache.ts < cfg.ttlMs) return cache.entries;
  const mcp = await getMcpContext();
  let result: unknown = null;
  for (const server of mcp.servers) {
    if (server.tools.some((t) => t.name === cfg.tool)) {
      result = await server.client.callTool(cfg.tool, cfg.args);
      break;
    }
  }
  if (result === null) {
    throw new Error(`Index-Tool ${cfg.tool} nicht gefunden - MCP-Server aktiv?`);
  }
  const { entries, error } = parseIndexResult(result);
  if (error) {
    throw new Error(`Index-Tool ${cfg.tool} fehlgeschlagen: ${error}`);
  }
  if (entries.length === 0) {
    throw new Error(`Index leer (${cfg.tool}): ${unwrapToolText(result).slice(0, 120)}`);
  }
  cache = { ts: Date.now(), entries };
  return entries;
}

// Parst das Ergebnis eines Index-Tool-Calls. Liefert Eintraege plus optional
// einen Tool-Fehler (JSON-Envelope mit success=false, z. B. bei Timeout).
export function parseIndexResult(result: unknown): { entries: IndexEntry[]; error: string | null } {
  const content = (result as { content?: { text?: unknown }[] })?.content;
  let text = String(result ?? '');
  if (Array.isArray(content)) {
    text = content
      .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as {
        success?: unknown;
        result?: unknown;
        error?: { message?: string } | string;
      };
      if (typeof parsed.result === 'string') {
        return { entries: splitLines(parsed.result), error: null };
      }
      if (parsed.success === false) {
        const err = parsed.error;
        const msg =
          err && typeof err === 'object' ? String(err.message ?? JSON.stringify(err)) : String(err ?? 'success=false');
        return { entries: [], error: msg.slice(0, 300) };
      }
      // Envelope ohne result/success-false: Rohtext unten versuchen
    } catch {
      // kein JSON-Envelope
    }
  }
  return { entries: splitLines(text), error: null };
}

function splitLines(text: string): IndexEntry[] {
  return text
    .split('\n')
    .map((line) => parseLine(line.trim()))
    .filter((e): e is IndexEntry => e !== null);
}

// Sprechbare Zeile (LLM- und sprachtauglich), keine JSON-Objekte.
export function fmtEntry(e: IndexEntry): string {
  const unit = e.unit ? ` ${e.unit}` : '';
  const area = e.area ? ` [${e.area}]` : '';
  const temp = e.attributes && 'current_temperature' in e.attributes ? ` (aktuell ${e.attributes.current_temperature}°C)` : '';
  return `${e.id} | ${e.name}: ${e.state}${unit}${area}${temp}`;
}

// Fuzzy-Scoring gegen den (gecachten) Index - Sprachwissen (Aliase,
// Domain-Hints, Stopwords) kommt aus der Konfiguration, nicht aus dem Code.
export function scoreEntries(entries: IndexEntry[], query: string, maxResults = 8): IndexEntry[] {
  const cfg = loadConfig();
  const stopwords = new Set([...cfg.stopwords].map(fold));
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => cfg.aliases[fold(t)] ?? fold(t))
    .filter((t) => t.length >= 2 && !stopwords.has(t));
  if (terms.length === 0) return [];
  const metricDomains = new Set<string>();
  for (const hint of cfg.domainHints) {
    if (terms.some((t) => hint.re.test(t))) {
      for (const d of hint.domains) metricDomains.add(d);
    }
  }
  const wantsTemperature = terms.some((t) => /temperatur|warm|kalt|grad/.test(t));
  const wantsHumidity = terms.some((t) => /feucht/.test(t));
  const scored: { score: number; entry: IndexEntry }[] = [];
  for (const entry of entries) {
    let score = 0;
    const nameLower = fold(entry.name);
    const nameTokens = nameLower.split(/[^a-z0-9]+/).filter(Boolean);
    const idTokens = entry.id.toLowerCase().split(/[._-]+/).filter(Boolean).map(fold);
    const areaTokens = fold(entry.area).split(/\s+/).filter(Boolean);
    for (const term of terms) {
      if (nameTokens.includes(term)) score += 3;
      else if (nameLower.includes(term)) score += 1;
      if (idTokens.includes(term)) score += 2;
      if (areaTokens.includes(term)) score += 2;
      for (const token of nameTokens) {
        if (token.length >= 4 && term.includes(token)) {
          score += 2;
          break;
        }
      }
      for (const token of idTokens) {
        if (token.length >= 4 && token.length < term.length && term.includes(token)) {
          score += 1;
          break;
        }
      }
    }
    const domain = entry.id.split('.')[0];
    if (domain && metricDomains.has(domain)) score += 2;
    if (wantsTemperature && (entry.attributes.device_class === 'temperature' || 'current_temperature' in entry.attributes)) {
      score += 4;
    }
    if (wantsTemperature && entry.id.startsWith('weather.')) score += 5;
    if (wantsHumidity && (entry.attributes.device_class === 'humidity' || 'humidity' in entry.attributes)) {
      score += 3;
    }
    if (score > 0) scored.push({ score, entry });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.entry);
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss');
}
