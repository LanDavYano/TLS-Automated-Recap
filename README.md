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

## 1. What it does

- **Runs on demand, not on a schedule** — a staffer types `/recap <OPPONENT>` in
  a sport's forum topic and the doc exists seconds later. No dashboard, no manual
  file duplication, no filing.
- **Onboards a new sport GC in one message** — `/setup UAAP | Men's Basketball`
  typed inside the topic. The bot reads the `chat_id` and `thread_id` off its own
  update, creates the Drive folder under this season's `Sports` root if it isn't
  there yet, and writes the tracker row itself. **No IDs are ever extracted,
  copied, or pasted by hand.**
- **Resolves the thread to its sport** — reads the `Sports` tracker to turn the
  `(chat_id, thread_id)` of the topic into that sport's league, name, Drive
  folder, and Docs template. Column order in the sheet doesn't matter; lookups
  are cached for 5 minutes.
- **Creates the game doc** — copies the sport's template into the correct Shared
  Drive folder, named by convention:
  `UAAP: Men's Basketball - ADMU - 2026-09-06` (opponent uppercased, today's date
  in Manila time).
- **Replies in-thread with the link** — the document name and URL land in the
  same forum topic the command came from, so the staffer never leaves Telegram.
- **Fails loudly, never silently** — a bare `/recap`, an unmapped thread, or a
  Drive error each get a specific, actionable reply in-thread (the unmapped one
  hands you the exact `/setup` command to fix it). And it *always* returns `200`
  to Telegram, so a hiccup can never trigger a retry that double-creates a doc.

### Commands

| Command | Who | What it does |
|---|---|---|
| `/recap <OPPONENT>` | Anyone | Creates the game doc for this topic's sport and replies with the link. |
| `/setup <LEAGUE> \| <Sport>` | Group admins | Maps the topic it's typed in — folder, row, and all. Safe to re-run. |
| `/sports` | Anyone | Lists the sports mapped in this group. |
| `/whereami` | Anyone | Prints this topic's `chat_id` / `thread_id` and whether it's mapped. |

---


## 2. How it works

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
4. Unmapped threads, malformed arguments, and copy failures each get a specific
   in-thread reply — the message names what was actually wrong rather than just
   printing usage. Nothing ever throws out of `doPost`.
5. `/setup` runs the same path in reverse: it takes `chat.id` and
   `message_thread_id` straight off the update it arrived on, resolves (or
   creates) the sport's folder under `SPORTS_ROOT_FOLDER_ID`, and upserts the
   `Sports` row itself under a script lock. This is why onboarding never requires
   reading an ID out of a Telegram link.

Full behavioral contract — command parsing, filename format, caching, error
handling, and security model — is in [SPECS.md](SPECS.md).

---

## 3. Repository layout

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

## 4. Configuration

Nothing is hardcoded. All secrets and IDs live in **Script Properties** (read via
`PropertiesService.getScriptProperties()`), and all per-sport routing lives in
the **`Sports` sheet**.

### Script Properties

Set these in the Apps Script editor: **Project Settings → Script Properties**.

| Property | Contents | Notes |
|---|---|---|
| `TELEGRAM_TOKEN` | Bot token for `@SportsRecap_bot` | From @BotFather. Grants full control of the bot — treat as a password. |
| `SHEET_ID` | Spreadsheet ID of the mapping sheet | The `/d/<THIS PART>/edit` segment of the sheet URL. |
| `SPORTS_ROOT_FOLDER_ID` | **This season's** `Sports` folder | The `/folders/<THIS PART>` segment of the folder URL. `/setup` creates each sport's subfolder inside it. **Repoint this every season.** |
| `TEMPLATE_ID` | The coverage template Doc | One template for every sport. A `template_id` cell in the sheet overrides it for that row only. |
| `SEASON` | Current season number, e.g. `90` | Optional. Stamped into the `season` column when `/setup` writes a row. |
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
| `chat_id` | Telegram supergroup ID (large negative, `-100…`). Written by `/setup`. Stored as text or number — the code compares as trimmed strings either way. |
| `thread_id` | Forum topic ID. Written by `/setup`. Same string-comparison rule. |
| `league` | Filename segment, used verbatim (e.g. `UAAP`). |
| `sport` | Filename segment, used verbatim (e.g. `Men's Basketball`). |
| `folder_id` | Destination Drive folder. **Written by `/setup`** — you should never paste one by hand. |
| `template_id` | Per-row override. Normally **blank**, which falls back to the `TEMPLATE_ID` script property. |
| `season` | Informational only. Not used in the filename today. |
| `active` | `TRUE` / `FALSE`. Anything that isn't a truthy `TRUE` is treated as unmapped. |

In normal use you don't type into this sheet at all — `/setup` fills it. It stays
readable and hand-editable as an escape hatch, and column order still doesn't
matter, for reads *or* writes.

The executing Google account needs at least **Contributor** access to the Sports
root folder — enough to create subfolders and to `makeCopy()` files into them.

---

## 5. Local development with clasp

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

## 6. Deploying a change

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

## 7. Registering / checking the webhook

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

## 8. Common tasks

### Onboard a new sport / thread

1. Add the bot to the group as an **administrator** (once per group).
2. Open the sport's forum topic and type:

   ```
   /setup UAAP | Men's Basketball
   ```

3. That's it. The bot creates `UAAP - Men's Basketball` under this season's
   Sports folder (or reuses it if it's already there), writes the row, and clears
   its own cache. `/recap` works in that topic immediately.

No IDs to extract, no sheet to open, no `clearCache()` to run.

**Notes**

- **Admins only.** `/setup` writes to shared config, so the bot checks
  `getChatMember` first. It fails closed — if that call errors, the command is
  refused.
- **Safe to re-run.** Running `/setup` again in the same topic *updates* that row
  instead of adding a second one. That's how you fix a typo'd sport name: just
  run it again with the right one.
- **Not in General.** `/setup` is refused in the General topic, which has no
  `thread_id` to map.
- Folder naming is `<LEAGUE> - <Sport>`, flat, one level under the Sports root.
  The league prefix keeps UAAP and NCAA versions of the same sport apart.

### Season rollover

Each season the incoming Sports Editor makes a fresh `Sports` folder. To move the
bot over:

1. Point `SPORTS_ROOT_FOLDER_ID` at the new folder, and bump `SEASON`.
2. Run **`reseasonFolders()`** once from the Apps Script editor.

That walks every active row, creates any missing `<LEAGUE> - <Sport>` folders
under the new root, and rewrites `folder_id`. Chat and thread mappings are
untouched, so nobody has to re-run `/setup`.

> ⚠️ **Step 2 isn't optional.** `folder_id` is stored per row, so if you only
> change the property, every sport keeps quietly writing into *last* season's
> folders — with no error to tip you off.

### Check what's mapped

- `/sports` in a group — lists that group's active mappings and their thread IDs.
- `/whereami` in a topic — prints its `chat_id`, `thread_id`, and whether it
  resolves to a sport. Run this first whenever a mapping misbehaves; it tells you
  straight away whether you're looking at a wrong row or a missing one.

### Deactivate a thread

Set `active` to `FALSE` on its row (don't delete the row — you keep the history).
Run `clearCache()` to apply immediately.

### Force a mapping change to take effect now

The `Sports` tab is cached for **300 seconds**. After editing the sheet, either
wait it out or run the `clearCache()` function once from the Apps Script editor
(**Editor → select `clearCache` → Run**).

---

## 9. Testing

Two functions run from the editor with no Telegram traffic required:

| Function | What it verifies |
|---|---|
| `testLookup()` | Logs the parsed `Sports` map — confirms header parsing and that the large negative `chat_id`s compare correctly. |
| `testResolveFolder()` | Confirms the Sports root is reachable and that folder resolution **reuses** an existing folder instead of duplicating it. |
| `testCreateDoc()` | Simulates `/recap ADMU` for a hardcoded `(chat_id, thread_id)` — confirms Drive permissions and filename construction, and actually creates a doc. |

`testCreateDoc()` has `CHAT_ID` / `THREAD_ID` / `OPPONENT` constants at the top;
edit them to target a different row. **It creates a real document** in the mapped
folder — delete the test doc afterward if you don't want it.
`testResolveFolder()` has `LEAGUE` / `SPORT` constants and will create a folder
if the name genuinely isn't there yet — point it at a sport you already have.

**End-to-end smoke test after a deploy:**

1. `/recap ADMU` in a mapped thread → doc created, reply arrives *in that thread*.
2. `/recap` bare → "needs an opponent", no doc.
3. `/recap Ateneo de Manila` → "takes one opponent", with a suggested fix.
4. `/recap ADMU` in the General topic → unmapped error showing `thread_id: (none)`, no doc.
5. `/setup` bare → "needs a league and a sport".
6. `/setup UAAP Men's Football` (no `|`) → names the missing separator.
7. `/setup UAAP | Men's Football` in a fresh topic → folder created, `/recap` works there right away.
8. The same `/setup` again → reply says *Updated* / *(existing)*, and the sheet still has **one** row for that thread.
9. `/setup` from a non-admin account → refused, nothing written.
10. `/sports` and `/whereami` → correct IDs and mapping status.

Steps 5–9 are the ones worth actually doing — they're where a regression would
silently corrupt the tracker rather than just fail loudly.

---

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Bot doesn't respond at all | Webhook broken or pointing at a dead URL | `getWebhookInfo`; re-run `setWebhook` with the current `/exec` URL. |
| Replies land in "General", not the topic | Bot isn't a group admin, so `message_thread_id` is missing | Promote the bot to administrator in the group. |
| "This thread isn't mapped yet" in a thread you added | Cache still holds the old map | Run `clearCache()`, or wait out the 300s TTL. Double-check `active = TRUE`. |
| Everything treated as unmapped after adding a column | (Shouldn't happen — lookup is header-driven) | Confirm header names match exactly: `chat_id`, `thread_id`, `active`, etc. |
| "Couldn't create the doc: …" reply | Executing account lacks folder access, or a bad `folder_id`/`template_id` | Check the account has Contributor on the folder and the IDs are correct. |
| `/setup` says "Only group admins…" but you *are* one | You posted as an anonymous admin, so Telegram reports the group as the sender | Turn off "Remain Anonymous" for yourself in the group, run `/setup`, turn it back on. |
| `/setup` says `SPORTS_ROOT_FOLDER_ID` is empty | Property never set, or cleared during rollover | Set it to this season's Sports folder ID (the `/folders/<ID>` part of the URL). |
| `/setup` created a duplicate folder | The existing folder's name doesn't match `<LEAGUE> - <Sport>` exactly | Matching is exact. Rename the old folder to match, or move the docs and delete the stray. |
| Docs are landing in last season's folders | `SPORTS_ROOT_FOLDER_ID` was repointed but `reseasonFolders()` never ran | Run `reseasonFolders()` from the editor. See "Season rollover". |
| Two rows for the same thread | A row was added by hand alongside one written by `/setup` | Delete the stale row; `/setup` upserts and would never create a second one itself. |
| Duplicate docs created | A code path threw before the request completed, so Telegram retried | Check Executions logs; `doPost` is wrapped in try/catch specifically to prevent this. |
| Changed the code but behavior is unchanged | Pushed but didn't cut a new deployment version | Deploy → Manage deployments → edit existing → New version. |

Logs live in the Apps Script editor under **Executions** (and Cloud Logging via
`console.error` / `console.log`).

---

## 11. Handoff checklist

When taking over or handing off this project, make sure you have / transfer:

- [ ] Ownership (or edit access) of the **Apps Script project** `recap-bot`
      (`scriptId` in `.clasp.json`).
- [ ] Access to the **mapping spreadsheet** (`SHEET_ID`) and its `Sports` tab.
- [ ] **Contributor** access on the season's **Sports root folder**
      (`SPORTS_ROOT_FOLDER_ID`) — the bot creates each sport's subfolder inside it.
- [ ] The **coverage template** Doc (`TEMPLATE_ID`), readable by the executing account.
- [ ] The **`@SportsRecap_bot` token** (from @BotFather) — needed to re-run
      `setWebhook`, and it's the value in the `TELEGRAM_TOKEN` script property.
- [ ] **Admin** on the Telegram groups (or a contact who can promote the bot).
- [ ] The current **`/exec` deployment URL** (kept out of git — get it from
      Deploy → Manage deployments).
- [ ] `clasp` installed and `clasp login` done as the project's owner account.

Read [SPECS.md](SPECS.md) for the design rationale before making changes — several
non-obvious decisions (string-compared IDs, single-key cache, always-200
response) are deliberate.
