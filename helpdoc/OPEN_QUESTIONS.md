# Offene Angaben vor Veröffentlichung

Diese Liste ist kein Restmüllplatz für vage TODOs. Jeder Punkt nennt die
fehlende Information und eine reproduzierbare Methode, sie zu erheben.

## Priorität 1: Installation

### Offizieller Gateway-Installationsweg

**Fehlt:** Entscheidung, ob Docker Compose, direkter Node.js-Betrieb oder
beides unterstützt wird.

**Erheben:** Eine Neuinstallation auf einem leeren Zielsystem durchführen und
alle Befehle, Dateien, Rechte und Neustartschritte protokollieren.

**Erfolg:** Ein Dritter erreicht ohne Vorwissen den funktionierenden Monitor.

### Gateway-Container

**Fehlt:** Dockerfile/Image, Compose-Service, Volumes, Healthcheck,
Dateirechte und stdio-Pakete.

**Erheben:** Produktive Definition anonymisieren, mit leerem Volume testen und
anschließend ins Repository aufnehmen.

### LLM-Server

**Fehlt:** unterstützte Implementierungen, Installation, Modellnamen,
Hardwarebedarf und getestete Latenzwerte.

**Erheben:** Für jede unterstützte Variante eine minimale Anfrage, einen
Tool-Aufruf und finales JSON testen.

### Reverse Proxy und TLS

**Fehlt:** konkrete Referenzkonfiguration und Netzwerkbild.

**Erheben:** Produktiven Proxy anonymisieren; extern `/alexa`, intern
Admin-UI und API testen; Zertifikatserneuerung dokumentieren.

## Priorität 2: Alexa und AWS

### Erstmaliges Lambda-Deployment

**Fehlt:** Region, Runtime, IAM-Rolle, Trigger, Secrets und manuelle
Vorarbeiten des Workflows.

**Erheben:** Deployment mit einer neuen Lambda-Funktion durchspielen und jeden
Schritt bis zum erfolgreichen Simulator-Test festhalten.

### GitHub Actions

**Fehlt:** vollständige Tabelle aller Secrets und Variablen mit Zweck und
Bezugsquelle.

**Erheben:** Workflow-Dateien auswerten und jeden Wert in einer Testumgebung
auf Notwendigkeit prüfen. Keine Secret-Werte dokumentieren.

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

### Verkehr

**Fehlt:** konkrete API, URL, Datenfelder und vollständiges Template.

**Erheben:** Öffentlichen Endpoint auswählen, Body-Limit prüfen und ein
anonymisiertes Rezept mit leerer und langer Meldungsliste testen.

### Wetter

**Fehlt:** offiziell verwendete API und Lizenz-/Quellenhinweis.

**Erheben:** Anbieter festlegen, Beispiel-URL mit Platzhalterkoordinaten testen
und Wettercode-Mapping vervollständigen.

## Widersprüche im aktuellen Bestand

### Alexa-Signaturprüfung

Der bisherige README nennt `off` als Default; der aktuelle Gateway-Code setzt
`enforce`. Für den Entwurf gilt der Code. Der alte Text muss bei der späteren
Übernahme korrigiert werden.

### Modell-Fallback

Die vorhandene Dokumentation sagt, es gebe keine Fallback-Kaskade. Der Code
enthält jedoch `LLM_FALLBACK_BASE_URL`, `LLM_FALLBACK_MODEL` und
`LLM_FALLBACK_AFTER_MS`. Verhalten und beabsichtigter Supportstatus klären.

### Seed-Prompt

Der Kommentar bezeichnet den Installationsprompt als neutral; sein Inhalt
enthält eine personalisierte Identität. Vor Veröffentlichung neutralisieren
oder die Absicht dokumentieren.

### Veraltete UI-Begriffe

Einige Hilfetexte nennen noch `ha.state`, `ha.call` oder direkte
Vorgangs-Templates, während die aktuelle Architektur `index.*`, `mcp.call`
und Funktionen verwendet. UI und Dokumentation gemeinsam angleichen.

### Tool-Auswahl

Texte unterscheiden sich darin, ob eine leere Auswahl „alle“ oder „keine“
Werkzeuge bedeutet. Backend-Kompatibilitätsverhalten und aktuelle
UI-Speicherung mit einem Fresh-Install-Test festhalten.

## Abnahmekriterien für die endgültige Dokumentation

- Ein neuer Betreiber kann Gateway und Monitor ohne Quellcodelektüre starten.
- Jeder Schritt nennt Ort, Wert und sichtbares Prüfergebnis.
- Platzhalter sind als Platzhalter erkennbar.
- Kein Beispiel behauptet „1:1 nachbaubar“, wenn eine API oder Funktion fehlt.
- Alle UI-Bezeichnungen stimmen mit der Oberfläche überein.
- Alle internen Links funktionieren.
- Sicherheitsrelevante Defaults stimmen mit dem Code überein.
