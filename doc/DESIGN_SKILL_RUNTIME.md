# Design: Skill-Runtime & Timing

> Wie das Skill-Backend betrieben wird und wie mit dem Alexa-Antwortfenster
> umgegangen wird. Entscheidung: [Issue #2](https://github.com/dezihh/meinhelfer/issues/2)

## Ergebnis (umgesetzt)

**Gateway als Alexa-Endpoint** – die Alexa-Lambda ist entfallen:

- Das Skill-Manifest zeigt auf `https://<gateway-host>/alexa` (nginx als
  knx als Reverse-Proxy, TLS, `location /` → Gateway `:8331`).
- Der `/alexa`-Endpoint im Gateway validiert die `applicationId`
  (403 bei fremder Skill-ID, kein Bearer – Alexa sendet keinen).
- Der Alexa-hosted-Build akzeptiert das Manifest mit `endpoint.uri` Problemlos.
- Der gehostete Lambda ist Dead Code (CodeCommit/CI-Push bleibt für
  Manifest/Modell-Sync bestehen).

## Grundlagen (verifiziert im Betrieb)

- Das Alexa-**Antwortfenster** von ~8 s gilt für die Antwort an den Nutzer.
- **Progressive Responses** verlängern das Nutzer-Fenster (~20–30 s).
- **UMGESETZT (13.09.2026):** Der Skill läuft jetzt über eine **eigene
  AWS-Lambda** (`meinhelfer-alexa`, Account 837775096857, Python 3.14,
  Timeout 30 s) statt der Alexa-hosted-Lambda — das harte 8-s-Limit ist
  dadurch entfallen. Manifet-Endpoint `uri` zeigt auf die Lambda-ARN
  (kein `sslCertificateType` bei ARN, nur HTTPS). Deployment: Workflow
  `deploy-aws-lambda.yml` (baut Zip aus `alexa/lambda/`, IAM-Rolle
  auto, Env via `--cli-input-json` aus GitHub-Secrets, ARN deterministisch).
  `sync-manifest.yml` kann den Endpoint per SMAPI-PUT setzen (input
  `endpoint_arn` oder Auto-Bau aus `AWS_REGION`). Architektur (Gateway,
  MCP, LLM, Router) unverändert – nur der Hosting-Layer der Thin-Lambda.

## Architektur: Gateway-Endpoint (Option B)

- `/alexa` hält die HTTP-Verbindung offen, bis der Core fertig ist
  (deterministische Actions 200–370 ms, Agent-Ketten 10–15 s, nginx
  `proxy_read_timeout 35s`).
- **Warteton-Watchdog im Gateway:** bei langen Agent-Queries sendet der
  Gateway nach 6,5 s eine Progressive Response („Einen Moment, ich schaue
  das kurz nach.") über die Directives API (`api.eu.amazonalexa.com`,
  Bearer `apiAccessToken` aus dem Request).
- **Fast-Paths ohne Engine-Call** (direkte Antworten im Adapter):
  - `LaunchRequest` → fixe Begrüßung
  - `AMAZON.HelpIntent` → Fix-Hilfetext
  - `AMAZON.StopIntent` / `AMAZON.CancelIntent` / `SessionEndedRequest` →
    Abschied, Session-Ende
  - `AMAZON.FallbackIntent` → höfliche Wiederholung mit Beispielfrage
- GptQueryIntent → Core (`processQuery`), Modus je Action
  (deterministic/llm/hybrid) oder Agent.

## Latenzprofile (gemessen)

| Szenario | Dauer | Bemerkung |
|---|---|---|
| Template-Action hausstatus | 0,2–0,4 s | `ha.call` an HA-MCP-Skript |
| Agent warm (1 Tool) | 2–6 s | glm/gemini-Klasse |
| Agent cold mit Websuche | 10–15 s | Warteton bei 6,5 s |

Konfiguration: `LLM_MODEL=gemini/gemini-3.5-flash-lite` (kostenlos,
0,6 s/Tool-Turn), `LLM_MAX_TOKENS=2000` (zu klein → leere Speech durch
Thinking-Tokens), `num_results`-Cap 3 für searxng_web_search.

## Offene Punkte

- [ ] Multi-Turn-Clarification-State (Issue #7)
- [ ] Query-Slot-Bereinigung (Invocation-Reste im Slot-Text)
- [ ] Agent-Qualität: Halluzinationen („Aktenzeichen …") beobachten
