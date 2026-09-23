# Paket-Registry

Fertige Installationspakete für den MeinHelfer-Gateway. Die Registry wird vom
Projekt gepflegt (Autor `dezihh`); das Gateway lädt sie direkt aus diesem
Repository (kein Nutzerfeld).

## Aufbau (sprachspezifisch)

```
packages/
  <lang>/                 z. B. de (BCP-47-Kuerzel)
    index.json            Liste der verfuegbaren Pakete dieser Sprache
    <id>/manifest.json    Installations-Manifest
    <id>/README.md        Einrichtungs-/Nutzungsdoku
```

Die aktive Sprache kommt aus dem Gateway-Setting `registry_language`
(Standard `de`). Das Gateway liest Manifest und Index unter
`packages/<lang>/...` — weitere Sprachen (`packages/en/...`) koennen so ohne
Umbau ergaenzt werden.

## Manifest-Felder

| Feld | Pflicht | Zweck |
| --- | --- | --- |
| `id`, `version` | ja | eindeutige Id, semver `x.y.z` |
| `name`, `summary`, `description` | ja | Anzeige und Kurzbeschreibung |
| `author`, `license`, `homepage` | empfohlen | Herkunft und Lizenz (Vertrauensmodell) |
| `language` | optional | Sprachkuerzel, Default `de` |
| `requires`, `setupDocs` | optional | benoetigte Gegenseite / Einrichtungshinweise |
| `minGatewayVersion` | optional | getestete Gateway-Mindestversion (wird **erzwungen**) |
| `changelog` | empfohlen | Versionshistorie und Upgrade-Hinweise |
| `params` | optional | Eingabefelder (Werte ersetzen `${key}` im Manifest) |
| `servers` / `functions` / `indexes` | optional | die anzulegenden Artefakte |
| `allowTools` | optional | Agent-Tool-Allowlist (wird vereinigt) |

`servers`/`functions` koennen `sideEffect: read|write` setzen (Default
`write`): schreibende Aufrufe verwerfen den Entity-Index-Cache des Agenten,
rein lesende (`read`) nicht.

## Vertrauensmodell

- **Herkunft/Lizenz**: `author`, `homepage`, `license`.
- **Kompatibilitaet**: `minGatewayVersion` wird beim Installationsversuch
  geprueft; zu alte Gateways lehnen das Paket mit klarer Meldung ab.
- **Nachvollziehbarkeit**: `changelog` (Upgrade-Hinweise).
- **Sicherheit** (in der UI sichtbar):
  - `shell()`-Templates gelten als **gefaehrlich** und verlangen beim Install
    eine ausdrueckliche Bestaetigung (`dangerousAck`).
  - `http()`-Templates werden als Info ausgewiesen (externe Aufrufe).
  - Pakete ohne `shell()`/`http()` gelten als nur lesend/unkritisch.
- **Updates**: „Neu installieren" ist ein Upsert. Lokal geaenderte Zeilen
  werden erkannt und pro Element zum Entscheiden angezeigt
  („Paket-Version uebernehmen" / „lokale Aenderung behalten" / abbrechen).

Signaturen oder eine gesonderte, geprüfte Registry sind als spaeterer
Ausbau vorgesehen.
