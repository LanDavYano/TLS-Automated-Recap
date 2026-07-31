# SPECS.md — `/recap` Telegram Bot (Google Apps Script)

> **Status: as-built.** This document is both the original design contract and
> the current specification of the deployed bot. The implementation lives in a
> single file, [`Code.gs`](Code.gs). For setup, deployment, and maintenance
> instructions, see [README.md](README.md). Where this spec and `Code.gs`
> diverge, `Code.gs` is the source of truth — this document is kept in sync with
> it.

## Purpose

A Telegram bot for a student sports newsroom. When a staffer types `/recap ADMU` in a
sport-specific forum topic, the bot copies a Google Docs coverage template into that
sport's Drive folder, names it by convention, and replies in-thread with the link.

This removes three recurring pain points: manually duplicating the template before every
game, manually filing the finished doc into the right Drive folder afterward, and — via
`/setup` — hand-extracting `chat_id`, `thread_id` and `folder_id` for every new sport GC.

**Non-goals.** The bot does not fill in any content inside the document. It does not
route by tournament round. It does not track or update state after creation.

---

## Environment

- **Platform:** Google Apps Script, standalone project named `recap-bot`
- **Entry point:** `doPost(e)` deployed as a Web App (Execute as: Me, Access: Anyone)
- **Trigger:** Telegram webhook POSTs update objects directly to the `/exec` URL
- **Project timezone:** `Asia/Manila` (already set — all date logic must respect it)
- **Drive:** Target folders live in a Shared Drive; the executing account has Contributor
  access, which is sufficient for file creation via `makeCopy()`

### Script Properties

| Property | Contents |
|---|---|
| `TELEGRAM_TOKEN` | Bot token for `@SportsRecap_bot` |
| `SHEET_ID` | Spreadsheet ID of the mapping sheet |
| `SPORTS_ROOT_FOLDER_ID` | **This season's** `Sports` folder. `/setup` creates each sport's subfolder here. |
| `TEMPLATE_ID` | The coverage template Doc. One template across every sport. |
| `SEASON` | Current season number (e.g. `89`). Written into new rows by `/setup`. Optional. |
| `SHARED_SECRET` | Random string; see "Security" below |

Read these via `PropertiesService.getScriptProperties()`. Never hardcode them.

`SPORTS_ROOT_FOLDER_ID` is the one property that changes each season: the
incoming Sports Editor creates a fresh `Sports` folder, and this property is
repointed at it. See "Season rollover" below.

---

## Data source: the `Sports` tab

A single tab named `Sports` in the spreadsheet identified by `SHEET_ID`. Row 1 is headers.

| chat_id | thread_id | league | sport | folder_id | template_id | season | active |
|---|---|---|---|---|---|---|---|
| -100XXXXXXXXXX | 3 | UAAP | Men's Football | 1CmM... | 1tSJ... | 89 | TRUE |
| -100XXXXXXXXXX | 2 | UAAP | Men's Basketball | 1_V2Z... | 1tSJ... | 89 | TRUE |

**Column semantics**

- `chat_id` — Telegram supergroup ID, negative, typically `-100`-prefixed. **May be stored
  as text or as a number.** Always compare as `String(cell).trim()`.
- `thread_id` — forum topic ID. Same string-comparison rule.
- `league` — filename segment, used verbatim (e.g. `UAAP`)
- `sport` — filename segment, used verbatim (e.g. `Men's Basketball`)
- `folder_id` — destination Drive folder for this thread's docs. **Written by `/setup`**;
  you should never have to paste one by hand.
- `template_id` — per-row override. Normally blank — a blank cell falls back to the
  `TEMPLATE_ID` script property, which is the real source of the template.
- `season` — informational; not used in the filename currently. Populated from the
  `SEASON` property when `/setup` writes a row.
- `active` — `TRUE`/`FALSE`. Rows that are not truthy `TRUE` are treated as unmapped.

**Do not assume column order.** Read the header row and build a name→index map, so that
inserting a column later does not break the script. This applies to writes as well:
`upsertSportRow()` only writes into columns that exist in the header row and ignores
keys with no matching column, so it can never shift the table.

---

## Behavior

### Commands

| Command | Purpose |
|---|---|
| `/recap <OPPONENT>` | Create the game doc for this thread's sport. |
| `/setup <LEAGUE> \| <Sport>` | Map the topic it's typed in. Admin only. |
| `/sports` | List the active mappings in this group. |
| `/whereami` | Print this topic's raw IDs and mapping status. |

Anything else is ignored silently.

### `/recap`

```
/recap <OPPONENT>
```

`<OPPONENT>` is a single token, uppercase acronym by convention (`ADMU`, `FEU`, `UST`).
Multi-word opponents are out of scope — if more than one token follows the command,
treat the request as malformed and reply with the usage hint.

Telegram appends the bot username in groups, so the command token may arrive as
`/recap@SportsRecap_bot`. Strip everything from `@` onward before matching.

Command matching is case-insensitive on the command itself. The opponent token is
uppercased before use in the filename.

### Happy path

1. Parse the update; extract `chat.id`, `message_thread_id`, `text`, and `from`.
2. Confirm `text` begins with `/recap` (after `@`-stripping). If not, exit silently.
3. Extract the opponent argument. If absent, reply with the usage hint and stop.
4. Look up `(chat_id, thread_id)` in `Sports`. If no active row, reply with the
   unmapped-thread error and stop.
5. Build the filename (below).
6. `DriveApp.getFileById(template_id).makeCopy(filename, DriveApp.getFolderById(folder_id))`
7. Reply in-thread with the document name and URL.

### Filename convention

```
<league>: <sport> - <OPPONENT> - <YYYY-MM-DD>
```

Example: `UAAP: Men's Basketball - ADMU - 2026-09-06`

- Date is *today* in `Asia/Manila`, formatted `yyyy-MM-dd` via
  `Utilities.formatDate(new Date(), 'Asia/Manila', 'yyyy-MM-dd')`
- Separator is space-hyphen-space
- Duplicate filenames are acceptable — no counter, no collision handling

### Replies

All replies must include `message_thread_id` in the `sendMessage` payload, or they land
in the group's General topic where nobody will see them.

**Success**

```
Created: UAAP: Men's Basketball - ADMU - 2026-09-06
<doc URL>
```

**Bad argument** — three distinct causes, three distinct messages. A generic
`Usage:` line doesn't tell a staffer *which* half they fumbled, so each rejection
names the specific problem and then repeats the usage hint.

| Input | Reply opens with |
|---|---|
| `/recap` | `/recap needs an opponent.` |
| `/recap Ateneo de Manila` | `Too many words — /recap takes one opponent.` plus `Try: /recap ATENEO` |
| `/recap ???` | `That doesn't look like a school acronym: ???` |

Opponents must match `/^[A-Za-z0-9.\-&]{1,20}$/` — the acronym conventions in use
(`UP`, `ADMU`, `NU`) all fit, and it keeps junk out of filenames.

**Unmapped thread** — include the raw IDs, and point at the command that fixes it:

```
This thread isn't mapped yet.
chat_id: -100XXXXXXXXXX
thread_id: 3

Run: /setup <LEAGUE> | <Sport>
Example: /setup UAAP | Men's Basketball
```

**Failure during copy** — surface the error message rather than failing silently:

```
Couldn't create the doc: <error message>
```

### General topic

Messages in a forum's General topic arrive with **no** `message_thread_id` field. Treat
this as unmapped and reply with the error above, showing `thread_id: (none)`. Do not
create a document.

### Non-forum groups

If `message_thread_id` is absent because the group is not a forum at all, the same
unmapped path applies. No special handling needed.

---

## Onboarding: `/setup`

```
/setup <LEAGUE> | <Sport>
```

Example: `/setup UAAP | Men's Basketball`

The design principle: **the bot already has the IDs.** Every update carries
`chat.id` and `message_thread_id`, so onboarding must never require a human to
extract, copy, or paste an ID. `/setup` reads them off its own update.

**Steps**

1. Reject if there is no `message_thread_id` — `/setup` is meaningless outside a
   topic, and mapping the General topic would be a mistake.
2. Reject if the sender is not `creator` or `administrator` (`getChatMember`).
   `/setup` mutates shared configuration, so it is not open to the whole newsroom.
   **Fails closed** — any API error denies the command.
3. Split the argument on `|` into exactly two non-empty fields. Anything else is a
   usage error.
4. Acquire the script lock. The sheet write is read-modify-write; two concurrent
   `/setup` calls without it can append duplicate rows.
5. Resolve the folder: look for `<LEAGUE> - <Sport>` directly under
   `SPORTS_ROOT_FOLDER_ID`, skipping trashed folders. Reuse on an exact name
   match, create it otherwise.
6. Upsert the row keyed on `(chat_id, thread_id)`, with `active = TRUE`.
7. `clearCache()`, then reply with what happened.

**Idempotency is required, not incidental.** Re-running `/setup` in an
already-mapped topic must update that row in place, never append a second one.
This is what makes season rollover and typo correction safe.

**Folder naming** is `<league> - <sport>` (`UAAP - Men's Basketball`), flat, one
level under the season's Sports root. The league prefix keeps two leagues running
the same sport from colliding into one folder.

**Reply**

```
Mapped this topic:
UAAP — Men's Basketball
Folder: UAAP - Men's Basketball (created)
<folder URL>

Ready — try /recap ADMU here.
```

Second and later runs open with `Updated this topic's mapping:` and the folder
line reads `(existing)`.

### Argument validation

Same principle as `/recap`: diagnose the specific mistake, echo what was typed,
then repeat the usage hint. Every one of these rejects **before** any folder is
created or any row is written.

| Input | Reply opens with |
|---|---|
| `/setup` | `/setup needs a league and a sport.` |
| `/setup UAAP Men's Football` | `Missing the "\|" between the league and the sport.` + `You typed: …` |
| `/setup UAAP \| Men's \| Football` | `Too many "\|" separators … but you gave 3.` |
| `/setup \| Men's Football` | `The league is missing — it goes before the "\|".` |
| `/setup UAAP \|` | `The sport is missing — it goes after the "\|".` |
| league > 40 or sport > 60 chars | `That league or sport name is too long…` |

The length caps exist because both fields become a Drive folder name.

### Read-only commands

`/sports` and `/whereami` take no arguments. Passing some is not an error — the
command still answers, prefixed with
`(/sports takes no arguments — ignoring "…")` so the user understands why what
they typed had no effect.

---

## `/sports` and `/whereami`

Read-only. No admin gate — they expose nothing a staffer can't already see.

`/sports` lists this group's active mappings sorted by `thread_id`, with a count
of active mappings in *other* groups appended. Empty result points at `/setup`.

`/whereami` prints the group title, `chat_id`, `thread_id`, and either the
resolved `league — sport` plus folder URL, or `Mapped: no`. This is the
first thing to run when a mapping misbehaves — it distinguishes "wrong row" from
"no row" immediately.

---

## Season rollover

Each season the incoming Sports Editor creates a new `Sports` folder by hand.
Rollover is then:

1. Point `SPORTS_ROOT_FOLDER_ID` at the new folder (and bump `SEASON`).
2. Run `reseasonFolders()` once from the editor.

`reseasonFolders()` walks every active row, resolves `<league> - <sport>` under
the *new* root — creating folders that don't exist yet — and rewrites `folder_id`
in place. Mappings, chat IDs and thread IDs are untouched.

Step 2 is not optional. `folder_id` is stored per row, so without it every active
row keeps writing into last season's folders while looking perfectly healthy.

---

## Caching

Sheet reads are the slowest part of the request and Telegram retries webhooks that are
slow to respond.

- Read the entire `Sports` tab once, serialize to JSON, store in
  `CacheService.getScriptCache()` under a single key (e.g. `sports_map`)
- TTL: 300 seconds
- On cache miss, read the sheet and repopulate
- Store the whole table under one key, not per-chat entries

Include a `clearCache()` utility function so mapping edits can be picked up immediately
without waiting out the TTL.

---

## Error handling and response contract

`doPost` must **always** resolve with a `200`. Telegram retries on any non-200,
which would create duplicate documents.

The guarantee is met by **never letting `doPost` throw**: the entire handler body
is wrapped in try/catch, errors are logged via `console.error`, and the user is
notified in-thread wherever the chat/thread is known. Apps Script serves an HTTP
`200` for any `doPost` execution that completes without throwing, so an explicit
response object is not required — the current implementation returns nothing and
relies on this behavior (verified in production).

> If you ever want an explicit, self-documenting response, adding
> `return ContentService.createTextOutput('ok');` as the final line of `doPost`
> is equivalent and harmless. Either form is acceptable; the non-negotiable rule
> is the one below.

Do not throw out of `doPost` under any circumstance.

---

## Security

Apps Script's `doPost` cannot read HTTP request headers, so Telegram's
`secret_token` header cannot be validated. The `/exec` URL's obscurity is the only
practical protection.

Mitigations to implement:

- Do not commit the `/exec` URL to any public repository
- Validate that the incoming payload actually looks like a Telegram update
  (has `update_id`, and either `message` or `edited_message`); ignore anything else
- Only act on chats present in the `Sports` tab — this is the real gate, since an
  unknown caller cannot cause a document to be created anywhere

`SHARED_SECRET` is configured but unused. Leave it in Script Properties; do not build
logic that depends on it.

---

## Structure

Single file, `Code.gs`, organized as:

```javascript
function doPost(e)              // entry point, try/catch wrapper, never throws (always 200)
function handleUpdate(update)   // validate, parse, route by command
function parseCommand(text)     // strip @botname, return {command, args}
function formatThreadId(id)     // absent thread -> '(none)'

// Command handlers
function handleRecap(chatId, threadId, args)
function handleSetup(message, chatId, threadId, args)
function handleSports(chatId, threadId)
function handleWhereami(message, chatId, threadId)

// Sheet reads (cached)
function getSportsSheet()       // opens the Sports tab, readable error if missing
function getSportsMap()         // cached read, header-driven column mapping
function lookupThread(chatId, threadId)  // returns row object or null

// Sheet writes (uncached, lock-protected)
function readSportsSheet()      // {sheet, data, col} — live values, real row numbers
function upsertSportRow(values) // insert or update on (chat_id, thread_id)
function applyValues(rowArray, col, values)

// Drive
function buildFolderName(league, sport)
function resolveSportFolder(rootId, folderName)  // {folder, created}
function buildFilename(row, opponent)
function createDoc(row, filename)

// Telegram
function sendMessage(chatId, threadId, text)
function isChatAdmin(chatId, userId)  // gates /setup; fails closed

// Utilities (run from the editor)
function clearCache()
function reseasonFolders()      // repoint active rows at the new season's root
```

Writes must go through `readSportsSheet()`, never `getSportsMap()` — the cached
map has no row numbers and may be up to 300s stale.

Use `UrlFetchApp.fetch()` for the Telegram Bot API. Set
`muteHttpExceptions: true` on outbound calls so a Telegram-side error doesn't throw.

---

## Testing

Provide a `testCreateDoc()` function that runs from the editor without Telegram,
simulating a `/recap ADMU` for a hardcoded `(chat_id, thread_id)` pair. This makes it
possible to verify Drive permissions and filename construction before the webhook
is live.

Also provide `testLookup()` that logs the parsed `Sports` map, to confirm header
parsing and string comparison of the large negative chat IDs.

`testResolveFolder()` confirms the Sports root is reachable and that folder
resolution **reuses** an existing folder rather than creating a duplicate — the
one behaviour that would quietly scatter docs if it broke.

### Manual verification checklist

1. `testLookup()` logs both mapped threads correctly
2. `testResolveFolder()` reports `Reused:` for a sport that already has a folder
3. `testCreateDoc()` produces a correctly named doc in the correct folder
4. Deploy as web app, register webhook, confirm `getWebhookInfo` shows no error
5. `/recap ADMU` in a mapped thread → doc created, reply arrives **in that thread**
6. `/recap` bare → usage hint, no doc created
7. `/recap ADMU` in General topic → unmapped error, no doc created
8. `/recap ADMU` in an unmapped thread → error shows the correct chat and thread IDs
9. `/setup UAAP | Men's Football` in a fresh topic → folder created, row appended,
   `/recap` works immediately (no `clearCache()` needed)
10. Same `/setup` run a **second** time → reply says *Updated*, folder says
    *(existing)*, and the sheet still has exactly one row for that thread
11. `/setup` in the General topic → refused, no row written
12. `/setup` from a non-admin account → refused, no row written
13. `/sports` lists the group's mappings; `/whereami` shows the right IDs in both a
    mapped and an unmapped topic

---

## Deployment notes for the human

> These steps are mirrored, with troubleshooting and handoff details, in
> [README.md](README.md#deploying-a-change). Keep the two in sync if you change
> the process.

After the code is in place:

1. Deploy → New deployment → Web app → Execute as **Me**, Access **Anyone**
2. Authorize (Advanced → Go to project)
3. Copy the `/exec` URL
4. `https://api.telegram.org/bot<TOKEN>/setWebhook?url=<EXEC_URL>`
5. Verify with `/getWebhookInfo`

**On future code changes:** Deploy → *Manage* deployments → edit the existing one →
New version. Creating a *new deployment* issues a new URL and silently breaks the
webhook.

The bot must be an **administrator** in the group to receive `message_thread_id`
reliably in forum topics.

---

## Future extensions (not in scope, but don't preclude)

- Round-based subfolder routing via a second `Rounds` tab keyed on date ranges
- Placeholder substitution inside the copied doc (`replaceText` on `[Opponent]`)
- Setting editor permissions on the created doc for assigned staffers
- `/unmap` to flip `active` to `FALSE` from chat instead of editing the sheet
- Rollover as a chat command rather than an editor run

Keep the sheet-driven lookup pattern intact so any of these becomes a schema addition
rather than a rewrite.