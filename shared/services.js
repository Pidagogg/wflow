// ============================================================================
// W FLOW — extra node definitions (core logic + service integrations)
//
// This module holds the node types that are NOT hand-written into catalog.js:
//   * CORE   — missing core / logic / utility nodes (Router, XML, HTML Extract,
//              Markdown, Text Parser, Compare Datasets, shell/SSH/FTP, …) whose
//              behaviour is implemented in server/executor.js.
//   * ACTION — external service integrations (email, messaging, CRMs, clouds,
//              commerce, marketing, AI providers, …). Each one carries a
//              `service` descriptor (auth scheme, base URL, default endpoint and
//              a request-body template) that server/service-exec.js turns into a
//              real, authenticated HTTP call.
//
// catalog.js merges EXTRA_NODES into NODES; the palette, the inspector and the
// executor then pick them up automatically.
// ============================================================================

// ----------------------------------------------------------------------------
// CORE — logic, data and server-side utility nodes
// ----------------------------------------------------------------------------
const coreBase = { kind: "logic", category: "logic", sources: ["out"] };

// Shared field list for the external-SQL nodes (Postgres/MySQL wire protocols).
const sqlCredFields = [
  { key: "host", label: "Host", type: "text", placeholder: "db.example.com", section: "Connection" },
  { key: "port", label: "Port", type: "number", section: "Connection" },
  { key: "database", label: "Database", type: "text", section: "Connection" },
  { key: "user", label: "User", type: "text", section: "Connection" },
  { key: "password", label: "Password", type: "secret", section: "Connection" },
  { key: "ssl", label: "Use TLS", type: "boolean", section: "Connection", optional: true },
  { key: "query", label: "SQL query (use $1 / ? placeholders)", type: "textarea", section: "Query" },
  { key: "params", label: "Parameters (JSON array)", type: "json", section: "Query", optional: true },
  { key: "storeIn", label: "Save rows under field", type: "text", placeholder: "rows", section: "Output" },
  { key: "connectTimeoutMs", label: "Connection timeout (ms)", type: "number", section: "Output", optional: true },
];

const CORE = {
  // ---- flow control -------------------------------------------------------
  router: {
    kind: "logic",
    category: "logic",
    type: "router",
    name: "Router",
    description: "Route each item to the first rule it matches — one output handle per rule, plus a fallback for everything else.",
    icon: "shuffle",
    sources: [],
    defaults: {
      rules: [{ field: "status", operator: "equals", value: "success", label: "Success" }],
      caseSensitive: false,
    },
    fields: [
      {
        key: "rules",
        label: "Rules (JSON array)",
        type: "json",
        help: 'Each rule is { "field", "operator", "value", "label" }. Operators: equals, notEquals, contains, notContains, startsWith, regex, gt, lt, exists, notExists. The first matching rule wins.',
        section: "Rules",
      },
      { key: "caseSensitive", label: "Case sensitive", type: "boolean", section: "Rules", optional: true },
      { key: "note", label: "Outputs", type: "note", section: "Rules", help: "The node grows one output handle per rule; items that match no rule leave through the FALLBACK handle." },
    ],
  },

  aggregate: {
    ...coreBase,
    type: "aggregate",
    name: "Aggregate (Array)",
    description: "Collect every incoming item into a single array — either the whole objects or one field from each.",
    icon: "list",
    defaults: { mode: "items", field: "", storeIn: "items" },
    fields: [
      {
        key: "mode",
        label: "What to collect",
        type: "select",
        options: [
          { value: "items", label: "All items (full objects)" },
          { value: "field", label: "One field from each item" },
        ],
        section: "Aggregate",
      },
      { key: "field", label: "Field name (for 'one field')", type: "text", optional: true, section: "Aggregate" },
      { key: "storeIn", label: "Save the array under field", type: "text", placeholder: "items", section: "Output" },
    ],
  },

  compareDatasets: {
    kind: "logic",
    category: "logic",
    type: "compareDatasets",
    name: "Compare Datasets",
    description: "Compare two lists by a key and split the result into matching, differing, only-A and only-B items.",
    icon: "filter",
    sources: ["same", "different", "onlyA", "onlyB"],
    defaults: { listA: "items", listB: "items", keyField: "id", compareField: "" },
    fields: [
      { key: "listA", label: "List A (field holding an array)", type: "text", placeholder: "items", section: "Input" },
      { key: "listB", label: "List B (field holding an array)", type: "text", placeholder: "items", section: "Input" },
      { key: "keyField", label: "Key field to match items on", type: "text", placeholder: "id", section: "Compare" },
      { key: "compareField", label: "Field to compare (optional)", type: "text", help: "When set, items with the same key are 'different' when this field differs. When empty the whole object is compared.", section: "Compare", optional: true },
    ],
  },

  // ---- data formats -------------------------------------------------------
  xml: {
    ...coreBase,
    type: "xml",
    name: "XML",
    description: "Parse XML text into JSON, or build an XML document from JSON.",
    icon: "code",
    defaults: { mode: "parse", field: "xml", storeIn: "xmlData", rootName: "root", attributePrefix: "@", textKey: "#text" },
    fields: [
      { key: "mode", label: "Mode", type: "select", options: [{ value: "parse", label: "Parse XML → JSON" }, { value: "build", label: "Build XML from JSON" }], section: "Mode" },
      { key: "field", label: "Field holding the XML (parse) / object (build)", type: "text", section: "Input" },
      { key: "rootName", label: "Root element name (build)", type: "text", section: "Build", optional: true },
      { key: "attributePrefix", label: "Attribute prefix", type: "text", section: "Parse", optional: true },
      { key: "textKey", label: "Text node key", type: "text", section: "Parse", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  htmlExtract: {
    ...coreBase,
    type: "htmlExtract",
    name: "HTML Extract",
    description: "Pull text, links, attributes or table cells out of HTML (best-effort, no browser needed).",
    icon: "fileSearch",
    defaults: { mode: "text", field: "html", tag: "", attribute: "", outputField: "htmlText" },
    fields: [
      {
        key: "mode",
        label: "Extract",
        type: "select",
        options: [
          { value: "text", label: "Visible text" },
          { value: "title", label: "Page title" },
          { value: "links", label: "All links (href)" },
          { value: "images", label: "All image sources" },
          { value: "attributes", label: "Attribute of a tag" },
          { value: "tables", label: "Table rows" },
        ],
        section: "Extract",
      },
      { key: "field", label: "Field holding the HTML", type: "text", placeholder: "html", section: "Input" },
      { key: "tag", label: "Tag (for attribute mode)", type: "text", placeholder: "a", section: "Extract", optional: true },
      { key: "attribute", label: "Attribute name", type: "text", placeholder: "href", section: "Extract", optional: true },
      { key: "outputField", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  markdown: {
    ...coreBase,
    type: "markdown",
    name: "Markdown",
    description: "Convert Markdown to HTML, or strip HTML/markdown down to plain text.",
    icon: "text",
    defaults: { mode: "toHtml", field: "markdown", storeIn: "html" },
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "toHtml", label: "Markdown → HTML" },
          { value: "toMarkdown", label: "HTML → Markdown" },
          { value: "toText", label: "Markdown → plain text" },
        ],
        section: "Mode",
      },
      { key: "field", label: "Field holding the source", type: "text", section: "Input" },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  textParser: {
    ...coreBase,
    type: "textParser",
    name: "Text Parser / Regex",
    description: "Extract with a regular expression, replace text, or split a field.",
    icon: "search",
    defaults: { mode: "extract", field: "text", pattern: "", flags: "g", replacement: "", group: 0, storeIn: "match" },
    fields: [
      {
        key: "mode",
        label: "Operation",
        type: "select",
        options: [
          { value: "extract", label: "Extract first match" },
          { value: "all", label: "Extract every match" },
          { value: "replace", label: "Replace" },
          { value: "split", label: "Split" },
          { value: "test", label: "Test (true/false)" },
        ],
        section: "Operation",
      },
      { key: "field", label: "Field to read (supports {{vars}})", type: "text", section: "Input" },
      { key: "pattern", label: "Regular expression", type: "text", placeholder: "\\w+@\\w+\\.\\w+", section: "Pattern" },
      { key: "flags", label: "Flags", type: "text", placeholder: "gim", section: "Pattern", optional: true },
      { key: "replacement", label: "Replacement (for Replace)", type: "text", section: "Pattern", optional: true },
      { key: "group", label: "Capture group (0 = whole match)", type: "number", section: "Pattern", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  // ---- server-side command / protocol nodes --------------------------------
  executeCommand: {
    ...coreBase,
    type: "executeCommand",
    name: "Execute Command",
    description: "Run a shell command on the server. Disabled unless the operator sets BF_ALLOW_COMMANDS=1.",
    icon: "terminal",
    defaults: { command: "", cwd: "", timeout: 60000, storeIn: "command" },
    fields: [
      { key: "command", label: "Command", type: "textarea", placeholder: "echo \"{{message}}\"", section: "Command", help: "Run through the system shell. Blocked unless the server sets BF_ALLOW_COMMANDS=1." },
      { key: "cwd", label: "Working directory (optional)", type: "text", section: "Command", optional: true },
      { key: "timeout", label: "Timeout (ms)", type: "number", section: "Command", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  ssh: {
    ...coreBase,
    type: "ssh",
    name: "SSH",
    description: "Run a command on a remote host over SSH (uses the server's ssh client). Disabled unless the operator sets BF_ALLOW_COMMANDS=1.",
    icon: "terminal",
    defaults: { host: "", port: 22, user: "", privateKeyPath: "", command: "", timeout: 30000, storeIn: "ssh" },
    fields: [
      { key: "host", label: "Host", type: "text", section: "Connection" },
      { key: "port", label: "Port", type: "number", section: "Connection" },
      { key: "user", label: "User", type: "text", section: "Connection" },
      { key: "privateKeyPath", label: "Private key path (optional)", type: "text", section: "Connection", optional: true, help: "Path to a key file the server can read. Without it the server's default SSH agent/keys are used." },
      { key: "command", label: "Command", type: "textarea", section: "Command" },
      { key: "timeout", label: "Timeout (ms)", type: "number", section: "Command", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  ftp: {
    ...coreBase,
    type: "ftp",
    name: "FTP / SFTP",
    description: "Upload, download or list files on an FTP / SFTP server (uses the server's curl). Disabled unless the operator sets BF_ALLOW_COMMANDS=1.",
    icon: "hardDrive",
    defaults: { protocol: "sftp", host: "", port: 22, user: "", password: "", action: "list", remotePath: "/", localPath: "", storeIn: "ftp" },
    fields: [
      { key: "protocol", label: "Protocol", type: "select", options: [{ value: "sftp", label: "SFTP" }, { value: "ftp", label: "FTP" }, { value: "ftps", label: "FTPS" }], section: "Connection" },
      { key: "host", label: "Host", type: "text", section: "Connection" },
      { key: "port", label: "Port", type: "number", section: "Connection" },
      { key: "user", label: "User", type: "text", section: "Connection" },
      { key: "password", label: "Password", type: "secret", section: "Connection" },
      { key: "action", label: "Action", type: "select", options: [{ value: "list", label: "List a directory" }, { value: "download", label: "Download a file" }, { value: "upload", label: "Upload a file" }], section: "Transfer" },
      { key: "remotePath", label: "Remote path", type: "text", section: "Transfer" },
      { key: "localPath", label: "Local path (upload/download)", type: "text", section: "Transfer", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  git: {
    ...coreBase,
    type: "git",
    name: "Git",
    description: "Run a git command in a local repository (uses the server's git client). Disabled unless the operator sets BF_ALLOW_COMMANDS=1.",
    icon: "branch",
    defaults: { repoPath: "", action: "status", args: "", timeout: 60000, storeIn: "git" },
    fields: [
      { key: "repoPath", label: "Repository path", type: "text", section: "Command" },
      { key: "action", label: "Action", type: "select", options: [{ value: "status", label: "status" }, { value: "pull", label: "pull" }, { value: "log", label: "log" }, { value: "clone", label: "clone" }, { value: "custom", label: "Custom arguments" }], section: "Command" },
      { key: "args", label: "Extra arguments", type: "text", section: "Command", optional: true },
      { key: "timeout", label: "Timeout (ms)", type: "number", section: "Command", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  docker: {
    ...coreBase,
    type: "docker",
    name: "Docker",
    description: "Run a docker command on the server (uses the server's docker CLI). Disabled unless the operator sets BF_ALLOW_COMMANDS=1.",
    icon: "terminal",
    defaults: { action: "ps", container: "", image: "", args: "", timeout: 60000, storeIn: "docker" },
    fields: [
      { key: "action", label: "Action", type: "select", options: [{ value: "ps", label: "List containers" }, { value: "start", label: "Start container" }, { value: "stop", label: "Stop container" }, { value: "restart", label: "Restart container" }, { value: "pull", label: "Pull image" }, { value: "custom", label: "Custom arguments" }], section: "Command" },
      { key: "container", label: "Container", type: "text", section: "Command", optional: true },
      { key: "image", label: "Image", type: "text", section: "Command", optional: true },
      { key: "args", label: "Extra arguments", type: "text", section: "Command", optional: true },
      { key: "timeout", label: "Timeout (ms)", type: "number", section: "Command", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  redis: {
    ...coreBase,
    type: "redis",
    name: "Redis",
    description: "Run a Redis command (GET / SET / DEL / …) over the wire protocol.",
    icon: "database",
    defaults: { host: "127.0.0.1", port: 6379, password: "", db: 0, command: "GET", key: "", value: "", storeIn: "redis" },
    fields: [
      { key: "host", label: "Host", type: "text", section: "Connection" },
      { key: "port", label: "Port", type: "number", section: "Connection" },
      { key: "password", label: "Password", type: "secret", section: "Connection", optional: true },
      { key: "db", label: "Database number", type: "number", section: "Connection", optional: true },
      { key: "command", label: "Command", type: "text", placeholder: "SET", section: "Command" },
      { key: "key", label: "Key", type: "text", section: "Command" },
      { key: "value", label: "Value (for SET/…)", type: "text", section: "Command", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  mqtt: {
    ...coreBase,
    type: "mqtt",
    name: "MQTT",
    description: "Publish a message to an MQTT broker (requires the optional mqtt package).",
    icon: "send",
    defaults: { url: "", topic: "", message: "{{message}}", username: "", password: "", storeIn: "mqtt" },
    fields: [
      { key: "url", label: "Broker URL", type: "text", placeholder: "mqtt://broker.example.com:1883", section: "Broker" },
      { key: "topic", label: "Topic", type: "text", section: "Broker" },
      { key: "message", label: "Message (supports {{vars}})", type: "textarea", section: "Message" },
      { key: "username", label: "Username", type: "text", section: "Broker", optional: true },
      { key: "password", label: "Password", type: "secret", section: "Broker", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  kafka: {
    ...coreBase,
    type: "kafka",
    name: "Kafka",
    description: "Produce a message to a Kafka topic (requires the optional kafkajs package).",
    icon: "send",
    defaults: { brokers: "", topic: "", message: "{{message}}", clientId: "wflow", storeIn: "kafka" },
    fields: [
      { key: "brokers", label: "Brokers (comma separated)", type: "text", placeholder: "localhost:9092", section: "Broker" },
      { key: "topic", label: "Topic", type: "text", section: "Broker" },
      { key: "clientId", label: "Client id", type: "text", section: "Broker", optional: true },
      { key: "message", label: "Message (supports {{vars}})", type: "textarea", section: "Message" },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  // ---- external SQL databases (wire-protocol clients already in the project) --
  sqlMariadb: {
    ...coreBase,
    type: "sqlMariadb",
    name: "MariaDB — Query",
    description: "Run a query against a MariaDB server (MySQL wire protocol).",
    icon: "database",
    defaults: { host: "127.0.0.1", port: 3306, database: "", user: "", password: "", ssl: false, query: "SELECT 1 AS one;", params: "[]", storeIn: "rows", connectTimeoutMs: 8000 },
    fields: sqlCredFields,
  },

  sqlTimescaledb: {
    ...coreBase,
    type: "sqlTimescaledb",
    name: "TimescaleDB — Query",
    description: "Run a query against a TimescaleDB (PostgreSQL wire protocol) server.",
    icon: "database",
    defaults: { host: "127.0.0.1", port: 5432, database: "", user: "", password: "", ssl: false, query: "SELECT 1 AS one;", params: "[]", storeIn: "rows", connectTimeoutMs: 8000 },
    fields: sqlCredFields,
  },

  sqlCratedb: {
    ...coreBase,
    type: "sqlCratedb",
    name: "CrateDB — Query",
    description: "Run a query against a CrateDB server (PostgreSQL wire protocol).",
    icon: "database",
    defaults: { host: "127.0.0.1", port: 5432, database: "doc", user: "crate", password: "", ssl: false, query: "SELECT 1 AS one;", params: "[]", storeIn: "rows", connectTimeoutMs: 8000 },
    fields: sqlCredFields,
  },

  sqlQuestdb: {
    ...coreBase,
    type: "sqlQuestdb",
    name: "QuestDB — Query",
    description: "Run a query against a QuestDB server (PostgreSQL wire protocol, port 8812).",
    icon: "database",
    defaults: { host: "127.0.0.1", port: 8812, database: "qdb", user: "admin", password: "quest", ssl: false, query: "SELECT 1 AS one;", params: "[]", storeIn: "rows", connectTimeoutMs: 8000 },
    fields: sqlCredFields,
  },

  sqlSqlserver: {
    ...coreBase,
    type: "sqlSqlserver",
    name: "Microsoft SQL Server — Query",
    description: "Run a query against a Microsoft SQL Server database (requires the optional mssql package).",
    icon: "database",
    defaults: { host: "127.0.0.1", port: 1433, database: "", user: "", password: "", encrypt: true, query: "SELECT 1 AS one;", params: "[]", storeIn: "rows", connectTimeoutMs: 8000 },
    fields: sqlCredFields,
  },

  // ---- AI ----------------------------------------------------------------
  aiClassify: {
    kind: "ai",
    category: "ai",
    type: "aiClassify",
    name: "Text Classifier / Sentiment",
    description: "Classify a field into one of your categories (or a sentiment) with a chat model.",
    icon: "sparkles",
    sources: ["out"],
    defaults: {
      provider: "openai",
      baseUrl: "",
      apiKey: "",
      model: "gpt-4o-mini",
      temperature: 0,
      maxTokens: 256,
      field: "text",
      categories: "positive, negative, neutral",
      mode: "categories",
      storeIn: "classification",
    },
    fields: [
      {
        key: "mode",
        label: "Mode",
        type: "select",
        options: [
          { value: "categories", label: "Choose one of my categories" },
          { value: "sentiment", label: "Sentiment (positive / negative / neutral)" },
        ],
        section: "Task",
      },
      { key: "field", label: "Field with the text to classify", type: "text", placeholder: "text", section: "Input" },
      { key: "categories", label: "Categories (comma separated)", type: "text", section: "Task", optional: true },
      { key: "provider", label: "Provider", type: "text", section: "Model", optional: true },
      { key: "baseUrl", label: "Base URL", type: "text", section: "Model", optional: true },
      { key: "apiKey", label: "API key", type: "secret", section: "Model", optional: true },
      { key: "model", label: "Model", type: "text", section: "Model", optional: true },
      { key: "storeIn", label: "Save result under field", type: "text", section: "Output" },
    ],
  },

  // ---- triggers -----------------------------------------------------------
  formTrigger: {
    kind: "trigger",
    category: "triggers",
    type: "formTrigger",
    name: "Form Trigger",
    description: "Start the workflow from a web form submission. Pressing Run fires a representative form payload.",
    icon: "checkSquare",
    sources: ["out"],
    defaults: { formName: "Contact form", fields: "name, email, message" },
    fields: [
      { key: "sampleInfo", label: "About this trigger", type: "note", help: "Pressing Run fires a sample form submission so you can design and test the flow." },
      { key: "formName", label: "Form name", type: "text", section: "Form" },
      { key: "fields", label: "Form fields (comma separated)", type: "text", section: "Form" },
    ],
  },

  executeWorkflowTrigger: {
    kind: "trigger",
    category: "triggers",
    type: "executeWorkflowTrigger",
    name: "Execute Workflow Trigger",
    description: "The entry point of a reusable sub-workflow — it receives the items the caller passes in.",
    icon: "workflow",
    sources: ["out"],
    defaults: {},
    fields: [
      { key: "note", label: "How it works", type: "note", help: "Put this at the start of a workflow you call with an Execute Sub-Workflow node. The caller's items arrive here and flow down the rest of the graph." },
    ],
  },
};

// ----------------------------------------------------------------------------
// SERVICE ACTIONS — external integrations driven by server/service-exec.js
//
// Each entry is a tuple:
//   [type, name, icon, auth, credKey, credLabel, base, method, path, body, desc, extraHeaders?]
//
// auth:  "bearer" | "header:<Name>" | "query:<param>" | "basic" | "aws" | "none"
// body:  an object template ({{placeholders}} are filled from the incoming item)
//        or null for GET-style calls.
// extraHeaders: an optional { Header: value } map pre-fills the node's
//        "Extra headers" field for services that require a constant header
//        (e.g. Notion's Notion-Version). The user can still edit it.
// ----------------------------------------------------------------------------
function buildAction(t) {
  const [type, name, icon, auth, credKey, credLabel, base, method, path, body, desc, extraHeaders] = t;
  const isAws = auth === "aws";
  const isNone = auth === "none";
  const fields = [
    { key: "baseUrl", label: "Base URL", type: "text", help: "Override the service's API base when you use a proxy or a different region.", section: "Request", optional: true },
    { key: "path", label: "Endpoint path", type: "text", help: "Relative to the base URL. Supports {{placeholders}} from the incoming item.", section: "Request" },
    { key: "method", label: "Method", type: "select", options: ["GET", "POST", "PUT", "PATCH", "DELETE"], section: "Request" },
    { key: "query", label: "Query parameters (JSON, {{vars}} allowed)", type: "json", section: "Request", optional: true },
    { key: "headers", label: "Extra headers (JSON)", type: "json", section: "Request", optional: true },
    { key: "body", label: "Request body (JSON, {{vars}} allowed)", type: "json", section: "Request", optional: true },
  ];
  if (!isNone && !isAws) {
    fields.unshift({ key: credKey, label: credLabel, type: "secret", section: "Credentials" });
  }
  if (isAws) {
    fields.unshift(
      { key: "region", label: "AWS region", type: "text", placeholder: "us-east-1", section: "Credentials" },
      { key: "secretKey", label: "Secret access key", type: "secret", section: "Credentials" },
      { key: "accessKey", label: "Access key id", type: "text", section: "Credentials" },
    );
  }
  fields.push({ key: "storeIn", label: "Save result under field", type: "text", placeholder: "data", section: "Output" });

  const defaults = {
    baseUrl: base,
    method,
    path: path || "",
    query: "",
    headers: extraHeaders ? JSON.stringify(extraHeaders) : "",
    body: body ? JSON.stringify(body) : "",
    storeIn: "data",
  };
  if (isAws) {
    defaults.region = "us-east-1";
    defaults.accessKey = "";
    defaults.secretKey = "";
  } else if (!isNone) {
    defaults[credKey] = "";
  }

  return {
    type,
    name,
    kind: "action",
    category: "actions",
    sources: ["out"],
    description: desc,
    icon,
    service: { auth, credKey, base, defaultMethod: method, defaultPath: path || "", defaultBody: body || null },
    defaults,
    fields,
  };
}

const ACTIONS = [
  // ---- Email ---------------------------------------------------------------
  ["postmarkSend", "Postmark — Send Email", "mail", "header:X-Postmark-Server-Token", "serverToken", "Server token", "https://api.postmarkapp.com", "POST", "/email", { From: "{{from}}", To: "{{to}}", Subject: "{{subject}}", TextBody: "{{body}}" }, "Send a transactional email through Postmark."],
  ["brevoSend", "Brevo (Sendinblue) — Send Email", "mailSend", "header:api-key", "apiKey", "API key", "https://api.brevo.com", "POST", "/v3/smtp/email", { sender: { email: "{{from}}" }, to: [{ email: "{{to}}" }], subject: "{{subject}}", htmlContent: "{{body}}" }, "Send a transactional email through Brevo (formerly Sendinblue)."],
  ["mailjetSend", "Mailjet — Send Email", "mailSend", "basic", "basicAuth", "API key : secret key", "https://api.mailjet.com", "POST", "/v3.1/send", { Messages: [{ From: { Email: "{{from}}" }, To: [{ Email: "{{to}}" }], Subject: "{{subject}}", TextPart: "{{body}}" }] }, "Send an email through Mailjet."],
  ["sesSend", "Amazon SES — Send Email", "mailSend", "aws", "", "", "https://email.us-east-1.amazonaws.com", "POST", "/v2/email/outbound-emails", { FromEmailAddress: "{{from}}", Destination: { ToAddresses: ["{{to}}"] }, Content: { Simple: { Subject: { Data: "{{subject}}" }, Body: { Text: { Data: "{{body}}" } } } } }, "Send an email through Amazon SES (SigV4-signed)."],
  ["mailerliteSub", "MailerLite — Add Subscriber", "mail", "bearer", "apiKey", "API key", "https://connect.mailerlite.com", "POST", "/api/subscribers", { email: "{{email}}", fields: { name: "{{name}}" } }, "Add or update a MailerLite subscriber."],

  // ---- Messaging & communication -------------------------------------------
  ["googleChatSend", "Google Chat — Send Message", "messageSquare", "bearer", "token", "OAuth access token", "https://chat.googleapis.com", "POST", "/v1/spaces/{{space}}/messages", { text: "{{text}}" }, "Post a message into a Google Chat space."],
  ["mattermostSend", "Mattermost — Send Message", "messageSquare", "bearer", "token", "Bot access token", "https://mattermost.example.com", "POST", "/api/v4/posts", { channel_id: "{{channel}}", message: "{{text}}" }, "Post a message to a Mattermost channel."],
  ["zoomMeeting", "Zoom — Create Meeting", "calendar", "bearer", "token", "OAuth access token", "https://api.zoom.us", "POST", "/v2/users/me/meetings", { topic: "{{topic}}", type: 2, start_time: "{{startTime}}", duration: 30 }, "Create a Zoom meeting."],
  ["messengerSend", "Facebook Messenger — Send Message", "messageCircle", "query:access_token", "accessToken", "Page access token", "https://graph.facebook.com", "POST", "/v21.0/me/messages", { recipient: { id: "{{to}}" }, message: { text: "{{text}}" } }, "Send a Facebook Messenger message from a page."],
  ["messagebirdSend", "MessageBird — Send SMS", "send", "header:Authorization", "accessKey", "Access key (AccessKey …)", "https://rest.messagebird.com", "POST", "/messages", { originator: "{{from}}", recipients: ["{{to}}"], body: "{{text}}" }, "Send an SMS through MessageBird."],
  ["lineSend", "LINE — Push Message", "messageCircle", "bearer", "token", "Channel access token", "https://api.line.me", "POST", "/v2/bot/message/push", { to: "{{to}}", messages: [{ type: "text", text: "{{text}}" }] }, "Push a LINE message to a user or group."],
  ["rocketchatSend", "Rocket.Chat — Send Message", "messageCircle", "header:X-Auth-Token", "authToken", "Auth token", "https://rocket.chat", "POST", "/api/v1/chat.postMessage", { channel: "{{channel}}", text: "{{text}}" }, "Post a message into Rocket.Chat."],
  ["webexSend", "Webex — Send Message", "messageSquare", "bearer", "token", "Access token", "https://webexapis.com", "POST", "/v1/messages", { toPersonEmail: "{{to}}", markdown: "{{text}}" }, "Send a Webex message."],
  ["matrixSend", "Matrix — Send Message", "messageCircle", "bearer", "token", "Access token", "https://matrix.org", "PUT", "/_matrix/client/v3/rooms/{{room}}/send/m.room.message/{{txnId}}", { msgtype: "m.text", body: "{{text}}" }, "Send a Matrix room message."],

  // ---- Google --------------------------------------------------------------
  ["googleDocsCreate", "Google Docs — Create Document", "file", "bearer", "token", "OAuth access token", "https://docs.googleapis.com", "POST", "/v1/documents", { title: "{{title}}" }, "Create a Google Docs document."],
  ["googleSlidesCreate", "Google Slides — Create Presentation", "file", "bearer", "token", "OAuth access token", "https://slides.googleapis.com", "POST", "/v1/presentations", { title: "{{title}}" }, "Create a Google Slides presentation."],
  ["googleFormsGet", "Google Forms — Get Form", "checkSquare", "bearer", "token", "OAuth access token", "https://forms.googleapis.com", "GET", "/v1/forms/{{formId}}", null, "Read a Google Form definition."],
  ["googleContactsCreate", "Google Contacts — Create Contact", "users", "bearer", "token", "OAuth access token", "https://people.googleapis.com", "POST", "/v1/people:createContact", { names: [{ givenName: "{{firstName}}", familyName: "{{lastName}}" }], emailAddresses: [{ value: "{{email}}" }] }, "Create a Google Contact."],
  ["googleTasksCreate", "Google Tasks — Create Task", "checkSquare", "bearer", "token", "OAuth access token", "https://tasks.googleapis.com", "POST", "/tasks/v1/lists/{{listId}}/tasks", { title: "{{title}}", notes: "{{notes}}" }, "Add a task to a Google Tasks list."],
  ["bigqueryQuery", "Google BigQuery — Query", "database", "bearer", "token", "OAuth access token", "https://bigquery.googleapis.com", "POST", "/bigquery/v2/projects/{{projectId}}/queries", { query: "{{query}}", useLegacySql: false }, "Run a query on Google BigQuery."],
  ["gcsUpload", "Google Cloud Storage — Upload", "cloudUpload", "bearer", "token", "OAuth access token", "https://storage.googleapis.com", "POST", "/upload/storage/v1/b/{{bucket}}/o", { name: "{{objectName}}" }, "Upload an object to a Google Cloud Storage bucket."],
  ["googleAnalyticsReport", "Google Analytics — Run Report", "list", "bearer", "token", "OAuth access token", "https://analyticsdata.googleapis.com", "POST", "/v1beta/properties/{{propertyId}}:runReport", { metrics: [{ name: "sessions" }], dateRanges: [{ startDate: "7daysAgo", endDate: "today" }] }, "Run a Google Analytics 4 report."],
  ["googleAdsReport", "Google Ads — Run Query", "list", "header:developer-token", "developerToken", "Developer token", "https://googleads.googleapis.com", "POST", "/v18/customers/{{customerId}}:searchStream", { query: "{{query}}" }, "Run a Google Ads query (needs a developer token and OAuth header)."],
  ["googleBusinessPost", "Google Business Profile — Create Post", "mapPin", "bearer", "token", "OAuth access token", "https://mybusiness.googleapis.com", "POST", "/v4/accounts/{{accountId}}/locations/{{locationId}}/localPosts", { summary: "{{text}}", topicType: "STANDARD" }, "Create a Google Business Profile post."],
  ["firestoreSet", "Firebase Firestore — Set Document", "database", "bearer", "token", "OAuth access token", "https://firestore.googleapis.com", "PATCH", "/v1/projects/{{projectId}}/databases/(default)/documents/{{path}}", { fields: "{{fields}}" }, "Create or replace a Firestore document."],
  ["pubsubPublish", "Google Cloud Pub/Sub — Publish", "send", "bearer", "token", "OAuth access token", "https://pubsub.googleapis.com", "POST", "/v1/projects/{{projectId}}/topics/{{topic}}:publish", { messages: [{ data: "{{data}}" }] }, "Publish a message to a Google Cloud Pub/Sub topic."],
  ["googleTranslate", "Google Translate — Translate Text", "languages", "query:key", "apiKey", "API key", "https://translation.googleapis.com", "POST", "/language/translate/v2", { q: "{{text}}", target: "{{targetLanguage}}" }, "Translate text with the Google Translation API."],

  // ---- Microsoft -----------------------------------------------------------
  ["msTodoCreate", "Microsoft To Do — Create Task", "checkSquare", "bearer", "token", "OAuth access token", "https://graph.microsoft.com", "POST", "/v1.0/me/todo/lists/{{listId}}/tasks", { title: "{{title}}" }, "Create a task in Microsoft To Do."],
  ["dynamicsCreate", "Dynamics 365 — Create Record", "briefcase", "bearer", "token", "OAuth access token", "https://{{org}}.crm.dynamics.com", "POST", "/api/data/v9.2/{{entity}}", { name: "{{name}}" }, "Create a record in Dynamics 365."],
  ["azureBlobUpload", "Azure Blob Storage — Upload", "cloudUpload", "header:Authorization", "sasToken", "SAS token", "https://{{account}}.blob.core.windows.net", "PUT", "/{{container}}/{{blob}}", null, "Upload a blob to Azure Blob Storage using a SAS token."],
  ["cosmosUpsert", "Azure Cosmos DB — Upsert Item", "database", "header:Authorization", "authKey", "Auth key header", "https://{{account}}.documents.azure.com", "POST", "/dbs/{{database}}/colls/{{container}}/docs", { id: "{{id}}" }, "Create or replace an item in Azure Cosmos DB."],
  ["powerBiRefresh", "Power BI — Refresh Dataset", "list", "bearer", "token", "OAuth access token", "https://api.powerbi.com", "POST", "/v1.0/myorg/datasets/{{datasetId}}/refreshes", null, "Trigger a Power BI dataset refresh."],
  ["oneNoteCreate", "OneNote — Create Page", "file", "bearer", "token", "OAuth access token", "https://graph.microsoft.com", "POST", "/v1.0/me/onenote/pages", null, "Create a OneNote page (send HTML body)."],
  ["azureOpenaiChat", "Azure OpenAI — Chat", "sparkles", "header:api-key", "apiKey", "API key", "https://{{resource}}.openai.azure.com", "POST", "/openai/deployments/{{deployment}}/chat/completions?api-version=2024-06-01", { messages: [{ role: "user", content: "{{prompt}}" }] }, "Call an Azure OpenAI chat deployment."],

  // ---- Productivity, PM & forms --------------------------------------------
  ["mondayCreateItem", "monday.com — Create Item", "list", "bearer", "token", "API token", "https://api.monday.com", "POST", "/v2", { query: "mutation { create_item(board_id: {{boardId}}, item_name: \"{{name}}\") { id } }" }, "Create an item on a monday.com board."],
  ["basecampCreate", "Basecamp — Create Todo", "checkSquare", "bearer", "token", "OAuth access token", "https://3.basecampapi.com", "POST", "/{{accountId}}/buckets/{{projectId}}/todolists/{{listId}}/todos.json", { content: "{{title}}" }, "Add a todo to a Basecamp list."],
  ["codaCreateRow", "Coda — Create Row", "table", "bearer", "token", "API token", "https://coda.io", "POST", "/apis/v1/docs/{{docId}}/tables/{{tableId}}/rows", { rows: [{ cells: "{{cells}}" }] }, "Insert a row into a Coda table."],
  ["smartsheetAddRow", "Smartsheet — Add Row", "table", "bearer", "token", "Access token", "https://api.smartsheet.com", "POST", "/2.0/sheets/{{sheetId}}/rows", { cells: "{{cells}}" }, "Add a row to a Smartsheet sheet."],
  ["baserowCreateRow", "Baserow — Create Row", "table", "header:Authorization", "token", "Token (Token …)", "https://api.baserow.io", "POST", "/api/database/rows/table/{{tableId}}/", { field_1: "{{value}}" }, "Create a row in a Baserow table."],
  ["nocodbCreateRow", "NocoDB — Create Row", "table", "header:xc-token", "token", "API token", "https://app.nocodb.com", "POST", "/api/v2/tables/{{tableId}}/records", { fields: "{{fields}}" }, "Create a record in a NocoDB table."],
  ["teamworkCreateTask", "Teamwork — Create Task", "checkSquare", "basic", "basicAuth", "API key : password", "https://{{site}}.teamwork.com", "POST", "/projects/api/v3/tasks.json", { task: { name: "{{title}}", description: "{{description}}" } }, "Create a Teamwork task."],
  ["wrikeCreateTask", "Wrike — Create Task", "checkSquare", "bearer", "token", "Permanent access token", "https://www.wrike.com", "POST", "/api/v4/folders/{{folderId}}/tasks", { title: "{{title}}", description: "{{description}}" }, "Create a Wrike task."],
  ["confluenceCreatePage", "Confluence — Create Page", "file", "basic", "basicAuth", "Email : API token", "https://{{site}}.atlassian.net", "POST", "/wiki/rest/api/content", { type: "page", title: "{{title}}", space: { key: "{{spaceKey}}" }, body: { storage: { value: "{{body}}", representation: "storage" } } }, "Create a Confluence page."],
  ["evernoteCreateNote", "Evernote — Create Note", "file", "bearer", "token", "Developer / access token", "https://www.evernote.com", "POST", "/shard/{{shard}}/notestore", { title: "{{title}}", content: "{{body}}" }, "Create an Evernote note."],
  ["calendlyEvent", "Calendly — Create Scheduling Link", "calendar", "bearer", "token", "Personal access token", "https://api.calendly.com", "POST", "/scheduling_links", { max_event_count: 1, owner: "{{eventTypeUri}}", owner_type: "EventType" }, "Create a Calendly scheduling link."],
  ["calcomBooking", "Cal.com — Create Booking", "calendar", "bearer", "token", "API key", "https://api.cal.com", "POST", "/v2/bookings", { eventTypeId: "{{eventTypeId}}", start: "{{start}}", attendee: { name: "{{name}}", email: "{{email}}", timeZone: "UTC" } }, "Create a Cal.com booking."],
  ["acuityAppointment", "Acuity Scheduling — Create Appointment", "calendar", "basic", "basicAuth", "User ID : API key", "https://acuityscheduling.com", "POST", "/api/v1/appointments", { appointmentTypeID: "{{appointmentTypeId}}", firstName: "{{firstName}}", lastName: "{{lastName}}", email: "{{email}}", datetime: "{{datetime}}" }, "Book an Acuity Scheduling appointment."],
  ["typeformResponses", "Typeform — Get Responses", "list", "bearer", "token", "Personal access token", "https://api.typeform.com", "GET", "/forms/{{formId}}/responses", null, "Fetch responses from a Typeform form."],
  ["jotformSubmissions", "Jotform — Get Submissions", "list", "query:apiKey", "apiKey", "API key", "https://api.jotform.com", "GET", "/form/{{formId}}/submissions", null, "Fetch submissions from a Jotform form."],
  ["surveymonkeyResponses", "SurveyMonkey — Get Responses", "list", "bearer", "token", "Access token", "https://api.surveymonkey.com", "GET", "/v3/surveys/{{surveyId}}/responses/bulk", null, "Fetch responses from a SurveyMonkey survey."],

  // ---- CRM, sales & outreach -----------------------------------------------
  ["zohoCreateLead", "Zoho CRM — Create Lead", "briefcase", "header:Authorization", "token", "OAuth token (Zoho-oauthtoken …)", "https://www.zohoapis.com", "POST", "/crm/v3/Leads", { data: [{ Last_Name: "{{lastName}}", Email: "{{email}}" }] }, "Create a lead in Zoho CRM."],
  ["freshsalesContact", "Freshsales — Create Contact", "briefcase", "bearer", "token", "API key", "https://{{domain}}.freshsales.io", "POST", "/api/contacts", { contact: { last_name: "{{lastName}}", email: "{{email}}" } }, "Create a Freshsales contact."],
  ["copperPerson", "Copper — Create Person", "users", "header:X-Pw-AccessToken", "token", "API token", "https://api.copper.com", "POST", "/developer_api/v1/people", { name: "{{name}}", email: "{{email}}" }, "Create a person in Copper."],
  ["closeLead", "Close — Create Lead", "briefcase", "basic", "basicAuth", "API key : (blank)", "https://api.close.com", "POST", "/api/v1/lead/", { name: "{{name}}", contacts: [{ name: "{{name}}" }] }, "Create a lead in Close."],
  ["keapContact", "Keap — Create Contact", "users", "bearer", "token", "Access token", "https://api.infusionsoft.com", "POST", "/crm/v2/contacts", { given_name: "{{firstName}}", family_name: "{{lastName}}", email_addresses: [{ email: "{{email}}", field: "EMAIL1" }] }, "Create a Keap (Infusionsoft) contact."],
  ["activecampaignContact", "ActiveCampaign — Create Contact", "users", "header:Api-Token", "apiKey", "API token", "https://{{account}}.api-us1.com", "POST", "/api/3/contacts", { contact: { email: "{{email}}", firstName: "{{firstName}}" } }, "Create an ActiveCampaign contact."],
  ["apolloSearch", "Apollo.io — Search People", "search", "header:X-Api-Key", "apiKey", "API key", "https://api.apollo.io", "POST", "/v1/mixed_people/search", { q_organization_domains: "{{domain}}" }, "Search Apollo.io for people."],
  ["clearbitEnrich", "Clearbit — Enrich Person", "search", "bearer", "token", "Secret key", "https://person.clearbit.com", "GET", "/v2/people/find?email={{email}}", null, "Look up a person with Clearbit."],
  ["hunterVerify", "Hunter — Verify Email", "search", "query:api_key", "apiKey", "API key", "https://api.hunter.io", "GET", "/v2/email-verifier?email={{email}}", null, "Verify an email address with Hunter."],
  ["lemlistAddLead", "Lemlist — Add Lead", "users", "bearer", "token", "API key", "https://api.lemlist.com", "POST", "/api/campaigns/{{campaignId}}/leads/", { email: "{{email}}", firstName: "{{firstName}}" }, "Add a lead to a Lemlist campaign."],
  ["woodpeckerCampaign", "Woodpecker — Add Prospect", "users", "header:X-API-Key", "apiKey", "API key", "https://api.woodpecker.co", "POST", "/rest/v1/campaigns/{{campaignId}}/prospects", { prospects: [{ email: "{{email}}" }] }, "Add a prospect to a Woodpecker campaign."],
  ["linkedinPost", "LinkedIn — Create Post", "globe", "bearer", "token", "OAuth access token", "https://api.linkedin.com", "POST", "/v2/ugcPosts", { author: "{{author}}", lifecycleState: "PUBLISHED", specificContent: { "com.linkedin.ugc.ShareContent": { shareCommentary: { text: "{{text}}" }, shareMediaCategory: "NONE" } }, visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" } }, "Publish a LinkedIn post."],
  ["phantombusterLaunch", "PhantomBuster — Launch Agent", "rocket", "header:X-Phantombuster-Key", "apiKey", "API key", "https://api.phantombuster.com", "POST", "/api/v2/agents/{{agentId}}/launch", { argument: "{{argument}}" }, "Launch a PhantomBuster agent."],
  ["lushaEnrich", "Lusha — Enrich Contact", "search", "header:api_key", "apiKey", "API key", "https://api.lusha.com", "POST", "/v2/person", { email: "{{email}}" }, "Enrich a contact with Lusha."],
  ["intercomMessage", "Intercom — Send Message", "messageSquare", "bearer", "token", "Access token", "https://api.intercom.io", "POST", "/messages", { message_type: "inapp", body: "{{text}}", from: { type: "admin", id: "{{adminId}}" }, to: { type: "user", id: "{{userId}}" } }, "Send an Intercom message."],
  ["driftMessage", "Drift — Create Contact", "messageCircle", "bearer", "token", "OAuth access token", "https://driftapi.com", "POST", "/contacts", { email: "{{email}}" }, "Create a Drift contact."],
  ["gongCalls", "Gong — List Calls", "headset", "bearer", "token", "Access key : secret", "https://api.gong.io", "POST", "/v2/calls/extensive", { filter: { fromDateTime: "{{fromDateTime}}" } }, "List Gong calls."],
  ["capsuleContact", "Capsule CRM — Create Contact", "users", "bearer", "token", "Personal access token", "https://api.capsulecrm.com", "POST", "/api/v2/parties", { party: { type: "person", name: "{{name}}", emailAddresses: [{ type: "Home", address: "{{email}}" }] } }, "Create a Capsule CRM contact."],
  ["insightlyContact", "Insightly — Create Contact", "users", "bearer", "token", "API key", "https://api.na1.insightly.com", "POST", "/v3.1/Contacts", { FIRST_NAME: "{{firstName}}", LAST_NAME: "{{lastName}}", EMAIL_ADDRESS: "{{email}}" }, "Create an Insightly contact."],
  ["gohighlevelContact", "GoHighLevel — Create Contact", "users", "bearer", "token", "API key", "https://rest.gohighlevel.com", "POST", "/v1/contacts/", { firstName: "{{firstName}}", lastName: "{{lastName}}", email: "{{email}}" }, "Create a GoHighLevel contact."],
  ["dropcontactEnrich", "Dropcontact — Enrich Contact", "search", "header:X-Access-Token", "apiKey", "Access token", "https://api.dropcontact.io", "POST", "/batch", { data: [{ email: "{{email}}" }] }, "Enrich contacts with Dropcontact."],

  // ---- Support & incident management ---------------------------------------
  ["freshdeskTicket", "Freshdesk — Create Ticket", "ticket", "basic", "basicAuth", "API key : X", "https://{{domain}}.freshdesk.com", "POST", "/api/v2/tickets", { subject: "{{subject}}", description: "{{description}}", email: "{{email}}", priority: 1, status: 2 }, "Create a Freshdesk ticket."],
  ["helpscoutConversation", "Help Scout — Create Conversation", "ticket", "bearer", "token", "OAuth access token", "https://api.helpscout.net", "POST", "/v2/conversations", { subject: "{{subject}}", type: "email", mailboxId: "{{mailboxId}}", customer: { email: "{{email}}" }, threads: [{ type: "customer", text: "{{description}}" }] }, "Create a Help Scout conversation."],
  ["servicenowIncident", "ServiceNow — Create Incident", "ticket", "basic", "basicAuth", "User : Password", "https://{{instance}}.service-now.com", "POST", "/api/now/table/incident", { short_description: "{{subject}}", description: "{{description}}" }, "Create a ServiceNow incident."],
  ["frontMessage", "Front — Send Message", "messageSquare", "bearer", "token", "API token", "https://api2.frontapp.com", "POST", "/channels/{{channelId}}/messages", { body: "{{text}}", to: ["{{to}}"], text: "{{text}}" }, "Send a Front message."],
  ["gorgiasTicket", "Gorgias — Create Ticket", "ticket", "basic", "basicAuth", "Email : API key", "https://{{domain}}.gorgias.com", "POST", "/api/tickets", { customer: { email: "{{email}}" }, subject: "{{subject}}", messages: [{ body_text: "{{description}}" }] }, "Create a Gorgias ticket."],
  ["crispMessage", "Crisp — Send Message", "messageCircle", "basic", "basicAuth", "Identifier : Key", "https://api.crisp.chat", "POST", "/v1/website/{{websiteId}}/conversation/{{sessionId}}/message", { type: "text", from: "operator", origin: "chat", content: "{{text}}" }, "Send a Crisp website chat message."],
  ["freshserviceTicket", "Freshservice — Create Ticket", "ticket", "basic", "basicAuth", "API key : X", "https://{{domain}}.freshservice.com", "POST", "/api/v2/tickets", { subject: "{{subject}}", description: "{{description}}", email: "{{email}}", priority: 1, status: 2 }, "Create a Freshservice ticket."],
  ["sentryIssue", "Sentry — Create Issue", "siren", "bearer", "token", "Auth token", "https://sentry.io", "POST", "/api/0/projects/{{org}}/{{project}}/issues/", { title: "{{title}}", message: "{{message}}" }, "Create a Sentry issue."],
  ["statuspageIncident", "Statuspage — Create Incident", "siren", "bearer", "token", "API key", "https://api.statuspage.io", "POST", "/v1/pages/{{pageId}}/incidents", { incident: { name: "{{name}}", status: "investigating", body: "{{body}}" } }, "Create a Statuspage incident."],

  // ---- Databases & queues --------------------------------------------------
  ["snowflakeQuery", "Snowflake — Query", "database", "bearer", "token", "OAuth access token", "https://{{account}}.snowflakecomputing.com", "POST", "/api/v2/statements", { statement: "{{query}}", timeout: 60 }, "Run SQL through the Snowflake SQL API."],
  ["elasticsearchQuery", "Elasticsearch — Search", "database", "basic", "basicAuth", "User : Password", "http://localhost:9200", "POST", "/{{index}}/_search", { query: { match_all: {} } }, "Run an Elasticsearch search."],
  ["firebaseRtdbSet", "Firebase Realtime Database — Set", "database", "query:auth", "databaseSecret", "Database secret", "https://{{project}}.firebaseio.com", "PUT", "/{{path}}.json", { value: "{{value}}" }, "Write a value to the Firebase Realtime Database."],
  ["dynamodbPut", "DynamoDB — Put Item", "database", "aws", "", "", "https://dynamodb.us-east-1.amazonaws.com", "POST", "/", { TableName: "{{table}}", Item: "{{item}}" }, "Put an item into a DynamoDB table (SigV4-signed)."],
  ["rabbitmqPublish", "RabbitMQ — Publish Message", "send", "basic", "basicAuth", "User : Password", "http://localhost:15672", "POST", "/api/exchanges/{{vhost}}/{{exchange}}/publish", { properties: {}, routing_key: "{{routingKey}}", payload: "{{message}}", payload_encoding: "string" }, "Publish a message through the RabbitMQ management API."],
  ["sqsSend", "Amazon SQS — Send Message", "send", "aws", "", "", "https://sqs.us-east-1.amazonaws.com", "POST", "/{{accountId}}/{{queueName}}", null, "Send an Amazon SQS message (SigV4-signed)."],
  ["pineconeUpsert", "Pinecone — Upsert Vector", "database", "header:Api-Key", "apiKey", "API key", "https://{{index}}-{{project}}.svc.environment.pinecone.io", "POST", "/vectors/upsert", { vectors: [{ id: "{{id}}", values: "{{values}}" }] }, "Upsert a vector into Pinecone."],

  // ---- Developer, DevOps & CMS ---------------------------------------------
  ["bitbucketIssue", "Bitbucket — Create Issue", "gitlab", "basic", "basicAuth", "User : App password", "https://api.bitbucket.org", "POST", "/2.0/repositories/{{workspace}}/{{repo}}/issues", { title: "{{title}}", content: { raw: "{{description}}" } }, "Create a Bitbucket issue."],
  ["jenkinsBuild", "Jenkins — Trigger Build", "rocket", "basic", "basicAuth", "User : API token", "https://{{host}}", "POST", "/job/{{job}}/build", null, "Trigger a Jenkins job build."],
  ["circleciTrigger", "CircleCI — Trigger Pipeline", "rocket", "header:Circle-Token", "token", "API token", "https://circleci.com", "POST", "/api/v2/project/{{slug}}/pipeline", { branch: "{{branch}}" }, "Trigger a CircleCI pipeline."],
  ["travisBuild", "Travis CI — Trigger Build", "rocket", "header:Authorization", "token", "API token (token …)", "https://api.travis-ci.com", "POST", "/repo/{{slug}}/requests", { request: { branch: "{{branch}}" } }, "Trigger a Travis CI build."],
  ["portainerContainer", "Portainer — Container Action", "terminal", "header:X-API-Key", "apiKey", "API key", "https://{{host}}", "POST", "/api/endpoints/{{endpointId}}/docker/containers/{{containerId}}/start", null, "Start / stop a container managed by Portainer."],
  ["netlifyDeploy", "Netlify — Create Deploy", "rocket", "bearer", "token", "Personal access token", "https://api.netlify.com", "POST", "/api/v1/sites/{{siteId}}/deploys", { clear_cache: true }, "Trigger a Netlify deploy."],
  ["herokuRelease", "Heroku — Create Release", "rocket", "bearer", "token", "API key", "https://api.heroku.com", "POST", "/apps/{{app}}/releases", { description: "{{description}}" }, "Create a Heroku release."],
  ["datadogEvent", "Datadog — Send Event", "siren", "header:DD-API-KEY", "apiKey", "API key", "https://api.datadoghq.com", "POST", "/api/v1/events", { title: "{{title}}", text: "{{text}}", alert_type: "info" }, "Send a Datadog event."],
  ["grafanaAnnotation", "Grafana — Create Annotation", "list", "bearer", "token", "API key", "https://{{host}}", "POST", "/api/annotations", { text: "{{text}}", tags: ["wflow"] }, "Create a Grafana annotation."],
  ["prometheusQuery", "Prometheus — Query", "list", "header:Authorization", "token", "Bearer token (optional)", "http://localhost:9090", "GET", "/api/v1/query?query={{query}}", null, "Run a PromQL query against Prometheus."],
  ["bubbleData", "Bubble — Create Thing", "globe", "bearer", "token", "API token", "https://{{app}}.bubbleapps.io", "POST", "/api/1.1/obj/{{type}}", { name: "{{name}}" }, "Create a Bubble data thing."],
  ["webflowItem", "Webflow — Create Item", "globe", "bearer", "token", "API token", "https://api.webflow.com", "POST", "/v2/collections/{{collectionId}}/items", { fieldData: { name: "{{name}}" } }, "Create a Webflow CMS item."],
  ["ghostPost", "Ghost — Create Post", "newspaper", "header:Authorization", "token", "Admin API key (Ghost …)", "https://{{host}}", "POST", "/ghost/api/admin/posts/?source=html", { posts: [{ title: "{{title}}", html: "{{html}}", status: "published" }] }, "Publish a post to Ghost."],
  ["strapiEntry", "Strapi — Create Entry", "database", "bearer", "token", "API token", "https://{{host}}", "POST", "/api/{{contentType}}", { data: "{{data}}" }, "Create a Strapi content entry."],
  ["contentfulEntry", "Contentful — Create Entry", "database", "bearer", "token", "Content management token", "https://api.contentful.com", "POST", "/spaces/{{spaceId}}/environments/{{environment}}/entries", { fields: "{{fields}}" }, "Create a Contentful entry."],
  ["sanityDocument", "Sanity — Create Document", "database", "bearer", "token", "API token", "https://{{projectId}}.api.sanity.io", "POST", "/v2021-06-07/data/mutate/{{dataset}}", { mutations: [{ create: "{{document}}" }] }, "Create a Sanity document."],
  ["directusItem", "Directus — Create Item", "database", "bearer", "token", "Static token", "https://{{host}}", "POST", "/items/{{collection}}", { name: "{{name}}" }, "Create a Directus item."],
  ["storyblokStory", "Storyblok — Create Story", "file", "header:Authorization", "token", "Management token", "https://api.storyblok.com", "POST", "/v1/spaces/{{spaceId}}/stories", { story: { name: "{{name}}", slug: "{{slug}}", content: "{{content}}" } }, "Create a Storyblok story."],
  ["vercelDeploy", "Vercel — Create Deployment", "rocket", "bearer", "token", "Access token", "https://api.vercel.com", "POST", "/v13/deployments", { name: "{{name}}" }, "Create a Vercel deployment."],

  // ---- Cloud & file storage ------------------------------------------------
  ["lambdaInvoke", "AWS Lambda — Invoke Function", "rocket", "aws", "", "", "https://lambda.us-east-1.amazonaws.com", "POST", "/2015-03-31/functions/{{functionName}}/invocations", { payload: "{{payload}}" }, "Invoke an AWS Lambda function (SigV4-signed)."],
  ["textractAnalyze", "AWS Textract — Analyze Document", "fileSearch", "aws", "", "", "https://textract.us-east-1.amazonaws.com", "POST", "/", { Document: { S3Object: { Bucket: "{{bucket}}", Name: "{{key}}" } } }, "Analyze a document with AWS Textract (SigV4-signed)."],
  ["rekognitionDetect", "AWS Rekognition — Detect Labels", "image", "aws", "", "", "https://rekognition.us-east-1.amazonaws.com", "POST", "/", { Image: { S3Object: { Bucket: "{{bucket}}", Name: "{{key}}" } } }, "Detect labels in an image with AWS Rekognition (SigV4-signed)."],
  ["comprehendAnalyze", "AWS Comprehend — Detect Sentiment", "search", "aws", "", "", "https://comprehend.us-east-1.amazonaws.com", "POST", "/", { Text: "{{text}}", LanguageCode: "en" }, "Analyze sentiment with AWS Comprehend (SigV4-signed)."],
  ["transcribeJob", "AWS Transcribe — Start Job", "fileSearch", "aws", "", "", "https://transcribe.us-east-1.amazonaws.com", "POST", "/", { TranscriptionJobName: "{{jobName}}", Media: { MediaFileUri: "{{mediaUri}}" }, LanguageCode: "en-US" }, "Start an AWS Transcribe job (SigV4-signed)."],
  ["boxUpload", "Box — Upload File", "cloudUpload", "bearer", "token", "Access token", "https://upload.box.com", "POST", "/api/2.0/files/content", null, "Upload a file to Box (send a multipart body)."],
  ["nextcloudUpload", "Nextcloud — Upload File", "cloudUpload", "basic", "basicAuth", "User : Password", "https://{{host}}", "PUT", "/remote.php/dav/files/{{user}}/{{path}}", null, "Upload a file to Nextcloud over WebDAV."],
  ["cloudinaryUpload", "Cloudinary — Upload", "image", "basic", "basicAuth", "API key : API secret", "https://api.cloudinary.com", "POST", "/v1_1/{{cloudName}}/image/upload", { file: "{{file}}", folder: "{{folder}}" }, "Upload an image to Cloudinary."],
  ["owncloudUpload", "ownCloud — Upload File", "cloudUpload", "basic", "basicAuth", "User : Password", "https://{{host}}", "PUT", "/remote.php/dav/files/{{user}}/{{path}}", null, "Upload a file to ownCloud over WebDAV."],
  ["minioUpload", "MinIO — Upload Object", "cloudUpload", "aws", "", "", "https://{{host}}", "PUT", "/{{bucket}}/{{object}}", null, "Upload an object to MinIO (SigV4-signed, S3-compatible)."],
  ["cloudflarePurge", "Cloudflare — Purge Cache", "globe", "bearer", "token", "API token", "https://api.cloudflare.com", "POST", "/client/v4/zones/{{zoneId}}/purge_cache", { files: ["{{url}}"] }, "Purge a URL from the Cloudflare cache."],
  ["awsIamList", "AWS IAM — List Users", "key", "aws", "", "", "https://iam.amazonaws.com", "POST", "/", null, "List AWS IAM users (SigV4-signed)."],

  // ---- E-commerce & payments -----------------------------------------------
  ["woocommerceProduct", "WooCommerce — Create Product", "shoppingBag", "basic", "basicAuth", "Consumer key : secret", "https://{{store}}", "POST", "/wp-json/wc/v3/products", { name: "{{name}}", regular_price: "{{price}}", description: "{{description}}" }, "Create a WooCommerce product."],
  ["paypalOrder", "PayPal — Create Order", "creditCard", "bearer", "token", "Access token", "https://api-m.paypal.com", "POST", "/v2/checkout/orders", { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "{{amount}}" } }] }, "Create a PayPal order."],
  ["magentoProduct", "Magento — Create Product", "shoppingBag", "bearer", "token", "Access token", "https://{{store}}", "POST", "/rest/V1/products", { product: { sku: "{{sku}}", name: "{{name}}", price: "{{price}}", attribute_set_id: 4, type_id: "simple" } }, "Create a Magento product."],
  ["bigcommerceProduct", "BigCommerce — Create Product", "shoppingBag", "header:X-Auth-Token", "token", "API token", "https://api.bigcommerce.com", "POST", "/stores/{{storeHash}}/v3/catalog/products", { name: "{{name}}", price: "{{price}}" }, "Create a BigCommerce product."],
  ["squarePayment", "Square — Create Payment", "creditCard", "bearer", "token", "Access token", "https://connect.squareup.com", "POST", "/v2/payments", { source_id: "{{sourceId}}", amount_money: { amount: "{{amount}}", currency: "USD" }, idempotency_key: "{{idempotencyKey}}" }, "Create a Square payment."],
  ["paddleTransaction", "Paddle — List Transactions", "creditCard", "bearer", "token", "API key", "https://api.paddle.com", "GET", "/transactions", null, "List Paddle transactions."],
  ["gumroadProduct", "Gumroad — Create Product", "shoppingBag", "query:access_token", "token", "Access token", "https://api.gumroad.com", "POST", "/v2/products", { name: "{{name}}", price: "{{price}}" }, "Create a Gumroad product."],
  ["lemonsqueezyCheckout", "Lemon Squeezy — Create Checkout", "creditCard", "bearer", "token", "API key", "https://api.lemonsqueezy.com", "POST", "/v1/checkouts", { data: { type: "checkouts", attributes: { checkout_data: { email: "{{email}}" } }, relationships: { store: { data: { type: "stores", id: "{{storeId}}" } }, variant: { data: { type: "variants", id: "{{variantId}}" } } } } }, "Create a Lemon Squeezy checkout."],
  ["chargebeeSubscription", "Chargebee — Create Subscription", "creditCard", "basic", "basicAuth", "API key : (blank)", "https://{{site}}.chargebee.com", "POST", "/api/v2/subscriptions", { plan_id: "{{planId}}", customer: { email: "{{email}}" } }, "Create a Chargebee subscription."],
  ["recurlyAccount", "Recurly — Create Account", "creditCard", "bearer", "token", "API key", "https://v3.recurly.com", "POST", "/accounts", { code: "{{code}}", email: "{{email}}" }, "Create a Recurly account."],
  ["molliePayment", "Mollie — Create Payment", "creditCard", "bearer", "token", "API key", "https://api.mollie.com", "POST", "/v2/payments", { amount: { currency: "EUR", value: "{{amount}}" }, description: "{{description}}", redirectUrl: "{{redirectUrl}}" }, "Create a Mollie payment."],
  ["wiseTransfer", "Wise — Create Transfer", "creditCard", "bearer", "token", "API token", "https://api.transferwise.com", "POST", "/v1/transfers", { targetAccount: "{{targetAccount}}", quoteUuid: "{{quoteUuid}}", customerTransactionId: "{{reference}}" }, "Create a Wise transfer."],
  ["razorpayPayment", "Razorpay — Create Payment", "creditCard", "basic", "basicAuth", "Key id : key secret", "https://api.razorpay.com", "POST", "/v1/payments", { amount: "{{amount}}", currency: "INR", receipt: "{{receipt}}" }, "Create a Razorpay payment."],
  ["shippoShipment", "Shippo — Create Shipment", "send", "header:Authorization", "token", "API token (ShippoToken …)", "https://api.goshippo.com", "POST", "/shipments/", { address_from: "{{addressFrom}}", address_to: "{{addressTo}}", parcels: ["{{parcel}}"] }, "Create a Shippo shipment."],
  ["shipstationOrder", "ShipStation — Create Order", "send", "basic", "basicAuth", "API key : secret", "https://ssapi.shipstation.com", "POST", "/orders/createorder", { orderNumber: "{{orderNumber}}", orderDate: "{{orderDate}}", orderStatus: "awaiting_shipment" }, "Create a ShipStation order."],
  ["easypostShipment", "EasyPost — Create Shipment", "send", "bearer", "token", "API key", "https://api.easypost.com", "POST", "/v2/shipments", { shipment: { to_address: "{{toAddress}}", from_address: "{{fromAddress}}", parcel: "{{parcel}}" } }, "Create an EasyPost shipment."],
  ["etsyListing", "Etsy — Create Listing", "shoppingBag", "bearer", "token", "OAuth access token", "https://openapi.etsy.com", "POST", "/v3/application/shops/{{shopId}}/listings", { quantity: 1, title: "{{title}}", price: "{{price}}", who_made: "i_did", when_made: "2020_2026", taxonomy_id: "{{taxonomyId}}" }, "Create an Etsy listing."],
  ["ebayListing", "eBay — Create Inventory Item", "shoppingBag", "bearer", "token", "OAuth access token", "https://api.ebay.com", "PUT", "/sell/inventory/v1/inventory_item/{{sku}}", { product: { title: "{{title}}" }, condition: "NEW", availability: { shipToLocationAvailability: { quantity: 1 } } }, "Create an eBay inventory item."],
  ["printfulOrder", "Printful — Create Order", "shoppingBag", "bearer", "token", "API token", "https://api.printful.com", "POST", "/orders", { recipient: "{{recipient}}", items: ["{{items}}"] }, "Create a Printful order."],
  ["klaviyoEvent", "Klaviyo — Track Event", "send", "header:Authorization", "token", "Private API key (Klaviyo-API-Key …)", "https://a.klaviyo.com", "POST", "/api/events", { data: { type: "event", attributes: { metric: { data: { type: "metric", attributes: { name: "{{event}}" } } }, profile: { data: { type: "profile", attributes: { email: "{{email}}" } } } } } }, "Track a Klaviyo event."],
  ["lightspeedProduct", "Lightspeed — Create Item", "shoppingBag", "bearer", "token", "Access token", "https://api.lightspeedapp.com", "POST", "/API/V3/Account/{{accountId}}/Item.json", { Item: { description: "{{name}}", price: "{{price}}" } }, "Create a Lightspeed Retail item."],
  ["prestashopProduct", "PrestaShop — Create Product", "shoppingBag", "query:ws_key", "apiKey", "Webservice key", "https://{{store}}", "POST", "/api/products", { product: { name: "{{name}}", price: "{{price}}" } }, "Create a PrestaShop product."],

  // ---- Finance & time tracking ---------------------------------------------
  ["quickbooksInvoice", "QuickBooks — Create Invoice", "coins", "bearer", "token", "OAuth access token", "https://quickbooks.api.intuit.com", "POST", "/v3/company/{{realmId}}/invoice", { Line: [{ Amount: "{{amount}}", DetailType: "SalesItemLineDetail", SalesItemLineDetail: { ItemRef: { value: "{{itemId}}" } } }], CustomerRef: { value: "{{customerId}}" } }, "Create a QuickBooks invoice."],
  ["xeroInvoice", "Xero — Create Invoice", "coins", "bearer", "token", "OAuth access token", "https://api.xero.com", "POST", "/api.xro/2.0/Invoices", { Type: "ACCREC", Contact: { ContactID: "{{contactId}}" }, LineItems: [{ Description: "{{description}}", Quantity: 1, UnitAmount: "{{amount}}" }] }, "Create a Xero invoice."],
  ["freshbooksInvoice", "FreshBooks — Create Invoice", "coins", "bearer", "token", "OAuth access token", "https://api.freshbooks.com", "POST", "/accounting/account/{{accountId}}/invoices/invoices", { invoice: { customerid: "{{customerId}}", lines: [{ name: "{{description}}", amount: "{{amount}}" }] } }, "Create a FreshBooks invoice."],
  ["zohoBooksInvoice", "Zoho Books — Create Invoice", "coins", "header:Authorization", "token", "OAuth token (Zoho-oauthtoken …)", "https://www.zohoapis.com", "POST", "/books/v3/invoices", { customer_id: "{{customerId}}", line_items: [{ name: "{{description}}", rate: "{{amount}}", quantity: 1 }] }, "Create a Zoho Books invoice."],
  ["harvestTimeEntry", "Harvest — Create Time Entry", "clock", "bearer", "token", "Personal access token", "https://api.harvestapp.com", "POST", "/v2/time_entries", { project_id: "{{projectId}}", task_id: "{{taskId}}", spent_date: "{{date}}", hours: "{{hours}}" }, "Log a Harvest time entry."],
  ["togglTimeEntry", "Toggl — Create Time Entry", "clock", "basic", "basicAuth", "API token : api_token", "https://api.track.toggl.com", "POST", "/api/v9/workspaces/{{workspaceId}}/time_entries", { start: "{{start}}", duration: "{{duration}}", description: "{{description}}" }, "Create a Toggl time entry."],
  ["clockifyTimeEntry", "Clockify — Create Time Entry", "clock", "header:X-Api-Key", "apiKey", "API key", "https://api.clockify.me", "POST", "/api/v1/workspaces/{{workspaceId}}/time-entries", { start: "{{start}}", end: "{{end}}", description: "{{description}}" }, "Create a Clockify time entry."],
  ["invoiceNinjaInvoice", "Invoice Ninja — Create Invoice", "coins", "header:X-API-TOKEN", "token", "API token", "https://{{host}}", "POST", "/api/v1/invoices", { client_id: "{{clientId}}", line_items: [{ product_key: "{{description}}", cost: "{{amount}}", quantity: 1 }] }, "Create an Invoice Ninja invoice."],
  ["sageInvoice", "Sage — Create Invoice", "coins", "bearer", "token", "Access token", "https://api.accounting.sage.com", "POST", "/v3.1/invoices", { invoice: { contact_id: "{{contactId}}", date: "{{date}}" } }, "Create a Sage invoice."],
  ["plaidTransactions", "Plaid — Get Transactions", "coins", "none", "", "", "https://production.plaid.com", "POST", "/transactions/get", { client_id: "{{clientId}}", secret: "{{secret}}", access_token: "{{accessToken}}", start_date: "{{startDate}}", end_date: "{{endDate}}" }, "Fetch Plaid transactions (client id and secret go in the body)."],

  // ---- Marketing, social & analytics ---------------------------------------
  ["facebookPagePost", "Facebook Pages — Create Post", "globe", "query:access_token", "accessToken", "Page access token", "https://graph.facebook.com", "POST", "/v21.0/{{pageId}}/feed", { message: "{{text}}" }, "Publish a post on a Facebook page."],
  ["facebookLeadForm", "Facebook Lead Ads — Get Leads", "users", "query:access_token", "accessToken", "Page access token", "https://graph.facebook.com", "GET", "/v21.0/{{formId}}/leads", null, "Fetch leads from a Facebook lead form."],
  ["instagramPost", "Instagram — Create Media", "image", "query:access_token", "accessToken", "Access token", "https://graph.facebook.com", "POST", "/v21.0/{{igUserId}}/media", { image_url: "{{imageUrl}}", caption: "{{caption}}" }, "Create an Instagram media container."],
  ["pinterestPin", "Pinterest — Create Pin", "image", "bearer", "token", "Access token", "https://api.pinterest.com", "POST", "/v5/pins", { board_id: "{{boardId}}", media_source: { source_type: "image_url", url: "{{imageUrl}}" }, title: "{{title}}", description: "{{description}}" }, "Create a Pinterest pin."],
  ["tiktokUpload", "TikTok — Init Video Upload", "image", "bearer", "token", "Access token", "https://open.tiktokapis.com", "POST", "/v2/post/publish/video/init/", { post_info: { title: "{{title}}" }, source_info: { source: "FILE_UPLOAD", video_size: "{{videoSize}}" } }, "Initialise a TikTok video upload."],
  ["bufferPost", "Buffer — Create Update", "send", "bearer", "token", "Access token", "https://api.bufferapp.com", "POST", "/1/updates/create.json", { text: "{{text}}", profile_ids: ["{{profileId}}"] }, "Queue a Buffer update."],
  ["hootsuitePost", "Hootsuite — Schedule Message", "send", "bearer", "token", "Access token", "https://platform.hootsuite.com", "POST", "/v1/messages", { text: "{{text}}", socialProfileIds: ["{{profileId}}"] }, "Schedule a Hootsuite message."],
  ["bitlyShorten", "Bitly — Shorten URL", "link", "bearer", "token", "Access token", "https://api-ssl.bitly.com", "POST", "/v4/shorten", { long_url: "{{url}}" }, "Shorten a URL with Bitly."],
  ["mediumPost", "Medium — Create Post", "newspaper", "bearer", "token", "Integration token", "https://api.medium.com", "POST", "/v1/users/{{authorId}}/posts", { title: "{{title}}", contentFormat: "markdown", content: "{{content}}", publishStatus: "public" }, "Publish a Medium post."],
  ["mauticContact", "Mautic — Create Contact", "users", "basic", "basicAuth", "User : Password", "https://{{host}}", "POST", "/api/contacts/new", { email: "{{email}}", firstname: "{{firstName}}" }, "Create a Mautic contact."],
  ["convertkitSubscriber", "ConvertKit — Add Subscriber", "mail", "query:api_key", "apiKey", "API key", "https://api.convertkit.com", "POST", "/v3/tags/{{tagId}}/subscribe", { email: "{{email}}" }, "Add a ConvertKit subscriber to a tag."],
  ["dripSubscriber", "Drip — Create Subscriber", "mail", "bearer", "token", "API token", "https://api.getdrip.com", "POST", "/v2/{{accountId}}/subscribers", { subscribers: [{ email: "{{email}}" }] }, "Create a Drip subscriber."],
  ["customerioEvent", "Customer.io — Track Event", "send", "bearer", "token", "App API key", "https://track.customer.io", "POST", "/api/v1/customers/{{id}}/events", { name: "{{event}}", data: "{{data}}" }, "Track a Customer.io event."],
  ["segmentTrack", "Segment — Track Event", "send", "basic", "basicAuth", "Write key : (blank)", "https://api.segment.io", "POST", "/v1/track", { userId: "{{userId}}", event: "{{event}}", properties: "{{properties}}" }, "Send a Segment track event."],
  ["mixpanelEvent", "Mixpanel — Track Event", "send", "none", "", "", "https://api.mixpanel.com", "POST", "/import?strict=1", { event: "{{event}}", properties: { token: "{{token}}", distinct_id: "{{userId}}" } }, "Send a Mixpanel event (project token goes in the body)."],
  ["posthogCapture", "PostHog — Capture Event", "send", "none", "", "", "https://app.posthog.com", "POST", "/capture/", { api_key: "{{apiKey}}", event: "{{event}}", distinct_id: "{{userId}}" }, "Capture a PostHog event."],
  ["amplitudeEvent", "Amplitude — Track Event", "send", "none", "", "", "https://api2.amplitude.com", "POST", "/2/httpapi", { api_key: "{{apiKey}}", events: [{ user_id: "{{userId}}", event_type: "{{event}}" }] }, "Send an Amplitude event."],
  ["facebookAdsInsights", "Facebook Ads — Get Insights", "users", "query:access_token", "accessToken", "Access token", "https://graph.facebook.com", "GET", "/v21.0/act_{{accountId}}/insights", null, "Fetch Facebook Ads insights."],

  // ---- AI providers & services ---------------------------------------------
  ["huggingfaceInference", "Hugging Face — Inference", "sparkles", "bearer", "token", "Access token", "https://api-inference.huggingface.co", "POST", "/models/{{model}}", { inputs: "{{text}}" }, "Run a Hugging Face inference endpoint."],
  ["cohereChat", "Cohere — Chat", "sparkles", "bearer", "token", "API key", "https://api.cohere.com", "POST", "/v2/chat", { model: "{{model}}", messages: [{ role: "user", content: "{{prompt}}" }] }, "Chat with a Cohere model."],
  ["perplexityChat", "Perplexity — Chat", "sparkles", "bearer", "token", "API key", "https://api.perplexity.ai", "POST", "/chat/completions", { model: "{{model}}", messages: [{ role: "user", content: "{{prompt}}" }] }, "Chat with a Perplexity model."],
  ["elevenlabsTts", "ElevenLabs — Text to Speech", "sparkles", "header:xi-api-key", "apiKey", "API key", "https://api.elevenlabs.io", "POST", "/v1/text-to-speech/{{voiceId}}", { text: "{{text}}", model_id: "eleven_multilingual_v2" }, "Generate speech with ElevenLabs."],
  ["stabilityImage", "Stability AI — Generate Image", "image", "bearer", "token", "API key", "https://api.stability.ai", "POST", "/v2beta/stable-image/generate/core", { prompt: "{{prompt}}", output_format: "png" }, "Generate an image with Stability AI."],
  ["assemblyaiTranscribe", "AssemblyAI — Transcribe", "fileSearch", "header:authorization", "apiKey", "API key", "https://api.assemblyai.com", "POST", "/v2/transcript", { audio_url: "{{audioUrl}}" }, "Submit an audio file to AssemblyAI for transcription."],

  // ---- Documents, utilities & HR -------------------------------------------
  ["pdfcoProcess", "PDF.co — Process PDF", "file", "header:x-api-key", "apiKey", "API key", "https://api.pdf.co", "POST", "/v1/pdf/convert/from/url", { url: "{{url}}" }, "Process a PDF with PDF.co."],
  ["docusignEnvelope", "DocuSign — Create Envelope", "file", "bearer", "token", "OAuth access token", "https://{{base}}.docusign.net", "POST", "/restapi/v2.1/accounts/{{accountId}}/envelopes", { emailSubject: "{{subject}}", status: "sent", documents: ["{{document}}"], recipients: { signers: [{ email: "{{email}}", name: "{{name}}", recipientId: "1" }] } }, "Create a DocuSign envelope."],
  ["pandadocDocument", "PandaDoc — Create Document", "file", "bearer", "token", "API key", "https://api.pandadoc.com", "POST", "/public/v1/documents", { name: "{{name}}", template_uuid: "{{templateId}}", recipients: [{ email: "{{email}}", role: "Client" }] }, "Create a PandaDoc document from a template."],
  ["bannerbearImage", "Bannerbear — Generate Image", "image", "bearer", "token", "API key", "https://api.bannerbear.com", "POST", "/v2/images", { template: "{{templateId}}", modifications: "{{modifications}}" }, "Generate an image with Bannerbear."],
  ["googleMapsGeocode", "Google Maps — Geocode", "mapPin", "query:key", "apiKey", "API key", "https://maps.googleapis.com", "GET", "/maps/api/geocode/json?address={{address}}", null, "Geocode an address with Google Maps."],
  ["bamboohrEmployee", "BambooHR — Add Employee", "users", "basic", "basicAuth", "API key : X", "https://api.bamboohr.com", "POST", "/api/gateway.php/{{companyDomain}}/v1/employees/", { firstName: "{{firstName}}", lastName: "{{lastName}}" }, "Add a BambooHR employee."],
  ["greenhouseCandidate", "Greenhouse — Create Candidate", "users", "basic", "basicAuth", "API key : (blank)", "https://harvest.greenhouse.io", "POST", "/v1/candidates", { first_name: "{{firstName}}", last_name: "{{lastName}}", emails: [{ value: "{{email}}", type: "personal" }] }, "Create a Greenhouse candidate."],

  // ---- GitHub actions ------------------------------------------------------
  // The catalog ships a GitHub trigger and create-issue / PR / release nodes;
  // these round out the day-to-day repository work (comment, review, list).
  ["githubCommentIssue", "GitHub — Comment on Issue", "github", "bearer", "token", "Personal access token", "https://api.github.com", "POST", "/repos/{{owner}}/{{repo}}/issues/{{number}}/comments", { body: "{{body}}" }, "Post a comment on a GitHub issue or pull request."],
  ["githubListIssues", "GitHub — List Issues", "github", "bearer", "token", "Personal access token", "https://api.github.com", "GET", "/repos/{{owner}}/{{repo}}/issues?state=open", null, "List issues in a GitHub repository."],
  ["githubGetRepository", "GitHub — Get Repository", "github", "bearer", "token", "Personal access token", "https://api.github.com", "GET", "/repos/{{owner}}/{{repo}}", null, "Read a GitHub repository's metadata."],
  ["githubListCommits", "GitHub — List Commits", "github", "bearer", "token", "Personal access token", "https://api.github.com", "GET", "/repos/{{owner}}/{{repo}}/commits", null, "List the commits on a GitHub repository branch."],
  ["githubCreateBranch", "GitHub — Create Branch", "branch", "bearer", "token", "Personal access token", "https://api.github.com", "POST", "/repos/{{owner}}/{{repo}}/git/refs", { ref: "refs/heads/{{branch}}", sha: "{{sha}}" }, "Create a branch pointing at a commit SHA."],
  ["githubMergePullRequest", "GitHub — Merge Pull Request", "merge", "bearer", "token", "Personal access token", "https://api.github.com", "PUT", "/repos/{{owner}}/{{repo}}/pulls/{{number}}/merge", { merge_method: "merge" }, "Merge a GitHub pull request."],
  ["githubTriggerWorkflow", "GitHub — Trigger Workflow", "github", "bearer", "token", "Personal access token", "https://api.github.com", "POST", "/repos/{{owner}}/{{repo}}/actions/workflows/{{workflowId}}/dispatches", { ref: "{{ref}}" }, "Dispatch a GitHub Actions workflow on a branch."],

  // ---- Gmail actions -------------------------------------------------------
  // The Gmail trigger only receives; these send and read mail. Like the other
  // Google nodes they sign in through a connected Google account
  // (shared/oauth.js); Send / Draft get plain message fields further down.
  ["gmailSend", "Gmail — Send Email", "mailSend", "bearer", "token", "OAuth access token", "https://gmail.googleapis.com", "POST", "/gmail/v1/users/me/messages/send", { raw: "{{raw}}" }, "Send an email through Gmail (base64url-encoded RFC 2822 message in `raw`)."],
  ["gmailCreateDraft", "Gmail — Create Draft", "mail", "bearer", "token", "OAuth access token", "https://gmail.googleapis.com", "POST", "/gmail/v1/users/me/drafts", { message: { raw: "{{raw}}" } }, "Save a Gmail draft."],
  ["gmailListMessages", "Gmail — List Messages", "inbox", "bearer", "token", "OAuth access token", "https://gmail.googleapis.com", "GET", "/gmail/v1/users/me/messages?maxResults=25", null, "List Gmail message ids."],
  ["gmailGetMessage", "Gmail — Get Message", "inbox", "bearer", "token", "OAuth access token", "https://gmail.googleapis.com", "GET", "/gmail/v1/users/me/messages/{{messageId}}", null, "Read a single Gmail message."],
  ["gmailModifyMessage", "Gmail — Add Label to Message", "mail", "bearer", "token", "OAuth access token", "https://gmail.googleapis.com", "POST", "/gmail/v1/users/me/messages/{{messageId}}/modify", { addLabelIds: ["{{labelId}}"], removeLabelIds: ["UNREAD"] }, "Apply (and optionally remove) labels on a Gmail message."],

  // ---- Stripe actions ------------------------------------------------------
  ["stripeCreateCustomer", "Stripe — Create Customer", "creditCard", "bearer", "apiKey", "Secret key", "https://api.stripe.com", "POST", "/v1/customers", { email: "{{email}}", name: "{{name}}" }, "Create a Stripe customer."],
  ["stripeCreateInvoice", "Stripe — Create Invoice", "coins", "bearer", "apiKey", "Secret key", "https://api.stripe.com", "POST", "/v1/invoices", { customer: "{{customerId}}", collection_method: "charge_automatically", auto_advance: true }, "Create a Stripe invoice for a customer."],
  ["stripeRefundPayment", "Stripe — Refund Payment", "creditCard", "bearer", "apiKey", "Secret key", "https://api.stripe.com", "POST", "/v1/refunds", { payment_intent: "{{paymentIntent}}" }, "Refund a Stripe payment intent."],
  ["stripeListPayments", "Stripe — List Payments", "list", "bearer", "apiKey", "Secret key", "https://api.stripe.com", "GET", "/v1/payment_intents?limit=25", null, "List recent Stripe payment intents."],

  // ---- Google Drive, Docs, Calendar ----------------------------------------
  ["googleDriveCopyFile", "Google Drive — Copy File", "file", "bearer", "token", "OAuth access token", "https://www.googleapis.com", "POST", "/drive/v3/files/{{fileId}}/copy", { name: "{{name}}" }, "Copy a Google Drive file."],
  ["googleDriveCreateFolder", "Google Drive — Create Folder", "folder", "bearer", "token", "OAuth access token", "https://www.googleapis.com", "POST", "/drive/v3/files", { name: "{{name}}", mimeType: "application/vnd.google-apps.folder" }, "Create a folder in Google Drive."],
  ["googleDriveDownloadFile", "Google Drive — Download File", "fileSearch", "bearer", "token", "OAuth access token", "https://www.googleapis.com", "GET", "/drive/v3/files/{{fileId}}?alt=media", null, "Download a Google Drive file's content."],
  ["googleDriveMoveFile", "Google Drive — Move File", "folderOpen", "bearer", "token", "OAuth access token", "https://www.googleapis.com", "PATCH", "/drive/v3/files/{{fileId}}?addParents={{folderId}}&removeParents={{removeParents}}", null, "Move a Google Drive file into another folder."],
  ["googleCalendarListEvents", "Google Calendar — List Events", "calendar", "bearer", "token", "OAuth access token", "https://www.googleapis.com", "GET", "/calendar/v3/calendars/{{calendarId}}/events", null, "List events on a Google Calendar."],
  ["googleDocsAppend", "Google Docs — Append Text", "file", "bearer", "token", "OAuth access token", "https://docs.googleapis.com", "POST", "/v1/documents/{{documentId}}:batchUpdate", { requests: [{ insertText: { text: "{{text}}", endOfSegmentLocation: {} } }] }, "Append text to the end of a Google Docs document."],

  // ---- Slack, Notion & Jira ------------------------------------------------
  ["slackUpdateMessage", "Slack — Update Message", "messageSquare", "bearer", "token", "Bot token", "https://slack.com", "POST", "/api/chat.update", { channel: "{{channel}}", ts: "{{ts}}", text: "{{text}}" }, "Edit a Slack message the bot already posted."],
  ["slackLookupUser", "Slack — Look Up User by Email", "users", "bearer", "token", "Bot token", "https://slack.com", "GET", "/api/users.lookupByEmail?email={{email}}", null, "Find a Slack user id from an email address."],
  ["notionGetPage", "Notion — Get Page", "notion", "bearer", "token", "Integration token", "https://api.notion.com", "GET", "/v1/pages/{{pageId}}", null, "Read a Notion page.", { "Notion-Version": "2022-06-28" }],
  ["notionAppendBlocks", "Notion — Append Blocks", "notion", "bearer", "token", "Integration token", "https://api.notion.com", "PATCH", "/v1/blocks/{{blockId}}/children", { children: "{{children}}" }, "Append content blocks to a Notion page.", { "Notion-Version": "2022-06-28" }],
  ["notionArchivePage", "Notion — Archive Page", "notion", "bearer", "token", "Integration token", "https://api.notion.com", "PATCH", "/v1/pages/{{pageId}}", { archived: true }, "Archive (trash) a Notion page.", { "Notion-Version": "2022-06-28" }],
  ["jiraAddComment", "Jira — Add Comment", "ticket", "basic", "basicAuth", "Email : API token", "https://{{site}}.atlassian.net", "POST", "/rest/api/2/issue/{{issueKey}}/comment", { body: "{{comment}}" }, "Add a comment to a Jira issue."],

  // ---- GitLab --------------------------------------------------------------
  ["gitlabCreateMergeRequest", "GitLab — Create Merge Request", "gitlab", "header:PRIVATE-TOKEN", "token", "Personal access token", "https://gitlab.com", "POST", "/api/v4/projects/{{projectId}}/merge_requests", { source_branch: "{{sourceBranch}}", target_branch: "{{targetBranch}}", title: "{{title}}" }, "Open a GitLab merge request."],
  ["gitlabTriggerPipeline", "GitLab — Trigger Pipeline", "rocket", "header:PRIVATE-TOKEN", "token", "Personal access token", "https://gitlab.com", "POST", "/api/v4/projects/{{projectId}}/pipeline", { ref: "{{ref}}" }, "Run a GitLab CI/CD pipeline on a ref."],

  // ---- Storage & search ----------------------------------------------------
  ["s3ListObjects", "S3 — List Objects", "list", "aws", "", "", "https://s3.us-east-1.amazonaws.com", "GET", "/{{bucket}}?list-type=2", null, "List the objects in an S3 bucket prefix (SigV4-signed)."],
  ["s3DeleteObject", "S3 — Delete Object", "fileArchive", "aws", "", "", "https://s3.us-east-1.amazonaws.com", "DELETE", "/{{bucket}}/{{key}}", null, "Delete an object from an S3 bucket (SigV4-signed)."],
  ["dynamodbQuery", "DynamoDB — Query Items", "database", "aws", "", "", "https://dynamodb.us-east-1.amazonaws.com", "POST", "/", { TableName: "{{table}}", KeyConditionExpression: "{{keyCondition}}", ExpressionAttributeValues: "{{values}}" }, "Query items in a DynamoDB table (SigV4-signed)."],
  ["elasticsearchIndex", "Elasticsearch — Index Document", "database", "basic", "basicAuth", "User : Password", "http://localhost:9200", "PUT", "/{{index}}/_doc/{{id}}", { document: "{{document}}" }, "Index a document into Elasticsearch."],
];
const SERVICE_ACTIONS = Object.fromEntries(ACTIONS.map((t) => [t[0], buildAction(t)]));

// ----------------------------------------------------------------------------
// MORE INTEGRATIONS — siblings of existing service nodes (Gitea next to GitHub,
// Groq next to Perplexity, Brave Search next to Google Search, …). Same tuple
// format and the same request engine (server/service-exec.js) as ACTIONS; they
// only live in their own palette group ("More Integrations") with its colour.
// An optional 13th element { query } pre-fills the Query parameters field.
// ----------------------------------------------------------------------------
const chatBody = (model) => ({ model, messages: [{ role: "user", content: "{{prompt}}" }] });
const INTEGRATIONS = [
  // ---- Git hosting (like GitHub / GitLab) ----------------------------------
  ["giteaCreateIssue", "Gitea — Create Issue", "github", "bearer", "token", "Access token", "https://gitea.com", "POST", "/api/v1/repos/{{owner}}/{{repo}}/issues", { title: "{{title}}", body: "{{body}}" }, "Open an issue in a Gitea / Forgejo repository (set Base URL for a self-hosted instance)."],
  ["giteaListIssues", "Gitea — List Issues", "github", "bearer", "token", "Access token", "https://gitea.com", "GET", "/api/v1/repos/{{owner}}/{{repo}}/issues", null, "List the issues of a Gitea / Forgejo repository.", null, { query: { state: "open", type: "issues" } }],
  ["giteaCreateRelease", "Gitea — Create Release", "rocket", "bearer", "token", "Access token", "https://gitea.com", "POST", "/api/v1/repos/{{owner}}/{{repo}}/releases", { tag_name: "{{tag}}", name: "{{name}}", body: "{{notes}}" }, "Publish a release in a Gitea / Forgejo repository."],
  ["codebergCreateIssue", "Codeberg — Create Issue", "github", "bearer", "token", "Access token", "https://codeberg.org", "POST", "/api/v1/repos/{{owner}}/{{repo}}/issues", { title: "{{title}}", body: "{{body}}" }, "Open an issue in a Codeberg repository."],

  // ---- Issue trackers (like Jira / Linear) ---------------------------------
  ["youtrackIssue", "YouTrack — Create Issue", "ticket", "bearer", "token", "Permanent token", "https://example.youtrack.cloud", "POST", "/api/issues", { project: { id: "{{projectId}}" }, summary: "{{title}}", description: "{{description}}" }, "Create an issue in JetBrains YouTrack.", null, { query: { fields: "id,idReadable,summary" } }],
  ["shortcutStory", "Shortcut — Create Story", "ticket", "header:Shortcut-Token", "apiToken", "API token", "https://api.app.shortcut.com", "POST", "/api/v3/stories", { name: "{{title}}", description: "{{description}}", workflow_state_id: "{{workflowStateId}}" }, "Create a story in Shortcut (formerly Clubhouse)."],
  ["planeIssue", "Plane — Create Work Item", "ticket", "header:X-API-Key", "apiKey", "API key", "https://api.plane.so", "POST", "/api/v1/workspaces/{{workspace}}/projects/{{projectId}}/issues/", { name: "{{title}}", description_html: "<p>{{description}}</p>" }, "Create a work item in a Plane project."],

  // ---- Social & notifications (like Twitter / Slack / Pushover) ------------
  ["mastodonPost", "Mastodon — Post Status", "megaphone", "bearer", "token", "Access token", "https://mastodon.social", "POST", "/api/v1/statuses", { status: "{{text}}", visibility: "public" }, "Publish a post (toot) on any Mastodon instance."],
  ["discourseTopic", "Discourse — Create Topic", "messageSquare", "header:Api-Key", "apiKey", "API key", "https://forum.example.com", "POST", "/posts.json", { title: "{{title}}", raw: "{{text}}", category: "{{categoryId}}" }, "Create a topic on a Discourse forum.", { "Api-Username": "system" }],
  ["gotifySend", "Gotify — Send Notification", "bell", "header:X-Gotify-Key", "appToken", "Application token", "https://gotify.example.com", "POST", "/message", { title: "{{title}}", message: "{{text}}", priority: 5 }, "Push a notification through a self-hosted Gotify server."],
  ["pushbulletSend", "Pushbullet — Send Push", "bell", "header:Access-Token", "accessToken", "Access token", "https://api.pushbullet.com", "POST", "/v2/pushes", { type: "note", title: "{{title}}", body: "{{text}}" }, "Send a note push to your Pushbullet devices."],

  // ---- Web search (like Google Search) -------------------------------------
  ["braveSearch", "Brave Search — Web Search", "search", "header:X-Subscription-Token", "apiKey", "API key", "https://api.search.brave.com", "GET", "/res/v1/web/search", null, "Search the web with the Brave Search API.", null, { query: { q: "{{query}}", count: "10" } }],
  ["tavilySearch", "Tavily — AI Web Search", "search", "bearer", "apiKey", "API key", "https://api.tavily.com", "POST", "/search", { query: "{{query}}", max_results: 5 }, "Search the web with Tavily (results tuned for LLM agents)."],
  ["serpapiSearch", "SerpApi — Google Results", "search", "query:api_key", "apiKey", "API key", "https://serpapi.com", "GET", "/search.json", null, "Fetch Google search results as JSON through SerpApi.", null, { query: { engine: "google", q: "{{query}}" } }],
  ["exaSearch", "Exa — Neural Search", "search", "header:x-api-key", "apiKey", "API key", "https://api.exa.ai", "POST", "/search", { query: "{{query}}", numResults: 5 }, "Search the web by meaning with Exa."],

  // ---- LLM chat (like Perplexity / Cohere) — OpenAI-style APIs -------------
  ["groqChat", "Groq — Chat", "sparkles", "bearer", "apiKey", "API key", "https://api.groq.com", "POST", "/openai/v1/chat/completions", chatBody("llama-3.3-70b-versatile"), "Fast chat completions on Groq hardware (OpenAI-compatible)."],
  ["mistralChat", "Mistral AI — Chat", "sparkles", "bearer", "apiKey", "API key", "https://api.mistral.ai", "POST", "/v1/chat/completions", chatBody("mistral-small-latest"), "Chat completions with Mistral AI models."],
  ["openrouterChat", "OpenRouter — Chat", "sparkles", "bearer", "apiKey", "API key", "https://openrouter.ai", "POST", "/api/v1/chat/completions", chatBody("openrouter/auto"), "Route a chat completion to any model through OpenRouter."],
  ["deepseekChat", "DeepSeek — Chat", "sparkles", "bearer", "apiKey", "API key", "https://api.deepseek.com", "POST", "/chat/completions", chatBody("deepseek-chat"), "Chat completions with DeepSeek models."],
  ["togetherChat", "Together AI — Chat", "sparkles", "bearer", "apiKey", "API key", "https://api.together.xyz", "POST", "/v1/chat/completions", chatBody("meta-llama/Llama-3.3-70B-Instruct-Turbo"), "Chat completions with open models hosted on Together AI."],
  ["xaiChat", "xAI Grok — Chat", "sparkles", "bearer", "apiKey", "API key", "https://api.x.ai", "POST", "/v1/chat/completions", chatBody("grok-3-mini"), "Chat completions with xAI's Grok models."],

  // ---- Email (like Postmark / SendGrid) ------------------------------------
  ["sparkpostSend", "SparkPost — Send Email", "mailSend", "header:Authorization", "apiKey", "API key", "https://api.sparkpost.com", "POST", "/api/v1/transmissions", { recipients: [{ address: "{{to}}" }], content: { from: "{{from}}", subject: "{{subject}}", text: "{{body}}" } }, "Send a transactional email through SparkPost."],
  ["smtp2goSend", "SMTP2GO — Send Email", "mailSend", "header:X-Smtp2go-Api-Key", "apiKey", "API key", "https://api.smtp2go.com", "POST", "/v3/email/send", { sender: "{{from}}", to: ["{{to}}"], subject: "{{subject}}", text_body: "{{body}}" }, "Send an email through SMTP2GO."],
  ["loopsEvent", "Loops — Send Event", "mail", "bearer", "apiKey", "API key", "https://app.loops.so", "POST", "/api/v1/events/send", { email: "{{email}}", eventName: "{{event}}" }, "Trigger a Loops email automation with an event."],

  // ---- Monitoring (like PagerDuty / Opsgenie) ------------------------------
  ["betterstackIncident", "Better Stack — Create Incident", "siren", "bearer", "token", "API token", "https://uptime.betterstack.com", "POST", "/api/v2/incidents", { summary: "{{summary}}", description: "{{description}}", requester_email: "{{email}}" }, "Open an incident in Better Stack Uptime."],
  ["healthchecksPing", "Healthchecks.io — Ping Check", "activity", "none", "", "", "https://hc-ping.com", "POST", "/{{checkUuid}}", null, "Signal a Healthchecks.io check (append /fail or /start to the path)."],
  ["uptimeKumaPush", "Uptime Kuma — Push Heartbeat", "activity", "none", "", "", "https://status.example.com", "GET", "/api/push/{{pushToken}}", null, "Send a heartbeat to an Uptime Kuma push monitor.", null, { query: { status: "up", msg: "OK" } }],

  // ---- CRM & databases (like HubSpot / Airtable) ---------------------------
  ["attioRecord", "Attio — Create Person", "users", "bearer", "token", "Access token", "https://api.attio.com", "POST", "/v2/objects/people/records", { data: { values: { email_addresses: ["{{email}}"] } } }, "Create a person record in the Attio CRM."],
  ["gristAddRecords", "Grist — Add Records", "table", "bearer", "apiKey", "API key", "https://docs.getgrist.com", "POST", "/api/docs/{{docId}}/tables/{{tableId}}/records", { records: [{ fields: "{{fields}}" }] }, "Add rows to a Grist document table."],
];
const INTEGRATION_NODES = Object.fromEntries(
  INTEGRATIONS.map((t) => {
    const node = { ...buildAction(t), category: "integrations" };
    const opts = t[12];
    if (opts?.query) node.defaults = { ...node.defaults, query: JSON.stringify(opts.query) };
    return [t[0], node];
  })
);

// ----------------------------------------------------------------------------
// FEEDS & SOURCES — ready-made readers for services that publish an RSS / Atom
// feed. Each one is the RSS Read node (same fetch + parser, see readFeed in
// server/executor.js) with a service-specific URL built from its own fields;
// they only differ in look and inputs and live in the "Feeds & Sources" group.
//
// Tuple: [type, name, icon, urlTemplate, inputFields, desc]
//   urlTemplate  {{key}} is replaced by that input's value (URL-encoded)
//   inputFields  [{ key, label, default, placeholder?, options?, help? }]
// ----------------------------------------------------------------------------
function buildFeed(t) {
  const [type, name, icon, url, inputs, desc] = t;
  const fields = inputs.map((f) => ({
    key: f.key,
    label: f.label,
    type: f.options ? "select" : "text",
    ...(f.options ? { options: f.options } : {}),
    ...(f.placeholder ? { placeholder: f.placeholder } : {}),
    help: f.help || "Supports {{vars}} from the incoming item.",
    section: "Feed",
  }));
  fields.push(
    { key: "limit", label: "Max items", type: "number", section: "Feed" },
    { key: "storeIn", label: "Save items under field", type: "text", placeholder: "items", section: "Output" }
  );
  const defaults = { ...Object.fromEntries(inputs.map((f) => [f.key, f.default ?? ""])), limit: 20, storeIn: "items" };
  return { type, name, kind: "action", category: "feeds", sources: ["out"], description: desc, icon, feed: { url }, defaults, fields };
}

const FEEDS = [
  ["youtubeChannelFeed", "YouTube — Channel Videos", "youtube", "https://www.youtube.com/feeds/videos.xml?channel_id={{channelId}}", [{ key: "channelId", label: "Channel ID", default: "UC_x5XG1OV2P6uZZ5FSM9Ttw", placeholder: "UC…", help: "The channel ID (starts with UC), shown under About → Share channel → Copy channel ID." }], "Latest videos of a YouTube channel — no API key needed."],
  ["youtubePlaylistFeed", "YouTube — Playlist Videos", "youtube", "https://www.youtube.com/feeds/videos.xml?playlist_id={{playlistId}}", [{ key: "playlistId", label: "Playlist ID", default: "", placeholder: "PL…", help: "The list= value from the playlist URL." }], "Latest videos added to a YouTube playlist — no API key needed."],
  ["redditSubredditFeed", "Reddit — Subreddit Posts", "globe", "https://www.reddit.com/r/{{subreddit}}/{{sort}}/.rss", [{ key: "subreddit", label: "Subreddit", default: "selfhosted", placeholder: "selfhosted" }, { key: "sort", label: "Sort", default: "new", options: ["hot", "new", "top", "rising"] }], "Posts from a subreddit (hot, new, top or rising) — no API key needed."],
  ["hackernewsFeed", "Hacker News — Stories", "newspaper", "https://hnrss.org/{{list}}", [{ key: "list", label: "List", default: "frontpage", options: ["frontpage", "newest", "best", "ask", "show", "jobs"] }], "Hacker News front page, newest, best, Ask HN, Show HN or jobs."],
  ["githubReleasesFeed", "GitHub — Repository Releases", "github", "https://github.com/{{owner}}/{{repo}}/releases.atom", [{ key: "owner", label: "Owner", default: "nodejs" }, { key: "repo", label: "Repository", default: "node" }], "New releases of a public GitHub repository — no token needed."],
  ["githubCommitsFeed", "GitHub — Branch Commits", "github", "https://github.com/{{owner}}/{{repo}}/commits/{{branch}}.atom", [{ key: "owner", label: "Owner", default: "nodejs" }, { key: "repo", label: "Repository", default: "node" }, { key: "branch", label: "Branch", default: "main" }], "Latest commits on a branch of a public GitHub repository."],
  ["gitlabReleasesFeed", "GitLab — Project Releases", "gitlab", "https://gitlab.com/{{project}}/-/releases.atom", [{ key: "project", label: "Project path", default: "gitlab-org/gitlab-runner", placeholder: "group/project", help: "The group/project path from the project URL." }], "New releases of a public GitLab project."],
  ["mastodonFeed", "Mastodon — Account Posts", "megaphone", "https://{{instance}}/@{{account}}.rss", [{ key: "instance", label: "Instance", default: "mastodon.social", placeholder: "mastodon.social" }, { key: "account", label: "Account", default: "Mastodon", placeholder: "username (without @)" }], "Public posts of a Mastodon account on any instance."],
  ["mastodonTagFeed", "Mastodon — Hashtag Posts", "megaphone", "https://{{instance}}/tags/{{tag}}.rss", [{ key: "instance", label: "Instance", default: "mastodon.social" }, { key: "tag", label: "Hashtag", default: "selfhosted", placeholder: "without #" }], "Public posts with a hashtag on a Mastodon instance."],
  ["blueskyFeed", "Bluesky — Profile Posts", "megaphone", "https://bsky.app/profile/{{handle}}/rss", [{ key: "handle", label: "Handle", default: "bsky.app", placeholder: "name.bsky.social" }], "Public posts of a Bluesky profile."],
  ["mediumFeed", "Medium — Author Stories", "book", "https://medium.com/feed/@{{user}}", [{ key: "user", label: "Username", default: "", placeholder: "without @" }], "Latest stories of a Medium author."],
  ["substackFeed", "Substack — Newsletter Posts", "mail", "https://{{publication}}.substack.com/feed", [{ key: "publication", label: "Publication", default: "", placeholder: "the name before .substack.com" }], "Latest posts of a Substack newsletter."],
  ["devtoFeed", "DEV Community — Tag Articles", "code", "https://dev.to/feed/tag/{{tag}}", [{ key: "tag", label: "Tag", default: "javascript" }], "Latest DEV Community (dev.to) articles for a tag."],
  ["stackoverflowTagFeed", "Stack Overflow — Tag Questions", "code", "https://stackoverflow.com/feeds/tag/{{tag}}", [{ key: "tag", label: "Tag", default: "node.js" }], "Newest Stack Overflow questions for a tag."],
  ["googleNewsFeed", "Google News — Search", "newspaper", "https://news.google.com/rss/search?q={{query}}&hl={{language}}", [{ key: "query", label: "Search query", default: "workflow automation" }, { key: "language", label: "Language", default: "en", options: ["en", "de", "fr", "es", "it", "ru", "pt-BR", "ja"] }], "Google News articles matching a search query."],
  ["arxivFeed", "arXiv — New Papers", "graduationCap", "https://rss.arxiv.org/rss/{{category}}", [{ key: "category", label: "Category", default: "cs.AI", placeholder: "cs.AI, cs.LG, math.CO …" }], "New arXiv papers in a subject category."],
  ["podcastFeed", "Podcast — Episodes", "podcast", "{{url}}", [{ key: "url", label: "Podcast feed URL", default: "", placeholder: "https://example.com/podcast.xml", help: "The show's RSS feed. Each episode includes its audio file under enclosure.url and its duration." }], "Latest episodes of a podcast, with audio file and duration."],
  ["wordpressFeed", "WordPress — Site Posts", "newspaper", "https://{{site}}/feed/", [{ key: "site", label: "Site domain", default: "wordpress.org/news", placeholder: "example.com" }], "Latest posts of any WordPress site."],
];
const FEED_NODES = Object.fromEntries(FEEDS.map((t) => [t[0], buildFeed(t)]));

// Gmail's API wants a base64url-encoded RFC 2822 message, which nobody writes
// by hand. These plain fields build it (server/executor.js, case "gmailSend");
// a `raw` field on the incoming item still wins for advanced use.
const GMAIL_MESSAGE_FIELDS = [
  { key: "to", label: "To", type: "text", placeholder: "someone@example.com, {{email}}", section: "Message", help: "One or more addresses, comma-separated. {{placeholders}} from the incoming item work." },
  { key: "cc", label: "Cc", type: "text", section: "Message", optional: true },
  { key: "subject", label: "Subject", type: "text", placeholder: "Workflow notification", section: "Message" },
  { key: "message", label: "Message", type: "textarea", placeholder: "Hello {{name}},\n\n…", section: "Message" },
  { key: "html", label: "Message is HTML", type: "boolean", section: "Message" },
];
for (const type of ["gmailSend", "gmailCreateDraft"]) {
  const def = SERVICE_ACTIONS[type];
  def.description = type === "gmailSend" ? "Send an email from your Gmail account." : "Save an email as a draft in your Gmail account.";
  // after the credential, so the account picker stays on top
  def.fields = [def.fields[0], ...GMAIL_MESSAGE_FIELDS, ...def.fields.slice(1)];
  def.defaults = { ...def.defaults, to: "", cc: "", subject: "", message: "", html: false };
}

// ---- request parameters as fields ----
// A service node's request is a template: Docs "Append Text" sends
// { insertText: { text: "{{text}}" } }. Without a field for it, `text` could
// only come from the incoming item or a hand-edited JSON body. Every
// {{placeholder}} in the base URL, path, query, headers or body therefore gets
// its own field above the raw request. A filled field fills the placeholder
// (itself rendered against the item, so "Hi {{name}}" works); an empty one
// keeps the old behaviour and reads the item's field of the same name.
// server/service-exec.js applies them through `service.params`.
const REQUEST_KEYS = new Set(["baseUrl", "path", "method", "query", "headers", "body", "storeIn", "region", "accessKey", "secretKey", "timeout"]);
const LONG_PARAMS = new Set(["text", "body", "message", "content", "description", "notes", "prompt", "query", "html", "markdown", "document", "comment", "summary", "caption", "fields", "data", "values"]);
// placeholders a node's own fields already produce
const BUILT_PARAMS = { gmailSend: ["raw"], gmailCreateDraft: ["raw"] };
// a sensible value for a parameter that is in the URL, so a fresh node runs
const PARAM_DEFAULTS = { googleCalendarListEvents: { calendarId: "primary" } };

function placeholderNames(...templates) {
  const names = [];
  for (const t of templates) {
    const s = typeof t === "string" ? t : JSON.stringify(t ?? "");
    for (const m of s.matchAll(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g)) if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function paramLabel(name) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/\b(id|url|sql|api)\b/gi, (w) => w.toUpperCase());
}

function applyParamFields(type, def) {
  const s = def.service;
  const d = def.defaults;
  const skip = BUILT_PARAMS[type] || [];
  const params = [];
  const fields = [];
  for (const name of placeholderNames(s.base, s.defaultPath, s.defaultBody, d.query, d.headers)) {
    if (skip.includes(name)) continue;
    // a hand-made field already fills it (no clash with the raw request fields)
    if (!REQUEST_KEYS.has(name) && def.fields.some((f) => f.key === name)) continue;
    const key = REQUEST_KEYS.has(name) ? `${name}Value` : name;
    params.push({ key, name });
    fields.push({
      key,
      label: paramLabel(name),
      type: LONG_PARAMS.has(name) ? "textarea" : "text",
      section: "Parameters",
      help: `Fills {{${name}}} in the request. Type the value, or use {{placeholders}} from the incoming item. Left empty, the item's own "${name}" field is used.`,
    });
    d[key] = PARAM_DEFAULTS[type]?.[name] ?? "";
  }
  if (!params.length) return;
  s.params = params;
  const at = def.fields.findIndex((f) => f.section === "Request");
  def.fields.splice(at < 0 ? def.fields.length : at, 0, ...fields);
}
for (const [type, def] of Object.entries({ ...SERVICE_ACTIONS, ...INTEGRATION_NODES })) applyParamFields(type, def);

export const EXTRA_NODES = {
  ...CORE,
  ...SERVICE_ACTIONS,
  ...INTEGRATION_NODES,
  ...FEED_NODES,
};
