# Roscoe

[![CI](https://github.com/michaelkrisper/saugi/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaelkrisper/saugi/actions/workflows/deploy.yml)
[![Lizenz: MIT](https://img.shields.io/badge/Lizenz-MIT-blue.svg)](LICENSE)
[![Biome](https://img.shields.io/badge/Code--Stil-Biome-60a5fa?logo=biome&logoColor=white)](https://biomejs.dev)
[![PWA](https://img.shields.io/badge/PWA-iOS%20%26%20Android-5a0fc8)](https://saugi.pages.dev)

Eine schnelle, schlanke Fernbedienung für Roborock-Saugroboter als PWA. Eine
einzige Seite statt der offiziellen App: Starten, Pausieren, nach Hause
schicken, und dazu die Live-Karte mit Position, Pfad und Sperrzonen.

**→ [saugi.pages.dev](https://saugi.pages.dev)**

<p align="center">
  <img src="docs/screenshot.png" width="340" alt="Hauptansicht: Status „Saugt", 76 % Akku, 12,3 m² in 14 Minuten, darunter die Karte mit farbigen Räumen, Fahrspur, Roboter, Ladestation, einer No-Go-Zone und einer Wischsperrzone, unten die Buttons Pause und Nach Hause">
</p>

## Funktionen

- **Start / Pause / Fortsetzen** und **Nach Hause**, mehr nicht. Eine pausierte
  Raum- oder Zonenreinigung wird fortgesetzt statt neu gestartet.
- **Live-Karte** mit Raumnamen, Fahrspur der laufenden Reinigung, Roboter samt
  Blickrichtung und Ladestation. Während der Fahrt alle 3 Sekunden neu.
- **No-Go-Zonen** (rot), **Wischsperrzonen** (lila) und **virtuelle Wände**.
- **Status**: Zustand, Akku, gereinigte Fläche und Dauer.
- **Startet sofort**: App-Shell offline im Service Worker, letzte Karte und
  letzter Status kommen aus dem Cache, die Live-Daten folgen.
- Fühlt sich nativ an: kein Zoom, kein Scrollen, Safe Areas, Dark Mode.

## Anmelden

Mit dem Roborock-Konto per E-Mail-Code, wie in der offiziellen App. Gespeichert
wird nur der IoT-Zugang im `localStorage` des Geräts; ein eigener Server, der
Zugangsdaten hält, existiert nicht.

Installieren: iOS über Safari → Teilen → „Zum Home-Bildschirm", Android über
Chrome → „App installieren".

Unterstützt werden Sauger mit dem Roborock-Protokoll `1.0` (etwa die S-Reihe);
Geräte mit den neueren Protokollen `A01`, `B01` oder `L01` werden beim Login
übersprungen. Entwickelt und getestet mit einem S7 (`roborock.vacuum.a15`).

## Wie es funktioniert

Der Browser spricht das Roborock-Protokoll selbst:

| Modul | Aufgabe |
| --- | --- |
| `public/js/api.js` | Login per E-Mail-Code, Gerätedaten (Hawk-signierte REST-Aufrufe) |
| `public/js/mqtt.js` | Minimaler MQTT-3.1.1-Client über WebSocket |
| `public/js/protocol.js` | Nachrichtenformat `1.0`, AES-ECB mit Zeitstempel-Schlüssel, Kartenantworten |
| `public/js/crypto.js` | MD5, CRC32, AES-ECB auf Basis von WebCrypto |
| `public/js/map.js` | Kartenformat parsen (Bild, Pfad, Roboter, Zonen) und rastern |
| `public/js/app.js` | Oberfläche, Polling, Befehle |

Ganz ohne Server geht es trotzdem nicht: Die Roborock-API sendet keine
CORS-Header, und der MQTT-Broker lauscht nur auf rohem TLS (Port 8883), das ein
Browser nicht öffnen kann. Zwei zustandslose Cloudflare Pages Functions reichen
deshalb nur Bytes durch, ausschließlich zu `*.roborock.com`:

- `functions/rest/[[path]].js`: `/rest/<host>/<pfad>` → `https://<host>/<pfad>`
- `functions/mqtt.js`: WebSocket ↔ TLS-Socket zum Broker

Die Gerätebefehle bleiben dabei mit dem Geräteschlüssel AES-verschlüsselt.

## Entwicklung

Kein Build-Schritt, keine Laufzeit-Abhängigkeiten. Node ≥ 24.

```sh
npm install
npm run dev      # wrangler pages dev auf http://localhost:8792
npm run check    # Biome + Tests
npm run deploy   # Cloudflare Pages (Branch main)
node scripts/browser-check.mjs http://localhost:8792   # Headless-Chrome-Smoke-Test
```

Die Tests (`tests/protocol.test.js`) vergleichen MD5, CRC32, AES, das
Nachrichtenformat, die Hawk-Signatur und den Kartenparser byte-genau mit
Referenzwerten aus python-roborock. Der Smoke-Test meldet sich mit absichtlich
falschen Zugangsdaten an und fährt deshalb nie einen echten Sauger an.

Jeder Push auf `main` läuft durch Lint und Tests und wird danach deployt,
sofern das Secret `CLOUDFLARE_API_TOKEN` gesetzt ist.

## Danksagung

Protokoll und Kartenformat sind Portierungen von
[python-roborock](https://github.com/Python-roborock/python-roborock) und
[vacuum-map-parser-roborock](https://github.com/PiotrMachowski/Python-package-vacuum-map-parser-roborock)
(beide Apache-2.0). Die Testkarten in `tests/fixtures/*.bin` stammen aus den
Testdaten von python-roborock.

Kein offizielles Roborock-Produkt.

## Lizenz

[MIT](LICENSE)
