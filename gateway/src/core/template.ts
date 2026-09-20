import nunjucks from 'nunjucks';
import { exec } from 'node:child_process';
import type { McpContext } from '../mcp/registry.js';
import { getIndexSnapshot, scoreEntries, fmtEntry, type IndexEntry } from './entityIndex.js';
import { getFunctionByName, getSettingNum } from '../db.js';
import type { AssistantResponse, TraceEvent } from '../types.js';

const env = new nunjucks.Environment(null, { autoescape: false });

// Shell-Helper: admin-only editierbar (Templates), laeuft im Gateway-Container.
// Absicherungen: Timeout + Output-Cap, damit ein haengender Befehl die
// Alexa-Antwort nicht blockiert bzw. den Prompt sprengt.
const SHELL_TIMEOUT_MS = 5000;
const SHELL_OUTPUT_CAP = 4000;

interface LiteralCalls {
  usesIndex: boolean;
  // index.state('id') bzw. index.state('id', 'indexKey')
  states: { id: string; key: string }[];
  // Alle in index.*-Aufrufen genutzten Index-Keys ('' = Default-Index)
  indexKeys: string[];
  calls: { tool: string; args: string | null }[];
  // mcp.call('tool', {…args.x…}) - Args-Expression wird im preheat evaluiert
  mcpCallDyn: { tool: string; expr: string }[];
  // http('url') bzw. http('url', ttlMs) - ttl > 0 aktiviert den Antwort-Cache
  httpCalls: { url: string; ttl: number }[];
  // http(<nunjucks-Expression>) - URL wird aus args/now berechnet (Finding #1)
  httpDyn: { expr: string; ttl: number }[];
  shells: string[];
  fns: string[];
  httpUrls: string[];
}

function extractLiterals(template: string): LiteralCalls {
  // 2. String-Arg eines index.*-Aufrufs = Index-Key ('' = Default-Index).
  const indexKeys = new Set<string>();
  for (const m of template.matchAll(
    /index\.(?:state|get|find)\(\s*(?:"[^"]*"|'[^']*')(?:\s*,\s*["']([^"']+)["']\s*)?\)/g
  )) {
    indexKeys.add((m[1] as string | undefined) ?? '');
  }
  // Dynamische Args (z. B. index.find(args.query) in fn-Templates): sonst
  // bleibt usesIndex false und der Agent-Pfad rendert ohne vorgewaermten
  // Index ("Entity-Index nicht verfuegbar"). Key aus 2. Literal-Arg.
  for (const m of template.matchAll(
    /index\.(?:state|get|find)\(\s*args\.[a-zA-Z0-9_]+\s*(?:,\s*["']([^"']+)["'])?\s*\)/g
  )) {
    indexKeys.add((m[1] as string | undefined) ?? '');
  }
  const states: { id: string; key: string }[] = [];
  for (const m of template.matchAll(
    /index\.state\(\s*["']([^"']+)["']\s*(?:,\s*["']([^"']+)["']\s*)?\)/g
  )) {
    states.push({ id: m[1] as string, key: (m[2] as string | undefined) ?? '' });
    if ((m[2] as string | undefined) !== undefined) indexKeys.add(m[2] as string);
  }
  const usesIndex = indexKeys.size > 0;
  const calls: { tool: string; args: string | null }[] = [];
  const mcpCallDyn: { tool: string; expr: string }[] = [];
  const shells: string[] = [];
  const fns: string[] = [];
  const httpCalls: { url: string; ttl: number }[] = [];
  const httpDyn: { expr: string; ttl: number }[] = [];
  // mcp.call('tool') bzw. mcp.call('tool', {flaches JSON-Literal, eine Zeile});
  // Literal-Args mit args./now. sind NICHT literal (die laufen als dynamisch).
  for (const m of template.matchAll(/mcp\.call\(\s*["']([^"']+)["']\s*(?:,\s*(\{(?![^{}]*\b(?:args|now)\.)[^\n]*?\}))?\s*\)/g)) {
    calls.push({ tool: m[1] as string, args: (m[2] as string | undefined) ?? null });
  }
  // dynamische mcp.call-Args: {…args.x…} (keine verschachtelten Objekte)
  for (const m of template.matchAll(/mcp\.call\(\s*["']([^"']+)["']\s*,\s*\{([^{}]*?(?:\bargs\.|\bnow\.)[^{}]*?)\}\s*\)/g)) {
    mcpCallDyn.push({ tool: m[1] as string, expr: `{${m[2] as string}}` });
  }
  for (const m of template.matchAll(/shell\(\s*["']([^"']+)["']\s*\)/g)) shells.push(m[1] as string);
  for (const m of template.matchAll(/fn\(\s*["']([a-zA-Z0-9_]+)["']\s*\)/g)) fns.push(m[1] as string);
  // http(...): Inneres je Call extrahieren (eine Klammerebene toleriert),
  // danach reines Literal (optional mit TTL) -> httpCalls; alles andere
  // (Konkatenation mit args/now) -> dynamische Expression.
  for (const m of template.matchAll(/http\(\s*((?:[^()]|\([^()]*\))*?)\s*\)/g)) {
    const inner = (m[1] as string).trim();
    if (!inner) continue;
    const lm = /^["']([^"']*)["']\s*(?:,\s*(\d+)\s*)?$/.exec(inner);
    if (lm) {
      httpCalls.push({ url: lm[1] as string, ttl: lm[2] ? Number(lm[2]) : 0 });
      continue;
    }
    let body = inner;
    let ttl = 0;
    const tm = /,\s*(\d+)\s*$/.exec(inner);
    if (tm) {
      ttl = Number(tm[1]);
      body = inner.slice(0, tm.index).trim();
    }
    httpDyn.push({ expr: body, ttl });
  }
  const httpUrls = httpCalls.map((c) => c.url);
  return { usesIndex, states, indexKeys: [...indexKeys], calls, mcpCallDyn, httpCalls, httpDyn, shells, fns, httpUrls };
}

// HTTP-Baustein: generischer GET-Fetch fuer beliebige REST-Endpunkte.
// Absicherungen: Timeout + Groessencap; JSON wird automatisch geparst,
// damit Templates direkt auf Felder zugreifen koennen.
export const HTTP_TIMEOUT_MS = 5000;
export const HTTP_BODY_CAP = 100_000;

// Antwort-Cache fuer http-Calls mit TTL-Argument (http('url', ttlMs));
// lebt im Prozess und pro URL. Ohne TTL-Argument wird nie gecacht.
const HTTP_CACHE = new Map<string, { ts: number; ttl: number; data: unknown }>();

async function fetchUrl(url: string, trace: TraceEvent[]): Promise<unknown | null> {
  const timeoutMs = getSettingNum('http_timeout_ms', HTTP_TIMEOUT_MS);
  const bodyCap = getSettingNum('http_body_cap', HTTP_BODY_CAP);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const raw = (await res.text()).slice(0, bodyCap);
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
  const { usesIndex, states, indexKeys, calls, mcpCallDyn, httpCalls, httpDyn, shells, fns, httpUrls } = extractLiterals(template);
  const stateMap = new Map<string, string | null>();
  const callMap = new Map<string, string | null>();
  const shellMap = new Map<string, string | null>();
  const fnMap = new Map<string, string | null>();
  const httpMap = new Map<string, unknown | null>();

  // HTTP-Cache (Finding #7): nur aktiv, wenn der Call eine TTL > 0 mitgibt
  // (http('url', 300000)). Cache lebt pro URL im Prozess, laeuft mit eigener TTL ab.
  const fetchCached = async (url: string, ttl: number): Promise<unknown | null> => {
    if (ttl > 0) {
      const hit = HTTP_CACHE.get(url);
      if (hit && Date.now() - hit.ts < hit.ttl) {
        trace.push({ ts: Date.now(), step: 'template.http.cache', detail: { url } });
        return hit.data;
      }
    }
    const data = await fetchUrl(url, trace);
    if (ttl > 0 && data !== null) HTTP_CACHE.set(url, { ts: Date.now(), ttl, data });
    return data;
  };

  // HTTP-URLs parallel laden (dedupliziert); dynamische Expressionen werden
  // zuerst mit args/now zu einer URL aufgeloest (Finding #1) und dann normal
  // gecacht/geholt. Ausdruck und Ergebnis-URL stimmen zur Render-Zeit wieder
  // ueberein, weil args innerhalb eines Renders konstant sind.
  const nowCtx = {
    hour: new Date().getHours(),
    weekday: new Date().toLocaleDateString('de-DE', { weekday: 'long' }),
    date: new Date().toLocaleDateString('de-DE'),
    time: new Date().toTimeString().slice(0, 5),
  };
  const dynUrls = await Promise.all(
    httpDyn.map(async (d) => {
      try {
        const url = env.renderString(`{{ ${d.expr} }}`, { args, now: nowCtx }).trim();
        return /^https?:\/\//.test(url) ? { url, ttl: d.ttl } : null;
      } catch (e) {
        trace.push({ ts: Date.now(), step: 'template.http.expr.error', detail: { expr: d.expr, error: String(e).slice(0, 200) } });
        return null;
      }
    })
  );
  const httpJobs: { url: string; ttl: number }[] = [...httpCalls, ...dynUrls.filter((d): d is { url: string; ttl: number } => d !== null)];
  await Promise.all(
    httpJobs.map(async (job) => {
      if (httpMap.has(job.url)) return;
      httpMap.set(job.url, await fetchCached(job.url, job.ttl));
      trace.push({ ts: Date.now(), step: 'template.http', detail: { url: job.url } });
    })
  );

  // Entity-Index(e) nur bei Bedarf vorwaermen - Basis fuer index.find/index.get/index.state.
  // Mehrere Keys parallel (Multi-Index: '' = Default, z. B. 'ma' = Music Assistant).
  const snapshotFor = new Map<string, IndexEntry[]>();
  if (usesIndex) {
    await Promise.all(
      indexKeys.map(async (key) => {
        try {
          snapshotFor.set(key, await getIndexSnapshot(key));
        } catch (e) {
          trace.push({ ts: Date.now(), step: 'template.index.error', detail: { index: key, error: String(e) } });
          snapshotFor.set(key, []);
        }
      })
    );
  }
  const indexFind = (query: string, key = ''): string => {
    const snapshot = snapshotFor.get(key) ?? [];
    if (snapshot.length === 0) return 'Entity-Index nicht verfuegbar';
    const hits = scoreEntries(snapshot, String(query ?? ''), 8, key).map(fmtEntry);
    return hits.length > 0 ? hits.join('\n') : 'keine Treffer';
  };
  const indexGet = (entityId: string, key = ''): string => {
    const snapshot = snapshotFor.get(key) ?? [];
    if (snapshot.length === 0) return 'Entity-Index nicht verfuegbar';
    const found = snapshot.find((e) => e.id === entityId);
    return found ? fmtEntry(found) : `${entityId}: nicht im Index (ID ungueltig) - nutze fn_find_entities mit dem Namen, statt IDs zu raten`;
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

  // Dynamische mcp.call-Args (Finding #1-Parallele fuer mcp): die
  // Args-Expression wird mit args/now zu einem JSON-Objekt evaluiert
  // (nunjucks '| dump'), live gecallt und unter dem normalisierten Key
  // gecacht - der Render lookup trifft denselben Key.
  for (const dyn of mcpCallDyn) {
    let parsedArgs: Record<string, unknown> | null = null;
    try {
      const json = env.renderString(`{{ (${dyn.expr}) | dump }}`, { args, now: nowCtx }).trim();
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedArgs = parsed as Record<string, unknown>;
      }
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.expr.error', detail: { tool: dyn.tool, error: String(e).slice(0, 200) } });
      continue;
    }
    if (!parsedArgs) continue;
    const normKey = `${dyn.tool}|${JSON.stringify(parsedArgs)}`;
    if (callMap.has(normKey)) continue;
    try {
      const found = findToolExact(mcp, dyn.tool);
      if (!found) throw new Error(`Tool ${dyn.tool} auf keinem MCP-Server gefunden`);
      const result = await found.server.client.callTool(found.toolName, parsedArgs);
      callMap.set(normKey, extractText(result));
      trace.push({ ts: Date.now(), step: 'template.mcp.dyn', detail: { tool: dyn.tool, server: found.server.name } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.mcp.error', detail: { tool: dyn.tool, error: String(e) } });
      callMap.set(normKey, null);
    }
  }

  for (const { id, key } of states) {
    const mapKey = `${key}\u0000${id}`;
    if (stateMap.has(mapKey)) continue;
    try {
      const entity = snapshotFor.get(key)?.find((e) => e.id === id);
      if (!entity) throw new Error(`Entity ${id} nicht gefunden (Index ${key || 'default'})`);
      stateMap.set(mapKey, entity.state);
      trace.push({ ts: Date.now(), step: 'template.state', detail: { entityId: id, index: key } });
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'template.state.error', detail: { entityId: id, index: key, error: String(e) } });
      stateMap.set(mapKey, null);
    }
  }

  for (const cmd of shells) {
    if (shellMap.has(cmd)) continue;
    shellMap.set(cmd, await runShell(cmd, trace));
  }

  return {
    args,
    index: {
      // 2. Argument = Index-Key ('' = Default-Index, z. B. 'ma' = Music Assistant)
      state: (entityId: string, key = ''): string | null => stateMap.get(`${key ?? ''}\u0000${entityId}`) ?? null,
      get: (entityId: string, key = ''): string => indexGet(entityId, key ?? ''),
      find: (query: string, key = ''): string => indexFind(String(query ?? ''), key ?? ''),
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
