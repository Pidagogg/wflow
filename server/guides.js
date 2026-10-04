// ============================================================================
// Guides — public how-to pages at /guides (English) and /de/guides (German).
//
// The app sits behind a login, so search engines had almost nothing to index.
// These pages answer what people actually search for ("RSS to Telegram",
// "n8n alternative", …), are plain server-rendered HTML (fast, readable
// without JavaScript), carry canonical / hreflang / schema.org tags, and are
// listed in the sitemap. Each guide exists in both languages under the same
// slug so the two versions point at each other.
// ============================================================================
import express from "express";

// ---- content ----
// Bodies are trusted HTML written here (never user input). Node names match
// the catalog so readers find exactly what the guide mentions.

const TRY = { en: "https://w-flow.tech", de: "https://w-flow.tech" };

export const GUIDES = [
  {
    slug: "form-to-google-sheets",
    updated: "2026-09-26",
    en: {
      title: "Save website form submissions to Google Sheets and get a Slack message",
      description:
        "Send every contact or lead form straight into a Google Sheet and notify your team in Slack — no code, no Zapier, set up in about 10 minutes.",
      body: `
<p>Every time someone fills in the contact form on your website, you want two things: the entry saved in a spreadsheet, and a quick heads-up for your team. With W flow that is one small workflow of three nodes — and there is a ready-made template for it.</p>

<h2>What you need</h2>
<ul>
  <li>A free W flow account.</li>
  <li>A Google account with a spreadsheet (first row: <code>Name</code>, <code>E-mail</code>, <code>Message</code>).</li>
  <li>A Slack <em>incoming webhook URL</em> for the channel that should be notified (Slack → Apps → Incoming Webhooks → Add to Slack).</li>
  <li>A website form that can send its data to a URL (almost every form builder can: “webhook”, “POST to URL” or a few lines of JavaScript).</li>
</ul>

<h2>Step 1 — Start from the template</h2>
<p>Open <strong>Workflows</strong>, click <strong>Templates</strong> and choose <strong>Webhook → Google Sheets → Slack</strong>. You get three connected nodes: <em>Webhook</em> (receives the form), <em>Google Sheets — Append Row</em> (saves it) and <em>Slack Message</em> (notifies you).</p>

<h2>Step 2 — Connect Google Sheets</h2>
<ol>
  <li>Click the <strong>Google Sheets — Append Row</strong> node.</li>
  <li>Next to <strong>Google account</strong> click <strong>Connect Google</strong> and allow access in the window that opens. No password or API key is typed into W flow — the connection is stored encrypted and renews itself.</li>
  <li>Paste the <strong>Spreadsheet ID</strong>: the long part of the sheet's address between <code>/d/</code> and <code>/edit</code>.</li>
  <li>Check <strong>Values</strong>. The template writes <code>[["{{name}}", "{{email}}", "{{message}}"]]</code> — one row with the three form fields. The names in <code>{{…}}</code> must match the field names your form sends.</li>
</ol>

<h2>Step 3 — Set up Slack</h2>
<p>Open the <strong>Slack Message</strong> node, paste your incoming webhook URL and adjust the text, for example <code>New lead: {{name}} ({{email}})</code>.</p>

<h2>Step 4 — Point your form at the webhook</h2>
<ol>
  <li>Open the <strong>Webhook</strong> node and copy its URL (it looks like <code>https://w-flow.tech/webhook/…</code>).</li>
  <li>Switch on <strong>Always listen</strong>, so the URL accepts submissions all the time — not only while you test.</li>
  <li>Optional but recommended: set a <strong>Secret</strong>. Your form then has to send it in the <code>X-W-Flow-Secret</code> header, so nobody else can fill your sheet.</li>
  <li>In your form tool, set the webhook / action URL to the copied address with method <code>POST</code> and JSON or form data.</li>
</ol>

<h2>Step 5 — Test it</h2>
<p>Press <strong>Run</strong> in the editor, then submit your form once. The <strong>Log console</strong> shows each node's input and output; a new row appears in the sheet and Slack pings the channel. If a node fails, the log names the exact field and an error code.</p>

<h2>Ideas to extend it</h2>
<ul>
  <li>Add an <strong>IF Condition</strong> to only notify Slack for messages that contain “pricing” or come from company domains.</li>
  <li>Reply to the sender automatically with <strong>Gmail — Send Email</strong>.</li>
  <li>Let an AI node (<strong>Extract Structured Data</strong>) classify the request before it is saved.</li>
</ul>`,
    },
    de: {
      title: "Website-Formular in Google Sheets speichern und per Slack benachrichtigen",
      description:
        "Jede Kontakt- oder Lead-Anfrage automatisch in eine Google-Tabelle schreiben und das Team in Slack informieren — ohne Code, in etwa 10 Minuten eingerichtet.",
      body: `
<p>Wenn jemand das Kontaktformular Ihrer Website ausfüllt, wollen Sie zwei Dinge: den Eintrag in einer Tabelle und eine kurze Info ans Team. Mit W flow ist das ein kleiner Workflow aus drei Nodes — und dafür gibt es eine fertige Vorlage.</p>

<h2>Was Sie brauchen</h2>
<ul>
  <li>Ein kostenloses W-flow-Konto.</li>
  <li>Ein Google-Konto mit einer Tabelle (erste Zeile: <code>Name</code>, <code>E-Mail</code>, <code>Nachricht</code>).</li>
  <li>Eine Slack-<em>Incoming-Webhook-URL</em> für den Kanal, der benachrichtigt werden soll (Slack → Apps → Incoming Webhooks → Zu Slack hinzufügen).</li>
  <li>Ein Website-Formular, das seine Daten an eine URL senden kann (fast jeder Formular-Baukasten kann das: „Webhook“, „POST an URL“ oder ein paar Zeilen JavaScript).</li>
</ul>

<h2>Schritt 1 — Mit der Vorlage starten</h2>
<p>Öffnen Sie <strong>Workflows</strong>, klicken Sie auf <strong>Templates</strong> und wählen Sie <strong>Webhook → Google Sheets → Slack</strong>. Sie erhalten drei verbundene Nodes: <em>Webhook</em> (empfängt das Formular), <em>Google Sheets — Append Row</em> (speichert es) und <em>Slack Message</em> (benachrichtigt Sie).</p>

<h2>Schritt 2 — Google Sheets verbinden</h2>
<ol>
  <li>Klicken Sie auf den Node <strong>Google Sheets — Append Row</strong>.</li>
  <li>Klicken Sie neben <strong>Google account</strong> auf <strong>Connect Google</strong> und erlauben Sie den Zugriff im neuen Fenster. Sie geben kein Passwort und keinen API-Schlüssel in W flow ein — die Verbindung wird verschlüsselt gespeichert und erneuert sich selbst.</li>
  <li>Fügen Sie die <strong>Spreadsheet ID</strong> ein: den langen Teil der Tabellen-Adresse zwischen <code>/d/</code> und <code>/edit</code>.</li>
  <li>Prüfen Sie <strong>Values</strong>. Die Vorlage schreibt <code>[["{{name}}", "{{email}}", "{{message}}"]]</code> — eine Zeile mit den drei Formularfeldern. Die Namen in <code>{{…}}</code> müssen zu den Feldnamen passen, die Ihr Formular sendet.</li>
</ol>

<h2>Schritt 3 — Slack einrichten</h2>
<p>Öffnen Sie den Node <strong>Slack Message</strong>, fügen Sie Ihre Incoming-Webhook-URL ein und passen Sie den Text an, zum Beispiel <code>Neue Anfrage: {{name}} ({{email}})</code>.</p>

<h2>Schritt 4 — Formular mit dem Webhook verbinden</h2>
<ol>
  <li>Öffnen Sie den Node <strong>Webhook</strong> und kopieren Sie seine URL (sie sieht aus wie <code>https://w-flow.tech/webhook/…</code>).</li>
  <li>Schalten Sie <strong>Always listen</strong> ein, damit die URL jederzeit Einsendungen annimmt — nicht nur während Sie testen.</li>
  <li>Optional, aber empfohlen: Setzen Sie ein <strong>Secret</strong>. Ihr Formular muss es dann im Header <code>X-W-Flow-Secret</code> mitsenden, damit niemand sonst Ihre Tabelle füllen kann.</li>
  <li>Tragen Sie in Ihrem Formular-Tool die kopierte Adresse als Webhook-/Ziel-URL ein, Methode <code>POST</code>, als JSON oder Formulardaten.</li>
</ol>

<h2>Schritt 5 — Testen</h2>
<p>Drücken Sie im Editor auf <strong>Run</strong> und senden Sie das Formular einmal ab. Die <strong>Log-Konsole</strong> zeigt Eingabe und Ausgabe jedes Nodes; in der Tabelle erscheint eine neue Zeile und Slack meldet sich im Kanal. Schlägt ein Node fehl, nennt das Log das genaue Feld und einen Fehlercode.</p>

<h2>Ideen zum Erweitern</h2>
<ul>
  <li>Mit einer <strong>IF Condition</strong> nur dann Slack benachrichtigen, wenn die Nachricht „Preis“ enthält oder von einer Firmen-Domain kommt.</li>
  <li>Dem Absender automatisch mit <strong>Gmail — Send Email</strong> antworten.</li>
  <li>Die Anfrage vor dem Speichern von einem KI-Node (<strong>Extract Structured Data</strong>) einordnen lassen.</li>
</ul>`,
    },
  },

  {
    slug: "rss-to-telegram",
    updated: "2026-09-26",
    en: {
      title: "Post new RSS articles to Telegram automatically",
      description:
        "Watch any blog, news site or YouTube channel and post every new article to a Telegram chat or channel — a free, no-code RSS to Telegram bot.",
      body: `
<p>Want every new post of a blog, a news site or a YouTube channel in your Telegram chat or channel — without checking it yourself? This workflow watches an RSS feed and sends each new article as a Telegram message.</p>

<h2>What you need</h2>
<ul>
  <li>A free W flow account.</li>
  <li>The feed address (RSS or Atom). Most blogs have one at <code>/feed</code> or <code>/rss</code>; YouTube channels at <code>https://www.youtube.com/feeds/videos.xml?channel_id=…</code>.</li>
  <li>A Telegram bot: open Telegram, write to <strong>@BotFather</strong>, send <code>/newbot</code> and follow the steps. You get a <strong>bot token</strong>.</li>
  <li>The <strong>chat ID</strong>: for a channel, add the bot as admin and use <code>@yourchannel</code>; for a private chat, write to your bot once and look up the ID with a bot like <strong>@userinfobot</strong>.</li>
</ul>

<h2>Step 1 — The trigger: RSS Feed — New Item</h2>
<ol>
  <li>Create a new workflow and add the trigger <strong>RSS Feed — New Item</strong>.</li>
  <li>Paste the feed URL and choose how often to check (<strong>poll interval</strong> in minutes, e.g. <code>15</code>).</li>
</ol>
<p>The server checks the feed on its own — you do not need to keep the editor open. The first check after saving only remembers what is already there, so old articles are never posted; from then on every new article triggers the workflow.</p>

<h2>Step 2 — One message per article: Split Out</h2>
<p>A single check can find several new articles at once. They arrive as a list called <code>items</code>. Add a <strong>Split Out</strong> node after the trigger and set <strong>Field</strong> to <code>items</code> — now every article travels on as its own item with <code>title</code>, <code>link</code> and <code>description</code>.</p>

<h2>Step 3 — Send it: Telegram Bot</h2>
<ol>
  <li>Add a <strong>Telegram Bot</strong> node after Split Out.</li>
  <li>Paste the <strong>bot token</strong> and the <strong>chat ID</strong>.</li>
  <li>Write the <strong>message text</strong>, for example:<br><code>📰 {{title}}<br>{{link}}</code></li>
</ol>

<h2>Step 4 — Test and save</h2>
<p>Press <strong>Run</strong>: the trigger fires with a sample article, so you can check the message format right away. Then save the workflow — from now on it runs by itself. Every automatic run appears under <strong>Executions</strong> with its full log.</p>

<h2>Variations</h2>
<ul>
  <li>Add a <strong>Filter</strong> node to only forward articles whose title contains a keyword.</li>
  <li>Let an AI node summarise each article in one sentence before posting.</li>
  <li>Send to Slack, Discord or e-mail instead — just swap the last node.</li>
</ul>`,
    },
    de: {
      title: "Neue RSS-Artikel automatisch an Telegram senden",
      description:
        "Jeden Blog, jede Nachrichtenseite oder jeden YouTube-Kanal beobachten und neue Beiträge automatisch in einen Telegram-Chat oder -Kanal posten — kostenlos und ohne Code.",
      body: `
<p>Sie möchten jeden neuen Beitrag eines Blogs, einer Nachrichtenseite oder eines YouTube-Kanals in Ihrem Telegram-Chat oder -Kanal haben — ohne selbst nachzusehen? Dieser Workflow beobachtet einen RSS-Feed und sendet jeden neuen Artikel als Telegram-Nachricht.</p>

<h2>Was Sie brauchen</h2>
<ul>
  <li>Ein kostenloses W-flow-Konto.</li>
  <li>Die Feed-Adresse (RSS oder Atom). Die meisten Blogs haben eine unter <code>/feed</code> oder <code>/rss</code>; YouTube-Kanäle unter <code>https://www.youtube.com/feeds/videos.xml?channel_id=…</code>.</li>
  <li>Einen Telegram-Bot: Schreiben Sie in Telegram an <strong>@BotFather</strong>, senden Sie <code>/newbot</code> und folgen Sie den Schritten. Sie erhalten ein <strong>Bot-Token</strong>.</li>
  <li>Die <strong>Chat-ID</strong>: Für einen Kanal den Bot als Admin hinzufügen und <code>@ihrkanal</code> verwenden; für einen privaten Chat einmal an Ihren Bot schreiben und die ID z. B. mit <strong>@userinfobot</strong> nachsehen.</li>
</ul>

<h2>Schritt 1 — Der Auslöser: RSS Feed — New Item</h2>
<ol>
  <li>Legen Sie einen neuen Workflow an und fügen Sie den Trigger <strong>RSS Feed — New Item</strong> hinzu.</li>
  <li>Fügen Sie die Feed-URL ein und wählen Sie, wie oft geprüft wird (<strong>Poll interval</strong> in Minuten, z. B. <code>15</code>).</li>
</ol>
<p>Der Server prüft den Feed selbstständig — der Editor muss nicht geöffnet bleiben. Die erste Prüfung nach dem Speichern merkt sich nur den aktuellen Stand, alte Artikel werden also nie gepostet; danach löst jeder neue Artikel den Workflow aus.</p>

<h2>Schritt 2 — Eine Nachricht pro Artikel: Split Out</h2>
<p>Eine Prüfung kann mehrere neue Artikel auf einmal finden. Sie kommen als Liste namens <code>items</code> an. Fügen Sie nach dem Trigger einen Node <strong>Split Out</strong> hinzu und setzen Sie <strong>Field</strong> auf <code>items</code> — jetzt läuft jeder Artikel als eigenes Element mit <code>title</code>, <code>link</code> und <code>description</code> weiter.</p>

<h2>Schritt 3 — Senden: Telegram Bot</h2>
<ol>
  <li>Fügen Sie nach Split Out einen Node <strong>Telegram Bot</strong> hinzu.</li>
  <li>Tragen Sie <strong>Bot-Token</strong> und <strong>Chat-ID</strong> ein.</li>
  <li>Schreiben Sie den <strong>Nachrichtentext</strong>, zum Beispiel:<br><code>📰 {{title}}<br>{{link}}</code></li>
</ol>

<h2>Schritt 4 — Testen und speichern</h2>
<p>Drücken Sie auf <strong>Run</strong>: Der Trigger feuert mit einem Beispielartikel, sodass Sie das Format der Nachricht sofort prüfen können. Speichern Sie dann den Workflow — ab jetzt läuft er von allein. Jeder automatische Lauf erscheint unter <strong>Executions</strong> mit vollständigem Log.</p>

<h2>Varianten</h2>
<ul>
  <li>Mit einem <strong>Filter</strong>-Node nur Artikel weiterleiten, deren Titel ein Stichwort enthält.</li>
  <li>Jeden Artikel vor dem Posten von einem KI-Node in einem Satz zusammenfassen lassen.</li>
  <li>Stattdessen an Slack, Discord oder per E-Mail senden — einfach den letzten Node tauschen.</li>
</ul>`,
    },
  },

  {
    slug: "daily-email-digest-gmail",
    updated: "2026-09-26",
    en: {
      title: "Get a daily e-mail digest of any RSS feed with Gmail",
      description:
        "Collect the newest articles of a feed every morning and mail them to yourself as one tidy digest from your own Gmail account — no password needed.",
      body: `
<p>Instead of a notification for every article, one e-mail each morning with the list of new posts. This guide uses the ready-made template <em>Daily RSS digest by e-mail</em> and sends from your own Gmail address.</p>

<h2>What you need</h2>
<ul>
  <li>A free W flow account.</li>
  <li>A Google account (Gmail).</li>
  <li>The feed you want to follow — the template starts with Hacker News.</li>
</ul>

<h2>Step 1 — Start from the template</h2>
<p>Open <strong>Workflows → Templates</strong> and choose <strong>Daily RSS digest by e-mail</strong>. It has four nodes:</p>
<ol>
  <li><strong>Schedule (Cron)</strong> — fires every weekday at 8:00 (<code>0 8 * * 1-5</code>).</li>
  <li><strong>RSS — Read Feed</strong> — reads the newest 15 articles.</li>
  <li><strong>Code (JS)</strong> — turns them into a numbered list and a subject line.</li>
  <li><strong>Gmail — Send Email</strong> — mails the digest.</li>
</ol>

<h2>Step 2 — Choose your feed and time</h2>
<ul>
  <li>In <strong>RSS — Read Feed</strong>, replace the URL with your feed and set how many articles to include.</li>
  <li>In <strong>Schedule</strong>, change the cron expression if you like: <code>0 7 * * *</code> is every day at 7:00, <code>0 18 * * 5</code> every Friday at 18:00. Set <strong>Timezone</strong> (e.g. <code>Europe/Berlin</code>) so the time matches yours.</li>
</ul>

<h2>Step 3 — Connect Gmail (no password)</h2>
<ol>
  <li>Click the <strong>Gmail — Send Email</strong> node.</li>
  <li>Click <strong>Connect Google</strong> next to <strong>Google account</strong> and allow W flow to send e-mail. Your Gmail password is never entered in W flow — Google hands over a revocable permission, stored encrypted.</li>
  <li>Fill in <strong>To</strong> with your address. <strong>Subject</strong> and <strong>Message</strong> already use the digest built by the Code node (<code>{{subject}}</code>, <code>{{digest}}</code>).</li>
</ol>

<h2>Step 4 — Test and save</h2>
<p>Press <strong>Run</strong> to send one digest right now and check your inbox. Save the workflow; from then on the server sends it on schedule, whether or not you are logged in. Each run is listed under <strong>Executions</strong>.</p>

<h2>Make it yours</h2>
<ul>
  <li>Several feeds: add more <strong>RSS — Read Feed</strong> nodes and join them with <strong>Merge</strong>.</li>
  <li>Let an AI node write a three-sentence summary on top of the list.</li>
  <li>Switch <strong>Message is HTML</strong> on and build a formatted newsletter in the Code node.</li>
</ul>`,
    },
    de: {
      title: "Täglicher E-Mail-Überblick aus jedem RSS-Feed mit Gmail",
      description:
        "Jeden Morgen die neuesten Artikel eines Feeds sammeln und als übersichtliche Zusammenfassung vom eigenen Gmail-Konto an sich selbst senden — ohne Passwort.",
      body: `
<p>Statt einer Benachrichtigung pro Artikel eine E-Mail am Morgen mit der Liste der neuen Beiträge. Diese Anleitung nutzt die fertige Vorlage <em>Daily RSS digest by e-mail</em> und sendet von Ihrer eigenen Gmail-Adresse.</p>

<h2>Was Sie brauchen</h2>
<ul>
  <li>Ein kostenloses W-flow-Konto.</li>
  <li>Ein Google-Konto (Gmail).</li>
  <li>Den Feed, dem Sie folgen möchten — die Vorlage startet mit Hacker News.</li>
</ul>

<h2>Schritt 1 — Mit der Vorlage starten</h2>
<p>Öffnen Sie <strong>Workflows → Templates</strong> und wählen Sie <strong>Daily RSS digest by e-mail</strong>. Sie besteht aus vier Nodes:</p>
<ol>
  <li><strong>Schedule (Cron)</strong> — löst werktags um 8:00 Uhr aus (<code>0 8 * * 1-5</code>).</li>
  <li><strong>RSS — Read Feed</strong> — liest die neuesten 15 Artikel.</li>
  <li><strong>Code (JS)</strong> — macht daraus eine nummerierte Liste und eine Betreffzeile.</li>
  <li><strong>Gmail — Send Email</strong> — versendet die Zusammenfassung.</li>
</ol>

<h2>Schritt 2 — Feed und Uhrzeit wählen</h2>
<ul>
  <li>Ersetzen Sie in <strong>RSS — Read Feed</strong> die URL durch Ihren Feed und legen Sie fest, wie viele Artikel enthalten sein sollen.</li>
  <li>Ändern Sie in <strong>Schedule</strong> bei Bedarf den Cron-Ausdruck: <code>0 7 * * *</code> ist täglich um 7:00 Uhr, <code>0 18 * * 5</code> jeden Freitag um 18:00 Uhr. Setzen Sie die <strong>Timezone</strong> (z. B. <code>Europe/Berlin</code>), damit die Uhrzeit stimmt.</li>
</ul>

<h2>Schritt 3 — Gmail verbinden (ohne Passwort)</h2>
<ol>
  <li>Klicken Sie auf den Node <strong>Gmail — Send Email</strong>.</li>
  <li>Klicken Sie neben <strong>Google account</strong> auf <strong>Connect Google</strong> und erlauben Sie W flow, E-Mails zu senden. Ihr Gmail-Passwort wird nie in W flow eingegeben — Google erteilt eine widerrufbare Berechtigung, die verschlüsselt gespeichert wird.</li>
  <li>Tragen Sie bei <strong>To</strong> Ihre Adresse ein. <strong>Subject</strong> und <strong>Message</strong> verwenden bereits die vom Code-Node erstellte Zusammenfassung (<code>{{subject}}</code>, <code>{{digest}}</code>).</li>
</ol>

<h2>Schritt 4 — Testen und speichern</h2>
<p>Drücken Sie auf <strong>Run</strong>, um sofort eine Zusammenfassung zu senden, und sehen Sie in Ihr Postfach. Speichern Sie den Workflow; danach sendet der Server ihn nach Zeitplan — egal, ob Sie angemeldet sind. Jeder Lauf erscheint unter <strong>Executions</strong>.</p>

<h2>Anpassen</h2>
<ul>
  <li>Mehrere Feeds: weitere <strong>RSS — Read Feed</strong>-Nodes hinzufügen und mit <strong>Merge</strong> zusammenführen.</li>
  <li>Einen KI-Node über der Liste eine Zusammenfassung in drei Sätzen schreiben lassen.</li>
  <li><strong>Message is HTML</strong> einschalten und im Code-Node einen formatierten Newsletter bauen.</li>
</ul>`,
    },
  },

  {
    slug: "n8n-vs-zapier-vs-make",
    updated: "2026-09-26",
    en: {
      title: "n8n vs Zapier vs Make vs W flow: which automation tool fits you?",
      description:
        "An honest comparison of the popular workflow automation tools — hosting, pricing model, AI features, integrations and who each one is best for.",
      body: `
<p>Zapier, Make and n8n are the best-known tools for connecting apps and automating work. W flow is a newer alternative. They overlap a lot, but differ in where they run, how you pay and how much control you get. Here is an honest overview.</p>

<h2>At a glance</h2>
<div class="table-wrap"><table>
<thead><tr><th></th><th>Zapier</th><th>Make</th><th>n8n</th><th>W flow</th></tr></thead>
<tbody>
<tr><td>Where it runs</td><td>Cloud only</td><td>Cloud only</td><td>Cloud or self-hosted</td><td>Cloud or self-hosted</td></tr>
<tr><td>Editor style</td><td>Step list</td><td>Visual canvas</td><td>Visual canvas</td><td>Visual canvas</td></tr>
<tr><td>Integrations</td><td>Largest catalogue (thousands of apps)</td><td>Very large</td><td>Large, plus community nodes</td><td>400+ node types, plus generic HTTP</td></tr>
<tr><td>Pricing model</td><td>Per task</td><td>Per operation</td><td>Per execution (cloud); self-hosting under its own license</td><td>Free plan with limits; Pro for unlimited use and self-hosting</td></tr>
<tr><td>AI</td><td>AI steps and agents</td><td>AI modules</td><td>AI agent nodes (LangChain-based)</td><td>AI agents, chat, extraction, embeddings — with your own model and key</td></tr>
<tr><td>Code when you need it</td><td>Limited</td><td>Limited</td><td>JavaScript / Python</td><td>JavaScript node</td></tr>
</tbody></table></div>
<p class="note">Features and prices change often — check each vendor's website for the current details.</p>

<h2>Zapier — easiest start, biggest catalogue</h2>
<p>Zapier connects more apps than anyone else and is the easiest to learn: pick a trigger, add steps, done. The trade-offs are cost at higher volumes (every step of every run counts as a task), linear flows that get awkward with lots of branching, and no way to run it on your own server.</p>
<p><strong>Best for:</strong> non-technical teams who need a niche app connected quickly.</p>

<h2>Make — visual and powerful</h2>
<p>Make (formerly Integromat) shows scenarios on a visual canvas with routers, iterators and detailed data mapping. It is usually cheaper than Zapier for complex flows, but also cloud only, and its operation-based pricing takes some getting used to.</p>
<p><strong>Best for:</strong> people who like visual building and complex data handling, and are happy in the cloud.</p>

<h2>n8n — developer-friendly and self-hostable</h2>
<p>n8n is a node-based editor you can run on your own server. It is popular with developers: code nodes, strong AI-agent features and full control over data. Self-hosting means you run updates, backups and security yourself; its license is “fair-code” rather than classic open source.</p>
<p><strong>Best for:</strong> technical teams who want full control and do not mind operating it.</p>

<h2>W flow — cloud or your own server, with your own AI</h2>
<p>W flow is a visual workflow and AI agent builder you can use as a hosted workspace or run on your own machine. What sets it apart:</p>
<ul>
  <li><strong>Bring your own model</strong> — OpenAI-compatible, Anthropic, Gemini, local or custom endpoints; no AI markup.</li>
  <li><strong>One-click Google and Microsoft sign-in</strong> on the nodes instead of pasting passwords or tokens.</li>
  <li><strong>Inspectable runs</strong> — input, output, duration and a classified error code for every node.</li>
  <li><strong>Encrypted credentials</strong> in your own database (SQLite or PostgreSQL) when self-hosted.</li>
</ul>
<p>W flow is in open beta: its catalogue is smaller than Zapier's and some triggers still run with sample data. The generic <strong>HTTP Request</strong> node covers most APIs that have no dedicated node yet.</p>
<p><strong>Best for:</strong> individuals and small teams who want a visual builder with strong AI features, and the option to move to their own server later.</p>

<h2>How to decide</h2>
<ul>
  <li>Need a rare app connected in five minutes? → <strong>Zapier</strong>.</li>
  <li>Complex data transformations, happy with cloud? → <strong>Make</strong>.</li>
  <li>Developer team, want to self-host and extend with code? → <strong>n8n</strong>.</li>
  <li>Visual builder + your own AI models, cloud now and self-hosted later? → <strong>W flow</strong>.</li>
</ul>`,
    },
    de: {
      title: "n8n vs. Zapier vs. Make vs. W flow: Welches Automatisierungs-Tool passt zu Ihnen?",
      description:
        "Ein ehrlicher Vergleich der bekannten Workflow-Automatisierungs-Tools — Hosting, Preismodell, KI-Funktionen, Integrationen und für wen sich welches eignet.",
      body: `
<p>Zapier, Make und n8n sind die bekanntesten Tools, um Apps zu verbinden und Arbeit zu automatisieren. W flow ist eine neuere Alternative. Sie überschneiden sich stark, unterscheiden sich aber darin, wo sie laufen, wie man bezahlt und wie viel Kontrolle man hat. Hier ein ehrlicher Überblick.</p>

<h2>Auf einen Blick</h2>
<div class="table-wrap"><table>
<thead><tr><th></th><th>Zapier</th><th>Make</th><th>n8n</th><th>W flow</th></tr></thead>
<tbody>
<tr><td>Betrieb</td><td>Nur Cloud</td><td>Nur Cloud</td><td>Cloud oder selbst gehostet</td><td>Cloud oder selbst gehostet</td></tr>
<tr><td>Editor</td><td>Schrittliste</td><td>Visuelle Arbeitsfläche</td><td>Visuelle Arbeitsfläche</td><td>Visuelle Arbeitsfläche</td></tr>
<tr><td>Integrationen</td><td>Größter Katalog (Tausende Apps)</td><td>Sehr groß</td><td>Groß, plus Community-Nodes</td><td>400+ Node-Typen, plus generischer HTTP-Node</td></tr>
<tr><td>Preismodell</td><td>Pro Task</td><td>Pro Operation</td><td>Pro Ausführung (Cloud); Self-Hosting unter eigener Lizenz</td><td>Kostenloser Plan mit Limits; Pro für unbegrenzte Nutzung und Self-Hosting</td></tr>
<tr><td>KI</td><td>KI-Schritte und Agenten</td><td>KI-Module</td><td>KI-Agent-Nodes (LangChain-basiert)</td><td>KI-Agenten, Chat, Extraktion, Embeddings — mit eigenem Modell und Schlüssel</td></tr>
<tr><td>Code bei Bedarf</td><td>Eingeschränkt</td><td>Eingeschränkt</td><td>JavaScript / Python</td><td>JavaScript-Node</td></tr>
</tbody></table></div>
<p class="note">Funktionen und Preise ändern sich häufig — aktuelle Details finden Sie auf den Websites der Anbieter.</p>

<h2>Zapier — einfachster Einstieg, größter Katalog</h2>
<p>Zapier verbindet mehr Apps als jeder andere und ist am leichtesten zu lernen: Trigger wählen, Schritte hinzufügen, fertig. Die Nachteile: hohe Kosten bei viel Volumen (jeder Schritt jedes Laufs zählt als Task), lineare Abläufe, die bei vielen Verzweigungen unhandlich werden, und kein Betrieb auf dem eigenen Server.</p>
<p><strong>Ideal für:</strong> nicht-technische Teams, die schnell eine Nischen-App anbinden müssen.</p>

<h2>Make — visuell und mächtig</h2>
<p>Make (früher Integromat) zeigt Szenarien auf einer visuellen Arbeitsfläche mit Routern, Iteratoren und detailliertem Daten-Mapping. Für komplexe Abläufe meist günstiger als Zapier, aber ebenfalls nur in der Cloud, und das Preismodell pro Operation braucht etwas Eingewöhnung.</p>
<p><strong>Ideal für:</strong> alle, die visuell bauen und komplexe Daten verarbeiten möchten und mit der Cloud zufrieden sind.</p>

<h2>n8n — entwicklerfreundlich und selbst hostbar</h2>
<p>n8n ist ein Node-basierter Editor, den Sie auf Ihrem eigenen Server betreiben können. Bei Entwicklern beliebt: Code-Nodes, starke KI-Agent-Funktionen und volle Kontrolle über die Daten. Self-Hosting heißt, dass Sie Updates, Backups und Sicherheit selbst übernehmen; die Lizenz ist „Fair-Code“, nicht klassisches Open Source.</p>
<p><strong>Ideal für:</strong> technische Teams, die volle Kontrolle wollen und den Betrieb nicht scheuen.</p>

<h2>W flow — Cloud oder eigener Server, mit eigener KI</h2>
<p>W flow ist ein visueller Workflow- und KI-Agent-Builder, den Sie als gehosteten Workspace nutzen oder auf Ihrem eigenen Rechner betreiben können. Das Besondere:</p>
<ul>
  <li><strong>Eigenes Modell</strong> — OpenAI-kompatibel, Anthropic, Gemini, lokal oder eigener Endpunkt; kein KI-Aufschlag.</li>
  <li><strong>Google- und Microsoft-Anmeldung per Klick</strong> in den Nodes, statt Passwörter oder Tokens einzufügen.</li>
  <li><strong>Nachvollziehbare Läufe</strong> — Eingabe, Ausgabe, Dauer und ein eingeordneter Fehlercode für jeden Node.</li>
  <li><strong>Verschlüsselte Zugangsdaten</strong> in Ihrer eigenen Datenbank (SQLite oder PostgreSQL), wenn selbst gehostet.</li>
</ul>
<p>W flow ist in der offenen Beta: Der Katalog ist kleiner als der von Zapier, und manche Trigger laufen noch mit Beispieldaten. Der generische Node <strong>HTTP Request</strong> deckt die meisten APIs ab, für die es noch keinen eigenen Node gibt.</p>
<p><strong>Ideal für:</strong> Einzelpersonen und kleine Teams, die einen visuellen Builder mit starken KI-Funktionen wollen — und später auf den eigenen Server wechseln möchten.</p>

<h2>So entscheiden Sie</h2>
<ul>
  <li>Eine seltene App in fünf Minuten anbinden? → <strong>Zapier</strong>.</li>
  <li>Komplexe Datenumwandlungen, Cloud ist in Ordnung? → <strong>Make</strong>.</li>
  <li>Entwicklerteam, selbst hosten und mit Code erweitern? → <strong>n8n</strong>.</li>
  <li>Visueller Builder + eigene KI-Modelle, jetzt Cloud und später selbst gehostet? → <strong>W flow</strong>.</li>
</ul>`,
    },
  },

  {
    slug: "self-hosted-zapier-alternative",
    updated: "2026-09-26",
    en: {
      title: "A self-hosted Zapier alternative: run your automations on your own server",
      description:
        "Why teams move automations to their own server, what to look for, and how to run W flow on your own machine with your own database and encryption key.",
      body: `
<p>Cloud automation tools are convenient — until your customer data, API keys and every run log sit on someone else's servers, and your bill grows with every task. A self-hosted workflow tool runs on a machine you control. Here is what that means and how to do it with W flow.</p>

<h2>Why self-host your automations?</h2>
<ul>
  <li><strong>Data stays with you.</strong> Payloads, run logs and credentials never leave your server — important for personal data under the GDPR.</li>
  <li><strong>Predictable cost.</strong> No per-task pricing; a small server handles thousands of runs a day.</li>
  <li><strong>Reach internal systems.</strong> Databases, intranet APIs and files on your network, without opening them to the internet.</li>
  <li><strong>No lock-in.</strong> Workflows are plain JSON you can export, version and move.</li>
</ul>

<h2>What to look for</h2>
<ul>
  <li>A visual editor your team can actually use, not just a config file.</li>
  <li>Encrypted credential storage and per-user separation.</li>
  <li>Webhooks, schedules and feed triggers that run without the editor open.</li>
  <li>Clear run logs and error messages — you are the support team now.</li>
  <li>Backups and an easy update path.</li>
</ul>

<h2>Option 1 — Start in the cloud, move later</h2>
<p>You do not have to decide on day one. Create a free account at <a href="https://w-flow.tech">w-flow.tech</a>, build and test your workflows in the hosted workspace, and move them to your own server when you are ready: <strong>Workflow settings → Export JSON</strong>, then import on the new install. Credentials are never exported, so you re-enter each key once on your server, where it is encrypted with your own key.</p>

<h2>Option 2 — Run W flow on your own machine</h2>
<p>With a <strong>Pro</strong> account, the welcome page offers a one-file installer for <strong>Windows, macOS and Linux</strong>:</p>
<ol>
  <li>Log in, open the welcome page and choose <strong>Self-hosted version</strong>.</li>
  <li>Download the installer for your operating system and run it on the machine that should host W flow.</li>
  <li>Answer the setup questions — where the copy lives and where workflows and credentials are stored.</li>
  <li>Open the local address it shows. You now have your own W flow with its own database (SQLite by default, PostgreSQL optional) and its own encryption key.</li>
</ol>
<p>For a server that runs around the clock, a small VPS with Docker works well; W flow ships a <code>Dockerfile</code> and a Caddy setup for automatic HTTPS.</p>

<h2>Running it well</h2>
<ul>
  <li><strong>Back up the data folder</strong> — it holds the database <em>and</em> the encryption key. Without the key, stored credentials cannot be read.</li>
  <li>Put it behind HTTPS before exposing webhooks to the internet.</li>
  <li>Keep the admin panel reachable only from your own network.</li>
</ul>`,
    },
    de: {
      title: "Selbst gehostete Zapier-Alternative: Automatisierungen auf dem eigenen Server",
      description:
        "Warum Teams ihre Automatisierungen auf den eigenen Server holen, worauf es ankommt und wie Sie W flow auf Ihrem eigenen Rechner mit eigener Datenbank und eigenem Schlüssel betreiben.",
      body: `
<p>Cloud-Automatisierung ist bequem — bis Kundendaten, API-Schlüssel und jedes Lauf-Log auf fremden Servern liegen und die Rechnung mit jedem Task wächst. Ein selbst gehostetes Workflow-Tool läuft auf einem Rechner, den Sie kontrollieren. Das bedeutet es — und so geht es mit W flow.</p>

<h2>Warum Automatisierungen selbst hosten?</h2>
<ul>
  <li><strong>Die Daten bleiben bei Ihnen.</strong> Nutzdaten, Lauf-Logs und Zugangsdaten verlassen Ihren Server nie — wichtig für personenbezogene Daten nach der DSGVO.</li>
  <li><strong>Planbare Kosten.</strong> Keine Abrechnung pro Task; ein kleiner Server schafft Tausende Läufe am Tag.</li>
  <li><strong>Interne Systeme erreichen.</strong> Datenbanken, Intranet-APIs und Dateien im eigenen Netz, ohne sie ins Internet zu öffnen.</li>
  <li><strong>Kein Lock-in.</strong> Workflows sind einfaches JSON, das Sie exportieren, versionieren und umziehen können.</li>
</ul>

<h2>Worauf Sie achten sollten</h2>
<ul>
  <li>Ein visueller Editor, den Ihr Team wirklich nutzt — nicht nur eine Konfigurationsdatei.</li>
  <li>Verschlüsselte Zugangsdaten und Trennung pro Benutzer.</li>
  <li>Webhooks, Zeitpläne und Feed-Trigger, die ohne geöffneten Editor laufen.</li>
  <li>Klare Lauf-Logs und Fehlermeldungen — Sie sind jetzt selbst der Support.</li>
  <li>Backups und ein einfacher Update-Weg.</li>
</ul>

<h2>Weg 1 — In der Cloud starten, später umziehen</h2>
<p>Sie müssen sich nicht sofort entscheiden. Legen Sie ein kostenloses Konto auf <a href="https://w-flow.tech">w-flow.tech</a> an, bauen und testen Sie Ihre Workflows im gehosteten Workspace und ziehen Sie sie auf Ihren eigenen Server um, sobald Sie bereit sind: <strong>Workflow settings → Export JSON</strong>, dann in der neuen Installation importieren. Zugangsdaten werden nie exportiert — Sie geben jeden Schlüssel einmal auf Ihrem Server ein, wo er mit Ihrem eigenen Schlüssel verschlüsselt wird.</p>

<h2>Weg 2 — W flow auf dem eigenen Rechner betreiben</h2>
<p>Mit einem <strong>Pro</strong>-Konto bietet die Startseite einen Ein-Datei-Installer für <strong>Windows, macOS und Linux</strong>:</p>
<ol>
  <li>Melden Sie sich an, öffnen Sie die Startseite und wählen Sie <strong>Self-hosted version</strong>.</li>
  <li>Laden Sie den Installer für Ihr Betriebssystem herunter und führen Sie ihn auf dem Rechner aus, der W flow betreiben soll.</li>
  <li>Beantworten Sie die Einrichtungsfragen — wo die Kopie liegt und wo Workflows und Zugangsdaten gespeichert werden.</li>
  <li>Öffnen Sie die angezeigte lokale Adresse. Sie haben jetzt Ihr eigenes W flow mit eigener Datenbank (standardmäßig SQLite, optional PostgreSQL) und eigenem Verschlüsselungsschlüssel.</li>
</ol>
<p>Für einen Server, der rund um die Uhr läuft, eignet sich ein kleiner VPS mit Docker; W flow bringt ein <code>Dockerfile</code> und eine Caddy-Konfiguration für automatisches HTTPS mit.</p>

<h2>Gut betreiben</h2>
<ul>
  <li><strong>Sichern Sie den Datenordner</strong> — er enthält die Datenbank <em>und</em> den Verschlüsselungsschlüssel. Ohne den Schlüssel sind gespeicherte Zugangsdaten nicht mehr lesbar.</li>
  <li>Stellen Sie HTTPS vor, bevor Sie Webhooks ins Internet öffnen.</li>
  <li>Machen Sie das Admin-Panel nur aus Ihrem eigenen Netz erreichbar.</li>
</ul>`,
    },
  },
];

// ---- page chrome ----

const UI = {
  en: {
    guides: "Guides",
    indexTitle: "W flow guides — workflow automation how-tos",
    indexDescription:
      "Step-by-step guides for workflow automation with W flow: forms to Google Sheets, RSS to Telegram, Gmail digests, tool comparisons and self-hosting.",
    indexH1: "Guides",
    indexIntro: "Step-by-step how-tos for automating everyday work with W flow — each one takes about ten minutes.",
    read: "Read the guide →",
    updated: "Updated",
    ctaTitle: "Try it yourself",
    ctaText: "Create a free W flow account and build this workflow in a few minutes.",
    ctaButton: "Start free",
    back: "← All guides",
    app: "Open W flow",
    other: "Deutsch",
    beta: "W flow is in open beta. Report a bug that helps us and get a free month of Pro once Pro launches.",
  },
  de: {
    guides: "Anleitungen",
    indexTitle: "W-flow-Anleitungen — Workflow-Automatisierung Schritt für Schritt",
    indexDescription:
      "Schritt-für-Schritt-Anleitungen zur Workflow-Automatisierung mit W flow: Formulare in Google Sheets, RSS an Telegram, Gmail-Zusammenfassungen, Tool-Vergleiche und Self-Hosting.",
    indexH1: "Anleitungen",
    indexIntro: "Schritt-für-Schritt-Anleitungen, um Alltagsarbeit mit W flow zu automatisieren — jede dauert etwa zehn Minuten.",
    read: "Zur Anleitung →",
    updated: "Aktualisiert",
    ctaTitle: "Selbst ausprobieren",
    ctaText: "Legen Sie ein kostenloses W-flow-Konto an und bauen Sie diesen Workflow in wenigen Minuten.",
    ctaButton: "Kostenlos starten",
    back: "← Alle Anleitungen",
    app: "W flow öffnen",
    other: "English",
    beta: "W flow ist in der offenen Beta. Melde einen Fehler, der uns hilft, und erhalte einen Monat Pro gratis, sobald Pro startet.",
  },
};

const LANGS = ["en", "de"];
const basePath = (lang) => (lang === "de" ? "/de/guides" : "/guides");
export const guidePath = (lang, slug) => `${basePath(lang)}${slug ? `/${slug}` : ""}`;

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const CSS = `
:root{--bg:#0a0f1d;--panel:#111a2e;--line:#22304f;--ink:#e6ecff;--dim:#a9b6d0;--faint:#6a7897;--blue:#6f8cff;--amber:#ffb84d}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--blue)}
header.site{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--line)}
header.site .brand{color:var(--ink);text-decoration:none;font-weight:700;letter-spacing:1px}
header.site .brand span{color:var(--blue)}
header.site nav{display:flex;gap:14px;margin-left:auto;font-size:14px;flex-wrap:wrap}
header.site nav a{text-decoration:none}
.beta{background:rgba(255,184,77,.12);border-bottom:1px solid rgba(255,184,77,.4);color:var(--amber);font-size:13px;padding:6px 20px;text-align:center}
main{max-width:780px;margin:0 auto;padding:36px 20px 60px}
h1{font-size:34px;line-height:1.2;margin:0 0 12px}
h2{font-size:22px;margin:36px 0 10px}
p.lede{color:var(--dim);font-size:18px}
p.meta{color:var(--faint);font-size:13px;margin:0 0 20px}
code{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:1px 5px;font-size:.9em;word-break:break-word}
li{margin:4px 0}
.table-wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px;margin:12px 0}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:var(--panel)}
td:first-child{color:var(--dim);white-space:nowrap}
p.note{color:var(--faint);font-size:13px}
.cards{display:grid;gap:14px;margin-top:24px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px}
.card h2{font-size:19px;margin:0 0 6px}
.card h2 a{color:var(--ink);text-decoration:none}
.card p{color:var(--dim);margin:0 0 10px;font-size:15px}
.cta{margin-top:44px;background:var(--panel);border:1px solid var(--blue);border-radius:12px;padding:20px 22px}
.cta h2{margin:0 0 6px;font-size:20px}
.cta p{margin:0 0 14px;color:var(--dim)}
.btn{display:inline-block;background:var(--blue);color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}
footer.site{border-top:1px solid var(--line);padding:18px 20px;color:var(--faint);font-size:13px;text-align:center}
footer.site a{color:var(--dim)}
@media (max-width:600px){h1{font-size:27px}main{padding-top:24px}}
`;

function page({ lang, title, description, canonicalPath, alternates, body, domain, jsonLd, legalHidden, beta }) {
  const t = UI[lang];
  const origin = domain ? `https://${domain}` : "";
  const other = lang === "en" ? "de" : "en";
  const links = [
    origin ? `<link rel="canonical" href="${esc(origin + canonicalPath)}"/>` : "",
    ...(origin ? LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${esc(origin + alternates[l])}"/>`) : []),
    origin ? `<link rel="alternate" hreflang="x-default" href="${esc(origin + alternates.en)}"/>` : "",
  ].filter(Boolean);
  const legal = legalHidden ? "" : ` · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<meta name="color-scheme" content="dark"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}"/>
<meta name="robots" content="index,follow,max-image-preview:large"/>
${links.join("\n")}
<meta property="og:type" content="article"/>
<meta property="og:site_name" content="W flow"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(description)}"/>
${origin ? `<meta property="og:url" content="${esc(origin + canonicalPath)}"/>\n<meta property="og:image" content="${esc(origin)}/logo.png"/>` : ""}
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"/>
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"/>
<link rel="icon" type="image/png" sizes="192x192" href="/favicon-192.png"/>
<link rel="icon" type="image/png" sizes="64x64" href="/favicon.png"/>
<link rel="apple-touch-icon" href="/apple-touch-icon.png"/>
<style>${CSS}</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body>
<header class="site">
  <a class="brand" href="/">W <span>flow</span></a>
  <nav>
    <a href="${basePath(lang)}">${t.guides}</a>
    <a href="${esc(alternates[other])}" hreflang="${other}">${t.other}</a>
    <a href="/">${t.app}</a>
  </nav>
</header>
${beta ? `<div class="beta">${t.beta}</div>` : ""}
<main>
${body}
</main>
<footer class="site">© ${new Date().getFullYear()} W flow · <a href="/">w-flow.tech</a> · <a href="${basePath(lang)}">${t.guides}</a>${legal}</footer>
</body>
</html>`;
}

function indexBody(lang) {
  const t = UI[lang];
  const cards = GUIDES.map((g) => {
    const c = g[lang];
    return `<article class="card"><h2><a href="${guidePath(lang, g.slug)}">${esc(c.title)}</a></h2><p>${esc(c.description)}</p><a href="${guidePath(lang, g.slug)}">${t.read}</a></article>`;
  }).join("\n");
  return `<h1>${t.indexH1}</h1>\n<p class="lede">${t.indexIntro}</p>\n<div class="cards">\n${cards}\n</div>`;
}

function guideBody(lang, guide) {
  const t = UI[lang];
  const c = guide[lang];
  return `<p class="meta"><a href="${basePath(lang)}">${t.back}</a> · ${t.updated} ${esc(guide.updated)}</p>
<h1>${esc(c.title)}</h1>
<p class="lede">${esc(c.description)}</p>
${c.body}
<section class="cta"><h2>${t.ctaTitle}</h2><p>${t.ctaText}</p><a class="btn" href="${TRY[lang]}">${t.ctaButton}</a></section>`;
}

/** Absolute URLs of every guide page, for the sitemap. */
export function guideUrls() {
  const out = [];
  for (const lang of LANGS) {
    out.push({ path: guidePath(lang), priority: "0.7" });
    for (const g of GUIDES) out.push({ path: guidePath(lang, g.slug), priority: "0.6", lastmod: g.updated });
  }
  return out;
}

/**
 * Express router for /guides and /de/guides. `site()` resolves per request to
 * { domain, legalHidden, beta } so admin changes apply without a restart.
 */
export function guidesRouter(site) {
  const router = express.Router();
  for (const lang of LANGS) {
    router.get(basePath(lang), async (_req, res, next) => {
      try {
        const s = await site();
        const t = UI[lang];
        res.type("html").send(
          page({
            lang,
            title: t.indexTitle,
            description: t.indexDescription,
            canonicalPath: guidePath(lang),
            alternates: { en: guidePath("en"), de: guidePath("de") },
            body: indexBody(lang),
            domain: s.domain,
            legalHidden: s.legalHidden,
            beta: s.beta,
            jsonLd: {
              "@context": "https://schema.org",
              "@type": "CollectionPage",
              name: t.indexTitle,
              inLanguage: lang,
            },
          })
        );
      } catch (err) {
        next(err);
      }
    });
    router.get(`${basePath(lang)}/:slug`, async (req, res, next) => {
      try {
        const guide = GUIDES.find((g) => g.slug === req.params.slug);
        if (!guide) return next();
        const s = await site();
        const c = guide[lang];
        const origin = s.domain ? `https://${s.domain}` : "";
        res.type("html").send(
          page({
            lang,
            title: `${c.title} — W flow`,
            description: c.description,
            canonicalPath: guidePath(lang, guide.slug),
            alternates: { en: guidePath("en", guide.slug), de: guidePath("de", guide.slug) },
            body: guideBody(lang, guide),
            domain: s.domain,
            legalHidden: s.legalHidden,
            beta: s.beta,
            jsonLd: {
              "@context": "https://schema.org",
              "@type": "Article",
              headline: c.title,
              description: c.description,
              inLanguage: lang,
              dateModified: guide.updated,
              ...(origin ? { mainEntityOfPage: origin + guidePath(lang, guide.slug), image: `${origin}/logo.png` } : {}),
              author: { "@type": "Organization", name: "W flow" },
              publisher: { "@type": "Organization", name: "W flow", ...(origin ? { logo: { "@type": "ImageObject", url: `${origin}/logo-square.png` } } : {}) },
            },
          })
        );
      } catch (err) {
        next(err);
      }
    });
  }
  return router;
}

/** Title, description, path and HTML body of every guide in one language (llms.txt). */
export function guideSummaries(lang = "en") {
  return GUIDES.map((g) => ({ ...g[lang], path: guidePath(lang, g.slug) }));
}
