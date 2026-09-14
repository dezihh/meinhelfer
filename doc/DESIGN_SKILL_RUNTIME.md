# Design: Skill-Runtime & Timing

> Wie das Skill-Backend betrieben wird und wie mit dem Alexa-Antwortfenster
> umgegangen wird. Entscheidung: [Issue #2](https://github.com/dezihh/meinhelfer/issues/2)

## Ergebnis (umgesetzt)

**Eigene AWS-Lambda statt Alexa-hosted** – das harte 8-s-Function-Timeout ist
überwunden (Live-Test 13.09.2026 erfolgreich, s.u.):

- Deployment über Workflow `deploy-aws-lambda.yml`:
  - Baut Zip aus `alexa/lambda/` (lambda_function.py + ask-sdk/requests),
    erstellt/aktualisiert die Funktion `meinhelfer-alexa`
    (Python 3.14, Memory 512, Timeout konfigurierbar, Default 30 s).
  - IAM-Rolle `meinhelfer-lambda-execution` wird bei Bedarf auto-angelegt
    (Lambda-Basic-Execution-Trust); Env-Variablen (`gateway_url`,
    `gateway_token`, `watchdog_delay=5`, `gateway_timeout=60`, …) kommen
    via `--cli-input-json` aus GitHub-Secrets, nie ins Repo.
  - Setzt den **Alexa-Skills-Kit-Trigger** per `aws lambda add-permission`
    (`action=lambda:InvokeFunction`, `principal=alexa-appkit.amazon.com`,
    `event-source-token=<Skill-ID>`). Ohne diesen Trigger lehnt Amazon den
    ARN-Endpoint ab: `"The trigger setting for the Lambda … is invalid"`
    (`SkillManifestError`, reproduzierbar mit jedem frischen Skill).
  - ARN deterministisch: `arn:aws:lambda:<REGION>:837775096857:function:meinhelfer-alexa`.
- Manifest-Repoint über `sync-manifest.yml` (SMAPI read-modify-write-PUT):
  - `/v1/skills/<id>/stages/development/manifest` – setzt zusätzlich zum
    Top-Level-`endpoint` auch **alle `regions.*.endpoint`-Einträge
    (<EU/D N/A/FE>) auf die eigene ARN**. WICHTIG: Nur das Top-Level-
    `endpoint` zu setzen reicht NICHT – solange `regions.EU.endpoint` noch
    auf die Amazon-`Release_0`-Lambda zeigt, wird der echte Device-Call über
    die Hosted-Lambda ausgeliefert (dort lag der kaputte `config.json`).
  - Build-Status wird gepollt (rohes JSON); bei ARN-Endpoint kein
    `sslCertificateType` (nur für HTTPS-URLs gültig).
  - Inputs `dry_run` (nur lesen), `endpoint_arn` (fester ARN), `add_apl`.
- **Verifikation (13.09.2026):**
  - Direkter `aws lambda invoke` mit GptQueryIntent-Hausstatus-Query →
    vollständige SSML-Antwort inkl. HA-Daten („Der Akkustand beträgt
    48 Prozent … Super E10 bei Nordöl …").
  - Echo-Live-Test nach Regions-Fix: Antwort kommt durch, keine
    8-s-Abbruchmeldung mehr (früher: NaN, jetzt Antwort in kürzester Zeit).
  - Diagnose-Workflows: `debug-skill.yml` (Stages/Endpoints/Repo-Baum),
    `debug-lambda-invoke.yml` (direkter Invoke), `debug-lambda-live.yml`
    (Gateway-Erreichbarkeit extern), `debug-lambda-logs.yml` (CloudWatch-Sicht).
- Rest-Konfiguration (Gateway, MCP, LLM, Router) unverändert – nur der
  Hosting-Layer der Thin-Lambda.

> Hinweis: Die Gateway-`/alexa`-Variante (Option B weiter unten) bleibt
> dokumentiert; aktuell ist jedoch die eigene AWS-Lambda aktiv.

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
| Template-Action hausstatus | 0,2–0,6 s | `ha.call` an HA-MCP-Skript (13.09.: 0,6 s via AWS-Lambda) |
| News-Fastpath (claude-haiku-4.5) komplexe Frage | ~3,4 s | 13.09. Messung via eigene AWS-Lambda |
| Agent warm (1 Tool) | 2–6 s | glm/gemini-Klasse |
| Agent cold mit Websuche | 10–15 s | Warteton bei 5 s (Watchdog-Delay) |

> **Eigene AWS-Lambda:** Function-Timeout 30 s statt hart 8 s — auch
> Agent-Queries mit 10–15 s kommen jetzt vollständig durch (nur das
> Nutzer-Fenster bzw. der Gateway-`proxy_read_timeout` begrenzt).

Konfiguration: `LLM_MODEL=gemini/gemini-3.5-flash-lite` (kostenlos,
0,6 s/Tool-Turn), `LLM_MAX_TOKENS=2000` (zu klein → leere Speech durch
Thinking-Tokens), `num_results`-Cap 3 für searxng_web_search.

## Offene Punkte

- [ ] Multi-Turn-Clarification-State (Issue #7)
- [ ] Query-Slot-Bereinigung (Invocation-Reste im Slot-Text)
- [ ] Agent-Qualität: Halluzinationen („Aktenzeichen …") beobachten
- [ ] Routing-Fehlklassifikation: Kombinierte Fragen („Nachrichten … und
      Hausdaten/Auto-laden") werden vom deterministischen Router auf
      `news_summary` gezogen statt in den Agent; News-Fastpath kennt keine
      HA-Tools → hilflose Antwort (13.09.); ggf. neue Aktion `solarstatus`/`energie`
- [ ] Test-Skill `amzn1.ask.skill.c7a2ab59…` (testweise angelegt) löschen
- [ ] `deploy-alexa.yml` (Push in Alexa-Hosted-CodeCommit) deaktivieren —
      Hosted-Builds setzen den Manifest-Endpoint sonst wieder auf `Release_0`
