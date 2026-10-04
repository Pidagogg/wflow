// ============================================================================
// W FLOW — what every node OUTPUTS (the item shape the next node receives)
//
// The catalog says which settings a node has; this says which fields come out
// of it. That is what an AI builder (or a person) needs to write a working
// {{placeholder}} further down the graph, and it is the difference between a
// generated workflow that runs and one that renders empty strings.
//
// Three sources, most specific first:
//   1. OUTPUTS below — hand-written for every node whose handler shapes its
//      own item (read off server/executor.js). tests/node-outputs.test.js fails
//      when a node is neither listed here nor covered by rule 2 or 3.
//   2. Triggers — the keys of their sample payload (shared/samples.js), which
//      is what the executor emits when the trigger fires.
//   3. Nodes with a `storeIn` field — the incoming item plus the result under
//      that key; generic REST service nodes also add `_service`.
//
// Notation: "+ a, b" keeps every incoming field and adds a and b.
//           "= { a, b }" REPLACES the item — earlier fields are gone, so a
//           later {{placeholder}} can only use a and b.
// ============================================================================
import { samplePayloadFor } from "./samples.js";

const SENT = "= { sent: true, status }";
const CREATED = (extra) => `= { created: true, status, ${extra} }`;
const TELEGRAM = "= the Telegram API result object { ok, sent, message_id, chat, date, … }";

export const OUTPUTS = {
  // ---- files ----
  extractFile: "+ the extracted content (text / rows / pages / entries / metadata, depending on the mode), fileType, extractionError (null on success)",
  readFile: "+ the extracted content (like Extract File), fileType, extractionError (null on success)",
  writeFile: "+ written (true/false), path, size, mimeType; on failure + error",
  listFiles: "= one item per file: incoming fields + name, path, size, modifiedAt …; an empty folder gives one item + { files: [], count: 0 }",
  convertToFile: "+ converted (true/false), sourceFormat, fileName, size, fileBase64 …; on failure + error",
  compress: "+ compressed: true, format, entryCount, entries, archiveSize, fileBase64",

  // ---- core actions ----
  http: "= { status, ok, headers, data } — data is the parsed JSON body (or text)",
  emailSend: "= { sent: true, messageId, to }",
  slackSend: SENT,
  discordSend: SENT,
  teamsSend: SENT,
  outlookSend: SENT,
  sendgridEmail: SENT,
  telegramSend: TELEGRAM,
  telegramSendPhoto: TELEGRAM,
  telegramSendDocument: TELEGRAM,
  telegramSendMedia: TELEGRAM,
  telegramSetCommands: TELEGRAM,
  telegramSendLocation: TELEGRAM,
  telegramSendPoll: TELEGRAM,
  telegramEditMessage: TELEGRAM,
  telegramDeleteMessage: TELEGRAM,
  telegramForward: TELEGRAM,
  telegramPin: TELEGRAM,
  telegramChatAction: TELEGRAM,
  telegramAnswerCallback: TELEGRAM,
  telegramGetChat: "= the chat object { id, type, title, username, …, memberCount }",
  telegramGetFile: "= { fileId, fileName, size, mimeType, base64 }",
  telegramApi: TELEGRAM,
  githubIssue: CREATED("number, url, message"),
  notionPage: CREATED("id, url"),
  webhookRespond: "= { responded: true, status, body } — and the webhook caller receives body",
  wait: "the incoming items, unchanged, after the delay",
  m365Calendar: CREATED("id, webLink"),
  onedriveUpload: "= { uploaded: true, status, id, name, size, webUrl }",
  excelCreate: "= { fileName, size, rows, fileBase64 } (+ uploaded / error when it is uploaded to OneDrive)",
  wordCreate: "= { fileName, size, paragraphs, style, fileBase64 } (+ uploaded / error when it is uploaded to OneDrive)",
  sharepointUpload: "= { uploaded: true, status, id, name, size, webUrl }",
  sharepointListItem: CREATED("id, webUrl"),
  plannerTask: CREATED("id, title"),
  excelAddRow: "= { added: true, status, index }",
  twilioSms: "= { sent: true, status, sid }",
  stripePaymentLink: CREATED("url, id"),
  hubspotContact: CREATED("id"),
  airtableRow: CREATED("id"),
  gitlabIssue: CREATED("iid, url"),
  trelloCard: CREATED("id, url"),
  asanaTask: CREATED("gid, url"),
  supabaseInsert: "= { inserted: true, status, data } — data is the inserted rows",
  jiraIssue: CREATED("key, url"),
  weather: "= { fetched: true, status, city, units, temp, feelsLike, humidity, pressure, description, icon, windSpeed, windDeg, clouds, sunrise, sunset, coordinates }",
  dashboard: "+ dashboardUrl, dashboard, series, value, pointsStored",
  wordpressPost: CREATED("id, link, slug"),
  googleCalendar: CREATED("id, htmlLink"),
  dropboxUpload: "= { uploaded: true, status, name, id, size, rev }",
  mailchimpSub: "= { saved: true, status, id, email, memberStatus }",
  resendEmail: "= { sent: true, status, id }",
  zendeskTicket: CREATED("id, url"),
  pagerdutyIncident: "= { triggered: true, status, dedupKey }",
  googleDriveUpload: "= { uploaded: true, status, id, name, folderId }",
  googleDriveList: "= { fetched: true, status, count, files: [ … ] }",
  googleSheetsRead: "= { fetched: true, status, rows: [ { <column header>: value, … } ], count, headers }",
  googleSheetsAppend: "= { appended: true, status, updatedRows, range }",
  sheetsUpdate: "= { updated: true, status, updatedCells, updatedRows, range }",
  notionQueryDb: "= { fetched: true, status, count, results: [ … ] }",
  notionUpdatePage: "= { updated: true, status, id, url }",
  mongoFind: "= { fetched: true, status, count, documents: [ … ] }",
  mongoInsert: "= { inserted: true, status, insertedId }",
  airtableRead: "= { fetched: true, status, count, records: [ { id, fields: { … } } ] }",
  airtableUpdate: "= { updated: true, status, id }",
  airtableDelete: "= { deleted: true, status, id }",
  supabaseRead: "= { fetched: true, status, count, rows: [ … ] }",
  supabaseUpdate: "= { updated: true, status, count, rows: [ … ] }",
  twitterPost: "= { posted: true, status, id }",
  salesforceContact: CREATED("id"),
  slackBotSend: "= { sent: true, status, ts, channel }",
  githubCreatePr: CREATED("number, url"),
  githubCreateRelease: CREATED("id, url"),
  mailgunSend: "= { sent: true, status, id }",
  vonageSms: "= { sent: true, status, messageId }",
  opsgenieAlert: CREATED("alertId, requestId"),
  pushoverSend: "= { sent: true, status, receipt }",
  ntfySend: "= { sent: true, status, topic }",
  s3Upload: "= { uploaded: true, status, bucket, key, eTag }",
  webdavUpload: "= { uploaded: true, status, path }",
  pipedriveDeal: CREATED("id, url, noteId"),
  linearIssue: CREATED("id, identifier, url"),
  randomData: "= { <fieldName> (default \"value\"): a random value of the chosen type } — count items, the incoming ones are ignored",
  whatsappSend: "= { sent: true, status, to, messageId }",
  todoistTask: CREATED("taskId, url"),
  clickupTask: CREATED("taskId, url"),
  qrcode: "= { qrText, qrBase64, qrDataUrl, mimeType: \"image/png\", size, fileName }",
  shopifyProduct: CREATED("id, title, handle, url"),

  // ---- logic ----
  if: "the incoming items unchanged, split over the handles \"true\" and \"false\"",
  switch: "the incoming items unchanged, routed to \"case-0\", \"case-1\", … (one per row in cases, in order) or \"default\"",
  router: "the incoming items unchanged, routed to \"case-0\", \"case-1\", … (one per rule, in order) or \"fallback\"",
  filter: "only the incoming items that match, unchanged",
  set: "+ one field per row in fields (mode \"delete\" removes those keys instead)",
  code: "= whatever the code returns: an array of { json: { … } } items; any other value becomes { result }",
  jsTransform: "= the object the code returns for each item (a non-object becomes { result })",
  jsFilter: "only the items for which the expression is true, unchanged",
  jsAggregate: "= ONE item: the final accumulator object",
  loop: "+ loop: { index, total } on every item",
  loopEnd: "the items that reached the end of the loop, unchanged",
  merge: "all items arriving from every connected input, unchanged, one list",
  log: "the incoming items, unchanged (the message goes to the run log)",
  limit: "the first N incoming items, unchanged",
  sort: "the incoming items, unchanged, in the new order",
  dedupe: "the incoming items without duplicates, unchanged",
  splitOut: "= one item per element of the chosen list field (objects become the item; plain values become { value }); with includeOtherFields: true the incoming fields + <field>: element",
  dateAndTime: "+ <outputField> (default \"timestamp\") holding the result",
  math: "+ <outputField> (default: the input field itself) holding the result",
  stickyNote: "not a step — an annotation on the canvas; connect nothing to or from it",
  summarize: "= one item per group: { <groupBy>: key, <field>: aggregate, … } (one item in total without groupBy)",
  approval: "the incoming items + approval: { approved, by, at, timedOut } on handle \"approved\" (plus the approvedItem fields) or \"rejected\"",
  noop: "the incoming items, unchanged",
  stopError: "nothing — the run stops with the rendered message as its error",
  compareDatasets: "= { key, a, b } items on \"same\" / \"different\", { key, a } on \"onlyA\", { key, b } on \"onlyB\"",
  htmlExtract: "+ <outputField> (default \"htmlText\") holding the extracted text / values",

  // ---- AI ----
  aiChat: "+ reply (the model's text), usage { prompt, completion, total }",
  langchainChain: "+ <outputField> (default \"text\") with the answer, usage",
  aiAgent: "+ reply, toolRuns [ … ], usage (saved / inline agent); + reply, replyStatus, replyRaw (API agent)",
  prompt: "+ <outputField> (default \"prompt\") holding the rendered template",
  aiImage: "+ imageUrl, revisedPrompt",
  aiParser: "+ parsed (the parsed object), parseError (null on success), parsedOk",
  vectorStore: "+ stored: true, namespace, key, dimensions",

  // ---- storeIn nodes whose item is NOT the incoming one ----
  textAggregate: "= ONE item: { <storeIn> (default \"aggregated\"): all values joined, count }",
  aggregate: "= ONE item: { <storeIn> (default \"items\"): [ the collected values ] }",
  chatOutput: "= { role, message, text, chat: true, at } (+ <storeIn>: text) — shown in the chat panel",
  subworkflow: "+ <storeIn> (default \"result\"): the called workflow's final item (several end items → { outputs: [ … ] })",
};

const describeValue = (v) => (Array.isArray(v) ? "[ … ]" : v && typeof v === "object" ? `{ ${Object.keys(v).slice(0, 8).join(", ")}${Object.keys(v).length > 8 ? ", …" : ""} }` : typeof v);

/** The trigger's output keys, one level deep, from its sample payload. */
function triggerDoc(type, def) {
  let sample;
  try {
    sample = samplePayloadFor({ type, data: { config: { ...(def?.defaults || {}) } } }, {});
  } catch {
    sample = null;
  }
  if (!sample || typeof sample !== "object") return "= the incoming event";
  const keys = Object.entries(sample).map(([k, v]) => (v && typeof v === "object" ? `${k}: ${describeValue(v)}` : k));
  return `= { ${keys.join(", ")} } — a real event replaces the sample with the actual payload`;
}

/**
 * One line describing what `type` outputs, or "" when nothing is known.
 * `def` is the node's catalog definition (NODES[type]).
 */
export function outputDocFor(type, def) {
  if (OUTPUTS[type]) return OUTPUTS[type];
  if (def?.kind === "trigger") return triggerDoc(type, def);
  const storeIn = (def?.fields || []).some((f) => f.key === "storeIn");
  if (storeIn) {
    const key = def?.defaults?.storeIn || "data";
    return def?.service
      ? `+ ${key} (the storeIn field): the service's parsed JSON response, _service { type, status, endpoint, at }`
      : `+ ${key} (the storeIn field): the result`;
  }
  return "";
}

// ---- output handles ----
function rowsOf(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * The output handles a concrete node has. Switch and Router grow one handle
 * per row ("case-0", "case-1", …) plus "default" / "fallback", exactly like the
 * canvas draws them (src/components/WorkflowNode.tsx); every other node uses
 * its catalog `sources`, "out" when it lists none, and [] for dead ends.
 */
export function outputHandlesFor(node, def) {
  const config = node?.data?.config || {};
  if (node?.type === "switch") return [...rowsOf(config.cases).map((_, i) => `case-${i}`), "default"];
  if (node?.type === "router") return [...rowsOf(config.rules).map((_, i) => `case-${i}`), "fallback"];
  if (Array.isArray(def?.sources)) return def.sources.length ? def.sources : [];
  return ["out"];
}
