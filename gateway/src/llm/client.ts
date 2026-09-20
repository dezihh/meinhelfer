import { config } from '../config.js';
import { getSetting, getSettingNum } from '../db.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cached?: boolean;
  via_fallback?: boolean;
  model?: string;
}

export interface ChatCompletionResult {
  message: ChatMessage;
  usage?: LlmUsage;
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description?: string; parameters: unknown };
}

export async function chatCompletion(
  messages: ChatMessage[],
  tools?: ToolSpec[],
  timeoutMs?: number,
  modelOverride?: string,
  maxTokensOverride?: number
): Promise<ChatCompletionResult> {
  // Betriebs-Tuning via Web-UI-Settings; .env/Code liefert die Defaults
  const primaryModel = modelOverride ?? (getSetting('llm_model')?.trim() || config.llm.model);
  const fallbackBase = modelOverride ? '' : config.llm.fallbackBaseUrl;
  const fallbackModel = modelOverride ? '' : config.llm.fallbackModel;
  const useFallback = Boolean(fallbackBase && fallbackModel);

  // Tool-Roundtrips brauchen Tool- und JSON-Faehigkeit -> nur Primaermodell
  if (!useFallback || (tools && tools.length > 0)) {
    return callLlm(config.llm.baseUrl, config.llm.apiKey, primaryModel, messages, tools, timeoutMs, maxTokensOverride);
  }

  // Timeout-Deckel: Primaermodell hat volle Chance bis zur Schwelle;
  // erst danach (oder bei Primaerfehler) uebernimmt der lokale Fallback.
  // Alle Rejections werden gefangen -> niemals unhandled rejection (Prozess-Crash).
  const primaryOk = callLlm(config.llm.baseUrl, config.llm.apiKey, primaryModel, messages, tools, timeoutMs, maxTokensOverride).then(
    (res) => ({ res }),
    () => ({ err: true })
  );
  const fallbackOk = callLlm(fallbackBase, '', fallbackModel, messages, tools, timeoutMs, maxTokensOverride).then(
    (fb) => ({ fb: fb.usage ? { ...fb, usage: { ...fb.usage, via_fallback: true, model: fallbackModel } } : fb }),
    () => ({ err: true })
  );
  return await new Promise<ChatCompletionResult>((resolve, reject) => {
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const clearTimers = () => {
      for (const t of timers) clearTimeout(t);
      timers.length = 0;
    };
    const done = (v: ChatCompletionResult) => {
      if (!settled) {
        settled = true;
        clearTimers();
        resolve(v);
      }
    };
    const fail = (msg: string) => {
      if (!settled) {
        settled = true;
        clearTimers();
        reject(new Error(msg));
      }
    };
    // Primary hat bis fallbackAfterMs Zeit; danach (oder bei Fehler) uebernimmt
    // der lokale Fallback. Overall = harte Gesamt-Deadline, damit nie gehaengt
    // wird (weder bei Timerlossen noch bei beiden Modellen, die nicht antworten).
    const fallbackAfter = getSettingNum('llm_fallback_after_ms', config.llm.fallbackAfterMs);
    timers.push(
      setTimeout(
        () => fail('LLM: Gesamt-Deadline überschritten'),
        fallbackAfter + (timeoutMs ?? fallbackAfter) + 5000
      )
    );
    primaryOk.then((r) => {
      if ('res' in r) {
        done(r.res);
      } else if ('err' in r && !settled) {
        // Primaerfehler: haengende fallbackOk-Reihe sofort abloesen
        fallbackOk.then((fb) => {
          if ('fb' in fb) done(fb.fb);
          else fail('LLM: beide Modelle nicht rechtzeitig antworteten');
        });
      }
    });
    timers.push(
      setTimeout(() => {
        fallbackOk.then((r) => {
          if ('fb' in r) done(r.fb);
          else fail('LLM: beide Modelle nicht rechtzeitig antworteten');
        });
      }, fallbackAfter)
    );
  });
}

async function callLlm(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  tools?: ToolSpec[],
  timeoutMs?: number,
  maxTokensOverride?: number
): Promise<ChatCompletionResult> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: maxTokensOverride ?? getSettingNum('llm_max_tokens', config.llm.maxTokens),
    temperature: 0.2,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  const reasoningEffort = getSetting('llm_reasoning_effort')?.trim() || config.llm.reasoningEffort;
  if (reasoningEffort) {
    body.reasoning_effort = reasoningEffort;
  }
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { role?: string; content?: string | null; tool_calls?: ChatMessage['tool_calls']; reasoning_content?: string } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cached_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error('LLM: leere Antwort');
  const usage = data.usage
    ? {
        prompt_tokens: data.usage.prompt_tokens,
        completion_tokens: data.usage.completion_tokens,
        total_tokens: data.usage.total_tokens,
        cached:
          (data.usage.cache_read_input_tokens !== undefined && data.usage.cache_read_input_tokens > 0) ||
          (data.usage.cached_tokens !== undefined && data.usage.cached_tokens > 0),
        // Echtes Serviertes Modell aus der Antwort (Proxy-echo), nicht der
        // .env-Default - sonst zeigt der Trace deepseek-v4-pro, obwohl
        // gpt-oss-120b o. ae. aktiv ist.
        model: (data as { model?: string }).model,
      }
    : undefined;
  return {
    message: {
      role: (message.role ?? 'assistant') as ChatMessage['role'],
      content: message.content ?? null,
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}),
    },
    usage,
  };
}
