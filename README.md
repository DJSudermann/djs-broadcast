# djs-broadcast

Kürzel für die Extension: djs-broadcast

`djs-broadcast` ist eine ChurchTools-Erweiterung für personalisierte Privatnachrichten an aktive, chatfähige Mitglieder freigegebener Gruppen. Absender ist immer die angemeldete Person; Vorlagen können ChurchTools-Platzhalter verwenden.

## Funktionen

- zentrale Freigabe von Gruppen und Rollen
- zusätzliche Prüfung der aktiven Mitgliedschaft und Chat-Schreibberechtigung
- auswählbare Empfängerrollen; Versand an deren aktive, chatfähige Mitglieder, ausgenommen der Absender
- personalisierte Vorschau und Versand über den ChurchTools-Chat
- optionale Analytics-Benachrichtigung an ausgewählte Personen der Admin-Gruppe, ausgenommen der jeweilige Absender
- automatische Anpassung an den ChurchTools-Darkmode

## Erste Konfiguration

Beim ersten Aufruf wählt eine berechtigte Person eine Admin-Gruppe und deren verantwortliche Rollen. Diese Auswahl bestimmt, wer den Admin-Bereich öffnen und spätere Freigaben verwalten darf.

Im Admin-Bereich werden anschließend die nutzbaren Gruppen und Rollen ausgewählt. Das Modul synchronisiert dabei – sofern der angemeldete Admin die nötigen ChurchTools-Rechte besitzt – auch das native Anzeigen-Recht für `djs-broadcast`. Admin-Gruppe, Admin-Rollen und Freigaben können später angepasst werden.

## Entwicklung

```bash
npm install
npm test
npm run build
```

Mit `npm run deploy` wird `releases/djs-broadcast-v<version>.zip` erzeugt.
