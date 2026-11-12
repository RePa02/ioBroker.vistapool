# Discovery-Skript

Dieses Skript prüft, ob dein Vistapool-Konto über die Cloud lesbar ist. Es erfasst außerdem **alle** Datenpunkte, die deine Anlage liefert. Damit lassen sich auch an anderen Anlagen unbekannte Felder und Steuerungen finden. Das Ergebnis (anonymisiert) gern als Issue anhängen.

**Das Skript sendet keine Befehle.** Es meldet sich nur an und liest Daten.

## Dateien

| Datei | Zweck |
|---|---|
| `poc.js` | Das Skript (Node.js ≥ 18, keine weiteren Pakete nötig) |
| `datapoints.js` | Katalog aller bekannten Datenpunkte (83, davon 36 steuerbar). Den übernimmt später der Adapter. |

## Ausführen (am besten auf dem ioBroker-Host)

```bash
mkdir -p ~/vistapool-poc && cd ~/vistapool-poc
# poc.js und datapoints.js hierher kopieren

# 1) Bestandsaufnahme inkl. Verlaufsdaten
node poc.js --stats

# 2) Steuerungen entdecken: 15 Minuten mitschreiben, was sich ändert
node poc.js --watch 15 --interval 10
```

Das Skript fragt nach E-Mail und Passwort deines Vistapool-Kontos. Das Passwort wird bei der Eingabe nicht angezeigt. Alternativ kannst du die Zugangsdaten als Variablen übergeben:

```bash
VISTAPOOL_EMAIL='du@example.de' VISTAPOOL_PASSWORD='…' node poc.js --stats
```

## Watch-Modus: so findest du alle Steuerungen

Während `--watch` läuft, änderst du in der Vistapool-App nacheinander jeweils **eine** Einstellung. Warte nach jeder Änderung etwa 30 Sekunden. Das Skript zeigt dann, welches Feld sich geändert hat. Felder, die noch nicht im Katalog stehen, sind mit `[NEU, nicht im Katalog]` markiert.

Vorschlag für die Reihenfolge:

1. Filtration aus und wieder an
2. Pumpenmodus: Manuell, Auto, Heizen, Smart, Intel (danach zurück auf deinen Normalmodus)
3. Pumpendrehzahl ändern
4. Heizung ein und aus, Solltemperatur ändern
5. Licht ein und aus, Lichtmodus ändern
6. Relais/AUX schalten, falls vorhanden
7. Elektrolyse-Sollwert, Boost und Abdeckung
8. pH- und Redox-Sollwerte (nur kurz ändern und dann sofort zurückstellen)

Notiere grob die Uhrzeiten, damit sich jede Änderung im Protokoll einer Aktion in der App zuordnen lässt.

## Ergebnis

Das Skript legt den Ordner `vistapool-output/` an:

| Datei | Inhalt |
|---|---|
| `bericht.md` | Übersicht: erkannte Datenpunkte, fehlende Module, unbekannte Felder |
| `POOL_1.json` | Komplettes Pool-Dokument, **anonymisiert** |
| `POOL_1-datenpunkte.csv` | Alle Datenpunkte als Tabelle |
| `POOL_1-stats.json` | Stichprobe der Verlaufsdaten (nur mit `--stats`) |
| `aenderungen.log` | Protokoll aus dem Watch-Modus |
| `zusammenfassung.json` | Kennzahlen |

Hänge den Ordner (z. B. als ZIP) an ein [Issue](https://github.com/RePa02/ioBroker.vistapool/issues) an.

**Anonymisierung:** Namen, E-Mail-Adressen, Adresse, Geokoordinaten, Gateway- und Pool-ID werden durch `***` bzw. `POOL_1` ersetzt. Schau trotzdem kurz in die JSON-Datei, bevor du sie weitergibst. Die Option `--raw` schaltet die Anonymisierung ab. Diese Ausgabe ist nur für dich lokal gedacht.

## Wenn etwas schiefgeht

| Meldung | Bedeutung |
|---|---|
| `Anmeldung fehlgeschlagen … INVALID_LOGIN_CREDENTIALS` | E-Mail oder Passwort falsch. Teste dieselben Daten unter hayward-europe.web.app. |
| `Netzwerkfehler bei …` | Der Host erreicht die Google-/Firebase-Server nicht (Firewall, DNS, Proxy) |
| `Firestore … HTTP 403` | Anmeldung hat geklappt, aber der Lesezugriff wurde verweigert. Bitte mit dieser Meldung ein Issue anlegen. |
| `Keine Pools im Benutzerdokument` | Das Konto hat keinen registrierten Pool. `user.json` wurde zur Analyse gespeichert. |

## Hintergrund

- Anmeldung: Firebase Identity Toolkit (dieselbe Methode wie die Web-App hayward-europe.web.app)
- Daten: Firestore-Dokumente `users/{uid}` und `pools/{poolId}`
- Verlauf: Cloud Function `getStats`
- Katalog abgeleitet aus der Home-Assistant-Integration `vistapool` (HA 2026.11.1) und der Bibliothek [aioaquarite](https://github.com/fdebrus/aioaquarite) (MIT)
