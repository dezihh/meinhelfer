# Design: Display & Media (Echo Show)

> Echo-Gerätepark: **gemischt** (Echo Show + reine Audio-Geräte) → alle
> Display-Inhalte sind optional, `speech` kommt immer.

## Roadmap

| Stufe | Inhalt | Aufwand | Meilenstein |
|---|---|---|---|
| 1 | Vorgelesener Text auf dem Display | gering | **MVP** |
| 2 | Grafiken/Bilder (Icons, Snapshots, Suchergebnis-Bilder, Carousels) | gering–mittel | **MVP** |
| 3 | Videos (MP4/HLS) via APL `Video` | mittel | später |
| 4 | Musik/Audio via `AudioPlayer`-Interface (Playqueue) | mittel–hoch | später |

## Antwort-Schema (Gateway → Lambda)

```json
{
  "speech": "…",
  "display": {
    "title": "…",
    "text": "…",
    "images": ["https://…"],
    "video": "https://…"
  }
}
```

- `display` ist **optional**; Audio-Geräte ignorieren es (Fallback-Strategie)
- Das dünne Lambda rendert nur ein APL-Dokument + SpeakItem-Command aus dem Payload (Template im Repo, keine Logik dort)
- MCP-Server können Media-URLs liefern; LLM kann Bild-URLs aus Suchergebnissen ergänzen
- Deterministische Actions (z. B. „Hausstatus") definieren ihre Display-Ausgabe im Template

## Umgesetzt (16.09.): Sprachsync-Autoscroll (Stufe 1)

Der vorgelesene Text läuft über das offizielle APL-Muster „Synchronize spoken
text with text on the screen": Die SSML aus dem Gateway landet im
APL-Datasource; die Transformer `ssmlToSpeech`/`ssmlToText` erzeugen daraus
TTS-Audio und Klartext; ein `Text` mit `speech`-Property in einer `ScrollView`
wird per `ExecuteCommands` → `SpeakItem` (`highlightMode: line`) gesprochen —
**das Display scrollt zeilenweise mit der Stimme mit** (Karaoke-Stil).

- `outputSpeech` nur noch als Fallback für Geräte ohne APL (sonst Dopplung)
- Bekannter Tradeoff: Nutzer-Touch während der Wiedergabe stoppt die Sprache
  (Geräte-UX, nicht konfigurierbar) — bewusst gegen freies Scrollen entschieden
- Umsetzung: `alexa/lambda/lambda_function.py` (Commit `29b7075`)

## Constraints (wichtig)

- Echo-Geräte holen Media **direkt aus dem Internet**: URLs müssen öffentlich per HTTPS erreichbar sein
- LAN-URLs (`192.168.x.x`) funktionieren nicht → LAN-Medien über den öffentlichen Host tunneln
  (z. B. `https://<host>/<sub-path>/media/…` mit Token-in-URL, kurzlebig)
- Formate: JPEG/PNG für Bilder; H.264/AAC MP4 oder HLS für Video
- `AudioPlayer` (Stufe 4) ist ein separates Interface mit eigenen Direktiven – eigener Workstream

## Offene Fragen

- [ ] Media-Endpoint am öffentlichen Host (Reverse-Proxy) konkret ausgestalten (Stufe 2)
- [ ] APL-Viewport-Anpassung je Echo-Show-Modell
