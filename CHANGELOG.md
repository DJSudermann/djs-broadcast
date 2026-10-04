# Changelog

## [1.0.0] - 2026-10-04

- Erste stabile Veröffentlichung von `djs-broadcast`.
- Gruppen- und Rollenfreigaben mit anpassbarer Administration.
- Personalisierte Vorschau und Versand über den ChurchTools-Chat.
- Optionale Analytics-Benachrichtigungen und automatische Darkmode-Anpassung.
- Konfiguration und Versand kommen ohne fest hinterlegte personen- oder gemeindebezogene Daten aus.

## [0.0.18] - 2026-10-03

- Analytics-Empfänger werden vor dem Versand direkt anhand ihrer gespeicherten Personen-ID aufgelöst.
- Der Analytics-Versand benötigt dadurch im Normalfall keinen Zugriff auf die Mitgliederliste der Admin-Gruppe mehr.
- Bestehende Konfigurationen bleiben unverändert kompatibel; die Admin-Gruppe dient weiterhin als Rückfallweg.

## [0.0.17] - 2026-10-03

- Analytics-Empfänger werden auch dann benachrichtigt, wenn normale Broadcast-Absender die Admin-Gruppe nicht einsehen dürfen.
- Bereits bekannte, erfolgreiche Broadcast-Empfänger werden für die Analytics-Zustellung wiederverwendet und dabei dedupliziert.
- Erfolg oder Fehler der Analytics-Zustellung werden nach dem Broadcast sichtbar angezeigt.

## [0.0.16] - 2026-10-03

- Die Empfängerrollen können für jeden Broadcast wieder einzeln ausgewählt werden.
- Beim Auswählen einer Gruppe sind zunächst alle chatfähigen Rollen markiert; die Empfängerliste wird nach jeder Änderung aktualisiert.

## [0.0.15] - 2026-10-03

- Vorabversion von `djs-broadcast` für die abschließende Prüfung vor 1.0.0.
- Gruppen- und Rollenfreigaben, anpassbare Administration, Analytics-Empfänger und ChurchTools-Darkmode.
- Absender werden von Broadcast- und Analytics-Nachrichten ausgeschlossen.
- Platzhalter aus Standard- und ChurchTools-Katalog werden ohne doppelte Einträge zusammengeführt.
- Lokaler Testmodus und umgebungsbasierte Zugangsdaten entfernt.
