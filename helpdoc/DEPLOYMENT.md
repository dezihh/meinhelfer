# Deployment und CI/CD (Betreiber/Entwickler)

> Zielgruppe: Betreiber und Entwickler. Diese Datei beschreibt die
> automatisierten Deploy-Wege über GitHub Actions sowie die AWS-/Alexa-Interna.
> Für die klassische Installation durch Anwender siehe [Alexa anbinden](ALEXA.md).

## Architektur

```text
Alexa Skill  ->  AWS Lambda (meinhelfer-alexa)  ->  POST /api/query  ->  Gateway
```

Die Lambda ist ein dünner Adapter. Routing, LLM, MCP und Werkzeuge bleiben im
Gateway. Das Gateway hat **keinen** direkten Alexa-Endpunkt; Alexa erreicht es
ausschließlich über die Lambda und `POST /api/query` (Bearer-Token).

## GitHub-Konfiguration

Nur Namen und Zweck – die Werte liegen ausschließlich in den Repo-Secrets.

### Secrets

| Secret | Zweck |
|---|---|
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | AWS-Deploy-Benutzer |
| `AWS_REGION` | AWS-Region (Default `eu-west-1`) |
| `AWS_LAMBDA_ROLE` | optional: bestehende Rollen-ARN überspringt die Auto-Anlage |
| `GATEWAY_URL` | öffentliche Basisadresse des Gateways |
| `GATEWAY_TOKEN` | muss dem `AUTH_TOKEN` des Gateways entsprechen |
| `ALEXA_SKILL_ID` | Skill-ID: Lambda-`applicationId`-Prüfung und Invoke-Trigger |
| `ASK_AUTH_INFO` / `ASK_CLI_CONFIG` | ASK-CLI-/SMAPI-Anmeldung (base64), für Skill-Sync |

### Variables

| Variable | Zweck |
|---|---|
| `EXTERNAL_BASE_URL` | öffentliche Gateway-Basis; Gate für `ext-check` |
| `ALEXA_SKILL_ID` | Skill-ID als Repo-Variable (u. a. Alt-Workflows/Ext-Check) |

## Workflows

Alle Workflows werden manuell über `workflow_dispatch` gestartet.

| Workflow | Zweck |
|---|---|
| `lambda-zip.yml` | Baut das Lambda-Zip bei Änderungen unter `alexa/lambda/**`; Artifact + rollendes `latest`-Release, bei Tag `v*` ein versioniertes Release |
| `deploy-aws-lambda.yml` | Baut das Lambda-Zip, legt Funktion + Ausführungsrolle an/aktualisiert sie, setzt Env-Variablen und den Alexa-Invoke-Trigger |
| `sync-manifest.yml` | Read-modify-write des Skill-Manifests: Endpoint auf Lambda-ARN (Top-Level und `regions.*`), ergänzt APL-Interface + Viewports; Inputs `endpoint_arn`, `add_apl`, `dry_run` |
| `sync-model.yml` | Lädt das Interaction Model (de-DE) in den development-Stage und pollt den Build-Status |
| `deploy-alexa.yml` | Optional/Legacy: Push des Skill-Packages in das Alexa-hosted CodeCommit-Repo (Branch `dev`/`master`) + SMAPI-Build |
| `ext-check.yml` | Prüft TLS, `POST /api/query` mit `GATEWAY_TOKEN` und dass `/alexa`, `/privacy`, `/admin` öffentlich nicht erreichbar sind. Sendet keine direkten Alexa-Requests |
| `debug-lambda-invoke.yml` | Ruft die Lambda direkt mit einem `GptQueryIntent`-Event auf |
| `debug-lambda-live.yml` | Zeigt Lambda-Env-Namen (URLs/Token maskiert) und testet das Gateway direkt |
| `debug-lambda-logs.yml` / `lambda-logs.yml` | CloudWatch-Logs der Lambda (`/aws/lambda/meinhelfer-alexa`) |
| `debug-skill.yml` | SMAPI-Diagnose: Invocation/Samples, Manifest-Endpoint je Stage, Build-Status |
| `list-skills.yml` | Listet die Skills des Vendors |

### `lambda-zip.yml`

Baut das Deployment-Zip der Lambda bei jeder Änderung unter `alexa/lambda/**`:
Abhängigkeiten aus `alexa/lambda/requirements.txt` plus `lambda_function.py`
(ohne Tests/Config). Ergebnis:

- Actions-Artifact für den CI-/Deploy-Weg
- rollendes Release `latest`, stabiler Anwender-Link:
  `releases/download/latest/meinhelfer-alexa-lambda.zip`
- bei Tag `v*` zusätzlich ein versioniertes Release mit dem Zip als Asset

### `deploy-aws-lambda.yml`

1. Baut `alexa/lambda/` zu einem Zip (Funktion + ask-sdk + requests).
2. Legt bei Bedarf die IAM-Ausführungsrolle `meinhelfer-lambda-execution` an
   (inkl. CloudWatch-Logs-Policy) oder nutzt `AWS_LAMBDA_ROLE`.
3. Erstellt/aktualisiert `meinhelfer-alexa` (Python, 512 MB, Timeout
   konfigurierbar) und setzt die Env-Variablen.
4. Setzt den Alexa-Skills-Kit-Trigger (`aws lambda add-permission`,
   `--event-source-token` = Skill-ID). Eine zuvor gesetzte Permission wird
   **vorher entfernt**, damit eine geänderte `ALEXA_SKILL_ID` die alte
   Permission tatsächlich ersetzt und nicht an einem Statement-ID-Konflikt
   scheitert. Ohne Trigger lehnt Amazon den ARN-Endpoint ab.

### `sync-manifest.yml`

Das Manifest wird **ausschließlich hier** auf die Lambda-ARN gesetzt. Wichtig:
Amazon liefert über `regions.*.endpoint` aus – nur das Top-Level-`endpoint`
zu setzen reicht nicht, der Workflow schreibt `regions.EU`/`NA`/`FE` mit.
Mit `dry_run=1` wird nur der aktuelle Zustand angezeigt (kein PUT).

## Lambda-Umgebungsvariablen

| Variable | Herkunft |
|---|---|
| `gateway_url` | Secret `GATEWAY_URL` |
| `gateway_token` | Secret `GATEWAY_TOKEN` (gleich `AUTH_TOKEN` des Gateways) |
| `alexa_skill_id` | Secret `ALEXA_SKILL_ID`; wird vor der Verarbeitung gegen die `applicationId` geprüft |
| `watchdog_delay`, `gateway_timeout`, `skill_name`, `assistant_name`, `apl_exit_delay_ms` | feste Werte aus dem Workflow |

## Skill-ID-Handling

- `ALEXA_SKILL_ID` bleibt als Deployment-Secret erhalten.
- `deploy-aws-lambda.yml` setzt sie als Lambda-Env `alexa_skill_id` **und**
  begrenzt die Invoke-Permission auf genau diese Skill-ID.
- Die Lambda nutzt den eingebauten Verifier des ASK SDK (`sb.skill_id`):
  Events mit abweichender `applicationId` werden abgelehnt.
- Die Skill-ID ist **keine** Gateway-Authentisierung und wird dem
  `/api/query`-Request nicht hinzugefügt; dort gilt weiter Bearer
  (`AUTH_TOKEN`).

## Deployment-Reihenfolge

1. `deploy-aws-lambda.yml` – Funktion, Env, Trigger.
2. `sync-manifest.yml` – Manifest-Endpoint auf die Lambda-ARN.
3. `sync-model.yml` – Interaction Model in den development-Stage.
4. `ext-check.yml` – Verifikation (TLS, `/api/query`, öffentliche Sperren).

Diagnose-Workflows nach Bedarf.

## Lokale Betreiber-Werkzeuge

| Werkzeug | Zweck |
|---|---|
| `alexa/scripts/sync_skill.py` | Interaction Model lokal per SMAPI synchronisieren; benötigt `alexa/skill.local.json` (nur `skill_id`) und ASK-CLI-Anmeldung |
| `gateway/scripts/smoke-test.mjs` | End-to-End-Smoke-Tests gegen ein laufendes Gateway |
| `alexa/lambda/test_lambda_function.py` | Lambda-Tests (stubben das ask-sdk, laufen ohne AWS/Netz) |
| `gateway` `npm test` / `npm run typecheck` / `npm run build` | Gateway-Tests und Typprüfung |

## Sicherheit

- Keine Secret-Werte in Repo, Doku oder Actions-Logs.
- `GATEWAY_TOKEN` nur im `Authorization`-Header; in Diagnose-Logs maskiert.
- Öffentlich erreichbar ist nur `/api/query` (Bearer). Admin-UI/API und die
  früheren Pfade `/alexa` und `/privacy` sind nicht öffentlich exponiert.
