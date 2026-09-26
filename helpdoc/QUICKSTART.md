# Schnellstart: die erste Antwort im Testmonitor

## Ziel

Nach diesem Weg beantwortet SmartPilot im Tab **Monitor / Test** die Frage
„Ist jemand zuhause?“. Alexa wird bewusst erst später angebunden.

Vorausgesetzt werden ein laufendes Gateway, eine erreichbare
OpenAI-kompatible LLM-Schnittstelle und ein laufender HA-MCP-Server. Fehlt
hiervon etwas, beginne mit [Installation](INSTALLATION.md).

## 1. Admin-Oberfläche öffnen

1. Öffne die Adresse des Gateways im Browser.
2. Trage rechts oben den Wert von `AUTH_TOKEN` als **Admin-Token** ein.
3. Wähle **Speichern**.

**Prüfung:** Die Tabs laden ohne Autorisierungsfehler.

Die Standardadresse der Admin-Oberfläche ist `http://<host>:<port>/admin`
(Login-Seite: `/admin/login.html`). Lokal verwendet das Gateway standardmäßig
Port `3000`; der Host-Port wird beim Start über `GATEWAY_PORT` gewählt.

## 2. Home Assistant verbinden

Öffne **Tool-Registry**, wähle **Neu** und trage ein:

| Feld | Wert |
|---|---|
| Name | `Home Assistant MCP` |
| Transport | `Streamable HTTP` |
| URL | `http://<ha-mcp-host>:8086/mcp` |
| Bearer-Token | leer, wenn HA-MCP keinen Client-Token verlangt |
| Aktiv | an |

Wähle **Speichern** und danach **Tools abfragen**.

**Prüfung:** Unter dem Editor erscheinen `ha_*`-Werkzeuge, insbesondere
`ha_eval_template`.

Der Home-Assistant-Zugriffstoken gehört bei der beschriebenen
HA-MCP-Docker-Variante in die Umgebung von HA-MCP, nicht in dieses
Gateway-Feld.

## 3. Standard-Index anlegen

Öffne **Index-Quellen**, wähle **Neu** und trage ein:

| Feld | Wert |
|---|---|
| Key | leer lassen |
| Beschreibung | `Home-Assistant-Entitäten` |
| Probe-Abfrage | `Sonne` |

**Config (JSON):**

```json
{
  "tool": "ha_eval_template",
  "args": {
    "template": "{% for e in states %}{% set area = area_name(e.entity_id) or '' %}{% set nm = e.attributes.get('friendly_name', e.entity_id) %}{% set extra = 'device_class=' ~ (e.attributes.get('device_class','') or '') ~ ';icon=' ~ (e.attributes.get('icon','') or '') ~ ';supported_features=' ~ (e.attributes.get('supported_features','') or '') %}{% if e.entity_id.startswith('climate.') and e.attributes.get('current_temperature') is not none %}{% set extra = extra ~ ';current_temperature=' ~ (e.attributes.get('current_temperature') or '') %}{% endif %}{{ e.entity_id }}|{{ area }}|{{ e.state }}|{{ e.attributes.get('unit_of_measurement','') or '' }}|{{ nm }}|{{ extra }}\n{% endfor %}",
    "timeout": 15,
    "report_errors": false
  },
  "ttlMs": 60000,
  "aliases": {
    "licht": "light",
    "lampe": "light",
    "steckdose": "switch",
    "temperatur": "temperature",
    "heizung": "climate",
    "fenster": "window",
    "tür": "door",
    "fernseher": "media_player",
    "rolladen": "cover",
    "draußen": "aussen",
    "drinnen": "innen"
  }
}
```

Wähle **Ausführen**.

**Prüfung:** Die Probe liefert `sun.sun` oder einen anderen passenden Eintrag.
Speichere anschließend.

## 4. Funktion anlegen

Öffne **Funktionen**, wähle **Neu** und trage ein:

| Feld | Wert |
|---|---|
| Name | `zuhause` |
| Beschreibung | `Sagt, ob jemand zuhause ist.` |
| Agent-Inventory-Zeile | leer |
| Aktiv | an |

**Template:**

```jinja
{%- set n = index.state('zone.home') | int -%}
{{ 'Niemand ist zuhause.' if n == 0 else ('Eine Person ist zuhause.' if n == 1 else n ~ ' Personen sind zuhause.') }}
```

Wähle **Ausführen** und erst danach **Speichern**.

**Prüfung:** Unter dem Editor erscheint ein vollständiger Satz; der Trace
enthält keinen Fehler.

## 5. Vorgang anlegen

Öffne **Vorgänge**, wähle **Neu** und trage ein:

| Feld | Wert |
|---|---|
| Name | `Zuhause` |
| Modus | `deterministisch (Template)` |
| Trigger-Phrasen | `Ist jemand zuhause?` und `Wer ist zuhause?`, je eine Zeile |
| Fuzzy-Schwellwert | leer |
| Daten aus Funktion | `zuhause` |
| Aktiv | an |

System-Prompt und erlaubte Tools bleiben leer. Speichere den Vorgang.

## 6. Gesamtweg testen

1. Öffne **Monitor / Test**.
2. Sende `Ist jemand zuhause?`.
3. Prüfe Antwort und Trace.

**Erwartung:** Der Trace zeigt den Vorgang `Zuhause`; die Antwort stammt aus
der Funktion `zuhause`. Für die Formulierung wurde kein LLM benötigt.

Damit ist der lokale Kernweg eingerichtet. Als Nächstes kannst du
[Alexa anbinden](ALEXA.md) oder ein [Praxisrezept](RECIPES.md) umsetzen.

## Warum dieser Weg zuerst kommt

Der Test trennt Gateway und Datenzugriff von Alexa, AWS und öffentlichem
Netzwerk. Fehler lassen sich dadurch wesentlich leichter eingrenzen.
