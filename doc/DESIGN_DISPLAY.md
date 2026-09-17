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
- Das dünne Lambda setzt immer `outputSpeech` und rendert auf Display-Geräten zusätzlich ein APL-Dokument aus dem Payload
- MCP-Server können Media-URLs liefern; LLM kann Bild-URLs aus Suchergebnissen ergänzen
- Deterministische Actions (z. B. „Hausstatus") definieren ihre Display-Ausgabe im Template

## Umgesetzt (17.09.): Scrollbare Textansicht (Stufe 1)

Alexa spricht die Antwort auf allen Geräten über den normalen
`outputSpeech`-Pfad. Echo Shows erhalten zusätzlich ein APL-Dokument mit einer
`ScrollView`, in der sich der Klartext manuell scrollen lässt. Damit bleibt die
Sprachausgabe unabhängig davon zuverlässig, ob und wann das Display-Dokument
gerendert wird.

- Der am 16.09. eingeführte kombinierte `RenderDocument`-/`SpeakItem`-Pfad
  wurde wegen Skill-Ausfällen zurückgenommen
- Sprachsynchrones Autoscroll bleibt offen und muss als eigener, auf echten
  Echo-Show-Geräten getesteter Ablauf wieder eingeführt werden
- Umsetzung: `alexa/lambda/lambda_function.py`

## Constraints (wichtig)

- Echo-Geräte holen Media **direkt aus dem Internet**: URLs müssen öffentlich per HTTPS erreichbar sein
- LAN-URLs (`192.168.x.x`) funktionieren nicht → LAN-Medien über den öffentlichen Host tunneln
  (z. B. `https://<host>/<sub-path>/media/…` mit Token-in-URL, kurzlebig)
- Formate: JPEG/PNG für Bilder; H.264/AAC MP4 oder HLS für Video
- `AudioPlayer` (Stufe 4) ist ein separates Interface mit eigenen Direktiven – eigener Workstream

## Offene Fragen

- [ ] Sprachsynchrones Autoscroll ohne Gefährdung des `outputSpeech`-Fallbacks
- [ ] Media-Endpoint am öffentlichen Host (Reverse-Proxy) konkret ausgestalten (Stufe 2)
- [ ] APL-Viewport-Anpassung je Echo-Show-Modell
