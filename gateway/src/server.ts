import express, { type Request, type Response } from 'express';
import { join } from 'node:path';
import { config } from './config.js';
import { requireAuth, createSession, sessionValid, cookieFor } from './auth.js';
import { verifyAlexaSignature } from './alexa-verify.js';
import { processQuery } from './core/engine.js';
import { chatCompletion } from './llm/client.js';
import { fromAssistantResponse, toVoiceQuery } from './adapters/alexa.js';
import { invalidateMcpCache, createClient } from './mcp/registry.js';
import type { ActionMode, TraceEvent } from './types.js';
import {
  createAction,
  createMcpServer,
  deleteAction,
  deleteFunction,
  deleteMcpServer,
  deleteSetting,
  getAction,
  getFunction,
  getMcpServer,
  getSettings,
  listActions,
  listFunctions,
  createFunction,
  listLogs,
  listMcpServers,
  listPrompts,
  setPrompt,
  setSetting,
  summarizeUsage,
  updateAction,
  updateFunction,
  updateMcpServer,
  addLog,
  getSetting,
  getSettingNum,
  type ActionInput,
  type FunctionInput,
  type McpServerInput,
} from './db.js';
import { getMcpContext } from './mcp/registry.js';
import { HTTP_BODY_CAP, HTTP_TIMEOUT_MS, renderActionTemplate } from './core/template.js';
import { assistIndex, applyDraft } from './core/indexAssistant.js';

const app = express();
app.use(
  express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Buffer }).rawBody = buf;
    },
  })
);

function normalizeActionInput(body: Record<string, unknown>): ActionInput {
  const mode = String(body.mode ?? '');
  if (mode !== 'deterministic' && mode !== 'llm' && mode !== 'hybrid') {
    throw new Error(`Ungültiger Modus: ${mode}`);
  }
  // Akzeptiert raw- (trigger_phrases/tools) UND geparste Felder (triggers/toolList),
  // damit ein PUT mit dem Bootstrap-Body keine Trigger leert (Finding #12).
  // Auch JSON-Strings von der GET-API werden geparst.
  const parseMaybeJsonArray = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v === 'string') {
      try {
        const parsed = JSON.parse(v) as unknown;
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        /* kein JSON - ignorieren */
      }
    }
    return null;
  };
  const triggers = parseMaybeJsonArray(body.trigger_phrases)
    ?? parseMaybeJsonArray(body.triggers)
    ?? [];
  const tools = parseMaybeJsonArray(body.tools)
    ?? parseMaybeJsonArray(body.toolList);
  const functionArgs =
    body.function_args && typeof body.function_args === 'object' && !Array.isArray(body.function_args)
      ? JSON.stringify(body.function_args)
      : null;
  return {
    name: String(body.name ?? '').trim(),
    mode: mode as ActionMode,
    trigger_phrases: JSON.stringify(triggers),
    fuzzy_threshold: body.fuzzy_threshold == null ? null : Number(body.fuzzy_threshold),
    system_prompt: body.system_prompt == null ? null : String(body.system_prompt),
    template: body.template == null ? null : String(body.template),
    function_ref: body.function_ref == null ? null : String(body.function_ref).trim() || null,
    function_args: functionArgs,
    // Explizit leeres Array '[]' = bewusst OHNE Tools (z. B. Hilfe-Action);
    // null (Feld fehlt) = unveraendert/alle Tools.
    tools: tools ? JSON.stringify(tools) : null,
    enabled: body.enabled === false ? 0 : 1,
  };
}

function normalizeFunctionInput(body: Record<string, unknown>): FunctionInput {
  const name = String(body.name ?? '').trim();
  if (!/^[a-z0-9_]{2,40}$/.test(name)) {
    throw new Error('Name: 2-40 Zeichen, nur a-z, 0-9, _');
  }
  const template = String(body.template ?? '').trim();
  if (!template) throw new Error('Template fehlt');
  let parameters: string | null = null;
  if (body.parameters != null && typeof body.parameters === 'object') {
    parameters = JSON.stringify(body.parameters);
  }
  let budget: number | null = null;
  if (body.budget != null && Number.isFinite(Number(body.budget))) {
    const b = Math.floor(Number(body.budget));
    budget = b > 0 ? b : null;
  }
  return {
    name,
    description: body.description == null ? null : String(body.description).trim() || null,
    template,
    parameters,
    budget,
    enabled: body.enabled === false ? 0 : 1,
  };
}

function normalizeServerInput(body: Record<string, unknown>): McpServerInput {
  const name = String(body.name ?? '').trim();
  const transport = body.transport === 'stdio' ? 'stdio' : 'http';
  let url = String(body.url ?? '').trim();
  let command: string | null = null;
  let args: string | null = null;
  let env: string | null = null;
  if (transport === 'stdio') {
    command = String(body.command ?? '').trim();
    if (!command) throw new Error('command ist für Transport stdio erforderlich');
    if (!name) throw new Error('name ist erforderlich');
    url = '';
    const argsList = Array.isArray(body.args)
      ? (body.args as unknown[]).map(String)
      : String(body.args ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
    args = JSON.stringify(argsList);
    const envObj: Record<string, string> = {};
    const envRaw = body.env;
    const entries: [string, string][] =
      envRaw && typeof envRaw === 'object' && !Array.isArray(envRaw)
        ? Object.entries(envRaw as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        : String(envRaw ?? '')
            .split('\n')
            .map((line) => {
              const i = line.indexOf('=');
              return i > 0 ? ([line.slice(0, i).trim(), line.slice(i + 1).trim()] as [string, string]) : null;
            })
            .filter((e): e is [string, string] => e !== null);
    for (const [k, v] of entries) if (k) envObj[k] = v;
    env = JSON.stringify(envObj);
  } else if (!url || !name) {
    throw new Error('name und url sind erforderlich');
  }
  return {
    name,
    url,
    auth_token: body.auth_token ? String(body.auth_token) : null,
    transport,
    command,
    args,
    env,
    enabled: body.enabled === false ? 0 : 1,
  };
}

const WARTETON_PHRASE = 'Einen Moment, ich schaue das kurz nach.';
const ALEXA_WELCOME = 'Hallo, ich bin Ihr Voice-Assistent. Was kann ich für Sie tun?';
const ALEXA_HELP =
  'Sie können mich zum Beispiel nach dem Hausstatus oder nach aktuellen Nachrichten fragen.';
const ALEXA_GOODBYE = 'Bis zum nächsten Mal.';
const ALEXA_FALLBACK =
  'Entschuldigung, das habe ich nicht verstanden. Versuchen Sie zum Beispiel: was ist der Hausstatus.';

async function sendProgressiveDirective(
  apiAccessToken: string,
  requestId: string
): Promise<void> {
  try {
    await fetch(`${config.alexaDirectivesBase}/v1/directives`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        directive: {
          header: { requestId },
          directive: { type: 'VoicePlayer.Speak', speech: WARTETON_PHRASE },
        },
      }),
    });
  } catch (e) {
    console.error('Progressive Directive fehlgeschlagen:', e);
  }
}

app.get('/privacy', (req, res) => {
  res
    .type('html')
    .send(
      '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Datenschutz – Voice Assist</title></head><body><h1>Datenschutz – Voice Assist</h1><p>Der Skill &bdquo;Voice Assist&ldquo; verarbeitet Sprachanfragen ausschlie&szlig;lich zur Beantwortung der Anfrage. Es werden keine Sprachdaten dauerhaft gespeichert und keine Daten an Dritte weitergegeben. Der Betrieb erfolgt privat im eigenen Netzwerk des Betreibers.</p><p>Bei Fragen wenden Sie sich an den Betreiber des Skills.</p></body></html>'
    );
});

app.post('/alexa', requireAuth, async (req, res) => {
  const body = req.body as {
    context?: {
      System?: { application?: { applicationId?: string }; apiAccessToken?: string };
    };
    session?: { application?: { applicationId?: string }; sessionId?: string };
    request?: { requestId?: string; type?: string; intent?: { name?: string } };
  };
  const appId =
    body.context?.System?.application?.applicationId ??
    body.session?.application?.applicationId;
  const appIdSource = body.context?.System?.application?.applicationId
    ? 'context'
    : body.session?.application?.applicationId
      ? 'session'
      : 'fehlt';
  const reqType = body.request?.type ?? '';
  const intentName =
    (body.request as { intent?: { name?: string } } | undefined)?.intent?.name ?? '';

  let sigState = 'off';
  if (config.alexaVerifyMode !== 'off') {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const result = await verifyAlexaSignature(
      raw,
      req.headers['signature'] as string | undefined,
      req.headers['signaturecertchainurl'] as string | undefined,
      (body.request as { timestamp?: string } | undefined)?.timestamp
    );
    sigState = result.ok ? 'ok' : `invalid:${result.reason}`.slice(0, 80);
  }

  if (getSetting('debug_logging') === '1') {
    addLog({
      sessionId: body.session?.sessionId ?? 'alexa',
      query: JSON.stringify({
        type: reqType,
        intent: intentName,
        appId: appId ? appId.slice(0, 30) : 'fehlt',
        appIdSource,
        skillMatch: appId === config.alexaSkillId,
        sig: sigState,
      }),
      route: `alexa:${reqType || intentName || '?'}`,
      response: '',
      durationMs: 0,
      trace: [],
    });
  }

  if (config.alexaSkillId && appId !== config.alexaSkillId) {
    res.status(403).json({ reason: 'Unerwartete applicationId' });
    return;
  }

  if (sigState.startsWith('invalid') && config.alexaVerifyMode === 'enforce') {
    res.status(401).json({ reason: 'ungueltige Alexa-Signatur' });
    return;
  }
  if (sigState.startsWith('invalid')) {
    console.warn(`Alexa-Signaturpruefung: ${sigState} (warn-Modus, Request zugelassen)`);
  }

  // Fast-Paths: einfache Requests ohne Engine-Aufruf (kein LLM-Turn, keine Kosten)
  if (reqType === 'SessionEndedRequest') {
    res.json({ version: '1.0', response: {} });
    return;
  }
  const fast =
    reqType === 'LaunchRequest'
      ? { speech: ALEXA_WELCOME, end: false }
      : intentName === 'AMAZON.HelpIntent'
        ? { speech: ALEXA_HELP, end: false }
        : intentName === 'AMAZON.StopIntent' || intentName === 'AMAZON.CancelIntent'
          ? { speech: ALEXA_GOODBYE, end: true }
          : intentName === 'AMAZON.FallbackIntent' || intentName === 'FallbackIntent'
            ? { speech: ALEXA_FALLBACK, end: false }
            : undefined;
  if (fast) {
    res.json(fromAssistantResponse({ speech: fast.speech, followUp: !fast.end }));
    return;
  }

  let watchdog: ReturnType<typeof setTimeout> | undefined;
  if (body.request?.type === 'IntentRequest' && body.context?.System?.apiAccessToken && body.request.requestId) {
    const progressAfter = getSettingNum('alexa_progress_after_ms', 6500);
    if (progressAfter > 0) {
      watchdog = setTimeout(
        () =>
          sendProgressiveDirective(
            body.context!.System!.apiAccessToken!,
            body.request!.requestId!
          ),
        progressAfter
      );
    }
  }

  try {
    const query = toVoiceQuery(req.body as Record<string, never>);
    if (!query.text || query.text.trim().length === 0) {
      if (getSetting('debug_logging') === '1') {
        addLog({
          sessionId: query.sessionId,
          query: '',
          route: 'alexa:empty',
          response: ALEXA_FALLBACK,
          durationMs: 0,
          trace: [],
        });
      }
      res.json(fromAssistantResponse({ speech: ALEXA_FALLBACK, followUp: true }));
      return;
    }
    const result = await processQuery(query);
    res.json(fromAssistantResponse(result.response));
  } catch (e) {
    console.error('Alexa-Verarbeitung fehlgeschlagen:', e);
    res.json(fromAssistantResponse({ speech: 'Entschuldigung, da ist etwas schiefgelaufen.' }));
  } finally {
    if (watchdog) clearTimeout(watchdog);
  }
});

const handleQuery = async (req: Request, res: Response): Promise<void> => {
  const body = req.body as { sessionId?: string; userId?: string; text?: string };
  if (!body.text) {
    res.status(400).json({ error: 'text erforderlich' });
    return;
  }
  const result = await processQuery({
    sessionId: body.sessionId ?? 'api-test',
    userId: body.userId,
    text: body.text,
  });
  res.json(result);
};

app.post('/api/query', requireAuth, handleQuery);
app.post('/admin/api/query', requireAuth, handleQuery);

const handleLambdaTrace = (req: Request, res: Response) => {
  const body = req.body as { sessionId?: string; event?: string; elapsedMs?: number; note?: string };
  if (getSetting('debug_logging') === '1') {
    addLog({
      sessionId: body.sessionId ?? 'lambda',
      query: JSON.stringify(body),
      route: `lambda-trace:${body.event ?? '?'}`,
      response: '',
      durationMs: Number(body.elapsedMs ?? 0),
      trace: [],
    });
  }
  res.status(204).end();
};
// Unter /api (nicht /admin): die LAN-only-Regel des Nginx-Vhosts blockiert sonst AWS-Lambda-IPs (403).
app.post('/api/lambda-trace', requireAuth, handleLambdaTrace);
app.post('/admin/api/lambda-trace', requireAuth, handleLambdaTrace);

app.get('/admin/api/bootstrap', requireAuth, (req, res) => {
  res.json({
    settings: getSettings(),
    // Effektive Defaults (aus .env bzw. Code) fuer die Web-UI-Platzhalter:
    // leeres Setting = dieser Wert gilt.
    settingDefaults: {
      llm_model: config.llm.model,
      llm_max_tokens: String(config.llm.maxTokens),
      llm_reasoning_effort: config.llm.reasoningEffort ?? '',
      tool_deadline_ms: String(config.toolDeadlineMs),
      max_tool_iterations: String(config.maxToolIterations),
      http_timeout_ms: String(HTTP_TIMEOUT_MS),
      http_body_cap: String(HTTP_BODY_CAP),
      alexa_progress_after_ms: '6500',
    },
    actions: listActions(false),
    functions: listFunctions(false),
    servers: listMcpServers(false),
    prompts: listPrompts(),
  });
});

app.put('/admin/api/settings', requireAuth, (req, res) => {
  const body = req.body as { settings?: Record<string, string> };
  if (!body.settings || typeof body.settings !== 'object') {
    res.status(400).json({ error: 'settings-Objekt erforderlich' });
    return;
  }
  for (const [key, value] of Object.entries(body.settings)) setSetting(key, String(value));
  res.json({ settings: getSettings() });
});

app.get('/admin/api/actions', requireAuth, (req, res) => {
  res.json({ actions: listActions(false) });
});

app.get('/admin/api/functions', requireAuth, (req, res) => {
  res.json({ functions: listFunctions(false) });
});

app.post('/admin/api/functions', requireAuth, (req, res) => {
  try {
    const fn = createFunction(normalizeFunctionInput(req.body as Record<string, unknown>));
    res.json({ function: fn });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.put('/admin/api/functions/:id', requireAuth, (req, res) => {
  try {
    const fn = updateFunction(Number(req.params.id), normalizeFunctionInput(req.body as Record<string, unknown>));
    if (!fn) return res.status(404).json({ error: 'Funktion nicht gefunden' });
    res.json({ function: fn });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.delete('/admin/api/functions/:id', requireAuth, (req, res) => {
  deleteFunction(Number(req.params.id));
  res.json({ ok: true });
});

// Index-Quellen: universale benannte Snapshot-Indexe (entity_index = Default,
// entity_index_<key> = benannt). Der Desc-Feldwert lebt im Config-JSON
// ("desc") und wird vom Index-Loader ignoriert.
app.get('/admin/api/indexes', requireAuth, (req, res) => {
  const settings = getSettings();
  const indexes: { key: string; config: string }[] = [];
  for (const [key, value] of Object.entries(settings)) {
    if (key === 'entity_index') {
      indexes.push({ key: '', config: value });
    } else if (key.startsWith('entity_index_')) {
      indexes.push({ key: key.slice('entity_index_'.length), config: value });
    }
  }
  res.json({ indexes });
});

app.put('/admin/api/indexes/:key', requireAuth, async (req, res) => {
  const key = String(req.params.key ?? '').toLowerCase();
  if (key && !/^[a-z0-9_]{1,30}$/.test(key)) return res.status(400).json({ error: 'Ungültiger Key (a-z 0-9 _, max. 30)' });
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(String(req.body.config ?? '')) as Record<string, unknown>;
  } catch {
    return res.status(400).json({ error: 'Config ist kein gültiges JSON' });
  }
  if (!obj || typeof obj !== 'object' || typeof obj.tool !== 'string' || !(obj.tool as string).trim()) {
    return res.status(400).json({ error: 'Config braucht ein "tool"' });
  }
  setSetting(key ? `entity_index_${key}` : 'entity_index', JSON.stringify(obj));
  const { invalidateIndex } = await import('./core/entityIndex.js');
  invalidateIndex();
  res.json({ ok: true, key });
});

app.delete('/admin/api/indexes/:key', requireAuth, (req, res) => {
  const key = String(req.params.key ?? '').toLowerCase();
  if (!key || !/^[a-z0-9_]{1,30}$/.test(key)) {
    return res.status(400).json({ error: 'Nur benannte Indexe löschbar (Default-Index leeren statt löschen)' });
  }
  deleteSetting(`entity_index_${key}`);
  void (async () => {
    const { invalidateIndex } = await import('./core/entityIndex.js');
    invalidateIndex();
  })().catch(() => {});
  res.json({ ok: true });
});

// Vorschau: Template direkt rendern (mit echtem MCP-Kontext), fuer den Funktionen-Editor
app.post('/admin/api/functions/preview', requireAuth, async (req, res) => {
  try {
    const template = String((req.body as { template?: unknown }).template ?? '');
    const argsRaw = (req.body as { args?: unknown }).args;
    const args =
      argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    const mcp = await getMcpContext();
    const trace: TraceEvent[] = [];
    const rendered = await renderActionTemplate(template, mcp, trace, args);
    res.json({ rendered, trace });
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

// Index-Assistent (Phase 2): LLM entwirft ein Index-Draft, der deterministische
// Validator prueft es live (lesende Tools only, Datenvertrag). Speichern nur
// ueber /index/apply nach Admin-Bestaetigung.
app.post('/admin/api/index/assist', requireAuth, async (req, res) => {
  try {
    const goal = String((req.body as { goal?: unknown }).goal ?? '');
    const indexKey = String((req.body as { indexKey?: unknown }).indexKey ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    res.json(await assistIndex(goal, indexKey));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.post('/admin/api/index/apply', requireAuth, async (req, res) => {
  try {
    const draft = (req.body as { draft?: unknown }).draft as never;
    const indexKey = String((req.body as { indexKey?: unknown }).indexKey ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '');
    res.json(await applyDraft(draft, indexKey));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.post('/admin/api/actions', requireAuth, (req, res) => {
  res.json({ action: createAction(normalizeActionInput(req.body as Record<string, unknown>)) });
});

app.put('/admin/api/actions/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const existing = getAction(id);
  if (!existing) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  const updated = updateAction(id, normalizeActionInput(req.body as Record<string, unknown>));
  res.json({ action: updated });
});

app.delete('/admin/api/actions/:id', requireAuth, (req, res) => {
  deleteAction(Number(req.params.id));
  res.json({ ok: true });
});

app.get('/admin/api/mcp-servers', requireAuth, (req, res) => {
  res.json({ servers: listMcpServers(false) });
});

// Alle fuer LLM-Actions verfuegbaren Tools (Facade + MCP) fuer den Web-Editor
app.get('/admin/api/tools', requireAuth, async (req, res) => {
  try {
    const mcp = await getMcpContext();
    const serverTools = mcp.servers.map((s) => ({ server: s.name, tools: s.tools.map((t) => t.name) }));
    const functions = listFunctions(true).map((f) => `fn_${f.name}`);
    res.json({ mcp: serverTools, functions });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/admin/api/mcp-servers', requireAuth, (req, res) => {
  const server = createMcpServer(normalizeServerInput(req.body as Record<string, unknown>));
  invalidateMcpCache();
  res.json({ server });
});

app.put('/admin/api/mcp-servers/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const updated = updateMcpServer(id, normalizeServerInput(req.body as Record<string, unknown>));
  invalidateMcpCache();
  if (!updated) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  res.json({ server: updated });
});

app.delete('/admin/api/mcp-servers/:id', requireAuth, (req, res) => {
  deleteMcpServer(Number(req.params.id));
  invalidateMcpCache();
  res.json({ ok: true });
});

app.post('/admin/api/mcp-servers/:id/health', requireAuth, async (req, res) => {
  const server = getMcpServer(Number(req.params.id));
  if (!server) {
    res.status(404).json({ error: 'nicht gefunden' });
    return;
  }
  try {
    const client = createClient(server);
    await client.init();
    const tools = await client.listTools();
    if (typeof client.stop === 'function') client.stop();
    res.json({ ok: true, tools: tools.map((t) => t.name) });
  } catch (e) {
    res.json({ ok: false, error: String(e) });
  }
});

app.put('/admin/api/prompts/:key', requireAuth, (req, res) => {
  const body = req.body as { content?: string };
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content erforderlich' });
    return;
  }
  setPrompt(String(req.params.key), body.content);
  res.json({ ok: true });
});

app.get('/admin/api/logs', requireAuth, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
  res.json({ logs: listLogs(limit) });
});

app.get('/admin/api/usage', requireAuth, (_req, res) => {
  res.json({ usage: summarizeUsage() });
});

// Admin-UI-Login: Token pruefen, Session-Cookie setzen
app.post('/admin/login', (req, res) => {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || String((req.body as { token?: unknown })?.token ?? '');
  const sessionId = createSession(token);
  if (!sessionId) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  res.setHeader('Set-Cookie', cookieFor(sessionId));
  res.json({ ok: true, token: sessionId });
});

// Login-Seite ist ohne Session erreichbar (legt das Cookie)
app.get('/admin/login.html', (_req, res) => {
  res.sendFile(join(process.cwd(), 'web', 'login.html'));
});

// Statische Admin-UI nur mit gueltiger Session (Login-Cookie oder Bearer-Query)
app.use('/admin', (req, res, next) => {
  if (!sessionValid(req)) {
    if (req.headers.accept?.includes('text/html')) {
      res.redirect('/admin/login.html');
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});
app.use('/admin', express.static(join(process.cwd(), 'web')));

app.listen(config.port, () => {
  console.log(`MeinHelfer Gateway auf Port ${config.port}`);
});

if (process.env.LLM_KEEPALIVE_MS !== '0') {
  setInterval(() => {
    chatCompletion([{ role: 'user', content: 'OK' }], undefined, 15000).catch(() => {});
  }, Number(process.env.LLM_KEEPALIVE_MS ?? 120_000)).unref();
}
