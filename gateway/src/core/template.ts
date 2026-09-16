import nunjucks from 'nunjucks';
import { exec } from 'node:child_process';
import type { McpContext } from '../mcp/registry.js';
import { getIndexSnapshot, scoreEntries, fmtEntry, type IndexEntry } from './entityIndex.js';
import { getFunctionByName } from '../db.js';
import type { AssistantResponse, TraceEvent } from '../types.js';

const env = new nunjucks.Environment(null, { autoescape: false });

// Shell-Helper: admin-only editierbar (Templates), laeuft im Gateway-Container.
// Absicherungen: Timeout + Output-Cap, damit ein haengender Befehl die
// Alexa-Antwort nicht blockiert bzw. den Prompt sprengt.
const SHELL_TIMEOUT_MS = 5000;
const SHELL_OUTPUT_CAP = 4000;

interface LiteralCalls {
  states: string[];
  calls: { tool: string; args: string | null }[];
  shells: string[];
  fns: string[];
  httpUrls: string[];
}

function extractLiterals(template: string): LiteralCalls {
  const states: string[] = [];
  const calls: { tool: string; args: string | null }[] = [];
  const shells: string[] = [];
  const fns: string[] = [];
  const httpUrls: string[] = [];
  for (const m of template.matchAll(/index\.state\(\s*["']([^"']+)["']\s*\)/g)) states.push(m[1] as string);
  // mcp.call('tool') bzw. mcp.call('tool', {flaches JSON-Literal, eine Zeile})
  for (const m of template.matchAll(/mcp\.call\(\s*["']([^"']+)["']\s*(?:,\s*(\{[^\n]*?\}))?\s*\)/g)) {
    calls.push({ tool: m[1] as string, args: (m[2] as string | undefined) ?? null });
  }
  for (const m of template.matchAll(/shell\(\s*["']([^"']+)["']\s*\)/g)) shells.push(m[1] as string);
  for (const m of template.matchAll(/fn\(\s*["']([a-zA-Z0-9_]+)["']\s*\)/g)) fns.push(m[1] as string);
  for (const m of template.matchAll(/http\(\s*["']([^"']+)["']\s*\)/g)) httpUrls.push(m[1] as string);
  return { states, calls, shells, fns, httpUrls };
}

// HTTP-Baustein: generischer GET-Fetch fuer beliebige REST-Endpunkte.
// Absicherungen: Timeout + Groessencap; JSON wird automatisch geparst,
// damit Templates direkt auf Felder zugreifen koennen.
const HTTP_TIMEOUT_MS = 5000;
const HTTP_BODY_CAP = 100_000;

async function fetchUrl(url: string, trace: TraceEvent[]): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const raw = (await res.text()).slice(0, HTTP_BODY_CAP);
    if (!res.ok) {
      trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url, status: res.status, body: raw.slice(0, 200) } });
      return null;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.http.error', detail: { url, error: String(e) } });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Verschachtelungstiefe fuer fn()-Aufrufe; verhindert Zyklen und Runaways.
const FN_MAX_DEPTH = 3;

function runShell(cmd: string, trace: TraceEvent[]): Promise<string | null> {
  return new Promise((resolve) => {
    exec(
      cmd,
      { timeout: SHELL_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          trace.push({
            ts: Date.now(),
            step: 'template.shell.error',
            detail: { cmd, error: String(err.message).slice(0, 300), stderr: String(stderr).slice(0, 300) },
          });
          return resolve(null);
        }
        const out = `${stdout}`.trim().slice(0, SHELL_OUTPUT_CAP);
        trace.push({ ts: Date.now(), step: 'template.shell', detail: { cmd, chars: out.length } });
        resolve(out);
      }
    );
  });
}

function findToolExact(
  mcp: McpContext,
  toolName: string
): { server: McpContext['servers'][number]; toolName: string } | undefined {
  for (const server of mcp.servers) {
    const tool = server.tools.find((t) => t.name === toolName);
    if (tool) return { server, toolName: tool.name };
  }
  return undefined;
}

// mcp.call-Args: flaches JSON-Literal im Template; einzelne Anfuehrungs-
// striche (Jinja-Stil) werden tolerant auf doppelte gemappt.
function parseCallArgs(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  for (const candidate of [raw, raw.replace(/'/g, '"')]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // naechste Variante
    }
  }
  return null;
}

function extractText(result: unknown): string {
  if (result && typeof result === 'object') {
    const content = (result as { content?: unknown }).content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : ''))
        .filter(Boolean)
        .join('\n');
    }
    return JSON.stringify(result);
  }
  return String(result ?? '');
}

interface UnwrappedSpeech {
  text: string;
  ssml: boolean;
}

function unwrapSpeech(value: unknown): UnwrappedSpeech | null {
  if (typeof value === 'string') return { text: value, ssml: false };
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const ssml = obj.ssml;
    if (typeof ssml === 'string') return { text: ssml, ssml: true };
    if (ssml && typeof ssml === 'object') {
      const inner = (ssml as Record<string, unknown>).speech;
      if (typeof inner === 'string') return { text: inner, ssml: true };
    }
    if (typeof obj.speech === 'string') return { text: obj.speech, ssml: false };
  }
  return null;
}

async function preheat(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[],
  depth: number,
  active: Set<string>,
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const { states, calls, shells, fns, httpUrls } = extractLiterals(template);
  const stateMap = new Map<string, string | null>();
  const callMap = new Map<string, string | null>();
  const shellMap = new Map<string, string | null>();
  const fnMap = new Map<string, string | null>();
  const httpMap = new Map<string, unknown | null>();

  // HTTP-URLs parallel laden (dedupliziert)
  await Promise.all(
    httpUrls.map(async (url) => {
      if (httpMap.has(url)) return;
      httpMap.set(url, await fetchUrl(url, trace));
      trace.push({ ts: Date.now(), step: 'template.http', detail: { url } });
    })
  );

  // Entity-Index vorwaermen (TTL-Cache) - Basis fuer index.find/index.get/index.state.
  let snapshot: IndexEntry[] = [];
  try {
    snapshot = await getIndexSnapshot();
  } catch (e) {
    trace.push({ ts: Date.now(), step: 'template.index.error', detail: { error: String(e) } });
  }
  const indexFind = (query: string): string => {
    if (snapshot.length === 0) return 'Entity-Index nicht verfuegbar';
    const hits = scoreEntries(snapshot, String(query ?? ''), 8).map(fmtEntry);
    return hits.length > 0 ? hits.join('\n') : 'keine Treffer';
  };
  const indexGet = (entityId: string): string => {
    const found = snapshot.find((e) => e.id === entityId);
    return found ? fmtEntry(found) : `${entityId}: unbekannt`;
  };

  for (const name of fns) {
    if (fnMap.has(name)) continue;
    if (active.has(name) || depth >= FN_MAX_DEPTH) {
      trace.push({
        ts: Date.now(),
        step: 'fn.error',
        detail: { name, reason: active.has(name) ? 'zyklus' : `tiefe > ${FN_MAX_DEPTH}` },
      });
      fnMap.set(name, null);
      continue;
    }
    const row = getFunctionByName(name);
    if (!row) {
      trace.push({ ts: Date.now(), step: 'fn.error', detail: { name, reason: 'unbekannt oder inaktiv' } });
      fnMap.set(name, null);
      continue;
    }
    try {
      active.add(name);
      const rendered = await renderPlain(row.template, mcp, trace, depth + 1, active);
      active.delete(name);
      fnMap.set(name, rendered);
      trace.push({ ts: Date.now(), step: 'fn.render', detail: { name, chars: rendered.length } });
    } catch (e) {
      active.delete(name);
      trace.push({ ts: Date.now(), step: 'fn.error', detail: { name, error: String(e) } });
      fnMap.set(name, null);
    }
  }

  for (const call of calls) {
    // Normalisierter Key (geparste Args) = Lookup-Schluessel im Template-ctx;
    // identische Aufrufe mit gleichem Tool+Args werden dedupliziert.
    const parsedArgs = parseCallArgs(call.args);
    const normKey = `${call.tool}|${parsedArgs ? JSON.stringify(parsedArgs) : ''}`;
    if (callMap.has(normKey)) continue;
    try {
      const found = findToolExact(mcp, call.tool);
      if (!found) throw new Error(`Tool ${call.tool} auf keinem MCP-Server gefunden`);
      const result = await found.server.client.callTool(found.toolName, parsedArgs ?? {});
      callMap.set(normKey, extractText(result));
      trace.push({ ts: Date.now(), step: 'template.mcp', detail: { tool: call.tool, server: found.server.name } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.error', detail: { tool: call.tool, error: String(e) } });
      callMap.set(normKey, null);
    }
  }

  for (const entityId of states) {
    if (stateMap.has(entityId)) continue;
    try {
      const entity = snapshot.find((e) => e.id === entityId);
      if (!entity) throw new Error(`Entity ${entityId} nicht gefunden`);
      stateMap.set(entityId, entity.state);
      trace.push({ ts: Date.now(), step: 'template.state', detail: { entityId } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.state.error', detail: { entityId, error: String(e) } });
      stateMap.set(entityId, null);
    }
  }

  for (const cmd of shells) {
    if (shellMap.has(cmd)) continue;
    shellMap.set(cmd, await runShell(cmd, trace));
  }

  return {
    args,
    index: {
      state: (entityId: string): string | null => stateMap.get(entityId) ?? null,
      get: (entityId: string): string => indexGet(entityId),
      find: (query: string): string => indexFind(String(query ?? '')),
    },
    mcp: {
      // Bewusst Objekt (nicht Funktion): mcp.call(...) im Template wuerde
      // sonst Function.prototype.call statt der Lookup-Funktion aufrufen.
      call: (tool: string, callArgs?: Record<string, unknown>): string | null =>
        callMap.get(`${tool}|${callArgs ? JSON.stringify(callArgs) : ''}`) ?? null,
    },
    shell: (cmd: string): string | null => shellMap.get(cmd) ?? null,
    fn: (name: string): string | null => fnMap.get(name) ?? null,
    http: (url: string): unknown | null => httpMap.get(url) ?? null,
    now: (() => {
      const d = new Date();
      return { hour: d.getHours(), weekday: d.toLocaleDateString('de-DE', { weekday: 'long' }), date: d.toLocaleDateString('de-DE'), time: d.toTimeString().slice(0, 5) };
    })(),
  };
}

async function renderPlain(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[],
  depth: number,
  active: Set<string>,
  args: Record<string, unknown> = {}
): Promise<string> {
  const ctx = await preheat(template, mcp, trace, depth, active, args);
  return env.renderString(template, ctx).trim();
}

// Rendert eine Funktion aus der Registry (function_ref am Vorgang oder
// als LLM-Tool-Aufruf mit Argumenten, die als args zur Verfuegung stehen).
export async function renderFunction(
  name: string,
  mcp: McpContext,
  trace: TraceEvent[],
  args: Record<string, unknown> = {}
): Promise<AssistantResponse> {
  const row = getFunctionByName(name);
  if (!row) throw new Error(`Funktion ${name} nicht gefunden oder inaktiv`);
  return renderActionTemplate(row.template, mcp, trace, args);
}

export async function renderActionTemplate(
  template: string,
  mcp: McpContext,
  trace: TraceEvent[],
  args: Record<string, unknown> = {}
): Promise<AssistantResponse> {
  const out = await renderPlain(template, mcp, trace, 0, new Set(), args);  if (/^<speak[\s>]/i.test(out)) {
    return { speech: out, ssml: true };
  }
  if (out.startsWith('{')) {
    try {
      const parsed = JSON.parse(out) as { speech?: unknown; display?: AssistantResponse['display'] };
      const unwrapped = unwrapSpeech(parsed.speech);
      if (unwrapped) {
        return {
          speech: unwrapped.text,
          ...(unwrapped.ssml ? { ssml: true } : {}),
          ...(parsed.display ? { display: parsed.display } : {}),
        };
      }
    } catch {
      return { speech: out };
    }
  }
  return { speech: out };
}
