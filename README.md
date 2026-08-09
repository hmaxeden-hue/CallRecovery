# Call Recovery — Phase 1

Kein verpasster Anruf soll mehr zu einer verlorenen Bestellung führen.

Ein Vapi-Voice-Agent nimmt Anrufe entgegen. Endet ein Anruf ohne abgeschlossene
Bestellung, schickt dieser Dienst dem Anrufer automatisch eine WhatsApp-Nachricht
mit einer kurzen Referenz (`R-7F3K`) und benachrichtigt den Betreiber. Alles
lokal-first: SQLite-Datei, keine Cloud-Abhängigkeit, kein Framework-Ballast.

Phase 1 ist bewusst schmal — sie deckt genau den Teil mit dem messbaren ROI ab.

## Setup

Voraussetzung: Node.js ≥ 20 (getestet mit 22).

```bash
npm install
cp .env.example .env      # ausfüllen, siehe unten
npm test                  # 88 Tests
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
| `WHATSAPP_PROVIDER` | nein | `stub` | `stub` loggt nur; `twilio`/`meta_cloud` folgen in Phase 2 |
| `OWNER_PHONE` | ja | — | Zielnummer der Owner-Benachrichtigung, E.164 |
| `DATABASE_PATH` | nein | `./data/recovery.sqlite` | SQLite-Datei, Verzeichnis wird angelegt |
| `PORT` | nein | `3000` | HTTP-Port |
| `TIMEZONE` | nein | `Europe/Zurich` | Zeitzone für Uhrzeiten in der Owner-Meldung |

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
  Guten Tag, Ihre Bestellung ist noch nicht abgeschlossen. Antworten Sie hier, um sie fertigzustellen. Ihre Referenz: R-MPP4.
[whatsapp:stub] channel=owner to=+41790000000 ref=R-MPP4
  ⚠️ Mögliche verlorene Bestellung — Nr.: +41791234567 · Name: Meier · Grund: Unvollständige Bestellung · Ref: R-MPP4 · Zeit: 14:32.
```

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
| `503` | Kunde konnte nicht erreicht werden | Retry erwünscht — wir sind idempotent |

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
      messaging-port.ts     # MessagingAdapter
      stub-messaging.ts     # loggt Nachrichten (Default)
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

## Nicht in Phase 1

Bewusst ausgeklammert, die Ports bleiben offen:

- vollständige Vapi-Agent-Konfiguration
- Order-Placement-Workflow
- Resume-Konversation (Kundenantwort verarbeiten)
- echter WhatsApp-Provider (Twilio, Meta Cloud API)
- Airtable-Persistenz
- Dashboard / UI
