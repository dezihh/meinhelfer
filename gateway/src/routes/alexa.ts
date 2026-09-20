import { Router } from 'express';
import type { Request } from 'express';
import { config } from '../config.js';
import { requireAuth } from '../auth.js';
import { verifyAlexaSignature } from '../alexa-verify.js';
import { processQuery } from '../core/engine.js';
import { fromAssistantResponse, toVoiceQuery } from '../adapters/alexa.js';
import { addLog, getSetting, getSettingNum } from '../db.js';
export const alexaRoutes = Router();

const WARTETON_PHRASE = 'Einen Moment, ich schaue das kurz nach.';
const ALEXA_WELCOME = 'Hallo, ich bin Ihr Voice-Assistent. Was kann ich für Sie tun?';
const ALEXA_HELP =
  'Sie können mich zum Beispiel nach dem Hausstatus oder nach aktuellen Nachrichten fragen.';
const ALEXA_GOODBYE = 'Bis zum nächsten Mal.';
const ALEXA_FALLBACK =
  'Entschuldigung, das habe ich nicht verstanden. Versuchen Sie zum Beispiel: was ist der Hausstatus.';

alexaRoutes.get('/privacy', (req, res) => {
  res
    .type('html')
    .send(
      '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Datenschutz – Voice Assist</title></head><body><h1>Datenschutz – Voice Assist</h1><p>Der Skill &bdquo;Voice Assist&ldquo; verarbeitet Sprachanfragen ausschlie&szlig;lich zur Beantwortung der Anfrage. Es werden keine Sprachdaten dauerhaft gespeichert und keine Daten an Dritte weitergegeben. Der Betrieb erfolgt privat im eigenen Netzwerk des Betreibers.</p><p>Bei Fragen wenden Sie sich an den Betreiber des Skills.</p></body></html>'
    );
});

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

alexaRoutes.post('/alexa', requireAuth, async (req, res) => {
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

