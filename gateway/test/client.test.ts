import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, type ChatMessage } from '../src/llm/client.js';
import { initDb, closeDb, getDb } from '../src/db/schema.js';
import { setSetting, deleteSetting } from '../src/db/settings.js';
import { config } from '../src/config.js';

const originalFetch = globalThis.fetch;
const savedLlm = { ...config.llm };

interface LlmStub {
  // Antwort je nach URL ('primary'/'fallback') und Aufruf-Index
  respond?: (url: string, body: Record<string, unknown>) => { status?: number; data?: unknown } | 'hang';
}

let calls: { url: string; model?: string; tools?: number }[] = [];
let stub: LlmStub = {};

function chatJson(model: string, content: string | null): unknown {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function stubFetchLlm(): void {
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({
      url: u.includes('fallback') ? 'fallback' : 'primary',
      model: body.model as string,
      tools: Array.isArray(body.tools) ? (body.tools as unknown[]).length : undefined,
    });
    const r = stub.respond?.(u, body) ?? { status: 500, data: {} };
    if (r === 'hang') {
      return new Promise<never>((_resolve, reject) => {
        (init?.signal as AbortSignal | undefined)?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    const res = {
      ok: (r.status ?? 200) >= 200 && (r.status ?? 200) < 300,
      status: r.status ?? 200,
      text: async () => JSON.stringify(r.data ?? {}),
      json: async () => r.data ?? {},
    };
    return res as unknown as Response;
  }) as typeof fetch;
}

const msgs: ChatMessage[] = [{ role: 'user', content: 'frage' }];

before(() => {
  closeDb();
  initDb('/tmp/opencode/test-llmclient.db');
  // Fallback-Kette fuer Tests aktivieren (Container .env hat keinen Fallback)
  config.llm.baseUrl = 'https://primary.example.org/v1';
  config.llm.fallbackBaseUrl = 'https://fallback.example.org/v1';
  config.llm.fallbackModel = 'fallback-modell';
  setSetting('llm_fallback_after_ms', '100');
});

beforeEach(() => {
  calls = [];
  stub = {};
  stubFetchLlm();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

after(() => {
  deleteSetting('llm_fallback_after_ms');
  Object.assign(config.llm, savedLlm);
  globalThis.fetch = originalFetch;
});

test('chatCompletion: Modell-Echo aus der Antwort landet in usage.model', async () => {
  stub.respond = () => ({ data: chatJson('gpt-oss-120b', 'antwort') });
  const r = await chatCompletion(msgs);
  assert.equal(r.message.content, 'antwort');
  assert.equal(r.usage?.model, 'gpt-oss-120b');
});

test('chatCompletion: cached-Flag via cache_read_input_tokens', async () => {
  stub.respond = () => ({
    data: { ...chatJson('m', 'x'), usage: { prompt_tokens: 1, completion_tokens: 1, cache_read_input_tokens: 1000 } },
  });
  const r = await chatCompletion(msgs);
  assert.equal(r.usage?.cached, true);
});

test('chatCompletion: ohne usage bleibt usage undefined', async () => {
  stub.respond = () => ({ data: { choices: [{ message: { role: 'assistant', content: 'y' } }] } });
  const r = await chatCompletion(msgs);
  assert.equal(r.usage, undefined);
});

test('Tool-Runden bleiben am Primaermodell (kein Fallback-Race)', async () => {
  stub.respond = () => ({ data: chatJson('primary', 'tool-antwort') });
  await chatCompletion(msgs, [{ type: 'function', function: { name: 'x', parameters: {} } }], 1000);
  assert.deepEqual(calls.map((c) => c.url), ['primary']);
});

test('Primaerfehler -> Fallback uebernimmt, via_fallback markiert', async () => {
  stub.respond = (url) => (url.includes('primary') ? { status: 500, data: {} } : { data: chatJson('fb', 'vom fallback') });
  const r = await chatCompletion(msgs, undefined, 5000);
  assert.equal(r.message.content, 'vom fallback');
  assert.equal(r.usage?.via_fallback, true);
  assert.equal(r.usage?.model, 'fallback-modell');
  assert.deepEqual(calls.map((c) => c.url), ['primary', 'fallback']);
});

test('haengendes Primaermodell -> Fallback nach Fallback-Schwelle', async () => {
  stub.respond = (url) => (url.includes('primary') ? 'hang' : { data: chatJson('fb', 'fallback gewinnt') });
  const r = await chatCompletion(msgs, undefined, 3000);
  assert.equal(r.message.content, 'fallback gewinnt');
  assert.deepEqual(calls.map((c) => c.url), ['primary', 'fallback']);
});

test('beide Modelle im Fehler -> klare Rejection, kein Crash', async () => {
  stub.respond = () => ({ status: 500, data: {} });
  await assert.rejects(() => chatCompletion(msgs, undefined, 3000), /beide Modelle/);
});

test('haengende Primaer-Timeouts geben Abbruch-Signal an fetch weiter', async () => {
  stub.respond = () => 'hang';
  await assert.rejects(() => chatCompletion(msgs, undefined, 100), /beide Modelle/);
});
