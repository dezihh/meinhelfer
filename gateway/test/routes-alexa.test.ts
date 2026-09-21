import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Request } from 'express';
import type { AddressInfo } from 'node:net';
import { initDb, closeDb } from '../src/db/schema.js';
import { alexaRoutes } from '../src/routes/alexa.js';
import { config } from '../src/config.js';

const TMP_DB = '/tmp/opencode/test-alexa-routes.db';

before(() => {
  closeDb(); // hermetisch: Import-seitige Runtime-Init (Container-DB) ersetzen
  initDb(TMP_DB);
});

after(() => {
  config.alexaVerifyMode = process.env.ALEXA_VERIFY_MODE ?? 'off';
  config.alexaSkillId = process.env.ALEXA_SKILL_ID;
});

function buildApp(): { port: number; close: () => void } {
  const app = express();
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    })
  );
  app.use(alexaRoutes);
  const server = app.listen(0);
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => server.close() };
}

let ctx: { port: number; close: () => void };

before(() => {
  ctx = buildApp();
});

after(() => {
  ctx.close();
});

const SKILL = config.alexaSkillId ?? 'amzn1.ask.skill.test';

function alexaBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '1.0',
    context: { System: { application: { applicationId: SKILL } } },
    session: { application: { applicationId: SKILL }, sessionId: 'sess-test' },
    request: {
      type: 'LaunchRequest',
      requestId: 'amzn1.request.test',
      timestamp: new Date().toISOString(),
    },
    ...overrides,
  };
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${ctx.port}/alexa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('/alexa ohne Bearer -> 401', async () => {
  const res = await post(alexaBody());
  assert.equal(res.status, 401);
});

test('/alexa mit falschem Bearer -> 401', async () => {
  const res = await post(alexaBody(), { Authorization: 'Bearer falsch' });
  assert.equal(res.status, 401);
});

test('LaunchRequest Fast-Path -> Willkommen, Session bleibt offen', async () => {
  config.alexaVerifyMode = 'off';
  const res = await post(alexaBody(), { Authorization: `Bearer ${config.authToken}` });
  assert.equal(res.status, 200);
  const json = (await res.json()) as {
    response: { outputSpeech: { ssml: string }; shouldEndSession: boolean };
  };
  assert.match(json.response.outputSpeech.ssml, /Voice-Assistent|Willkommen|Hallo/);
  assert.equal(json.response.shouldEndSession, false);
});

test('SessionEndedRequest Fast-Path -> leere Response, kein Engine-Aufruf', async () => {
  config.alexaVerifyMode = 'off';
  const res = await post(
    alexaBody({ request: { type: 'SessionEndedRequest' } }),
    { Authorization: `Bearer ${config.authToken}` }
  );
  assert.equal(res.status, 200);
  const json = (await res.json()) as { response: Record<string, never> };
  assert.deepEqual(json.response, {});
});

test('falsche applicationId -> 403', async () => {
  config.alexaVerifyMode = 'off';
  const body = alexaBody({
    context: { System: { application: { applicationId: `${SKILL}-falsch` } } },
  });
  const res = await post(body, { Authorization: `Bearer ${config.authToken}` });
  assert.equal(res.status, 403);
});

test('enforce-Modus: ungueltige Signatur -> 401 trotz gueltigem Bearer', async () => {
  config.alexaVerifyMode = 'enforce';
  const res = await post(alexaBody(), {
    Authorization: `Bearer ${config.authToken}`,
    Signature: 'AAAA',
    Signaturecertchainurl: 'https://evil.example/echo.api/x.pem',
  });
  assert.equal(res.status, 401);
  const json = (await res.json()) as { reason?: string };
  assert.match(json.reason ?? '', /Signatur/);
});

test('warn-Modus: ungueltige Signatur wird durchgelassen (Fast-Path 200)', async () => {
  config.alexaVerifyMode = 'warn';
  const res = await post(alexaBody(), {
    Authorization: `Bearer ${config.authToken}`,
    Signature: 'AAAA',
    Signaturecertchainurl: 'https://evil.example/echo.api/x.pem',
  });
  assert.equal(res.status, 200);
});

test('StopIntent Fast-Path -> shouldEndSession true', async () => {
  config.alexaVerifyMode = 'off';
  const body = alexaBody({ request: { type: 'IntentRequest', intent: { name: 'AMAZON.StopIntent' } } });
  const res = await post(body, { Authorization: `Bearer ${config.authToken}` });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { response: { shouldEndSession: boolean } };
  assert.equal(json.response.shouldEndSession, true);
});
