import { setTranslations } from "@mariozechner/mini-lit";
import { translations as webUiTranslations } from "@mariozechner/pi-web-ui";

declare module "@mariozechner/mini-lit" {
	interface i18nMessages {
		// Web-UI base keys (needed for type safety)
		"Delete this session?": string;
		Today: string;
		Yesterday: string;
		"{days} days ago": string;
		Sessions: string;
		"Load a previous conversation": string;
		"No sessions yet": string;
		messages: string;
		Delete: string;
		"Loading...": string;

		// Session tree dialog
		"Compacting context...": string;
		Browsing: string;
		Confirm: string;
		Cancel: string;
		"Enable extension": string;
		"Disable extension": string;
		"Uninstall extension": string;
		"Open downloaded file": string;
		"Sitegeist's agent wants to perform this action and needs your confirmation.": string;
		"Chrome requires this action to be triggered by a real user click. Confirming here provides that click; nothing happens if you cancel.": string;
		"The extension becomes active again.": string;
		"The extension stops running until re-enabled. Its settings are kept.": string;
		"This removes the extension and its data. Chrome will ask you to confirm again.": string;
		"Chrome opens the file with its default application.": string;
		"Cancelled by user in the confirmation dialog - nothing was changed.": string;
		"Browse follow": string;
		"Activity timeout (minutes)": string;
		"Controls how page navigations interact with the agent. Navigations are always recorded in the session history; whether they may trigger a response is gated below.": string;
		"When enabled, navigating to a page while the agent is idle (and you were active recently) wakes the agent to react to the page. Off by default.": string;
		"Navigations after this many minutes without a prompt are treated as idle browsing: they are recorded silently and never trigger or extend a response.": string;
		"Session branches": string;
		"Jump to a previous point; the next message starts a new branch there": string;
		"No branch points yet": string;
		You: string;
		Assistant: string;
		"Re-send": string;
		"Re-send this message as a new branch": string;
		Navigation: string;
		Compaction: string;
		"Continue from here": string;
		"Onward branches at this point": string;
		branches: string;

		// Sitegeist extension keys
		"Permission request failed": string;
		"JavaScript Execution Permission Required": string;
		"This extension needs permission to execute JavaScript code on web pages": string;
		"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.": string;
		"The AI can read and modify web page content when you ask it to": string;
		"Code runs in an isolated environment with security safeguards": string;
		"Network access is blocked to prevent data exfiltration": string;
		"You can revoke this permission at any time in browser settings": string;
		"Writing JavaScript code...": string;
		"Execute JavaScript": string;
		"Preparing JavaScript...": string;
		"Getting skill": string;
		"Got skill": string;
		"Listing skills": string;
		"Creating skill": string;
		"Created skill": string;
		"Updating skill": string;
		"Updated skill": string;
		"Rewriting skill": string;
		"Rewritten skill": string;
		"Deleting skill": string;
		"Processing skill...": string;
		"No skills found": string;
		"Skills for domain": string;
		"Deleted skill": string;
		Examples: string;
		Library: string;
		"Command failed:": string;
		"Why is this needed?": string;
		"What this means:": string;
		"Continue Anyway": string;
		"Requesting...": string;
		"Grant Permission": string;
		"Navigating to": string;
		"Click to open": string;
		"Waiting...": string;
		Current: string;
		Locked: string;
		"Export failed. Check console for details.": string;
		"Invalid import file format": string;
		"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.": string;
		"Imported {imported} sessions, skipped {skipped} duplicates": string;
		"Imported {count} sessions": string;
		"Import failed. Check console for details.": string;
		Import: string;
		"Export All": string;
		Export: string;
		"No sessions older than {days} days": string;
		"Delete {count} sessions older than {days} days?": string;
		"Failed to delete sessions. Check console for details.": string;
		"Delete Old": string;
		"All sessions": string;
		"No sessions to delete": string;
		"Delete ALL {count} sessions? This cannot be undone!": string;
		"Older than 7 days": string;
		"Older than 30 days": string;
		"Older than 90 days": string;
		"Search sessions...": string;
		"Total: {count} sessions · {messages} messages · ${cost}": string;
		"Open tabs": string;
		"Waiting for selection": string;
		"Preparing element selector...": string;
		About: string;
		"AI-powered browser extension for web navigation and interaction": string;
		"Version:": string;
		Website: string;
		Imprint: string;
		Privacy: string;
		"Checking for updates...": string;
		"Update Available": string;
		"A new version ({version}) is available": string;
		Update: string;
		"You're up to date": string;
		"Update Required": string;
		"A new version ({version}) is available. Please update to continue.": string;
		"Update Now": string;
	}
}

const sitegeistTranslations = {
	en: {
		"Permission request failed": "Permission request failed",
		"JavaScript Execution Permission Required": "JavaScript Execution Permission Required",
		"This extension needs permission to execute JavaScript code on web pages":
			"This extension needs permission to execute JavaScript code on web pages",
		"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.":
			"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.",
		"The AI can read and modify web page content when you ask it to":
			"The AI can read and modify web page content when you ask it to",
		"Code runs in an isolated environment with security safeguards":
			"Code runs in an isolated environment with security safeguards",
		"Network access is blocked to prevent data exfiltration":
			"Network access is blocked to prevent data exfiltration",
		"You can revoke this permission at any time in browser settings":
			"You can revoke this permission at any time in browser settings",
		"Writing JavaScript code...": "Writing JavaScript code...",
		"Execute JavaScript": "Execute JavaScript",
		"Preparing JavaScript...": "Preparing JavaScript...",
		"Getting skill": "Getting skill",
		"Got skill": "Got skill",
		"Listing skills": "Listing skills",
		"Creating skill": "Creating skill",
		"Created skill": "Created skill",
		"Updating skill": "Updating skill",
		"Updated skill": "Updated skill",
		"Rewriting skill": "Rewriting skill",
		"Rewritten skill": "Patched skill",
		"Deleting skill": "Deleting skill",
		"Processing skill...": "Processing skill...",
		"No skills found": "No skills found",
		"Skills for domain": "Skills for domain",
		"Deleted skill": "Deleted skill",
		Examples: "Examples",
		Library: "Library",
		"Command failed:": "Command failed:",
		"Why is this needed?": "Why is this needed?",
		"What this means:": "What this means:",
		"Continue Anyway": "Continue Anyway",
		"Requesting...": "Requesting...",
		"Grant Permission": "Grant Permission",
		"Navigating to": "Navigating to",
		"Click to open": "Click to open",
		"Waiting...": "Waiting...",
		Current: "Current",
		Locked: "Locked",
		"Export failed. Check console for details.": "Export failed. Check console for details.",
		"Invalid import file format": "Invalid import file format",
		"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.":
			"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.",
		"Imported {imported} sessions, skipped {skipped} duplicates":
			"Imported {imported} sessions, skipped {skipped} duplicates",
		"Imported {count} sessions": "Imported {count} sessions",
		"Import failed. Check console for details.": "Import failed. Check console for details.",
		Import: "Import",
		"Export All": "Export All",
		Export: "Export",
		"No sessions older than {days} days": "No sessions older than {days} days",
		"Delete {count} sessions older than {days} days?": "Delete {count} sessions older than {days} days?",
		"Failed to delete sessions. Check console for details.": "Failed to delete sessions. Check console for details.",
		"Delete Old": "Delete",
		"All sessions": "All sessions",
		"No sessions to delete": "No sessions to delete",
		"Delete ALL {count} sessions? This cannot be undone!": "Delete ALL {count} sessions? This cannot be undone!",
		"Older than 7 days": "Older than 7 days",
		"Older than 30 days": "Older than 30 days",
		"Older than 90 days": "Older than 90 days",
		"Search sessions...": "Search sessions...",
		"Total: {count} sessions · {messages} messages · ${cost}":
			"Total: {count} sessions · {messages} messages · ${cost}",
		"Open tabs": "Open tabs",
		"Waiting for selection": "Waiting for selection",
		"Preparing element selector...": "Preparing element selector...",
		About: "About",
		"AI-powered browser extension for web navigation and interaction":
			"AI-powered browser extension for web navigation and interaction",
		"Version:": "Version:",
		Website: "Website",
		Imprint: "Imprint",
		Privacy: "Privacy",
		"Checking for updates...": "Checking for updates...",
		"Update Available": "Update Available",
		"A new version ({version}) is available": "A new version ({version}) is available",
		Update: "Update",
		"You're up to date": "You're up to date",
		"Update Required": "Update Required",
		"A new version ({version}) is available. Please update to continue.":
			"A new version ({version}) is available. Please update to continue.",
		"Update Now": "Update Now",
		"Compacting context...": "Compacting context...",
		Browsing: "Browsing",
		Confirm: "Confirm",
		Cancel: "Cancel",
		"Enable extension": "Enable extension",
		"Disable extension": "Disable extension",
		"Uninstall extension": "Uninstall extension",
		"Open downloaded file": "Open downloaded file",
		"Sitegeist's agent wants to perform this action and needs your confirmation.":
			"Sitegeist's agent wants to perform this action and needs your confirmation.",
		"Chrome requires this action to be triggered by a real user click. Confirming here provides that click; nothing happens if you cancel.":
			"Chrome requires this action to be triggered by a real user click. Confirming here provides that click; nothing happens if you cancel.",
		"The extension becomes active again.": "The extension becomes active again.",
		"The extension stops running until re-enabled. Its settings are kept.":
			"The extension stops running until re-enabled. Its settings are kept.",
		"This removes the extension and its data. Chrome will ask you to confirm again.":
			"This removes the extension and its data. Chrome will ask you to confirm again.",
		"Chrome opens the file with its default application.": "Chrome opens the file with its default application.",
		"Cancelled by user in the confirmation dialog - nothing was changed.":
			"Cancelled by user in the confirmation dialog - nothing was changed.",
		"Browse follow": "Browse follow",
		"Activity timeout (minutes)": "Activity timeout (minutes)",
		"Controls how page navigations interact with the agent. Navigations are always recorded in the session history; whether they may trigger a response is gated below.":
			"Controls how page navigations interact with the agent. Navigations are always recorded in the session history; whether they may trigger a response is gated below.",
		"When enabled, navigating to a page while the agent is idle (and you were active recently) wakes the agent to react to the page. Off by default.":
			"When enabled, navigating to a page while the agent is idle (and you were active recently) wakes the agent to react to the page. Off by default.",
		"Navigations after this many minutes without a prompt are treated as idle browsing: they are recorded silently and never trigger or extend a response.":
			"Navigations after this many minutes without a prompt are treated as idle browsing: they are recorded silently and never trigger or extend a response.",
		"Session branches": "Session branches",
		"Jump to a previous point; the next message starts a new branch there":
			"Jump to a previous point; the next message starts a new branch there",
		"No branch points yet": "No branch points yet",
		You: "You",
		Assistant: "Assistant",
		"Re-send": "Re-send",
		"Re-send this message as a new branch": "Re-send this message as a new branch",
		Navigation: "Navigation",
		Compaction: "Compaction",
		"Continue from here": "Continue from here",
		"Onward branches at this point": "Onward branches at this point",
		branches: "branches",
	},
	de: {
		"Permission request failed": "Berechtigungsanfrage fehlgeschlagen",
		"JavaScript Execution Permission Required": "JavaScript-Ausführungsberechtigung erforderlich",
		"This extension needs permission to execute JavaScript code on web pages":
			"Diese Erweiterung benötigt die Berechtigung, JavaScript-Code auf Webseiten auszuführen",
		"The JavaScript REPL tool allows the AI to read and interact with web pages on your behalf. This requires the userScripts permission to execute code safely and securely.":
			"Das JavaScript-REPL-Tool ermöglicht es der KI, Webseiten in Ihrem Auftrag zu lesen und damit zu interagieren. Dies erfordert die userScripts-Berechtigung, um Code sicher auszuführen.",
		"The AI can read and modify web page content when you ask it to":
			"Die KI kann Webseiteninhalte lesen und ändern, wenn Sie es verlangen",
		"Code runs in an isolated environment with security safeguards":
			"Code wird in einer isolierten Umgebung mit Sicherheitsvorkehrungen ausgeführt",
		"Network access is blocked to prevent data exfiltration":
			"Netzwerkzugriff ist blockiert, um Datenexfiltration zu verhindern",
		"You can revoke this permission at any time in browser settings":
			"Sie können diese Berechtigung jederzeit in den Browsereinstellungen widerrufen",
		"Writing JavaScript code...": "Schreibe JavaScript-Code...",
		"Execute JavaScript": "Führe JavaScript aus",
		"Preparing JavaScript...": "Bereite JavaScript vor...",
		"Getting skill": "Hole Skill",
		"Got skill": "Skill erhalten",
		"Listing skills": "Liste Skills auf",
		"Creating skill": "Erstelle Skill",
		"Created skill": "Skill erstellt",
		"Updating skill": "Aktualisiere Skill",
		"Updated skill": "Skill aktualisiert",
		"Rewriting skill": "Patche Skill",
		"Rewritten skill": "Skill gepatcht",
		"Deleting skill": "Lösche Skill",
		"Processing skill...": "Verarbeite Skill...",
		"No skills found": "Keine Skills gefunden",
		"Skills for domain": "Skills für Domain",
		"Deleted skill": "Skill gelöscht",
		Examples: "Beispiele",
		Library: "Bibliothek",
		"Command failed:": "Befehl fehlgeschlagen:",
		"Why is this needed?": "Warum ist das notwendig?",
		"What this means:": "Was das bedeutet:",
		"Continue Anyway": "Trotzdem fortfahren",
		"Requesting...": "Anfrage läuft...",
		"Grant Permission": "Berechtigung erteilen",
		"Navigating to": "Navigiere zu",
		"Click to open": "Klicken zum Öffnen",
		"Waiting...": "Warte...",
		Current: "Aktuell",
		Locked: "Gesperrt",
		"Export failed. Check console for details.": "Export fehlgeschlagen. Prüfen Sie die Konsole für Details.",
		"Invalid import file format": "Ungültiges Import-Dateiformat",
		"Found {count} duplicate sessions. Click OK to overwrite, Cancel to skip duplicates.":
			"{count} doppelte Sitzungen gefunden. OK zum Überschreiben, Abbrechen zum Überspringen.",
		"Imported {imported} sessions, skipped {skipped} duplicates":
			"{imported} Sitzungen importiert, {skipped} Duplikate übersprungen",
		"Imported {count} sessions": "{count} Sitzungen importiert",
		"Import failed. Check console for details.": "Import fehlgeschlagen. Prüfen Sie die Konsole für Details.",
		Import: "Importieren",
		"Export All": "Alle exportieren",
		Export: "Exportieren",
		"No sessions older than {days} days": "Keine Sitzungen älter als {days} Tage",
		"Delete {count} sessions older than {days} days?": "{count} Sitzungen älter als {days} Tage löschen?",
		"Failed to delete sessions. Check console for details.":
			"Löschen fehlgeschlagen. Prüfen Sie die Konsole für Details.",
		"Delete Old": "Löschen",
		"All sessions": "Alle Sitzungen",
		"No sessions to delete": "Keine Sitzungen zum Löschen",
		"Delete ALL {count} sessions? This cannot be undone!":
			"ALLE {count} Sitzungen löschen? Dies kann nicht rückgängig gemacht werden!",
		"Older than 7 days": "Älter als 7 Tage",
		"Older than 30 days": "Älter als 30 Tage",
		"Older than 90 days": "Älter als 90 Tage",
		"Search sessions...": "Sitzungen durchsuchen...",
		"Total: {count} sessions · {messages} messages · ${cost}":
			"Gesamt: {count} Sitzungen · {messages} Nachrichten · ${cost}",
		"Open tabs": "Offene Tabs",
		"Waiting for selection": "Warte auf Auswahl",
		"Preparing element selector...": "Bereite Element-Auswahl vor...",
		About: "Über",
		"AI-powered browser extension for web navigation and interaction":
			"KI-gestützte Browser-Erweiterung für Webnavigation und -interaktion",
		"Version:": "Version:",
		Website: "Webseite",
		Imprint: "Impressum",
		Privacy: "Datenschutz",
		"Checking for updates...": "Suche nach Updates...",
		"Update Available": "Update verfügbar",
		"A new version ({version}) is available": "Eine neue Version ({version}) ist verfügbar",
		Update: "Aktualisieren",
		"You're up to date": "Sie sind auf dem neuesten Stand",
		"Update Required": "Update erforderlich",
		"A new version ({version}) is available. Please update to continue.":
			"Eine neue Version ({version}) ist verfügbar. Bitte aktualisieren Sie, um fortzufahren.",
		"Update Now": "Jetzt aktualisieren",
		"Compacting context...": "Kontext wird komprimiert ...",
		Browsing: "Browsing",
		Confirm: "Best\u00e4tigen",
		Cancel: "Abbrechen",
		"Enable extension": "Erweiterung aktivieren",
		"Disable extension": "Erweiterung deaktivieren",
		"Uninstall extension": "Erweiterung deinstallieren",
		"Open downloaded file": "Heruntergeladene Datei \u00f6ffnen",
		"Sitegeist's agent wants to perform this action and needs your confirmation.":
			"Sitegeists Agent m\u00f6chte diese Aktion ausf\u00fchren und ben\u00f6tigt Ihre Best\u00e4tigung.",
		"Chrome requires this action to be triggered by a real user click. Confirming here provides that click; nothing happens if you cancel.":
			"Chrome verlangt f\u00fcr diese Aktion einen echten Nutzerklick. Die Best\u00e4tigung hier liefert genau diesen; bei Abbruch passiert nichts.",
		"The extension becomes active again.": "Die Erweiterung wird wieder aktiv.",
		"The extension stops running until re-enabled. Its settings are kept.":
			"Die Erweiterung stoppt bis zur Reaktivierung. Ihre Einstellungen bleiben erhalten.",
		"This removes the extension and its data. Chrome will ask you to confirm again.":
			"Dies entfernt die Erweiterung samt Daten. Chrome fragt danach noch einmal nach.",
		"Chrome opens the file with its default application.": "Chrome \u00f6ffnet die Datei mit der Standardanwendung.",
		"Cancelled by user in the confirmation dialog - nothing was changed.":
			"Vom Nutzer im Best\u00e4tigungsdialog abgebrochen - nichts wurde ge\u00e4ndert.",
		"Browse follow": "Browsing folgen",
		"Activity timeout (minutes)": "Inaktivit\u00e4tsschwellwert (Minuten)",
		"Controls how page navigations interact with the agent. Navigations are always recorded in the session history; whether they may trigger a response is gated below.":
			"Steuert, wie Seitennavigationen mit dem Agenten interagieren. Navigationen werden immer im Sitzungsverlauf aufgezeichnet; ob sie eine Antwort ausl\u00f6sen d\u00fcrfen, wird unten geregelt.",
		"When enabled, navigating to a page while the agent is idle (and you were active recently) wakes the agent to react to the page. Off by default.":
			"Wenn aktiviert, weckt eine Navigation zu einer Seite den Agenten (im Leerlauf und bei k\u00fcrzlicher Aktivit\u00e4t), um auf die Seite zu reagieren. Standardm\u00e4\u00dfig aus.",
		"Navigations after this many minutes without a prompt are treated as idle browsing: they are recorded silently and never trigger or extend a response.":
			"Navigationen nach so vielen Minuten ohne Eingabe gelten als inaktives Browsing: sie werden still aufgezeichnet und l\u00f6sen niemals eine Antwort aus oder verl\u00e4ngern diese.",
		"Session branches": "Sitzungs-Zweige",
		"Jump to a previous point; the next message starts a new branch there":
			"Zu einem früheren Punkt springen; die nächste Nachricht startet dort einen neuen Zweig",
		"No branch points yet": "Noch keine Verzweigungspunkte",
		You: "Du",
		Assistant: "Assistent",
		"Re-send": "Erneut senden",
		"Re-send this message as a new branch": "Diese Nachricht als neuen Zweig erneut senden",
		Navigation: "Navigation",
		Compaction: "Kompaktierung",
		"Continue from here": "Hier fortsetzen",
		"Onward branches at this point": "Verzweigungen ab diesem Punkt",
		branches: "Verzweigungen",
	},
};

// Merge web-ui translations with sitegeist translations
const mergedTranslations = {
	en: { ...webUiTranslations.en, ...sitegeistTranslations.en },
	de: { ...webUiTranslations.de, ...sitegeistTranslations.de },
};

setTranslations(mergedTranslations);
