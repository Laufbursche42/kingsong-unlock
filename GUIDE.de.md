# Anleitung

> **Wichtig für Fehler-Reports:** Schalte unten auf der Seite den **Diagnose-Log** ein, *bevor* du dich mit dem Scooter verbindest. Nur dann wird der komplette Verbindungsaufbau mitgeschnitten - und genau diese Zeilen brauchen wir in einem [Ticket](https://github.com/Laufbursche42/Laufbursche42/issues), um ein Problem nachzuvollziehen.

## Was du brauchst
- Ein KingSong Elektro-Einrad (EUC).
- Ein Handy oder einen Rechner mit **Chrome**, **Edge** oder auf iOS **Bluefy**. Safari und Firefox können kein Web Bluetooth.

## Verbinden
1. Bluetooth am Gerät einschalten, das Rad einschalten (wecken).
2. Auf **Verbinden** tippen und das Rad in der Liste auswählen.
3. Taucht es nicht auf, setze den Haken bei **Alle Geräte zeigen** und verbinde erneut. Der echte Test ist der gefundene Bluetooth-Dienst (FFE0 oder AD00), nicht der angezeigte Name.
4. Nach dem Verbinden erscheinen die Karten für empfangene Daten, Sperre, Geschwindigkeit und Einstellungen.

## Empfangene Daten lesen
Das Rad sendet laufend Frames. Die Byte-Positionen im Telemetrie-Frame sind nicht in benannte Werte wie Tempo oder Akku aufgeschlüsselt, darum zeigt die Karte **Empfangene Daten** jeden Frame roh nach Opcode. Geraten wird hier nichts.

## Geschwindigkeit setzen
- **Setzen** schreibt den Max-Speed-Wert aus dem Feld als Opcode 0x87 (Byte 4). Das ist zugleich der Weak-Magnetic-Overclock-Pfad.
- Die Knöpfe **km/h** und **mph** schalten die Einheit um (Opcode 0x8B bzw. 0x8A) und tragen den gleichen Wert mit.
- Wichtig: Ein Echo im Log heißt nur, dass das Rad das Frame angenommen hat. Ob die Firmware den Wert wirklich übernimmt und in welcher Skalierung, musst du an deinem Gerät ausprobieren. Ein Rücklesen des aktuellen Limits ist mangels Telemetrie nicht möglich.

## Elektronische Sperre
In der Karte **Elektronische Sperre** schaltest du den Stop-Schalter des Rads (Opcode 0x7E). Ob das ein echter Diebstahlschutz oder nur ein Fahr-Stopp ist hängt vom Modell ab. Entsperren hebt die Sperre wieder auf.

## Weitere Einstellungen
Scheinwerfer (0x6C) und Pedal-Modus (0x1B). Die Zeilen sind sichtbar sobald du verbunden bist, denn ihre aktuellen Werte lassen sich nicht zurücklesen.

## Erweiterte Einstellungen (Engine-Ebene)
**Rohes Frame** sendet deine Hex-Bytes unverändert. **Frame bauen** nimmt Opcode und Payload und ergänzt Header (AA 55), Länge und Footer (5A 5A) selbst.

## Shortcuts
Kopiere den Link auf den Startbildschirm, dann ent- oder sperrt ein Tipp direkt. Auf iOS über Bluefy, und das Rad muss vorher einmal normal verbunden gewesen sein.

## Wenn etwas nicht geht
- Kein Verbinden? Prüfe, dass der Browser Web Bluetooth kann, Bluetooth an ist und das Rad wach ist. Mit **Alle Geräte zeigen** erneut versuchen.
- Nichts passiert nach einem Befehl? Schau ins Log: steht dort "gesendet" aber kein "bestätigt", hat das Rad das Frame nicht quittiert. Beachte, dass KingSong seine Init-Kommandos vom Server holt. Ohne diesen Handshake kann die Firmware einen Schreibbefehl ignorieren.
- **Diagnose: alle Geräte auflisten** im Log-Bereich zeigt alle Bluetooth-Dienste eines Geräts, ohne etwas zu schreiben - hilfreich für Support.

## Mithelfen
Willst du herausfinden, ob und wie Tuning bei deinem Scooter geht? Teste dieses Tool an deinem eigenen Fahrzeug und öffne ein Ticket auf [GitHub](https://github.com/Laufbursche42/Laufbursche42/issues) - mit deinem Modell und was funktioniert hat (oder nicht). So finden wir gemeinsam heraus, was bei welchem Modell möglich ist.
