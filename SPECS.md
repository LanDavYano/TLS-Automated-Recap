# SPECS.md — `/recap` Telegram Bot (Google Apps Script)

## Purpose

A Telegram bot for a student sports newsroom. When a staffer types `/recap ADMU` in a
sport-specific forum topic, the bot copies a Google Docs coverage template into that
sport's Drive folder, names it by convention, and replies in-thread with the link.

This removes two recurring pain points: manually duplicating the template before every
game, and manually filing the finished doc into the right Drive folder afterward.

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

### Script Properties (already configured)

| Property | Contents |
|---|---|
| `TELEGRAM_TOKEN` | Bot token for `@SportsRecap_bot` |
| `SHEET_ID` | Spreadsheet ID of the mapping sheet |
| `SHARED_SECRET` | Random string; see "Security" below |

Read these via `PropertiesService.getScriptProperties()`. Never hardcode them.

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
- `folder_id` — destination Drive folder for this thread's docs
- `template_id` — Google Doc to copy
- `season` — informational; not used in the filename currently
- `active` — `TRUE`/`FALSE`. Rows that are not truthy `TRUE` are treated as unmapped.

**Do not assume column order.** Read the header row and build a name→index map, so that
inserting a column later does not break the script.

---

## Behavior

### Command

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

**Missing argument**

```
Usage: /recap <OPPONENT>
Example: /recap ADMU
```

**Unmapped thread** — include the raw IDs so onboarding a new thread is copy-paste:

```
This thread isn't mapped yet.
chat_id: -100XXXXXXXXXX
thread_id: 3
Add a row to the Sports tab.
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

`doPost` must **always** return a `200`. Telegram retries on non-200, which would cause
duplicate documents. Wrap the entire handler body in try/catch, log the error via
`console.error`, attempt to notify the user in-thread, and return
`ContentService.createTextOutput('ok')` regardless.

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
function doPost(e)              // entry point, try/catch wrapper, always returns 200
function handleUpdate(update)   // parse, route, orchestrate
function parseCommand(text)     // strip @botname, return {command, args}
function getSportsMap()         // cached sheet read, header-driven column mapping
function lookupThread(chatId, threadId)  // returns row object or null
function buildFilename(row, opponent)
function createDoc(row, filename)
function sendMessage(chatId, threadId, text)
function clearCache()           // manual utility
```

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

### Manual verification checklist

1. `testLookup()` logs both mapped threads correctly
2. `testCreateDoc()` produces a correctly named doc in the correct folder
3. Deploy as web app, register webhook, confirm `getWebhookInfo` shows no error
4. `/recap ADMU` in a mapped thread → doc created, reply arrives **in that thread**
5. `/recap` bare → usage hint, no doc created
6. `/recap ADMU` in General topic → unmapped error, no doc created
7. `/recap ADMU` in an unmapped thread → error shows the correct chat and thread IDs

---

## Deployment notes for the human

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
- A `season` column driving filename or folder selection across seasons

Keep the sheet-driven lookup pattern intact so any of these becomes a schema addition
rather than a rewrite.