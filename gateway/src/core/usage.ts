// LLM-Usage-Trace: Lesen und Summieren der llm.usage-Trace-Events (pure).
import type { TraceEvent } from '../types.js';
import type { ChatCompletionResult } from '../llm/client.js';

export function traceUsage(trace: TraceEvent[], model: string, result: ChatCompletionResult): void {
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
    },
  });
}

export function sumUsageFromTrace(trace: TraceEvent[]): { promptTokens?: number; completionTokens?: number; model?: string } {
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
