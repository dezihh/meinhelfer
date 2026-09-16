import { getMcpContext } from '../mcp/registry.js';

export interface HaEntity {
  entity_id: string;
  name: string;
  state: string;
  unit: string;
  area: string;
  attributes: Record<string, string>;
}

const SPEECH_RELEVANT_ATTRS = new Set([
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

const SNAPSHOT_TTL_MS = 60_000;

const TERM_ALIASES: Record<string, string> = {
  draussen: 'aussen',
  drausen: 'aussen',
};

const METRIC_DOMAIN_HINTS: { re: RegExp; domains: string[] }[] = [
  { re: /temperatur|warm|kalt|grad/, domains: ['sensor', 'climate', 'weather'] },
  { re: /feucht/, domains: ['sensor'] },
  { re: /verbrauch|leistung|energie|strom|kwh|watt/, domains: ['sensor'] },
  { re: /fullstand|zisterne|tank/, domains: ['sensor'] },
  { re: /licht|lampe|leuchte/, domains: ['light'] },
  { re: /steckdose|schalter/, domains: ['switch', 'light'] },
  { re: /rolladen|raffstore|jalousie/, domains: ['cover'] },
  { re: /thermostat|heizung|heizen/, domains: ['climate'] },
  { re: /lautsta|musik|radio|sprecher/, domains: ['media_player'] },
];

const STOPWORDS = new Set([
  'wie', 'ist', 'es', 'im', 'in', 'der', 'den', 'das', 'die', 'von', 'am', 'an', 'um',
  'mein', 'meine', 'mir', 'bitte', 'sag', 'mal', 'derzeit', 'aktuell', 'aktuelle',
  'gibt', 'gib', 'mir', 'den', 'dem', 'eine', 'einen', 'und', 'oder', 'für', 'mit',
]);

let snapshot: { ts: number; entities: HaEntity[] } | null = null;

// HA-States vollstaendig ueber MCP statt REST: Das MCP-Tool ha_eval_template
// (Community-Server ha-mcp) werte serverseitig ein Jinja-Template aus und
// liefert alle Entities kompakt als Pipe-Format zurueck
// entity_id|area|state|unit|friendly_name|key=value;... (Areas inklusive -
// ersetzt die frueheren separaten /api/states- und /api/template-REST-Calls).
const SNAPSHOT_TEMPLATE = `{%- set KEYS = ['current_temperature', 'target_temperature', 'temperature', 'humidity', 'brightness', 'position', 'battery_level', 'hvac_mode', 'fan_mode', 'device_class'] -%}
{% for e in states %}{{ e.entity_id }}|{{ area_name(e.entity_id) }}|{{ e.state }}|{{ e.attributes.get('unit_of_measurement', '') }}|{{ e.attributes.get('friendly_name', e.entity_id) }}|{% for k in KEYS %}{% if k in e.attributes %}{{ k }}={{ e.attributes[k] }};{% endif %}{% endfor %}
{% endfor %}`;

function mcpText(result: unknown): string {
  const content = (result as { content?: { text?: unknown }[] })?.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && typeof c.text === 'string' ? c.text : ''))
      .filter(Boolean)
      .join('\n');
  }
  return String(result ?? '');
}

// ha_eval_template antwortet mit JSON-Envelope {success, template, result,
// ...} - den Evaluierungs-Ergebnis-Text herausloesen, Rohtext durchreichen,
// falls kein Envelope kommt.
function unwrapToolText(result: unknown): string {
  const text = mcpText(result);
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

function parseEntityLine(line: string): HaEntity | null {
  const parts = line.split('|');
  if (parts.length < 6) return null;
  const [entityId, area, state, unit, name, extra] = parts;
  if (!entityId || !area || !state || !unit || !name || !extra) return null;
  if (!entityId.includes('.')) return null;
  const attributes: Record<string, string> = {};
  for (const pair of extra.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0) {
      const key = pair.slice(0, eq).trim();
      if (SPEECH_RELEVANT_ATTRS.has(key)) attributes[key] = pair.slice(eq + 1).trim();
    }
  }
  // area_name() rendert ohne Zuordnung als Jinja-String "None"
  return {
    entity_id: entityId,
    name,
    state,
    unit,
    area: area === 'None' ? '' : area,
    attributes,
  };
}

async function callHaTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const mcp = await getMcpContext();
  for (const server of mcp.servers) {
    if (server.tools.some((t) => t.name === name)) {
      return server.client.callTool(name, args);
    }
  }
  throw new Error(`MCP-Tool ${name} nicht gefunden - HA-MCP-Server (ha-mcp) in der MCP-Registry aktiv?`);
}

export async function getStatesSnapshot(force = false): Promise<HaEntity[]> {
  if (!force && snapshot && Date.now() - snapshot.ts < SNAPSHOT_TTL_MS) return snapshot.entities;
  const result = await callHaTool('ha_eval_template', { template: SNAPSHOT_TEMPLATE });
  const entities = unwrapToolText(result)
    .split('\n')
    .map((line) => parseEntityLine(line.trim()))
    .filter((e): e is HaEntity => e !== null);
  if (entities.length === 0) {
    throw new Error(`HA-Snapshot leer (MCP ha_eval_template): ${mcpText(result).slice(0, 120)}`);
  }
  snapshot = { ts: Date.now(), entities };
  return entities;
}

// Sync-Scoring gegen einen (gecachten) Snapshot - fuer Template-Hilfsfunktion ha.find.
export function scoreEntities(entities: HaEntity[], query: string, maxResults = 8): HaEntity[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => TERM_ALIASES[fold(t)] ?? fold(t))
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (terms.length === 0) return [];
  const metricDomains = new Set<string>();
  for (const hint of METRIC_DOMAIN_HINTS) {
    if (terms.some((t) => hint.re.test(t))) {
      for (const d of hint.domains) metricDomains.add(d);
    }
  }
  const wantsTemperature = terms.some((t) => /temperatur|warm|kalt|grad/.test(t));
  const wantsHumidity = terms.some((t) => /feucht/.test(t));
  const scored: { score: number; entity: HaEntity }[] = [];
  for (const entity of entities) {
    let score = 0;
    const nameLower = fold(entity.name);
    const nameTokens = nameLower.split(/[^a-z0-9]+/).filter(Boolean);
    const idTokens = entity.entity_id.toLowerCase().split(/[._-]+/).filter(Boolean).map(fold);
    const areaTokens = fold(entity.area).split(/\s+/).filter(Boolean);
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
    const domain = entity.entity_id.split('.')[0];
    if (domain && metricDomains.has(domain)) score += 2;
    if (wantsTemperature && (entity.attributes.device_class === 'temperature' || 'current_temperature' in entity.attributes)) {
      score += 4;
    }
    if (wantsTemperature && entity.entity_id.startsWith('weather.')) score += 5;
    if (wantsHumidity && (entity.attributes.device_class === 'humidity' || 'humidity' in entity.attributes)) {
      score += 3;
    }
    if (score > 0) scored.push({ score, entity });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map((s) => s.entity);
}

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/ü/g, 'u')
    .replace(/ß/g, 'ss');
}
