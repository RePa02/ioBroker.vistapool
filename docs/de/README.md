![Logo](../../admin/vistapool.png)

# ioBroker.vistapool – Anleitung

Cloud-Anbindung für Poolsteuerungen von **Vistapool / Hayward AquaRite / Sugar Valley** (auch Kripsol, Dagen, Poolwatch, Oxilife, Hidrolife …) über das Vistapool-Konto. Zusätzliche Hardware ist nicht nötig, das WLAN-Modul der Anlage genügt.

> Status: **Beta.** Getestet an einer Anlage (Hydrolyse in %, pH-Säure, Redox, Pumpe mit fester Drehzahl, ohne Rückspülung). Rückmeldungen zu anderen Anlagen sind sehr willkommen, siehe [Hilfe bei anderen Anlagen](#hilfe-bei-anderen-anlagen).

## Funktionen

- Liest **alle Werte** der Anlage. Module, die die Anlage nicht hat, werden nicht angelegt.
- **Push-Aktualisierung** wie in der Vistapool-App: Änderungen kommen innerhalb von Sekunden. Ist Push nicht verfügbar, fragt der Adapter automatisch im Intervall ab (Standard 30 s) und wechselt so bald wie möglich zurück.
- **Steuerbar:** Filtration ein/aus, Pumpenmodus und Drehzahl, Zeitfenster, Heizung und Smart-Temperaturen, Hydrolyse-/Elektrolyse-Sollwert, Boost, Abdeckung, pH- und Redox-Sollwerte, Relais AUX 1–4 (Modus, Zeitplan, Tempo, Kopplung), Licht (ein/aus, Modus, Zeitplan), LED-Farbwechsel, Uhrzeit.
- **Instanz-Seite** mit denselben Einstellungen wie die Vistapool-Web-App (siehe unten).
- Schreiben geht über die Instanz-Seite **und** über die Objekte (`ack=false`), also auch aus Skripten, Blockly, VIS oder Alexa.
- **Zuverlässige Befehle** bei schwachem WLAN:
  - Änderungen innerhalb einer Sekunde werden zu einem Befehl je Einstellungsbereich gebündelt, höchstens 6 Befehle pro Minute im Abstand von 3 s (nach Befehlsserien fällt die Steuerung sonst kurz aus dem WLAN).
  - Jeder Befehl wird auf Bestätigung geprüft. War die Steuerung offline, wird er nach ihrer Rückkehr erneut gesendet (höchstens zweimal). Befehle, die älter als 10 Minuten sind (einstellbar), werden verworfen, statt zu einer unerwarteten Zeit zu schalten.
  - Unmittelbar vor einem Befehl wird der aktuelle Stand gelesen, damit Änderungen aus der App nicht überschrieben werden.
  - Befehle, die die Steuerung im aktuellen Modus ignoriert (z. B. Licht ein im Auto-Modus), werden nicht wiederholt; im Log steht ein Hinweis.
- **Automatische Uhrzeit-Synchronisation:** Die Uhr der Steuerung driftet und kennt keine Sommerzeit, Zeitfenster laufen dann versetzt. Der Adapter stellt die Uhr, sobald sie mehr als 3 Minuten abweicht (einstellbar, höchstens alle 6 Stunden).
- **Fehlwert-Filter:** Beim Umschalten liefert die Cloud kurzzeitig unsinnige Werte (z. B. `interval1.to = -520093692`). Sie werden ignoriert und nie an die Anlage zurückgeschickt.
- Status-Datenpunkte je Pool: online, offline seit, letzte Meldung, offene Befehle, letzter Befehl und sein Status, Abweichung der Uhr.
- Optional alle Rohfelder der Cloud unter `raw.*` (zur Fehlersuche).

## Instanz-Seite

| Tab | Inhalt |
|---|---|
| Verbindung | Zugangsdaten, „Verbindung testen“ (geht schon vor dem Speichern), Push / Abfrageintervall, Verfall unbestätigter Befehle, Rohdaten, Uhrzeit-Synchronisation und Zeitzone |
| Anlage | Poolauswahl, erkannte Ausstattung, „Wo hängt was?“, Uhrzeit jetzt synchronisieren |
| Pumpe & Heizung | Pumpenmodus (Manuell, Auto, Heizen, Smart, Intel) mit den jeweils passenden Feldern: Zeitfenster 1–3, Drehzahl (nur bei drehzahlgeregelter Pumpe), Heizung, Smart-Temperaturen und Frostschutz, Intel-Temperatur und Filterstunden |
| Licht | Manuell ein/aus oder Zeitplan mit Wiederholung |
| Relais | AUX 1–4: Verwendung in ioBroker (z. B. Wärmepumpe), Name in der Steuerung, Modus Manuell / Auto (2 Zeitfenster) / Tempo (Laufzeit, Taster) / Gekoppelt (Signal, Verzögerung, Polarität) / Gekoppelt + Zeitplan |
| Wasserpflege | Hydrolyse/Elektrolyse (Produktion, Abdeckung + Reduktion, Boost), pH-, Redox-, Chlor- und Leitfähigkeits-Sollwert – nur was die Anlage hat |
| Rückspülung | Nur sichtbar, wenn vorhanden |

- Die Einstellungen der Anlage werden beim Öffnen direkt aus der Anlage geladen und nicht in der Instanz gespeichert.
- Jeder Tab hat einen eigenen Knopf **„An Anlage senden“** mit Rückfrage. Übertragen werden nur Felder, die von der Anlage abweichen; das Ergebnis steht darunter.
- **„Speichern“** speichert nur Adapter-Einstellungen (Zugangsdaten, Intervalle, Relais-Verwendung, Boost-Verhalten, Uhrzeit).

Voraussetzung: Admin ≥ 7.6.20, die Instanz muss laufen.

## Installation (Testversion)

Der Adapter ist noch nicht im ioBroker-Repository. Testversion direkt von GitHub:

- **Admin:** Adapter → Expertenmodus einschalten → „Installieren aus eigener URL“ (Katzen-Symbol) → Reiter „Benutzerdefiniert“ → `https://github.com/RePa02/ioBroker.vistapool` → Installieren. Danach eine Instanz hinzufügen.
- **Konsole:**

```bash
iobroker url https://github.com/RePa02/ioBroker.vistapool
iobroker add vistapool        # nur beim ersten Mal
```

Updates genauso installieren; die Instanz startet danach neu.

Danach in der Instanz E-Mail und Passwort des Vistapool-Kontos eintragen (dieselben wie in der App). Das Passwort wird verschlüsselt gespeichert.

## Objekte

```
vistapool.0.info.connection           Cloud erreichbar (Push oder Abfrage)
vistapool.0.info.push                 Push-Aktualisierung aktiv
vistapool.0.<poolId>                  Device = Pool (Name aus der App)
  ├─ measure.*      Temperatur, pH, Redox, Chlor, Leitfähigkeit, Produktion
  ├─ status.*       Filtration/Heizung/Dosierpumpen laufen
  ├─ alarm.*        Durchfluss, Tanks, Pumpenalarm
  ├─ filtration.*   ein/aus, mode, speed, Zeitfenster 1–3 (HH:MM), intelHours, intelTemp [steuerbar]
  ├─ heating.* / smart.*  Klima, Temperaturgrenzen                   [steuerbar]
  ├─ electrolysis.* Sollwert (% oder g/h), Boost, Abdeckung, Reduktion [steuerbar]
  ├─ setpoint.*     Redox, pH                                        [steuerbar]
  ├─ relay.*        AUX 1–4 ein/aus, Modus, Zeitplan, Ausgang aktiv  [steuerbar]
  ├─ light.*        ein/aus, Modus off/on/auto, Zeitplan             [steuerbar]
  ├─ button.*       syncTime, ledNext                                [steuerbar]
  ├─ modules.*      vorhandene Module
  ├─ info.*         online, offlineSince, lastUpdate, pendingCommands, lastCommand,
  │                 lastCommandStatus, clockDrift, lastClockSync, Firmware, RSSI
  └─ raw.*          alle Rohfelder (optional, nur lesen)
```

`filtration.mode`: 0 = manual, 1 = auto, 2 = heat, 3 = smart, 4 = intel. `relay.auxNMode`: 0 = manual, 1 = auto, 2 = tempo, 3 = linked, 4 = linked_auto. Du kannst die Zahl oder die Bezeichnung schreiben.

`info.lastCommandStatus`: `sent` (gesendet), `confirmed` (bestätigt), `retrying` (wird wiederholt), `expired` (nach der eingestellten Zeit verworfen), `failed` (nach zwei Wiederholungen nicht übernommen), `sent, not tracked` (von der Steuerung im aktuellen Modus ignoriert oder Uhrzeit), `error`.

Beispiel: Meldung, wenn ein Befehl nicht ankam

```js
on({ id: 'vistapool.0.*.info.lastCommandStatus', change: 'ne' }, obj => {
    if (['expired', 'failed', 'error'].includes(obj.state.val)) {
        const cmd = getState(obj.id.replace('lastCommandStatus', 'lastCommand')).val;
        sendTo('telegram.0', `Pool-Befehl nicht angekommen: ${cmd} (${obj.state.val})`);
    }
});
```

## Hinweise

- **WLAN:** Viele Poolsteuerungen stehen am Rand des WLANs. Solange die Steuerung offline ist, erreicht sie kein Befehl; er wird nach ihrer Rückkehr wiederholt (siehe oben). `info.online` und `info.offlineSince` zeigen den Zustand.
- **Uhrzeit und Zeitzone:** Die Synchronisation nutzt die Zeitzone des ioBroker-Servers. Läuft ioBroker in UTC (z. B. Docker ohne `TZ`), trage in der Instanz die Zeitzone der Anlage ein (z. B. `Europe/Berlin`), sonst bleibt die automatische Synchronisation aus.
- **Last auf der Cloud:** Das Abfrageintervall bitte nicht ohne Not verkleinern. Mit Push liest der Adapter nur alle 15 Minuten zur Sicherheit.
- **Relais-Namen** lassen sich nicht leeren – die Steuerung ignoriert leere Namen. **LED:** nur „nächste Farbe“, keine direkte Farbwahl.
- **Boost (Schockchlorung)** hält die Pumpe an – „Pumpe aus“ nimmt die Steuerung im manuellen Modus erst an, wenn der Boost aus ist. Der Adapter sendet den Befehl dann nicht und schreibt einen Hinweis ins Log.
- Befehle, die noch auf Bestätigung warten, gehen bei einem Neustart des Adapters verloren.
- **Bei Frost die Filtration nicht ausgeschaltet lassen.**

## Hilfe bei anderen Anlagen

Anlagen unterscheiden sich (drehzahlgeregelte Pumpe, Elektrolyse in g/h, pH-Base, Chlor-/Leitfähigkeitssonde, Rückspülung, UV, Ionisation, mehrere Pools im Konto). Wenn etwas fehlt oder falsch ist:

1. In der Instanz „Rohdaten unter raw.* anlegen“ einschalten oder das lesende [Discovery-Skript](../../tools/discovery/README.md) ausführen (es entfernt E-Mail-Adressen, Tokens und IDs).
2. Ein [Issue](https://github.com/RePa02/ioBroker.vistapool/issues) anlegen mit Modell der Steuerung, erwartetem Verhalten, den Debug-Log-Zeilen mit `sendPoolCommand` und der anonymisierten Discovery-Ausgabe.

## Haftung und Marken

Dies ist kein offizielles Produkt von Hayward oder Sugar Valley. Die Cloud-Schnittstelle ist nicht offiziell dokumentiert und kann sich jederzeit ändern oder eingeschränkt werden. Nutzung auf eigene Verantwortung.

Hayward, AquaRite, Vistapool, Sugar Valley, Kripsol und Dagen sind Marken ihrer jeweiligen Inhaber. Sie werden hier nur genannt, um die kompatiblen Geräte zu beschreiben.

Credits, Changelog und Lizenz: siehe [README](../../README.md).
