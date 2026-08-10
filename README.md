# Call Recovery

Kein verpasster Anruf soll mehr zu einer verlorenen Bestellung führen.

Ein Vapi-Voice-Agent nimmt Anrufe entgegen. Endet ein Anruf ohne abgeschlossene
Bestellung, schickt dieser Dienst dem Anrufer automatisch eine WhatsApp-Nachricht
mit einer kurzen Referenz (`R-7F3K`) und benachrichtigt den Betreiber. Alles
lokal-first: SQLite-Datei, keine Cloud-Abhängigkeit, kein Framework-Ballast.

Bewusst schmal gehalten: nur der Teil mit dem messbaren ROI, dafür produktiv
einsetzbar. Versand läuft wahlweise über einen Konsolen-Stub oder echtes
WhatsApp via Twilio.

## Setup

Voraussetzung: Node.js ≥ 20 (getestet mit 22).

```bash
npm install
cp .env.example .env      # ausfüllen, siehe unten
npm test                  # 145 Tests
npm run dev               # Server auf http://localhost:3000
```

### Konfiguration

Alle Variablen werden beim Start mit Zod validiert. Fehlt eine Pflichtvariable
oder ist eine ungültig, bricht der Start ab und nennt **alle** Probleme auf
einmal — nicht eines pro Neustart.

| Variable | Pflicht | Default | Bedeutung |
|---|---|---|---|
| `VAPI_WEBHOOK_SECRET` | ja | — | Secret der Vapi-Server-URL, kommt als `x-vapi-secret` zurück |
| `VAPI_SIGNATURE_MODE` | nein | `shared_secret` | `shared_secret` oder `hmac_sha256` |
| `WHATSAPP_PROVIDER` | nein | `stub` | `stub` loggt nur; `twilio` versendet echt; `meta_cloud` noch nicht gebaut |
| `OWNER_PHONE` | ja | — | Zielnummer der Owner-Benachrichtigung, E.164 |
| `DATABASE_PATH` | nein | `./data/recovery.sqlite` | SQLite-Datei, Verzeichnis wird angelegt |
| `PORT` | nein | `3000` | HTTP-Port |
| `TIMEZONE` | nein | `Europe/Zurich` | Zeitzone für Uhrzeiten in der Owner-Meldung |

Mit `WHATSAPP_PROVIDER=twilio` kommen sieben weitere Pflichtvariablen dazu
(`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM` und vier
`TWILIO_CONTENT_SID_*`). Sie werden im selben Durchgang geprüft — ein frisches
Setup sieht alle fehlenden Werte auf einmal, nicht einen pro Neustart.

`OWNER_PHONE` wird normalisiert: `0041 79 000 00 00` wird zu `+41790000000`.

### Skripte

| Befehl | Zweck |
|---|---|
| `npm run dev` | Server mit Auto-Reload |
| `npm test` | Vitest, einmalig |
| `npm run test:watch` | Vitest im Watch-Modus |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` / `npm start` | Kompilieren und kompiliert starten |
| `npm run simulate` | End-to-End ohne HTTP (siehe unten) |
| `npm run send-test` | Eine echte Nachricht über den konfigurierten Provider |

## Ausprobieren

### Ohne HTTP

```bash
npm run simulate                                        # Anruf + identischer Retry
npm run simulate -- --partial --name Meier --once       # unvollständige Bestellung
npm run simulate -- --completed --once                  # wird übersprungen
npm run simulate -- --phone "0041 79 111 22 33" --once  # Normalisierung
```

### Über den Webhook

Server starten (`npm run dev`), dann einen End-of-Call-Webhook simulieren. Das
Secret muss dem `VAPI_WEBHOOK_SECRET` aus der `.env` entsprechen:

```bash
curl -i -X POST http://localhost:3000/webhooks/vapi \
  -H 'content-type: application/json' \
  -H 'x-vapi-secret: dev-secret-change-me' \
  -d '{
    "message": {
      "type": "end-of-call-report",
      "endedReason": "customer-hung-up",
      "startedAt": "2026-08-09T12:30:00.000Z",
      "endedAt": "2026-08-09T12:32:00.000Z",
      "customer": { "number": "+41791234567" },
      "phoneNumber": { "number": "+41445556677" },
      "call": { "id": "vapi-call-demo-1" },
      "analysis": {
        "structuredData": {
          "callerName": "Meier",
          "orderCompleted": false,
          "items": [{ "sku": "BIER-50", "qty": 2 }]
        }
      }
    }
  }'
```

Antwort:

```json
{"outcome":"notified","recoveryId":"R-MPP4","reason":"incomplete_order","retriedPending":false,"ownerNotified":true}
```

Im Server-Log stehen beide Nachrichten im Klartext:

```
[whatsapp:stub] channel=customer to=+41791234567 ref=R-MPP4
  template=customer_incomplete_order lang=de {{1}}=R-MPP4
  Guten Tag, Ihre Bestellung mit der Referenz R-MPP4 ist noch nicht abgeschlossen. Antworten Sie hier, um sie fertigzustellen. Vielen Dank!
[whatsapp:stub] channel=owner to=+41790000000 ref=R-MPP4
  template=owner_lost_order lang=de {{1}}=+41791234567 {{2}}=Meier {{3}}=Unvollständige Bestellung {{4}}=R-MPP4 {{5}}=14:32
  ⚠️ Mögliche verlorene Bestellung
  Nummer: +41791234567
  Name: Meier
  Grund: Unvollständige Bestellung
  Referenz: R-MPP4
  Zeit: 14:32 Uhr
```

Der Stub zeigt beides: das Template-Payload, das ein echter Provider verschickt,
und darunter den Text, den der Empfänger liest.

Derselbe Befehl ein zweites Mal ausgeführt sendet **nichts** mehr:

```json
{"outcome":"duplicate","recoveryId":"R-MPP4","status":"notified"}
```

Ohne den `x-vapi-secret`-Header antwortet der Endpoint mit `401`.

### Statuscodes

Bewusst danach gewählt, wie Vapi darauf reagiert:

| Code | Fall | Vapi |
|---|---|---|
| `200` | benachrichtigt, Duplikat, übersprungen, ignorierter Nachrichtentyp | kein Retry |
| `401` | Secret fehlt oder falsch | kein Retry |
| `400` | kaputtes JSON oder nicht mappbares Payload | Retry hilft nicht |
| `503` | Kunde vorübergehend nicht erreichbar | Retry erwünscht — wir sind idempotent |
| `200` | Kunde dauerhaft nicht erreichbar (`send_rejected`) | Retry zwecklos, Owner wurde informiert |

## WhatsApp scharfschalten

### Die Regel, die alles bestimmt

WhatsApp erlaubt frei formulierten Text nur innerhalb von 24 Stunden nach der
letzten Nachricht **des Kunden auf WhatsApp**. Ein Telefonanruf öffnet dieses
Fenster nicht. Jede Recovery-Nachricht ist deshalb business-initiated und muss
als vorab genehmigtes **Template** verschickt werden. Ohne genehmigte Templates
geht keine einzige Nachricht raus — das ist der lange Pol beim Setup.

### Templates einreichen

Im Twilio Content Template Builder anlegen, Sprache `de`, zur WhatsApp-Freigabe
einreichen. Jedes Template liefert eine Content SID (`HX…`) für die `.env`.

**1. `verpasster_anruf_de`** → `TWILIO_CONTENT_SID_CUSTOMER_MISSED_CALL`
```
Guten Tag, wir haben Ihren Anruf leider verpasst. Möchten Sie Ihre Bestellung
schnell per WhatsApp aufgeben? Antworten Sie einfach direkt hier – wir kümmern
uns darum. Ihre Referenz: {{1}}. Vielen Dank!
```

**2. `bestellung_unvollstaendig_de`** → `TWILIO_CONTENT_SID_CUSTOMER_INCOMPLETE_ORDER`
```
Guten Tag, Ihre Bestellung mit der Referenz {{1}} ist noch nicht abgeschlossen.
Antworten Sie hier, um sie fertigzustellen. Vielen Dank!
```

**3. `owner_verlorene_bestellung_de`** → `TWILIO_CONTENT_SID_OWNER_LOST_ORDER`
```
⚠️ Mögliche verlorene Bestellung
Nummer: {{1}}
Name: {{2}}
Grund: {{3}}
Referenz: {{4}}
Zeit: {{5}} Uhr
```

**4. `owner_whatsapp_unzustellbar_de`** → `TWILIO_CONTENT_SID_OWNER_UNDELIVERABLE`
```
⚠️ WhatsApp nicht zustellbar
Nummer: {{1}}
Referenz: {{2}}
Fehler: {{3}}
Bitte den Kunden manuell zurückrufen.
```

Templates 2–4 sind klar *Utility*. Template 1 kann als *Marketing* eingestuft
werden, weil es zu einer neuen Bestellung einlädt. Falls das stört, diese
Variante zusätzlich einreichen — sie bindet die Nachricht an ein konkretes
Ereignis statt an ein Angebot:

```
Guten Tag, Ihr Anruf bei uns um {{1}} Uhr ist leider abgebrochen. Antworten Sie
direkt hier, um Ihre Bestellung aufzunehmen. Ihre Referenz: {{2}}. Vielen Dank!
```

Die Reihenfolge der Variablen muss zu `src/core/messages.ts` passen — die Tests
dort prüfen sie.

### Ersten echten Versand auslösen

```bash
npm run send-test -- --to +41791234567                              # Kunde, verpasster Anruf
npm run send-test -- --to +41791234567 --template customer_incomplete_order
npm run send-test -- --owner                                        # an OWNER_PHONE
```

Mit `WHATSAPP_PROVIDER=stub` wird nur geloggt — der Befehl ist also auch ohne
Credentials gefahrlos. In der Twilio-Sandbox muss die Zielnummer vorher einmalig
den Join-Code an die Sandbox-Nummer schicken; das ist Twilios Opt-in, kein Fehler.

### Was ein erfolgreicher Versand bedeutet

Ein `201 Created` von Twilio heißt **angenommen**, nicht **zugestellt**. Die
Zustellbestätigung käme über einen Status-Callback, der bewusst noch nicht
gebaut ist.

### Fehlerbehandlung

| Klasse | Beispiele | Recovery-Status | Antwort an Vapi |
|---|---|---|---|
| transient | 429, 5xx, Timeout, Netzfehler | bleibt `pending` | `503`, Retry erwünscht |
| permanent | Nummer nicht bei WhatsApp, Template nicht frei, 401 | wird `closed` | `200`, Retry zwecklos |

Transiente Fehler werden im Adapter bis zu dreimal mit Exponential-Backoff und
Jitter wiederholt; ein `Retry-After` des Providers schlägt die eigene Kurve.

Bei einem **permanenten** Fehler bekommt der Owner Template 4 mit der Bitte um
Rückruf. Ohne das würde genau der häufigste Fall — Nummer ohne WhatsApp — den
Anruf still verschwinden lassen.

## Architektur

Kern-Logik und austauschbare Adapter sind strikt getrennt.

```
src/
  core/                     # keine Adapter, kein fetch, kein SQL, kein HTTP
    types.ts                # Domain-Typen + Ports (Clock, Logger)
    messages.ts             # deutsche Templates, reine Funktionen
    phone.ts                # E.164-Normalisierung
    recovery-id.ts          # "R-7F3K"-Generator
    recovery-service.ts     # decide() pur + handle() Orchestrierung
  interfaces/
    intake/
      vapi-webhook.ts       # HTTP-Route
      vapi-signature.ts     # Shared Secret / HMAC, timing-safe
      vapi-mapping.ts       # rohes Vapi-Payload -> IncomingCallEvent
    messaging/
      messaging-port.ts     # MessagingAdapter + MessagingError
      retry.ts              # Backoff mit Jitter
      whatsapp-http.ts      # gemeinsame HTTP-Basis (Timeout, Retry, Sanitizing)
      stub-messaging.ts     # loggt Nachrichten (Default)
      twilio-messaging.ts   # echter Versand über Twilio
    persistence/
      persistence-port.ts   # CustomerRepo + CallRecoveryRepo
      sqlite-persistence.ts # better-sqlite3 (Default)
      in-memory-persistence.ts
  config.ts                 # ENV via Zod
  app.ts                    # Wiring — die einzige Stelle, die Adapter kennt
  server.ts                 # HTTP-Bootstrap
```

**Adapter tauschen** heißt: eine neue Datei, die das Port-Interface
implementiert, plus eine Zeile in `app.ts`. In `core/` ändert sich nichts. Die
Persistence-Ports sind bereits `Promise`-basiert, damit ein späterer
Airtable- oder Postgres-Adapter keine Signaturänderung im Kern erzwingt.

**Vapi-Payload ändert sich?** Dann ändert sich `vapi-mapping.ts` — und sonst
nichts. Kein Vapi-Feldname existiert außerhalb dieser Datei.

### Datenmodell

```
customers
  id, phone (UNIQUE, E.164), name, created_at

call_recoveries
  recovery_id (PK, "R-7F3K"), customer_id, call_id (UNIQUE),
  reason ("missed_call" | "incomplete_order"),
  status ("pending" | "notified" | "resumed" | "closed"),
  partial_order (JSON), created_at, notified_at
```

Das Schema wird beim Start idempotent angelegt, ein Migrations-Framework gibt es
in Phase 1 nicht.

### Idempotenz

Vapi wiederholt Webhooks. `call_id` ist deshalb `UNIQUE` — der Constraint, nicht
ein vorheriges `SELECT`, ist die Garantie, auch wenn zwei Retries gleichzeitig
eintreffen.

Ein Datensatz auf `pending` bedeutet: der Kunde wurde nachweislich **nicht**
erreicht. Ein erneuter Webhook holt den Versand dann nach, unter derselben
Referenz. Jeder andere Status führt zu `duplicate` ohne weiteren Versand.

Die Kundennachricht geht vor der Owner-Meldung raus. Scheitert die Owner-Meldung,
bleibt die Recovery trotzdem `notified` (`ownerNotified: false` im Log) — ein
erreichter Kunde wird nicht wegen einer fehlgeschlagenen internen Notiz verworfen.

## Noch nicht gebaut

Bewusst ausgeklammert, die Ports bleiben offen:

- vollständige Vapi-Agent-Konfiguration
- Order-Placement-Workflow
- Resume-Konversation (Kundenantwort verarbeiten)
- Meta Cloud API als zweiter Provider (eine Datei, eine Zeile im Wiring)
- Zustellstatus-Callbacks (`sent`/`delivered`/`read`/`failed`)
- Airtable-Persistenz
- Dashboard / UI
