import { config } from '../config.js';
import {
  addLog,
  listActions,
  getPrompt,
  getSetting,
  recentAgentTurns,
} from '../db.js';
import { chatCompletion, type ChatCompletionResult, type ChatMessage, type ToolSpec } from '../llm/client.js';
import { getMcpContext, type McpContext } from '../mcp/registry.js';
import { facadeTools, type FacadeTool } from '../tools/facade.js';
import { routeAction, type RouteMatch } from './router.js';
import { renderActionTemplate } from './template.js';
import type {
  AssistantResponse,
  EngineResult,
  ParsedAction,
  TraceEvent,
  VoiceQuery,
} from '../types.js';

const FallbackError = 'Entschuldigung, da ist etwas schiefgelaufen.';

const sessionHistory = new Map<string, ChatMessage[]>();
const HISTORY_MAX_MESSAGES = 8;
const HISTORY_MAX_SESSIONS = 100;

function priorTurns(sessionId: string): ChatMessage[] {
  const inMem = sessionHistory.get(sessionId);
  if (inMem && inMem.length > 0) return inMem;
  // DB-Recall als ALT markieren: Das LLM weiss, dass die Zeit fortgeschritten
  // ist, und kann selbst entscheiden, ob der Inhalt noch relevant ist.
  const turns = recentAgentTurns(2, 30 * 60_000);
  if (turns.length === 0) return [];
  const ageHits = turns.filter((t) => t.ageMs > 5 * 60_000);
  const out: ChatMessage[] = [];
  if (ageHits.length > 0) {
    const detail = ageHits
      .map((t) => `${Math.round(t.ageMs / 60000)} min: ${t.response.slice(0, 80)}`)
      .join('; ');
    out.push({
      role: 'system',
      content: `Hinweis: Es gibt fruehere Unterhaltungen aus anderen Sitzungen (${detail}). Erwaehne sie NICHT als Teil der aktuellen Frage und traue ihrem Inhalt NICHT als aktuellen Stand. Nutze sie nur, wenn sie fuer die aktuelle Frage klar relevant sind.`,
    });
  }
  for (const t of turns) {
    out.push({ role: 'user', content: t.query });
    out.push({ role: 'assistant', content: t.response });
  }
  return out;
}

function rememberTurn(sessionId: string, query: string, speech: string): void {
  if (sessionHistory.size > HISTORY_MAX_SESSIONS) sessionHistory.clear();
  const prev = sessionHistory.get(sessionId) ?? [];
  prev.push({ role: 'user', content: query });
  prev.push({ role: 'assistant', content: speech });
  sessionHistory.set(sessionId, prev.slice(-HISTORY_MAX_MESSAGES));
}

type ToolRoute =
  | { kind: 'mcp'; client: McpContext['servers'][number]['client']; toolName: string }
  | { kind: 'facade'; tool: FacadeTool };

type ToolRouteMap = { specs: ToolSpec[]; routes: Map<string, ToolRoute> };

const LLM_BLOCKED_TOOLS = new Set(['googe_ai', 'gargedoor_open_script', '_433_gray4_off', '_433_gray4_on', 'XXXXXXXXXXXXXXhausstatus']);

function buildMcpTools(
  mcp: McpContext,
  allowlist: string[] | null,
  routes: Map<string, ToolRoute>,
  specs: ToolSpec[]
): void {
  for (const server of mcp.servers) {
    for (const def of server.tools) {
      const key = routes.has(def.name) ? `${server.name}.${def.name}` : def.name;
      if (LLM_BLOCKED_TOOLS.has(def.name)) continue;
      if (routes.has(key)) continue;
      if (allowlist && !allowlist.includes(def.name) && !allowlist.includes(key)) continue;
      routes.set(key, { kind: 'mcp', client: server.client, toolName: def.name });
      specs.push({
        type: 'function',
        function: {
          name: key,
          description: (def.description ?? '').slice(0, 160),
          parameters: def.inputSchema ?? { type: 'object' },
        },
      });
    }
  }
}

function buildTools(
  mcp: McpContext,
  allowlist: string[] | null
): ToolRouteMap {
  const mode = getSetting('facade_mode') ?? 'facade';
  const routes = new Map<string, ToolRoute>();
  const specs: ToolSpec[] = [];
  if (mode === 'facade' || mode === 'both') {
    for (const tool of facadeTools) {
      if (allowlist && !allowlist.includes(tool.name)) continue;
      routes.set(tool.name, { kind: 'facade', tool });
      specs.push({
        type: 'function',
        function: { name: tool.name, description: tool.description.slice(0, 300), parameters: tool.parameters },
      });
    }
  }
  if (mode === 'raw' || mode === 'both') {
    buildMcpTools(mcp, allowlist, routes, specs);
  }
  return { specs, routes };
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripSsmlTags(text: string): string {
  return text
    .replace(/<speak>|<\/speak>/gi, '')
    .replace(/<break[^>]*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function withSsmlBreaks(resp: AssistantResponse): AssistantResponse {
  if (resp.ssml) return resp;
  const s = resp.speech.trim();
  let parts = s
    .split(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2 && s.length >= 160) {
    const sentences = s.split(/(?<=[.!?])\s+(?=[A-ZÄÖÜ„"])/);
    if (sentences.length >= 2) {
      parts = [];
      for (let i = 0; i < sentences.length; i += 2) {
        parts.push(sentences.slice(i, i + 2).join(' ').trim());
      }
    }
  }
  if (parts.length < 2 || s.length < 150) return resp;
  const speech = `<speak>${parts
    .map((p) => escapeXml(p).replace(/\s*\n\s*/g, ' '))
    .join('<break time="300ms"/>')}</speak>`;
  return { ...resp, speech, ssml: true };
}

function withDisplay(resp: AssistantResponse): AssistantResponse {
  const text = resp.display?.text ?? (resp.ssml ? stripSsmlTags(resp.speech) : resp.speech);
  const title = getSetting('display_title') ?? 'MeinHelfer';
  return { ...resp, display: { ...resp.display, title, text } };
}

function parseAgentAnswer(content: string, trace: TraceEvent[]): AssistantResponse {
  const filtered = content
    .replace(/<\|?tool_call>[\s\S]*?(?:<tool_call\|>|<\|end_of_turn\|>|$)/gi, '')
    .replace(/<\|[^>]*\|>/g, '')
    .trim();
  if (filtered !== content.trim()) {
    trace.push({ ts: Date.now(), step: 'agent.leak_filtered', detail: { lenBefore: content.length, lenAfter: filtered.length } });
  }
  const text = filtered.replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as { needs_clarification?: boolean; speech?: string; keep_open?: boolean };
      if (typeof parsed.speech === 'string' && parsed.speech.trim().length > 0) {
        return { speech: parsed.speech, followUp: parsed.needs_clarification === true, keepOpen: parsed.keep_open === true };
      }
      trace.push({ ts: Date.now(), step: 'agent.empty_speech' });
      return { speech: 'Entschuldigung, dazu habe ich gerade nichts gefunden.' };
    } catch {
      trace.push({ ts: Date.now(), step: 'agent.json_parse_error' });
    }
  }
  if (text.length === 0) {
    trace.push({ ts: Date.now(), step: 'agent.empty_content' });
    return { speech: 'Entschuldigung, dazu habe ich gerade nichts gefunden.' };
  }
  return { speech: text };
}

function assistantName(): string {
  return getSetting('assistant_name') ?? 'Smart Pilot';
}

function promptWithName(key: string): string | undefined {
  const raw = getPrompt(key);
  return raw?.replace('{assistant_name}', assistantName());
}

// System-Prompt fuer den Agenten: agent_system + optionales Tool-Inventory (agent_inventory)
function agentSystemPrompt(): string {
  const sys = promptWithName('agent_system') ?? 'Du bist ein hilfreicher deutscher Sprachassistent.';
  const inv = promptWithName('agent_inventory');
  if (!inv) return sys;
  return `${sys}\n\n## Tool-Inventory (Nachschlagewerk)\n${inv}`;
}

function traceUsage(trace: TraceEvent[], model: string, result: ChatCompletionResult): void {
  if (!result.usage) return;
  trace.push({
    ts: Date.now(),
    step: 'llm.usage',
    detail: {
      model: result.usage.model ?? model,
      prompt_tokens: result.usage.prompt_tokens,
      completion_tokens: result.usage.completion_tokens,
      total_tokens: result.usage.total_tokens,
      cached: result.usage.cached,
      via_fallback: result.usage.via_fallback,
    },
  });
}

function sumUsageFromTrace(trace: TraceEvent[]): { promptTokens?: number; completionTokens?: number; model?: string } {
  const sums: Record<string, number> = {};
  let model: string | undefined;
  for (const e of trace) {
    if (e.step !== 'llm.usage') continue;
    const d = e.detail as Record<string, number | string | boolean | undefined>;
    const prompt = typeof d.prompt_tokens === 'number' ? d.prompt_tokens : 0;
    const comp = typeof d.completion_tokens === 'number' ? d.completion_tokens : 0;
    sums.prompt = (sums.prompt ?? 0) + prompt;
    sums.completion = (sums.completion ?? 0) + comp;
    if (!model && typeof d.model === 'string') model = d.model;
  }
  return { promptTokens: sums.prompt, completionTokens: sums.completion, model };
}

async function runToolLoop(
  system: string,
  queryText: string,
  source: string | null,
  mcp: McpContext,
  trace: TraceEvent[],
  sessionId: string,
  allowlist: string[] | null = null
): Promise<AssistantResponse> {
  const { specs, routes } = buildTools(mcp, allowlist);
  const history = sessionId ? priorTurns(sessionId) : [];
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: queryText },
  ];
  const overallDeadline = Date.now() + config.toolDeadlineMs * 2;
  const TimeoutAnswer = 'Das hat gerade zu lange gedauert, bitte versuche es gleich noch einmal.';
  const toolBudgets: Record<string, number> = { web_url_read: 1, search_web: 1, get_house_status: 1, get_fuel_prices: 1 };
  const toolCalls: Record<string, number> = {};
  const runTools = async (message: ChatMessage): Promise<void> => {
    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    });
    const results = await Promise.all(
      (message.tool_calls ?? []).map(async (call) => {
        let result: string;
        try {
          const route = routes.get(call.function.name);
          if (!route) throw new Error(`unbekanntes Tool: ${call.function.name}`);
          const used = toolCalls[call.function.name] ?? 0;
          const budget = toolBudgets[call.function.name];
          if (budget !== undefined && used >= budget) {
            result = `Limit erreicht (${call.function.name}: max. ${budget} pro Frage). Antworte JETZT mit den vorhandenen Informationen.`;
            trace.push({
              ts: Date.now(),
              step: 'tool.budget_hit',
              detail: { tool: call.function.name, used },
            });
            return { id: call.id, content: result };
          }
          toolCalls[call.function.name] = used + 1;
          const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
          if (typeof args.num_results === 'number' && args.num_results > 3) {
            args.num_results = 3;
          }
          const out =
            route.kind === 'facade'
              ? await route.tool.run(args, mcp)
              : await route.client.callTool(route.toolName, args);
          result = JSON.stringify(out).slice(0, 2000);
          trace.push({ ts: Date.now(), step: 'tool.call', detail: { tool: call.function.name, args } });
        } catch (e) {
          result = `ERROR: ${String(e)}`;
          trace.push({
            ts: Date.now(),
            step: 'tool.error',
            detail: { tool: call.function.name, error: String(e) },
          });
        }
        return { id: call.id, content: result };
      })
    );
    for (const r of results) {
      messages.push({ role: 'tool', content: r.content, tool_call_id: r.id });
    }
  };
  for (let i = 0; i < config.maxToolIterations; i++) {
    if (i > 0 && Date.now() >= overallDeadline) {
      trace.push({ ts: Date.now(), step: 'tool.deadline' });
      return { speech: TimeoutAnswer };
    }
    const remaining = Math.min(config.toolDeadlineMs, Math.max(overallDeadline - Date.now(), 5000));
    let message: ChatMessage;
    try {
      const result = await chatCompletion(messages, specs.length > 0 ? specs : undefined, remaining);
      message = result.message;
      traceUsage(trace, config.llm.model, result);
    } catch (e) {
      if (!(String(e).includes('TimeoutError') || String(e).includes('abort'))) throw e;
      trace.push({ ts: Date.now(), step: 'llm.timeout', detail: { round: i } });
      if (i === 0) {
        try {
          const retryResult = await chatCompletion(messages, specs.length > 0 ? specs : undefined, 7000);
          traceUsage(trace, config.llm.model, retryResult);
          const retry = retryResult.message;
          if (!retry.tool_calls || retry.tool_calls.length === 0) {
            return parseAgentAnswer(retry.content ?? '', trace);
          }
          await runTools(retry);
          const finalResult = await chatCompletion(messages, undefined, 7000);
          traceUsage(trace, config.llm.model, finalResult);
          const final = finalResult.message;
          return parseAgentAnswer(final.content ?? '', trace);
        } catch (e2) {
          trace.push({ ts: Date.now(), step: 'tool.deadline', detail: String(e2).slice(0, 60) });
          return { speech: TimeoutAnswer };
        }
      }
      trace.push({ ts: Date.now(), step: 'tool.deadline' });
      return { speech: TimeoutAnswer };
    }
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return parseAgentAnswer(message.content ?? '', trace);
    }
    await runTools(message);
  }
  return { speech: TimeoutAnswer };
}

async function runAgent(query: VoiceQuery, mcp: McpContext, trace: TraceEvent[]): Promise<AssistantResponse> {
  const system = agentSystemPrompt();
  const response = await runToolLoop(system, query.text, null, mcp, trace, query.sessionId);
  rememberTurn(query.sessionId, query.text, response.speech);
  return response;
}

async function executeAction(
  action: ParsedAction,
  query: VoiceQuery,
  mcp: McpContext,
  trace: TraceEvent[]
): Promise<AssistantResponse> {
  if (action.mode === 'llm' || (action.mode === 'hybrid' && !action.template)) {
    const system = action.system_prompt?.replace('{assistant_name}', assistantName()) ?? agentSystemPrompt();
    return runToolLoop(system, query.text, null, mcp, trace, query.sessionId, action.toolList);
  }
  const rendered = await renderActionTemplate(action.template ?? '', mcp, trace);
  if (action.mode === 'deterministic') return rendered;
  const system = action.system_prompt?.replace('{assistant_name}', assistantName()) ?? agentSystemPrompt();
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Daten:\n${rendered.speech}\n\nAnfrage: ${query.text}\nFormuliere daraus eine kurze, sprechbare Antwort.`,
    },
  ];
  const message = await chatCompletion(messages);
  return parseAgentAnswer(message.content ?? '', trace);
}

const CHAT_CHAT_SESSIONS = new Set<string>();

const CHAT_ON_RE = /(chat[-\s]?modus|chatmodus|unterhaltung[-\s]?modus|gespraechs?[-\s]?modus|im gespraech bleiben)/i;
const CHAT_OFF_RE = /(one[-\s]?shot|einzelmodus|alltag[-\s]?modus|beende.*chat|chat[-\s]?beenden|wechsle.*one[-\s]?shot)/i;

export function isChatSession(sessionId: string): boolean {
  return CHAT_CHAT_SESSIONS.has(sessionId);
}

export async function processQuery(query: VoiceQuery): Promise<EngineResult> {
  const start = Date.now();
  const trace: TraceEvent[] = [
    { ts: start, step: 'query', detail: { sessionId: query.sessionId, text: query.text } },
  ];

  // Chat-/OneShot-Modus-Wechsel: deterministisch, Session-Zustand
  const qLower = query.text.toLowerCase();
  if (CHAT_OFF_RE.test(qLower)) {
    CHAT_CHAT_SESSIONS.delete(query.sessionId);
    trace.push({ ts: Date.now(), step: 'chat.off', detail: { sessionId: query.sessionId } });
    return {
      response: { speech: 'Okay, ich beantworte die nächsten Fragen wieder einzeln.', followUp: false },
      route: 'chat',
      durationMs: Date.now() - start,
      trace,
    };
  }
  if (CHAT_ON_RE.test(qLower)) {
    CHAT_CHAT_SESSIONS.add(query.sessionId);
    trace.push({ ts: Date.now(), step: 'chat.on', detail: { sessionId: query.sessionId } });
    return {
      response: {
        speech: 'Gut, ich bleibe im Gespräch. Was möchtest du noch wissen?',
        followUp: true,
        followupPrompt: 'Was möchtest du noch wissen?',
      },
      route: 'chat',
      durationMs: Date.now() - start,
      trace,
    };
  }
  const actions = listActions(true);
  const fuzzyGlobal = getSetting('fuzzy_global') !== '0';
  const match: RouteMatch | null = routeAction(query.text, actions, fuzzyGlobal);
  const mcp = await getMcpContext().catch((e: unknown) => {
    trace.push({ ts: Date.now(), step: 'mcp.error', detail: String(e) });
    return { servers: [] } as McpContext;
  });

  let response: AssistantResponse;
  let route: string;
  if (match) {
    route = 'action';
    trace.push({
      ts: Date.now(),
      step: 'route.action',
      detail: { action: match.action.name, score: match.score, phrase: match.phrase },
    });
    try {
      response = await executeAction(match.action, query, mcp, trace);
      rememberTurn(query.sessionId, query.text, response.speech);
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'action.error', detail: String(e) });
      response = { speech: FallbackError };
    }
  } else {
    route = 'agent';
    trace.push({ ts: Date.now(), step: 'route.agent' });
    try {
      response = await runAgent(query, mcp, trace);
    } catch (e) {
      trace.push({ ts: Date.now(), step: 'agent.error', detail: String(e) });
      response = { speech: FallbackError };
    }
  }

  response = withSsmlBreaks(response);
  response = withDisplay(response);

  if (CHAT_CHAT_SESSIONS.has(query.sessionId)) {
    response = { ...response, followUp: true, followupPrompt: 'Was möchtest du noch wissen?' };
  } else if (!response.followUp) {
    const mode = getSetting('session_followup') ?? '0';
    const wantLlm = mode === 'llm' || mode === 'beides';
    const wantKw = mode === 'keyword' || mode === 'beides';
    const kwList = (getSetting('session_keywords') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const kwHit = wantKw && kwList.some((k) => query.text.toLowerCase().includes(k));
    const llmHit = wantLlm && response.keepOpen === true;
    if (kwHit || llmHit) {
      response = { ...response, followUp: true, followupPrompt: 'Was kann ich noch für Sie tun?' };
    }
  }

  const durationMs = Date.now() - start;
  addLog({
    sessionId: query.sessionId,
    query: query.text,
    route,
    actionId: match?.action.id,
    score: match?.score,
    response: response.speech,
    durationMs,
    trace,
    ...sumUsageFromTrace(trace),
  });
  return {
    response,
    route,
    actionId: match?.action.id,
    score: match?.score,
    durationMs,
    trace,
  };
}
