/**
 * /recap Telegram bot — Google Apps Script
 *
 * Copies a Google Docs coverage template into a sport's Drive folder when a
 * staffer types `/recap <OPPONENT>` in a mapped forum topic, then replies
 * in-thread with the link.
 *
 * See SPECS.md for the full contract. Configuration lives in Script Properties
 * (TELEGRAM_TOKEN, SHEET_ID, SHARED_SECRET) and the `Sports` tab of SHEET_ID.
 */

var SPORTS_SHEET_NAME = 'Sports';
var CACHE_KEY = 'sports_map';
var CACHE_TTL_SECONDS = 300;
var COMMAND = '/recap';
var TIMEZONE = 'Asia/Manila';

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
  return ContentService.createTextOutput('ok');
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Validates the payload, parses the command, and routes to doc creation or an
 * error reply. Any failure past the point where we know the chat/thread is
 * surfaced to the user in-thread.
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
  var displayThreadId = (typeof threadId === 'undefined' || threadId === null)
    ? '(none)'
    : threadId;

  var parsed = parseCommand(text);
  if (!parsed || parsed.command !== COMMAND) {
    return; // not our command — exit silently
  }

  // Opponent must be exactly one token.
  if (parsed.args.length !== 1) {
    sendMessage(chatId, threadId,
      'Usage: /recap <OPPONENT>\nExample: /recap ADMU');
    return;
  }
  var opponent = parsed.args[0].toUpperCase();

  var row = lookupThread(chatId, threadId);
  if (!row) {
    sendMessage(chatId, threadId,
      "This thread isn't mapped yet.\n" +
      'chat_id: ' + chatId + '\n' +
      'thread_id: ' + displayThreadId + '\n' +
      'Add a row to the Sports tab.');
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

// ---------------------------------------------------------------------------
// Sheet lookup (cached)
// ---------------------------------------------------------------------------

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

  var sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  var sheet = SpreadsheetApp.openById(sheetId).getSheetByName(SPORTS_SHEET_NAME);
  var values = sheet.getDataRange().getValues();

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
 */
function createDoc(row, filename) {
  var template = DriveApp.getFileById(row.template_id);
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
