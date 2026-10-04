// ============================================================================
// W FLOW — sample payloads for service triggers
// Shared between the executor (server) and the node config modal (frontend),
// so the "input overview" can show which fields a trigger will produce before
// the workflow is even run.
// ============================================================================

export function samplePayloadFor(node, ctx = {}) {
  const c = node?.data?.config || {};
  switch (node?.type) {
    case "webhook": {
      const body = ctx?.webhookPayload ?? { message: "Hello from the webhook!", source: "wflow", ts: new Date().toISOString() };
      return {
        headers: ctx?.webhookHeaders ?? { "content-type": "application/json" },
        method: c.method || "POST",
        body,
        query: ctx?.webhookQuery ?? {},
      };
    }
    case "schedule": {
      // A real scheduled run passes the actual fire time via ctx.triggerPayload
      // (the background cron scheduler); a manual run just uses "now".
      const t = ctx?.triggerPayload && typeof ctx.triggerPayload === "object" ? ctx.triggerPayload : {};
      return {
        triggeredAt: t.triggeredAt || new Date().toISOString(),
        cron: c.cron || "",
        timezone: c.timezone || "UTC",
        nextRuns: t.nextRuns || [],
      };
    }
    case "gmail":
    case "imap":
      return {
        triggeredAt: new Date().toISOString(),
        mailbox: node.type === "gmail" ? c.user || "you@gmail.com" : c.host || "imap.example.com",
        folder: c.folder || "INBOX",
        count: 1,
        messages: [
          {
            id: "msg_001",
            uid: 1042,
            from: c.filterFrom || "Alex <sender@example.com>",
            fromAddress: c.filterFrom || "sender@example.com",
            to: c.user || "you@example.com",
            subject: c.filterSubject ? `[${c.filterSubject}] Project update` : "Project update — Q3 planning",
            text: "Hi,\n\nAttached are the notes from today's planning session.\n\nCheers,\nAlex",
            html: "",
            date: new Date().toISOString(),
            attachments: [],
          },
        ],
      };
    case "slackTrigger":
      return {
        event: "message",
        channel: c.channel || "#general",
        user: "U12345678",
        text: c.filterKeyword ? `[${c.filterKeyword}] Hello from Slack!` : "Hello from Slack!",
        ts: new Date().toISOString(),
      };
    case "githubTrigger":
      return {
        event: c.event || "issues",
        action: "opened",
        repository: { owner: c.owner || "octocat", name: c.repo || "Hello-World", url: "https://github.com/octocat/Hello-World" },
        issue: {
          number: 42,
          title: "Bug: workflow does not trigger",
          body: "Reported by a user. Labels: " + (c.filterLabel || "bug"),
          labels: c.filterLabel ? [{ name: c.filterLabel }] : [{ name: "bug" }],
          url: "https://github.com/octocat/Hello-World/issues/42",
          created_at: new Date().toISOString(),
        },
      };
    case "telegramTrigger": {
      // The sample matches the trigger's "Listen for" choice, so a bot built
      // for button presses or /commands can be tested with the right shape.
      const chat = { id: c.chatId ? Number(c.chatId) : 987654321, type: "private" };
      const from = { id: 555, first_name: "Demo", username: "demo_user" };
      const date = Math.floor(Date.now() / 1000);
      if (c.updates === "button presses") {
        return {
          update_id: 123456789,
          callback_query: {
            id: "4382bfdwdsb323b2d9",
            from,
            data: "yes",
            message: { message_id: 99, chat, text: "Do you want to continue?", date },
          },
        };
      }
      const cmd = String(c.command || "/start").trim();
      return {
        update_id: 123456789,
        message: {
          message_id: 100,
          chat,
          from,
          text: c.updates === "commands" ? (cmd.startsWith("/") ? cmd : `/${cmd}`) : "Hello from Telegram!",
          date,
        },
      };
    }
    case "notionTrigger":
      return {
        event: "page.created",
        page: {
          id: "page_abc123",
          database_id: c.databaseId || "db_000",
          title: "New task created",
          created_time: new Date().toISOString(),
          url: "https://www.notion.so/New-task-abc123",
        },
      };
    case "sheetsTrigger":
      return {
        triggeredAt: new Date().toISOString(),
        spreadsheetId: c.spreadsheetId || "1abc…",
        sheetName: c.sheetName || "",
        headers: ["Name", "Email", "Plan", "Signed up"],
        firstRow: 12,
        rows: [{ Name: "Ada Example", Email: "ada@example.com", Plan: "Pro", "Signed up": new Date().toISOString().slice(0, 10) }],
        values: [["Ada Example", "ada@example.com", "Pro", new Date().toISOString().slice(0, 10)]],
        count: 1,
      };
    case "teamsTrigger":
      return {
        event: "message",
        channel: c.channel || "General",
        user: { id: "U12345", displayName: "Demo User" },
        text: c.filterKeyword ? `[${c.filterKeyword}] Hello from Microsoft Teams!` : "Hello from Microsoft Teams!",
        ts: new Date().toISOString(),
      };
    case "outlookTrigger":
      return {
        mailbox: c.mailbox || "you@contoso.com",
        folder: c.folder || "Inbox",
        message: {
          id: "msg_001",
          from: { emailAddress: { address: c.filterFrom || "sender@contoso.com", name: "Alex" } },
          subject: c.filterSubject ? `[${c.filterSubject}] Quarterly report` : "Quarterly report",
          body: { contentType: "text", content: "Hi,\n\nHere is the quarterly report.\n\nBest,\nAlex" },
          receivedDateTime: new Date().toISOString(),
        },
      };
    case "stripeTrigger":
      return {
        event: c.mode || "checkout.session.completed",
        id: "evt_1Qwxyz",
        created: Math.floor(Date.now() / 1000),
        customer: { email: "customer@example.com", name: "Ada Example" },
        session: {
          id: "cs_test_abc123",
          customer_email: "customer@example.com",
          amount_total: 2500,
          currency: "usd",
          payment_status: "paid",
          status: "complete",
          url: "https://buy.stripe.com/test_abc123",
        },
      };
    case "jiraTrigger":
      return {
        event: c.event === "issue_updated" ? "jira:issue_updated" : "jira:issue_created",
        timestamp: new Date().toISOString(),
        issue: {
          key: "PROJ-123",
          id: "10001",
          summary: "New task created by a workflow",
          description: "This issue was created through W flow.",
          status: { name: "To Do" },
          priority: { name: "Medium" },
          project: { key: c.projectKey || "PROJ", name: "Project" },
          reporter: { displayName: "Demo User", emailAddress: "demo@example.com" },
          url: `https://your.atlassian.net/browse/${c.projectKey || "PROJ"}-123`,
        },
      };
    case "discordTrigger":
      return {
        event: "message",
        channel: c.channel || "general",
        author: { id: "U123456", username: "demo_user" },
        content: c.filterKeyword ? `[${c.filterKeyword}] Hello from Discord!` : "Hello from Discord!",
        ts: new Date().toISOString(),
      };
    case "googleDriveTrigger":
      return {
        event: "file.created",
        file: {
          id: "file_abc123",
          name: "new-report.csv",
          mimeType: "text/csv",
          size: 2048,
          parents: c.folderId ? [c.folderId] : [],
          webViewLink: "https://drive.google.com/file/d/file_abc123/view",
          modifiedTime: new Date().toISOString(),
        },
      };
    case "rssTrigger":
      return {
        feed: c.url || "https://example.com/feed.xml",
        items: [
          {
            title: "New post: W flow update",
            link: "https://example.com/wflow-update",
            description: "A summary of the latest changes.",
            pubDate: new Date().toISOString(),
            guid: "bf-post-001",
          },
        ],
      };
    case "cryptoPriceTrigger": {
      const threshold = Number(c.threshold) || 100000;
      const up = (c.condition || "above") !== "below";
      return {
        triggeredAt: new Date().toISOString(),
        exchange: c.exchange || "binance",
        symbol: c.symbol || "BTCUSDT",
        price: up ? threshold * 1.002 : threshold * 0.998,
        previousPrice: up ? threshold * 0.999 : threshold * 1.001,
        condition: c.condition || "above",
        threshold,
        crossed: up ? "above" : "below",
        change24h: 2.4,
      };
    }
    case "polymarketTrigger":
      return {
        triggeredAt: new Date().toISOString(),
        question: "Will Bitcoin reach $100,000 in September?",
        outcome: c.outcome || "Yes",
        chance: 62,
        previousChance: 48,
        condition: c.condition || "above",
        threshold: Number(c.threshold) || 50,
        crossed: "above",
        url: "https://polymarket.com/market/will-bitcoin-reach-100k-in-september-2026",
      };
    case "walletDepositTrigger":
      return {
        triggeredAt: new Date().toISOString(),
        network: c.network || "ethereum",
        address: c.address || "0x9d8A62f656a8d1615C1294fd71e9CFb3E4855A4F",
        asset: c.tokenAddress ? "USDC" : "ETH",
        token: c.tokenAddress || null,
        amount: 0.25,
        balance: 1.75,
        previousBalance: 1.5,
      };
    case "errorTrigger":
      return {
        event: "workflow.error",
        workflow: { name: "Daily report" },
        error: { message: "HTTP request failed with status 500", code: 4003, node: "HTTP Request" },
        ts: new Date().toISOString(),
      };
    case "hubspotTrigger":
      return {
        event: "contact.creation",
        contact: {
          id: 123456789,
          email: "new-contact@example.com",
          firstname: "Ada",
          lastname: "Example",
          createdate: new Date().toISOString(),
        },
      };
    case "airtableTrigger":
      return {
        event: "record.created",
        table: c.tableName || "Table 1",
        records: [{ id: "rec_abc123", fields: { Name: "Ada Example", Status: "New" }, createdTime: new Date().toISOString() }],
      };
    case "supabaseTrigger":
      return {
        event: "INSERT",
        table: c.tableName || "items",
        schema: "public",
        record: { id: 1, name: "Ada Example", created_at: new Date().toISOString() },
        type: "INSERT",
      };
    case "slackReactionTrigger":
      return {
        event: "reaction_added",
        user: "U12345678",
        reaction: c.filterEmoji || ":white_check_mark:",
        item: { type: "message", channel: "C123456", ts: "1700000000.000000" },
        ts: new Date().toISOString(),
      };
    case "chatTrigger": {
      // A real chat message comes in via ctx.triggerPayload (the chat panel).
      const t = ctx?.triggerPayload && typeof ctx.triggerPayload === "object" ? ctx.triggerPayload : {};
      const text = t.message ?? t.text ?? "Hello!";
      return {
        channel: "chat",
        role: "user",
        message: text,
        text,
        history: Array.isArray(t.history) ? t.history : [],
        at: t.at || new Date().toISOString(),
      };
    }
    case "formTrigger": {
      const fields = String(c.fields || "name, email, message")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const payload = { form: c.formName || "Contact form", submittedAt: new Date().toISOString() };
      for (const field of fields) {
        payload[field] = field === "email" ? "ada@example.com" : field === "message" ? "Hello from the form!" : `sample ${field}`;
      }
      return payload;
    }
    default: {
      const payload = ctx?.triggerPayload && typeof ctx.triggerPayload === "object" ? ctx.triggerPayload : {};
      return { triggeredAt: new Date().toISOString(), ...payload, data: payload };
    }
  }
}
