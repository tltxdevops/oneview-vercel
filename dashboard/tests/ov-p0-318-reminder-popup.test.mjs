import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), "utf8");

test("OV-P0-318: lembrete Webex é independente e a inbox é limitada ao solicitante", async () => {
  const inbox = await read("api/_lib/oneview-operator-reminder-inbox.js");
  assert.match(inbox, /where created_by = \$1/);
  assert.match(inbox, /status = 'processing'/);
  assert.match(inbox, /status = 'sent'/);
  assert.doesNotMatch(inbox, /created_by_name = \$1/);
});

test("OV-P0-318: popup persistente é centrado, opcional e não possui auto-dismiss", async () => {
  const [toast, provider, preferences, settings] = await Promise.all([
    read("src/components/oneview/OperatorReminderInboxToast.tsx"),
    read("src/providers/OperatorReminderInboxProvider.tsx"),
    read("src/lib/oneview-notification-preferences.ts"),
    read("src/pages/Settings.tsx"),
  ]);

  assert.doesNotMatch(toast, /setTimeout\(|autoDismiss/);
  assert.match(toast, /top-1\/2/);
  assert.match(toast, /Este aviso permanece aqui/);
  assert.match(toast, /Não exibir pop-ups/);
  assert.match(provider, /oneview\.reminder-inbox\.open/);
  assert.match(provider, /setOneViewReminderLinkPopup\(false, actorId\)/);
  assert.match(provider, /playReminderLinkSound\(actorId\)/);
  assert.match(preferences, /reminderLinkPopup: true/);
  assert.match(preferences, /setOneViewReminderLinkPopup/);
  assert.match(preferences, /ONEVIEW_NOTIFICATION_PREFERENCES_EVENT/);
  assert.match(settings, /Exibir pop-up de lembrete/);
  assert.match(settings, /Som nos lembretes de link/);
  assert.match(settings, /Webex\/Theo segue independente/);
});
