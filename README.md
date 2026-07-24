# TLS Automated Recap — `/recap` Telegram Bot

A Telegram bot for a student sports newsroom. When a staffer types
`/recap ADMU` inside a sport's forum topic, the bot copies that sport's Google
Docs coverage template into the correct Shared Drive folder, names it by
convention, and replies in-thread with the link.

Author: Lance Jardiniano, TLS65 Sports Staffer

> **Full technical spec:** [SPEC.md](SPECS.md). This README is the practical handoff — read it first.


It removes two recurring chores: manually duplicating the template before every
game, and manually filing the finished doc into the right Drive folder.

> **Status:** Live and in production. Built on Google Apps Script, deployed as a
> Web App, driven by a Telegram webhook.

---


## 1. How it works

```
Telegram group (forum)                 Google Apps Script                Google Workspace
──────────────────────                 ─────────────────                ────────────────
 staffer types                          doPost(e)  ◄── webhook POST
 /recap ADMU                                │
   │                                        ▼
   │  message_thread_id ───────────►  handleUpdate()
   │                                        │  parseCommand()
   │                                        │  lookupThread()  ────────►  Sheets: `Sports` tab
   │                                        │      (cached 300s)          (chat_id, thread_id → folder/template)
   │                                        │  buildFilename()
   │                                        │  createDoc()     ────────►  Drive: makeCopy(template → folder)
   │  ◄───────  reply in-thread  ──── sendMessage()  ────────►  Telegram Bot API
```

1. Telegram delivers each message to the Web App `/exec` URL as an HTTP POST.
2. `doPost` parses the update and hands off to `handleUpdate`, which validates
   it, matches the `/recap` command, and looks up the `(chat_id, thread_id)`
   pair in the `Sports` sheet.
3. On a match, it copies the sport's template into the sport's folder with a
   dated filename and replies in the same forum topic with the link.
4. Unmapped threads, missing arguments, and copy failures each get a specific
   in-thread reply. Nothing ever throws out of `doPost`.

Full behavioral contract — command parsing, filename format, caching, error
handling, and security model — is in [SPECS.md](SPECS.md).

---

## 2. Repository layout

| File | Purpose |
|---|---|
| `Code.gs` | The entire bot. Single-file Apps Script project. |
| `appsscript.json` | Apps Script manifest — timezone (`Asia/Manila`), V8 runtime. |
| `.clasp.json` | Links this repo to the Apps Script project (`scriptId`). Git-ignored. |
| `SPECS.md` | The design contract — what each function does and why. |
| `README.md` | This file — operations and handoff. |
| `.gitignore` | Keeps `.clasp.json` and `.clasprc.json` (credentials) out of git. |

There is no build step and no `node_modules` for the bot itself — `clasp` is the
only tooling, and it runs the raw `Code.gs`.

---

## 3. Configuration

Nothing is hardcoded. All secrets and IDs live in **Script Properties** (read via
`PropertiesService.getScriptProperties()`), and all per-sport routing lives in
the **`Sports` sheet**.

### Script Properties

Set these in the Apps Script editor: **Project Settings → Script Properties**.

| Property | Contents | Notes |
|---|---|---|
| `TELEGRAM_TOKEN` | Bot token for `@SportsRecap_bot` | From @BotFather. Grants full control of the bot — treat as a password. |
| `SHEET_ID` | Spreadsheet ID of the mapping sheet | The `/d/<THIS PART>/edit` segment of the sheet URL. |
| `SHARED_SECRET` | Random string | Currently **unused** by the code; reserved. Leave it in place. |

### The `Sports` tab

One tab named `Sports` in the spreadsheet identified by `SHEET_ID`. **Row 1 is
headers.** Column order does not matter — the code reads the header row and maps
by name, so you can insert columns without breaking anything.

| chat_id | thread_id | league | sport | folder_id | template_id | season | active |
|---|---|---|---|---|---|---|---|
| -100XXXXXXXXXX | 3 | UAAP | Men's Football | 1CmM… | 1tSJ… | 89 | TRUE |
| -100XXXXXXXXXX | 2 | UAAP | Men's Basketball | 1_V2Z… | 1tSJ… | 89 | TRUE |

| Column | Meaning |
|---|---|
| `chat_id` | Telegram supergroup ID (large negative, `-100…`). Stored as text or number — the code compares as trimmed strings either way. |
| `thread_id` | Forum topic ID. Same string-comparison rule. |
| `league` | Filename segment, used verbatim (e.g. `UAAP`). |
| `sport` | Filename segment, used verbatim (e.g. `Men's Basketball`). |
| `folder_id` | Destination Drive folder for this thread's docs. |
| `template_id` | Google Doc to copy for this thread. |
| `season` | Informational only. Not used in the filename today. |
| `active` | `TRUE` / `FALSE`. Anything that isn't a truthy `TRUE` is treated as unmapped. |

The executing Google account needs at least **Contributor** access to each
Shared Drive folder — that is enough for `makeCopy()` to create files.

---

## 4. Local development with clasp

[`clasp`](https://github.com/google/clasp) is Google's CLI for pushing/pulling
Apps Script code. It's already wired to this project via `.clasp.json`
(`scriptId: <YOUR_SCRIPT_ID>`).

**One-time setup on a new machine:**

```bash
npm install -g @google/clasp     # requires Node.js
clasp login                      # opens a browser; sign in as the bot's owner account
```

`clasp login` writes credentials to `~/.clasprc.json`. That file and
`.clasp.json` are git-ignored — **never commit them.**

**Everyday commands (run from the repo root):**

```bash
clasp status      # show which files clasp will push
clasp push        # upload Code.gs + appsscript.json to Apps Script
clasp push -f     # push without the "overwrite manifest?" prompt
clasp pull        # download the editor's version over your local files
clasp open        # open the project in the Apps Script editor
```

`clasp push` only updates the **editor** copy. It does **not** deploy a new
version to the live webhook — see the next section.

---

## 5. Deploying a change

The live webhook points at a specific **deployment**, not at the editor code.
After `clasp push`, the new code is in the editor but the webhook still runs the
previously deployed version until you cut a new one.

> ⚠️ **Always edit the existing deployment. Never create a new one.**
> A new deployment issues a new `/exec` URL, which silently breaks the webhook
> (Telegram keeps POSTing to the old, now-dead URL).

To ship a code change:

1. `clasp push` (or edit in the browser).
2. In the editor: **Deploy → Manage deployments**.
3. Click the ✏️ pencil on the existing deployment.
4. **Version → New version**, add a short description, **Deploy**.

The `/exec` URL stays the same, so no webhook change is needed.

**First-ever deployment** (already done for this project, kept for reference):

1. **Deploy → New deployment → Web app**
2. Execute as **Me**, Who has access **Anyone**
3. Authorize when prompted (**Advanced → Go to project → Allow**)
4. Copy the `/exec` URL and register the webhook (below)

---

## 6. Registering / checking the webhook

Apps Script can't read request headers, so Telegram's `secret_token` can't be
validated — the obscurity of the `/exec` URL is the protection. **Keep that URL
out of git and out of public chats.**

```bash
# Point Telegram at the Web App (run once, or after a URL change)
https://api.telegram.org/bot<TELEGRAM_TOKEN>/setWebhook?url=<EXEC_URL>

# Confirm it's healthy — "last_error_message" should be empty
https://api.telegram.org/bot<TELEGRAM_TOKEN>/getWebhookInfo
```

The bot must be an **administrator** in each group, or Telegram won't reliably
include `message_thread_id` for forum topics and every reply will be treated as
unmapped.

---

## 7. Common tasks

### Onboard a new sport / thread

1. In the target forum topic, have the bot post something (or read the unmapped
   error) to capture the `chat_id` and `thread_id`. The easiest way: type
   `/recap TEST` in the new thread — the bot replies with the exact
   `chat_id` and `thread_id` to paste.
2. Add a row to the `Sports` tab with those IDs, the `league`, `sport`,
   `folder_id`, `template_id`, `season`, and `active = TRUE`.
3. Run `clearCache()` in the editor (or wait 5 minutes) so the new row is picked
   up. See below.

### Deactivate a thread

Set `active` to `FALSE` on its row (don't delete the row — you keep the history).
Run `clearCache()` to apply immediately.

### Force a mapping change to take effect now

The `Sports` tab is cached for **300 seconds**. After editing the sheet, either
wait it out or run the `clearCache()` function once from the Apps Script editor
(**Editor → select `clearCache` → Run**).

---

## 8. Testing

Two functions run from the editor with no Telegram traffic required:

| Function | What it verifies |
|---|---|
| `testLookup()` | Logs the parsed `Sports` map — confirms header parsing and that the large negative `chat_id`s compare correctly. |
| `testCreateDoc()` | Simulates `/recap ADMU` for a hardcoded `(chat_id, thread_id)` — confirms Drive permissions and filename construction, and actually creates a doc. |

`testCreateDoc()` has `CHAT_ID` / `THREAD_ID` / `OPPONENT` constants at the top;
edit them to target a different row. **It creates a real document** in the mapped
folder — delete the test doc afterward if you don't want it.

**End-to-end smoke test after a deploy:**

1. `/recap ADMU` in a mapped thread → doc created, reply arrives *in that thread*.
2. `/recap` bare → usage hint, no doc.
3. `/recap ADMU` in the General topic → unmapped error showing `thread_id: (none)`, no doc.
4. `/recap ADMU` in an unmapped thread → error showing the correct `chat_id` / `thread_id`.

---

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot doesn't respond at all | Webhook broken or pointing at a dead URL | `getWebhookInfo`; re-run `setWebhook` with the current `/exec` URL. |
| Replies land in "General", not the topic | Bot isn't a group admin, so `message_thread_id` is missing | Promote the bot to administrator in the group. |
| "This thread isn't mapped yet" in a thread you added | Cache still holds the old map | Run `clearCache()`, or wait out the 300s TTL. Double-check `active = TRUE`. |
| Everything treated as unmapped after adding a column | (Shouldn't happen — lookup is header-driven) | Confirm header names match exactly: `chat_id`, `thread_id`, `active`, etc. |
| "Couldn't create the doc: …" reply | Executing account lacks folder access, or a bad `folder_id`/`template_id` | Check the account has Contributor on the folder and the IDs are correct. |
| Duplicate docs created | A code path threw before the request completed, so Telegram retried | Check Executions logs; `doPost` is wrapped in try/catch specifically to prevent this. |
| Changed the code but behavior is unchanged | Pushed but didn't cut a new deployment version | Deploy → Manage deployments → edit existing → New version. |

Logs live in the Apps Script editor under **Executions** (and Cloud Logging via
`console.error` / `console.log`).

---

## 10. Handoff checklist

When taking over or handing off this project, make sure you have / transfer:

- [ ] Ownership (or edit access) of the **Apps Script project** `recap-bot`
      (`scriptId` in `.clasp.json`).
- [ ] Access to the **mapping spreadsheet** (`SHEET_ID`) and its `Sports` tab.
- [ ] **Contributor** access on every Shared Drive folder referenced in `folder_id`.
- [ ] The **`@SportsRecap_bot` token** (from @BotFather) — needed to re-run
      `setWebhook`, and it's the value in the `TELEGRAM_TOKEN` script property.
- [ ] **Admin** on the Telegram groups (or a contact who can promote the bot).
- [ ] The current **`/exec` deployment URL** (kept out of git — get it from
      Deploy → Manage deployments).
- [ ] `clasp` installed and `clasp login` done as the project's owner account.

Read [SPECS.md](SPECS.md) for the design rationale before making changes — several
non-obvious decisions (string-compared IDs, single-key cache, always-200
response) are deliberate.
