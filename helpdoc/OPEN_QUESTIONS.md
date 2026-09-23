# Offene Angaben vor Veröffentlichung

Diese Liste ist kein Restmüllplatz für vage TODOs. Jeder Punkt nennt die
fehlende Information und eine reproduzierbare Methode, sie zu erheben.

## Erledigt (Stand 23.09.2026)

- **Gateway-Installationsweg**: Docker Compose ist der getestete und
  dokumentierte Weg ([Installation](INSTALLATION.md), getestet 22.09.2026).
- **Gateway-Container**: Dockerfile, Compose-Service und Volumes liegen im
  Repository (`gateway/Dockerfile`, `docker-compose.yaml`).
- **Reverse Proxy und TLS**: nginx-Referenzaufbau in
  [Installation](INSTALLATION.md#netzwerk-und-https).
- **Lambda-Deployment (Workflow-Weg)**: Secrets-Tabelle und Ablauf in
  [Alexa anbinden](ALEXA.md#lambda-bereitstellen).
- **Paket-Invalidierung**: Install/Uninstall/Restore verwerfen MCP-Katalog
  und Entity-Index ([Cache](CACHE.md)).
- **Alexa-Signatur-Default**: Code und Doku stimmen überein (`enforce`).

## Priorität 1: Installation

### LLM-Server

**Fehlt:** unterstützte Implementierungen, Installation, Modellnamen,
Hardwarebedarf und getestete Latenzwerte.

**Erheben:** Für jede unterstützte Variante eine minimale Anfrage, einen
Tool-Aufruf und finales JSON testen.

## Priorität 2: Alexa und AWS

### Manuelles Lambda-Deployment

**Fehlt:** vollständige manuelle Anleitung (Region, Runtime, IAM-Rolle,
Trigger, Secrets) für Betreiber ohne GitHub-Actions-Weg. Die vom Workflow
automatisierten Schritte sind in [Alexa anbinden](ALEXA.md) als Reihenfolge
dokumentiert.

**Erheben:** Deployment mit einer neuen Lambda-Funktion durchspielen und jeden
Schritt bis zum erfolgreichen Simulator-Test festhalten.

### Physische Alexa-Einrichtung

**Fehlt:** Aktivierung des Development-Skills im Amazon-Konto, Gerätekonto,
Locale und Test auf Echo beziehungsweise Echo Show.

**Erheben:** Ein neues Gerät oder Testkonto verbinden und den Weg mit
Screenshots oder präzisen Menübezeichnungen protokollieren.

## Priorität 3: Konkrete Funktionen

### `ma_players`

**Fehlt:** vollständiges Parameter-Schema, Template, Budget und getestete
Toolnamen.

**Erheben:** Aktive Funktion anonymisiert exportieren oder anhand des aktuellen
Music-Assistant-MCP-Katalogs neu anlegen und testen.

### Recherche

**Fehlt:** final unterstützte Such-Toolnamen, vollständiges Parameter-Schema
und klare Auswahl zwischen SearXNG, Brave und nativer Modellsuche.

**Erheben:** Je Variante dieselben drei Fragen ausführen und Aufrufzahl,
Latenz und Ergebnisqualität vergleichen.

### Wetter

**Fehlt:** offiziell verwendete API und Lizenz-/Quellenhinweis. Das Paket
`open-meteo-wetter` nutzt Open-Meteo; das Rezept in
[Praxisrezepte](RECIPES.md) verwendet noch eine Platzhalter-URL.

**Erheben:** Rezept auf Open-Meteo umstellen und Wettercode-Mapping
vervollständigen.

## Widersprüche im aktuellen Bestand

### Modell-Fallback

Die ältere Fachdokumentation sagt, es gebe keine Fallback-Kaskade. Der Code
enthält jedoch `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL` und
`LLM_FALLBACK_AFTER_MS` (nur für Anfragen ohne Tools). Verhalten ist in
[Referenz](REFERENCE.md#laufzeitkonfiguration) beschrieben; der Supportstatus
als offizielles Feature ist noch zu erklären.

### Seed-Prompt

Der Kommentar bezeichnet den Installationsprompt als neutral; sein Inhalt
enthält eine personalisierte Identität. Vor Veröffentlichung neutralisieren
oder die Absicht dokumentieren.

### Veraltete UI-Begriffe

Einige Hilfetexte nennen noch `ha.state`, `ha.call` oder direkte
Vorgangs-Templates, während die aktuelle Architektur `index.*`, `mcp.call`
und Funktionen verwendet. UI und Dokumentation gemeinsam angleichen.
Zudem nennen UI-Hilfetexte falsche Defaults (4 Tool-Runden / 12000 ms statt
6 / 9000 ms).

## Abnahmekriterien für die endgültige Dokumentation

- Ein neuer Betreiber kann Gateway und Monitor ohne Quellcodelektüre starten.
- Jeder Schritt nennt Ort, Wert und sichtbares Prüfergebnis.
- Platzhalter sind als Platzhalter erkennbar.
- Kein Beispiel behauptet „1:1 nachbaubar“, wenn eine API oder Funktion fehlt.
- Alle UI-Bezeichnungen stimmen mit der Oberfläche überein.
- Alle internen Links funktionieren.
- Sicherheitsrelevante Defaults stimmen mit dem Code überein.
