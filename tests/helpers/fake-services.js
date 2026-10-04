// ============================================================================
// Canned service responses for the offline fetch stub.
//
// Pure data (no side effects) shared by tests/helpers/node-harness.js and
// tests/all-nodes.test.js. Each entry is matched by URL substring and must be
// realistic enough that the node's own success checks pass — a node that
// requires `data.id`, `cod: 200` or `status: "success"` needs the stub to
// return one, otherwise its happy path cannot be exercised offline.
// ============================================================================
const FEED_RSS =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><title>First story</title><link>http://localhost/1</link><description>Hello world</description><enclosure url="http://localhost/1.mp3" type="audio/mpeg" length="1234"/></item></channel></rss>';

export const FAKE_RESPONSES = {
  // --- AI providers ---------------------------------------------------------
  "/chat/completions": JSON.stringify({ choices: [{ message: { content: '{"ok": true, "reply": "hello"}' } }], usage: {} }),
  // NOTE: "/v1/messages" (not "/messages") so it cannot shadow other endpoints
  // such as api.pushover.net/1/messages.json.
  "/v1/messages": JSON.stringify({ content: [{ type: "text", text: "Hello from the stub." }], usage: {} }),
  "/embeddings": JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3, 0.4, 0.5], object: "embedding" }], usage: {} }),
  "/images/generations": JSON.stringify({ data: [{ url: "http://localhost/stub.png", revised_prompt: "revised" }] }),
  "/models": JSON.stringify({ data: [{ id: "stub-model" }] }),

  // --- Feeds / search -------------------------------------------------------
  // real RSS/Atom XML so the RSS Read node runs its actual feed parser
  "/feed.xml":
    '<?xml version="1.0"?><rss version="2.0"><channel><title>Test Feed</title><item><title>First story</title><link>http://localhost/1</link><description>Hello world</description><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item><item><title>Second story</title><link>http://localhost/2</link></item></channel></rss>',
  // Atom (several <link>s per entry) for the Feeds & Sources presets that
  // read GitHub / GitLab / YouTube feeds, RSS for the rest. Listed before
  // "reddit.com" so the subreddit feed gets XML, not the search JSON.
  ".atom": '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Test Atom Feed</title><entry><id>tag:test,2026:1</id><title>First entry</title><updated>2026-09-01T10:00:00Z</updated><link rel="alternate" href="http://localhost/entry/1"/><link rel="replies" href="http://localhost/entry/1/replies"/><author><name>alice</name></author></entry></feed>',
  "feeds/videos.xml": '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Test Atom Feed</title><entry><id>tag:test,2026:1</id><title>First entry</title><updated>2026-09-01T10:00:00Z</updated><link rel="alternate" href="http://localhost/entry/1"/><link rel="replies" href="http://localhost/entry/1/replies"/><author><name>alice</name></author></entry></feed>',
  "/.rss": FEED_RSS,
  ".rss": FEED_RSS,
  "hnrss.org": FEED_RSS,
  "bsky.app/profile": FEED_RSS,
  "medium.com/feed": FEED_RSS,
  "substack.com/feed": FEED_RSS,
  "dev.to/feed": FEED_RSS,
  "stackoverflow.com/feeds": FEED_RSS,
  "news.google.com/rss": FEED_RSS,
  "rss.arxiv.org": FEED_RSS,
  "/podcast.xml": FEED_RSS,
  "wordpress.org/news/feed": FEED_RSS,
  "youtube/v3/search": JSON.stringify({
    items: [{ snippet: { title: "Video one", description: "d", channelTitle: "Channel", publishedAt: "2026-01-01T00:00:00Z" }, id: { videoId: "abc123" } }],
  }),
  "hn.algolia.com": JSON.stringify({ hits: [{ title: "Story", objectID: "1", url: "http://localhost/1", points: 5, author: "a", num_comments: 2, created_at: "2026-01-01T00:00:00Z" }] }),
  "wikipedia.org": JSON.stringify({ query: { search: [{ title: "Ada Lovelace", snippet: "<b>Ada</b>", size: 100 }] } }),
  "customsearch/v1": JSON.stringify({ items: [{ title: "Result", link: "http://localhost/1", snippet: "s", displayLink: "localhost" }] }),
  "reddit.com": JSON.stringify({ data: { children: [{ data: { id: "1", title: "Post", author: "a", subreddit: "r", permalink: "/r/r/1", score: 1, num_comments: 0, created_utc: 1, selftext: "" } }] } }),
  "tinyurl.com/api-create.php": "https://tinyurl.com/stub",

  // --- Public data ----------------------------------------------------------
  "api.openweathermap.org": JSON.stringify({
    cod: 200,
    main: { temp: 20, feels_like: 19, humidity: 50, pressure: 1013 },
    weather: [{ description: "clear sky", icon: "01d" }],
    wind: { speed: 3, deg: 180 },
    clouds: { all: 5 },
    sys: { sunrise: 1, sunset: 2 },
    coord: { lat: 1, lon: 2 },
  }),
  "api.coingecko.com": JSON.stringify({ bitcoin: { usd: 65000, usd_24h_change: 1.2 } }),
  // crypto exchange tickers (public, no key)
  "api.coinbase.com/api/v3/brokerage/market/products": JSON.stringify({ product_id: "BTC-USD", price: "65000.12", price_percentage_change_24h: "1.5", volume_24h: "12345.6" }),
  "api.binance.com/api/v3/ticker/24hr": JSON.stringify({ symbol: "BTCUSDT", lastPrice: "65000.10", priceChangePercent: "-0.8", highPrice: "66000", lowPrice: "64000", volume: "999.5" }),
  "api.kraken.com/0/public/Ticker": JSON.stringify({ error: [], result: { XXBTZUSD: { c: ["65000.0", "0.01"], o: "64000.0", h: ["66000", "66000"], l: ["63000", "63000"], v: ["10", "20"] } } }),
  "api.bybit.com/v5/market/tickers": JSON.stringify({ retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", lastPrice: "65000", price24hPcnt: "0.012", highPrice24h: "66000", lowPrice24h: "64000", volume24h: "10" }] } }),
  "www.okx.com/api/v5/market/ticker": JSON.stringify({ code: "0", msg: "", data: [{ instId: "BTC-USDT", last: "65000", open24h: "64000", high24h: "66000", low24h: "63000", vol24h: "10" }] }),
  "api.kucoin.com/api/v1/market/stats": JSON.stringify({ code: "200000", data: { symbol: "BTC-USDT", last: "65000", changeRate: "0.01", high: "66000", low: "64000", vol: "10" } }),
  // Polymarket search (Gamma sends outcomes / prices / token IDs as JSON strings)
  "gamma-api.polymarket.com/public-search": JSON.stringify({
    events: [{ title: "Bitcoin in 2026", markets: [{ id: "1", question: "Will Bitcoin reach $100k?", slug: "btc-100k", outcomes: '["Yes", "No"]', outcomePrices: '["0.4", "0.6"]', clobTokenIds: '["111", "222"]', active: true, closed: false }] }],
  }),
  "ip-api.com": JSON.stringify({ status: "success", country: "DE", countryCode: "DE", regionName: "BE", city: "Berlin", lat: 52.5, lon: 13.4, timezone: "Europe/Berlin", isp: "ISP", org: "Org", query: "1.2.3.4" }),

  // --- Senders that require a returned id ----------------------------------
  "api.twitter.com/2/tweets": JSON.stringify({ data: { id: "1700000000000000000" } }),
  "sobjects/Contact": JSON.stringify({ id: "003000000000000AAA", success: true }),
  "api.github.com/repos": JSON.stringify({ number: 7, html_url: "https://github.com/o/r/pull/7", id: 42, message: undefined }),
  "rest.nexmo.com/sms/json": JSON.stringify({ messages: [{ status: "0", "message-id": "vonage-1" }] }),
  "api.pushover.net": JSON.stringify({ status: 1, receipt: "receipt-1" }),
  "api.linear.app/graphql": JSON.stringify({ data: { issueCreate: { success: true, issue: { id: "lin-1", identifier: "ENG-1", url: "https://linear.app/issue/ENG-1" } } } }),
  "admin/api/2024-01/products.json": JSON.stringify({ product: { id: 99, title: "Product", handle: "product" } }),
  "api.pipedrive.com/v1/deals": JSON.stringify({ success: true, data: { id: 5, url: "https://pipedrive.com/deal/5" } }),
  "api.pipedrive.com/v1/notes": JSON.stringify({ success: true, data: { id: 6 } }),
  "api.slack.com/api/chat.postMessage": JSON.stringify({ ok: true, ts: "1700000000.000100", channel: "C1" }),
  "api.telegram.org": JSON.stringify({ ok: true, result: { message_id: 1 } }),
};

// Fallback for any other endpoint. Deliberately generic, but it includes the
// fields a wide range of nodes look for (an id, an ok flag, rows) so their
// success path is still exercised.
export const FAKE_JSON_ANY = JSON.stringify({
  ok: true,
  sent: true,
  created: true,
  status: 200,
  id: 1,
  messageId: 1,
  insertedId: "stub-id",
  data: { id: 1, rows: [{ a: 1 }], documents: [{ a: 1 }] },
  rows: [{ a: 1 }],
  records: [{ id: "rec1", fields: { a: 1 } }],
  results: [{ id: "res1" }],
  values: [["a", "b"]],
  items: [{ id: "item1" }],
  files: [{ id: "file1", name: "f.txt" }],
  updates: { updatedRows: 1, updatedRange: "Sheet1!A1" },
  documents: [{ a: 1 }],
  updatedCells: 1,
  updatedRows: 1,
  children: [],
  hits: [],
});
