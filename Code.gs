/**
 * /recap Telegram bot — Google Apps Script
 *
 * Copies a Google Docs coverage template into a sport's Drive folder when a
 * staffer types `/recap <OPPONENT>` in a mapped forum topic, then replies
 * in-thread with the link.
 *
 * Threads are onboarded from inside Telegram with `/setup <LEAGUE> | <Sport>`,
 * which reads the chat/thread IDs off its own update, creates (or reuses) the
 * sport's folder under the season's Sports root, and writes the row itself.
 *
 * See SPECS.md for the full contract. Configuration lives in Script Properties
 * (TELEGRAM_TOKEN, SHEET_ID, SPORTS_ROOT_FOLDER_ID, TEMPLATE_ID, SEASON) and the
 * `Sports` tab of SHEET_ID.
 */

var SPORTS_SHEET_NAME = 'Sports';
var CACHE_KEY = 'sports_map';
var CACHE_TTL_SECONDS = 300;
var TIMEZONE = 'Asia/Manila';

var CMD_RECAP = '/recap';
var CMD_SETUP = '/setup';
var CMD_SPORTS = '/sports';
var CMD_WHEREAMI = '/whereami';

var PROP_SPORTS_ROOT = 'SPORTS_ROOT_FOLDER_ID';
var PROP_TEMPLATE = 'TEMPLATE_ID';
var PROP_SEASON = 'SEASON';

// Usage hints. Every rejection ends with one of these, so a staffer never has to
// guess the shape of a command from an error alone.
var USAGE_RECAP =
  'Usage: /recap <OPPONENT>\n' +
  'Example: /recap ADMU\n\n' +
  'One opponent, written as the school acronym.';

var USAGE_SETUP =
  'Usage: /setup <LEAGUE> | <Sport>\n' +
  'Example: /setup UAAP | Men’s Basketball\n\n' +
  'The "|" separates the two fields. Both are required.';

// Opponent acronyms: letters, digits, and the occasional . - & (e.g. UP, ADMU, NU).
var OPPONENT_PATTERN = /^[A-Za-z0-9.\-&]{1,20}$/;
var MAX_LEAGUE_LENGTH = 40;
var MAX_SPORT_LENGTH = 60;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Telegram webhook entry point. MUST always return 200 — Telegram retries on
 * any non-200, which would create duplicate documents. Never throws.
 */
function doPost(e) {
  try {
    var update = JSON.parse(e.postData.contents);
    handleUpdate(update);
  } catch (err) {
    console.error('doPost error: ' + (err && err.stack ? err.stack : err));
  }

}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Validates the payload, parses the command, and routes to a handler. Any
 * failure past the point where we know the chat/thread is surfaced to the user
 * in-thread.
 */
function handleUpdate(update) {
  // Payload sanity check: must look like a Telegram update.
  if (!update || typeof update.update_id === 'undefined') {
    return;
  }
  if (!update.message && !update.edited_message) {
    return;
  }

  // Only act on fresh messages. Edited messages are accepted as valid updates
  // (so we return 200) but ignored, to avoid duplicate docs on an edit.
  var message = update.message;
  if (!message) {
    return;
  }

  var text = message.text;
  if (!text) {
    return;
  }

  var chatId = message.chat && message.chat.id;
  // Forum topics carry message_thread_id; General topic / non-forum groups omit it.
  var threadId = message.message_thread_id;

  var parsed = parseCommand(text);
  if (!parsed) {
    return;
  }

  switch (parsed.command) {
    case CMD_RECAP:
      handleRecap(chatId, threadId, parsed.args);
      return;
    case CMD_SETUP:
      handleSetup(message, chatId, threadId, parsed.args);
      return;
    case CMD_SPORTS:
      handleSports(chatId, threadId, parsed.args);
      return;
    case CMD_WHEREAMI:
      handleWhereami(message, chatId, threadId, parsed.args);
      return;
    default:
      return; // not our command — exit silently
  }
}

// ---------------------------------------------------------------------------
// /recap — create the game doc
// ---------------------------------------------------------------------------

/**
 * Resolves the thread to its sport and copies the template into that sport's
 * folder. Replies in-thread on every outcome.
 */
function handleRecap(chatId, threadId, args) {
  // Opponent must be exactly one token. Each way of getting that wrong gets its
  // own message — "usage" alone doesn't tell you which half you fumbled.
  if (!args.length) {
    sendMessage(chatId, threadId,
      '/recap needs an opponent.\n\n' + USAGE_RECAP);
    return;
  }
  if (args.length > 1) {
    sendMessage(chatId, threadId,
      'Too many words — /recap takes one opponent.\n' +
      'You typed: /recap ' + args.join(' ') + '\n' +
      'Try: /recap ' + args[0].toUpperCase() + '\n\n' + USAGE_RECAP);
    return;
  }
  if (!OPPONENT_PATTERN.test(args[0])) {
    sendMessage(chatId, threadId,
      "That doesn't look like a school acronym: " + args[0] + '\n' +
      'Letters, digits, and . - & only, up to 20 characters.\n\n' + USAGE_RECAP);
    return;
  }
  var opponent = args[0].toUpperCase();

  var row = lookupThread(chatId, threadId);
  if (!row) {
    sendMessage(chatId, threadId,
      "This thread isn't mapped yet.\n" +
      'chat_id: ' + chatId + '\n' +
      'thread_id: ' + formatThreadId(threadId) + '\n\n' +
      'Run: /setup <LEAGUE> | <Sport>\n' +
      'Example: /setup UAAP | Men’s Basketball');
    return;
  }

  var filename = buildFilename(row, opponent);

  try {
    var doc = createDoc(row, filename);
    sendMessage(chatId, threadId, 'Created: ' + filename + '\n' + doc.getUrl());
  } catch (err) {
    console.error('createDoc error: ' + (err && err.stack ? err.stack : err));
    sendMessage(chatId, threadId, "Couldn't create the doc: " + err.message);
  }
}

// ---------------------------------------------------------------------------
// /setup — onboard a thread without leaving Telegram
// ---------------------------------------------------------------------------

/**
 * Maps the topic this command was typed in. The chat and thread IDs come from
 * the update itself, so nothing has to be extracted by hand; the Drive folder is
 * created under SPORTS_ROOT_FOLDER_ID if it doesn't already exist.
 *
 * Re-running it in an already-mapped topic updates that row in place rather than
 * appending a duplicate, which is what makes the season rollover cheap.
 */
function handleSetup(message, chatId, threadId, args) {
  if (typeof threadId === 'undefined' || threadId === null) {
    sendMessage(chatId, threadId,
      '/setup only works inside a sport’s forum topic.\n' +
      'Open that topic and run it there.');
    return;
  }

  var userId = message.from && message.from.id;
  if (!isChatAdmin(chatId, userId)) {
    sendMessage(chatId, threadId,
      'Only group admins can run /setup — it writes to the Sports tracker.');
    return;
  }

  // `/setup UAAP | Men's Basketball` -> ['UAAP', "Men's Basketball"]
  // Each malformed shape is diagnosed separately: nothing is more frustrating
  // than a bare "usage:" reply when you can't see what you got wrong.
  var raw = args.join(' ').trim();

  if (!raw) {
    sendMessage(chatId, threadId,
      '/setup needs a league and a sport.\n\n' + USAGE_SETUP);
    return;
  }

  if (raw.indexOf('|') === -1) {
    sendMessage(chatId, threadId,
      'Missing the "|" between the league and the sport.\n' +
      'You typed: /setup ' + raw + '\n\n' + USAGE_SETUP);
    return;
  }

  var parts = raw.split('|');
  if (parts.length > 2) {
    sendMessage(chatId, threadId,
      'Too many "|" separators — /setup takes exactly two fields, ' +
      'but you gave ' + parts.length + '.\n' +
      'You typed: /setup ' + raw + '\n\n' + USAGE_SETUP);
    return;
  }

  var league = parts[0].trim();
  var sport = parts[1].trim();

  if (!league || !sport) {
    var missing = (!league && !sport)
      ? 'Both the league and the sport are missing'
      : (!league
        ? 'The league is missing — it goes before the "|"'
        : 'The sport is missing — it goes after the "|"');
    sendMessage(chatId, threadId, missing + '.\n\n' + USAGE_SETUP);
    return;
  }

  if (league.length > MAX_LEAGUE_LENGTH || sport.length > MAX_SPORT_LENGTH) {
    sendMessage(chatId, threadId,
      'That league or sport name is too long ' +
      '(max ' + MAX_LEAGUE_LENGTH + ' and ' + MAX_SPORT_LENGTH + ' characters).\n' +
      'These become a Drive folder name, so keep them short.\n\n' + USAGE_SETUP);
    return;
  }

  var props = PropertiesService.getScriptProperties();

  var rootId = props.getProperty(PROP_SPORTS_ROOT);
  if (!rootId) {
    sendMessage(chatId, threadId,
      'Not configured: the ' + PROP_SPORTS_ROOT + ' script property is empty.\n' +
      'Set it to this season’s Sports folder ID, then run /setup again.');
    return;
  }

  // The sheet write is read-modify-write, so serialize concurrent /setup calls.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(15000);
  } catch (err) {
    sendMessage(chatId, threadId, 'Another setup is running right now — try again in a moment.');
    return;
  }

  try {
    var folderName = buildFolderName(league, sport);
    var resolved = resolveSportFolder(rootId, folderName);

    var values = {
      chat_id: String(chatId),
      thread_id: String(threadId),
      league: league,
      sport: sport,
      folder_id: resolved.folder.getId(),
      active: 'TRUE'
    };
    var season = props.getProperty(PROP_SEASON);
    if (season) {
      values.season = season;
    }

    var result = upsertSportRow(values);
    clearCache();

    sendMessage(chatId, threadId,
      (result.updated ? 'Updated this topic’s mapping:' : 'Mapped this topic:') + '\n' +
      league + ' — ' + sport + '\n' +
      'Folder: ' + folderName + (resolved.created ? ' (created)' : ' (existing)') + '\n' +
      resolved.folder.getUrl() + '\n\n' +
      'Ready — try /recap ADMU here.');
  } catch (err) {
    console.error('handleSetup error: ' + (err && err.stack ? err.stack : err));
    sendMessage(chatId, threadId, "Couldn't finish setup: " + err.message);
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// /sports and /whereami — inspect the mapping from chat
// ---------------------------------------------------------------------------

/**
 * Lists the active mappings for this group, so you can see at a glance which
 * topics are wired up without opening the sheet.
 */
function handleSports(chatId, threadId, args) {
  var note = extraArgsNote('/sports', args);
  var rows = getSportsMap();
  var wantChat = String(chatId).trim();
  var here = [];
  var elsewhere = 0;

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.active).trim().toUpperCase() !== 'TRUE') {
      continue;
    }
    if (String(row.chat_id).trim() === wantChat) {
      here.push(row);
    } else {
      elsewhere++;
    }
  }

  if (!here.length) {
    sendMessage(chatId, threadId, note +
      'No sports mapped in this group yet.\n' +
      'Open a sport’s topic and run: /setup <LEAGUE> | <Sport>');
    return;
  }

  here.sort(function (a, b) {
    return Number(a.thread_id) - Number(b.thread_id);
  });

  var lines = here.map(function (row) {
    return '• ' + row.league + ' — ' + row.sport + '  (thread ' + row.thread_id + ')';
  });

  var text = note + 'Mapped in this group (' + here.length + '):\n' + lines.join('\n');
  if (elsewhere) {
    text += '\n\n+' + elsewhere + ' active in other groups.';
  }
  sendMessage(chatId, threadId, text);
}

/**
 * Dumps the raw IDs and mapping status for wherever it was typed. The fast way
 * to tell a bad mapping from a missing one.
 */
function handleWhereami(message, chatId, threadId, args) {
  var title = (message.chat && message.chat.title) || '(no title)';
  var lines = [
    'Group: ' + title,
    'chat_id: ' + chatId,
    'thread_id: ' + formatThreadId(threadId)
  ];

  var row = lookupThread(chatId, threadId);
  if (row) {
    lines.push('Mapped: ' + row.league + ' — ' + row.sport);
    lines.push('Folder: https://drive.google.com/drive/folders/' + row.folder_id);
  } else {
    lines.push('Mapped: no — run /setup <LEAGUE> | <Sport> here');
  }

  sendMessage(chatId, threadId, extraArgsNote('/whereami', args) + lines.join('\n'));
}

/**
 * Prefix for the read-only commands when someone passes arguments they don't
 * take. The command still runs — the note just explains why the argument had no
 * effect, instead of leaving the user to wonder.
 */
function extraArgsNote(command, args) {
  if (!args || !args.length) {
    return '';
  }
  return '(' + command + ' takes no arguments — ignoring "' + args.join(' ') + '")\n\n';
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

/**
 * Parses a message into { command, args }. Strips the @botname suffix Telegram
 * appends in groups and lowercases the command for case-insensitive matching.
 * Returns null when there is no leading token.
 */
function parseCommand(text) {
  var tokens = String(text).trim().split(/\s+/);
  if (!tokens.length || !tokens[0]) {
    return null;
  }
  // Strip everything from '@' onward: /recap@SportsRecap_bot -> /recap
  var command = tokens[0].split('@')[0].toLowerCase();
  return { command: command, args: tokens.slice(1) };
}

/** Renders an absent thread ID as `(none)` for user-facing messages. */
function formatThreadId(threadId) {
  return (typeof threadId === 'undefined' || threadId === null) ? '(none)' : threadId;
}

// ---------------------------------------------------------------------------
// Sheet lookup (cached)
// ---------------------------------------------------------------------------

/** Opens the `Sports` tab, throwing a readable error if it's missing. */
function getSportsSheet() {
  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  var sheet = SpreadsheetApp.openById(sheetId).getSheetByName(SPORTS_SHEET_NAME);
  if (!sheet) {
    throw new Error('No tab named "' + SPORTS_SHEET_NAME + '" in the mapping sheet.');
  }
  return sheet;
}

/**
 * Returns the entire `Sports` tab as an array of row objects keyed by header
 * name. Cached as a single JSON blob for CACHE_TTL_SECONDS. Column order is not
 * assumed — a name→value map is built from the header row.
 */
function getSportsMap() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(CACHE_KEY);
  if (cached) {
    return JSON.parse(cached);
  }

  var values = getSportsSheet().getDataRange().getValues();

  var rows = [];
  if (values.length > 1) {
    var headers = values[0].map(function (h) { return String(h).trim(); });
    for (var i = 1; i < values.length; i++) {
      var row = {};
      for (var c = 0; c < headers.length; c++) {
        row[headers[c]] = values[i][c];
      }
      rows.push(row);
    }
  }

  cache.put(CACHE_KEY, JSON.stringify(rows), CACHE_TTL_SECONDS);
  return rows;
}

/**
 * Finds the active mapping for (chatId, threadId). Compares as trimmed strings
 * because chat_id/thread_id may be stored as text or number in the sheet, and
 * chat IDs are large negative numbers. Returns the row object or null.
 */
function lookupThread(chatId, threadId) {
  var wantChat = String(chatId).trim();
  var wantThread = String(threadId).trim();
  var rows = getSportsMap();

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (String(row.active).trim().toUpperCase() !== 'TRUE') {
      continue;
    }
    if (String(row.chat_id).trim() === wantChat &&
        String(row.thread_id).trim() === wantThread) {
      return row;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sheet writes
// ---------------------------------------------------------------------------

/**
 * Reads the sheet uncached and returns { sheet, data, col } where `col` maps a
 * header name to its 0-based column index. Writes must never use the cached map
 * — they need live values and real row numbers.
 */
function readSportsSheet() {
  var sheet = getSportsSheet();
  var data = sheet.getDataRange().getValues();
  if (!data.length) {
    throw new Error('The Sports tab is empty — it needs a header row.');
  }

  var col = {};
  var headers = data[0];
  for (var c = 0; c < headers.length; c++) {
    var name = String(headers[c]).trim();
    if (name) {
      col[name] = c;
    }
  }
  if (typeof col.chat_id === 'undefined' || typeof col.thread_id === 'undefined') {
    throw new Error('The Sports tab needs chat_id and thread_id header columns.');
  }

  return { sheet: sheet, data: data, col: col };
}

/**
 * Inserts or updates the row for (values.chat_id, values.thread_id). Only writes
 * into columns that actually exist in the header row, so an unknown key is
 * ignored rather than shifting the table. Returns { updated, rowNumber }.
 *
 * Callers must hold the script lock — this is read-modify-write.
 */
function upsertSportRow(values) {
  var ctx = readSportsSheet();
  var data = ctx.data;
  var col = ctx.col;
  var width = data[0].length;

  var wantChat = String(values.chat_id).trim();
  var wantThread = String(values.thread_id).trim();

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][col.chat_id]).trim() === wantChat &&
        String(data[i][col.thread_id]).trim() === wantThread) {
      var existing = data[i].slice(0, width);
      applyValues(existing, col, values);
      ctx.sheet.getRange(i + 1, 1, 1, width).setValues([existing]);
      return { updated: true, rowNumber: i + 1 };
    }
  }

  var fresh = [];
  for (var c = 0; c < width; c++) {
    fresh.push('');
  }
  applyValues(fresh, col, values);
  ctx.sheet.appendRow(fresh);
  return { updated: false, rowNumber: ctx.sheet.getLastRow() };
}

/** Writes each known key of `values` into its column position in `rowArray`. */
function applyValues(rowArray, col, values) {
  for (var key in values) {
    if (values.hasOwnProperty(key) && typeof col[key] !== 'undefined') {
      rowArray[col[key]] = values[key];
    }
  }
}

// ---------------------------------------------------------------------------
// Drive folders
// ---------------------------------------------------------------------------

/** The per-sport folder name under the season's Sports root: `UAAP - Men's Basketball`. */
function buildFolderName(league, sport) {
  return league + ' - ' + sport;
}

/**
 * Finds the folder named `folderName` directly under `rootId`, creating it if
 * absent. Matching is exact and skips trashed folders, so a deleted folder from
 * a previous run doesn't get resurrected. Returns { folder, created }.
 */
function resolveSportFolder(rootId, folderName) {
  var root = DriveApp.getFolderById(rootId);
  var matches = root.getFoldersByName(folderName);

  while (matches.hasNext()) {
    var candidate = matches.next();
    if (!candidate.isTrashed() && candidate.getName() === folderName) {
      return { folder: candidate, created: false };
    }
  }

  return { folder: root.createFolder(folderName), created: true };
}

// ---------------------------------------------------------------------------
// Document creation
// ---------------------------------------------------------------------------

/**
 * Builds the doc filename: `<league>: <sport> - <OPPONENT> - <YYYY-MM-DD>`
 * where the date is today in Asia/Manila.
 */
function buildFilename(row, opponent) {
  var date = Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd');
  return row.league + ': ' + row.sport + ' - ' + opponent + ' - ' + date;
}

/**
 * Copies the template into the mapped folder under the given filename and
 * returns the new File. Duplicate names are acceptable — no collision handling.
 *
 * The template is the same across every sport, so it lives in the TEMPLATE_ID
 * script property; a non-empty `template_id` cell overrides it for that row.
 */
function createDoc(row, filename) {
  var templateId = String(row.template_id || '').trim() ||
    PropertiesService.getScriptProperties().getProperty(PROP_TEMPLATE);
  if (!templateId) {
    throw new Error('No template configured — set the ' + PROP_TEMPLATE + ' script property.');
  }

  var template = DriveApp.getFileById(templateId);
  var folder = DriveApp.getFolderById(row.folder_id);
  return template.makeCopy(filename, folder);
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

/**
 * Sends a message back to the chat, always including message_thread_id so the
 * reply lands in the originating forum topic rather than the General topic.
 * muteHttpExceptions keeps a Telegram-side error from throwing.
 */
function sendMessage(chatId, threadId, text) {
  var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  var payload = {
    chat_id: chatId,
    text: text
  };
  if (typeof threadId !== 'undefined' && threadId !== null) {
    payload.message_thread_id = threadId;
  }

  UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
}

/**
 * True when the user is the group's creator or an administrator. Used to gate
 * /setup, which mutates shared configuration. Fails closed: any API error or
 * unparseable response denies the command rather than allowing it.
 *
 * Note: messages sent by anonymous admins carry the group as the sender, so they
 * will not pass this check — post normally when running /setup.
 */
function isChatAdmin(chatId, userId) {
  if (!userId) {
    return false;
  }

  var token = PropertiesService.getScriptProperties().getProperty('TELEGRAM_TOKEN');
  var url = 'https://api.telegram.org/bot' + token + '/getChatMember' +
    '?chat_id=' + encodeURIComponent(chatId) +
    '&user_id=' + encodeURIComponent(userId);

  try {
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var body = JSON.parse(response.getContentText());
    if (!body.ok || !body.result) {
      return false;
    }
    return body.result.status === 'creator' || body.result.status === 'administrator';
  } catch (err) {
    console.error('isChatAdmin error: ' + (err && err.stack ? err.stack : err));
    return false;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Clears the cached sheet map so mapping edits are picked up immediately
 * without waiting out the TTL. Run manually from the editor.
 */
function clearCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
  console.log('Cache cleared: ' + CACHE_KEY);
}

/**
 * Season rollover. After the incoming Sports Editor creates the new season's
 * Sports folder and you point SPORTS_ROOT_FOLDER_ID at it, run this once: every
 * active row is repointed at a folder of the same name under the new root,
 * creating any that don't exist yet. Mappings and IDs are untouched.
 *
 * Without this, active rows keep writing into last season's folders.
 */
function reseasonFolders() {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty(PROP_SPORTS_ROOT);
  if (!rootId) {
    console.error(PROP_SPORTS_ROOT + ' is not set — nothing to do.');
    return;
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var ctx = readSportsSheet();
    var data = ctx.data;
    var col = ctx.col;
    if (typeof col.league === 'undefined' || typeof col.sport === 'undefined' ||
        typeof col.active === 'undefined' || typeof col.folder_id === 'undefined') {
      console.error('The Sports tab needs league, sport, folder_id and active columns.');
      return;
    }

    var season = props.getProperty(PROP_SEASON);
    var moved = 0;
    var created = 0;

    for (var i = 1; i < data.length; i++) {
      if (String(data[i][col.active]).trim().toUpperCase() !== 'TRUE') {
        continue;
      }

      var league = data[i][col.league];
      var sport = data[i][col.sport];
      var folderName = buildFolderName(league, sport);
      var resolved = resolveSportFolder(rootId, folderName);
      if (resolved.created) {
        created++;
      }

      var updates = { folder_id: resolved.folder.getId() };
      if (season) {
        updates.season = season;
      }

      var row = data[i].slice(0, data[0].length);
      applyValues(row, col, updates);
      ctx.sheet.getRange(i + 1, 1, 1, data[0].length).setValues([row]);
      moved++;

      console.log(folderName + ' -> ' + resolved.folder.getId() +
        (resolved.created ? ' (created)' : ' (existing)'));
    }

    clearCache();
    console.log('Repointed ' + moved + ' active row(s); created ' + created + ' folder(s).');
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Manual tests (run from the editor, no Telegram required)
// ---------------------------------------------------------------------------

/**
 * Logs the parsed Sports map to confirm header parsing and string comparison
 * of the large negative chat IDs.
 */
function testLookup() {
  var rows = getSportsMap();
  console.log('Parsed ' + rows.length + ' row(s):');
  console.log(JSON.stringify(rows, null, 2));
}

/**
 * Simulates `/recap ADMU` for a hardcoded (chat_id, thread_id) pair to verify
 * Drive permissions and filename construction before the webhook is live.
 * Edit CHAT_ID / THREAD_ID to match a real active row in the Sports tab.
 */
function testCreateDoc() {
  var CHAT_ID = '-100XXXXXXXXXX';
  var THREAD_ID = '2';
  var OPPONENT = 'ADMU';

  var row = lookupThread(CHAT_ID, THREAD_ID);
  if (!row) {
    console.error('No active mapping for chat_id=' + CHAT_ID + ' thread_id=' + THREAD_ID);
    return;
  }
  var filename = buildFilename(row, OPPONENT);
  var doc = createDoc(row, filename);
  console.log('Created: ' + filename);
  console.log(doc.getUrl());
}

/**
 * Verifies the Sports root is reachable and that folder resolution reuses an
 * existing folder instead of creating a duplicate. Creates a folder only if the
 * name genuinely isn't there yet.
 */
function testResolveFolder() {
  var LEAGUE = 'UAAP';
  var SPORT = "Men's Basketball";

  var rootId = PropertiesService.getScriptProperties().getProperty(PROP_SPORTS_ROOT);
  if (!rootId) {
    console.error(PROP_SPORTS_ROOT + ' is not set.');
    return;
  }

  var root = DriveApp.getFolderById(rootId);
  console.log('Sports root: ' + root.getName() + ' (' + root.getUrl() + ')');

  var resolved = resolveSportFolder(rootId, buildFolderName(LEAGUE, SPORT));
  console.log((resolved.created ? 'Created: ' : 'Reused: ') +
    resolved.folder.getName() + ' -> ' + resolved.folder.getUrl());
}
