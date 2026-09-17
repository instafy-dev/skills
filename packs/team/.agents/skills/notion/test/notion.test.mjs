import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  MAX_ALL_PAGES,
  MAX_BLOCKS_PER_REQUEST,
  MAX_RETRIES,
  MAX_RETRY_DELAY_MS,
  MIN_REQUEST_INTERVAL_MS,
  NOTION_VERSION,
  classifyRequest,
  createClient,
  createRateLimiter,
  main,
  maskToken,
  notionId,
  retryDelayMs,
  richText,
  scrub,
  searchObjectFilter,
  textToBlocks,
} from "../notion.mjs";

// Obviously fake fixtures: RFC 4122 example ids and a token that spells out
// what it is. No real workspace, page, person or token appears here.
const PAGE_ID = "123e4567-e89b-12d3-a456-426614174000";
const PAGE_ID_BARE = "123e4567e89b12d3a456426614174000";
const DATABASE_ID = "123e4567-e89b-12d3-a456-426614174001";
const DATA_SOURCE_ID = "123e4567-e89b-12d3-a456-426614174002";
const OTHER_DATA_SOURCE_ID = "123e4567-e89b-12d3-a456-426614174003";
const API_KEY = "ntn_fake_token_never_printed_0000";

function fakeEnv(overrides = {}) {
  return { NOTION_API_KEY: API_KEY, ...overrides };
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

// A fake fetch: records every call and answers from a handler. The handler
// receives the path after /v1, the fetch options and the call list.
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const text = String(url);
    const apiPath = text.slice(text.indexOf("/v1") + "/v1".length);
    const call = {
      url: text,
      path: apiPath,
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      body: options.body ? JSON.parse(options.body) : null,
    };
    calls.push(call);
    return handler(call, calls);
  };
  impl.calls = calls;
  return impl;
}

// A clock that only advances when the client sleeps, so waits are exact.
function fakeClock() {
  let time = 0;
  const sleeps = [];
  return {
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms);
      time += ms;
    },
    sleeps,
  };
}

function clientWith(fetch, overrides = {}) {
  const clock = fakeClock();
  const client = createClient({
    env: fakeEnv(),
    fetch,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    ...overrides,
  });
  return { client, clock };
}

async function runMain(argv, { env = fakeEnv(), fetch, cwd } = {}) {
  const stdout = [];
  const stderr = [];
  const clock = fakeClock();
  const code = await main(argv, {
    env,
    fetch,
    cwd: cwd ?? (await emptyDir()),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0,
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

const created = [];

async function emptyDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "notion-skill-test-"));
  created.push(dir);
  return dir;
}

after(async () => {
  for (const dir of created) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("accepts ids with or without dashes and from notion links", () => {
  assert.equal(notionId(PAGE_ID), PAGE_ID);
  assert.equal(notionId(PAGE_ID_BARE), PAGE_ID);
  assert.equal(notionId(PAGE_ID_BARE.toUpperCase()), PAGE_ID);
  assert.equal(
    notionId(`https://www.notion.so/example-workspace/Some-Page-${PAGE_ID_BARE}`),
    PAGE_ID,
  );
  assert.equal(
    notionId(
      `https://www.notion.so/example-workspace/${PAGE_ID_BARE}?v=${DATABASE_ID.replaceAll("-", "")}`,
    ),
    PAGE_ID,
  );
});

test("rejects ids that are not 32 hex characters", () => {
  assert.throws(() => notionId("not-an-id", "Page ID"), /Page ID must be a Notion id/);
  assert.throws(() => notionId(PAGE_ID_BARE.slice(0, 31)), /32 hex characters/);
  assert.throws(() => notionId(`${PAGE_ID_BARE}/children`), /32 hex characters/);
  assert.throws(() => notionId(""), /is required/);
  assert.throws(() => notionId("https://example.test/" + PAGE_ID_BARE), /notion\.so/);
  assert.throws(() => notionId("https://www.notion.so/example-workspace/no-id"), /does not contain/);
});

test("maps --object database to the data_source search filter", () => {
  assert.equal(searchObjectFilter(undefined), null);
  assert.equal(searchObjectFilter("page"), "page");
  assert.equal(searchObjectFilter("database"), "data_source");
  assert.equal(searchObjectFilter("data_source"), "data_source");
  assert.throws(() => searchObjectFilter("user"), /--object must be/);
});

test("masks the token to configured or missing and scrubs it from text", () => {
  assert.equal(maskToken(API_KEY), "configured");
  assert.equal(maskToken(""), "missing");
  assert.equal(maskToken(undefined), "missing");
  assert.equal(scrub(`Bearer ${API_KEY} failed`, API_KEY), "Bearer *** failed");
  assert.equal(scrub("no secret here", ""), "no secret here");
});

test("request policy allows the reads and only the two writes", () => {
  assert.equal(classifyRequest("GET", "/users/me"), "read");
  assert.equal(classifyRequest("GET", `/pages/${PAGE_ID}`), "read");
  assert.equal(classifyRequest("GET", `/blocks/${PAGE_ID}/children?page_size=100`), "read");
  assert.equal(classifyRequest("GET", `/databases/${DATABASE_ID}`), "read");
  assert.equal(classifyRequest("GET", `/data_sources/${DATA_SOURCE_ID}`), "read");
  assert.equal(classifyRequest("POST", "/search"), "read");
  assert.equal(classifyRequest("POST", `/data_sources/${DATA_SOURCE_ID}/query`), "read");
  assert.throws(() => classifyRequest("PATCH", `/data_sources/${DATA_SOURCE_ID}/query`), /not allowed/);
  assert.equal(classifyRequest("PATCH", `/blocks/${PAGE_ID}/children`), "write");
  assert.equal(classifyRequest("POST", "/pages"), "write");
  assert.throws(() => classifyRequest("DELETE", `/blocks/${PAGE_ID}`), /not allowed/);
  assert.throws(() => classifyRequest("PATCH", `/pages/${PAGE_ID}`), /not allowed/);
  assert.throws(() => classifyRequest("POST", "/databases"), /not allowed/);
  assert.throws(() => classifyRequest("GET", `/pages/${PAGE_ID_BARE}`), /not allowed/);
  assert.throws(() => classifyRequest("GET", "/pages/../users"), /must not contain/);
  assert.throws(() => classifyRequest("GET", "users/me"), /must start with/);
});

test("splits rich text into 2000 character chunks", () => {
  const long = "x".repeat(4500);
  const chunks = richText(long);
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].text.content.length, 2000);
  assert.equal(chunks[2].text.content.length, 500);
  assert.deepEqual(richText(""), [{ type: "text", text: { content: "" } }]);
});

test("turns markdown-ish text into blocks", () => {
  const text = [
    "# Title",
    "First line",
    "second line",
    "",
    "- bullet",
    "* another",
    "- [ ] open task",
    "- [x] done task",
    "1. first",
    "2) second",
    "> quoted",
    "---",
    "```js",
    "const a = 1;",
    "```",
    "## Sub",
    "Tail",
  ].join("\n");
  const blocks = textToBlocks(text);
  assert.deepEqual(
    blocks.map((entry) => entry.type),
    [
      "heading_1",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "to_do",
      "to_do",
      "numbered_list_item",
      "numbered_list_item",
      "quote",
      "divider",
      "code",
      "heading_2",
      "paragraph",
    ],
  );
  assert.equal(blocks[0].heading_1.rich_text[0].text.content, "Title");
  assert.equal(blocks[1].paragraph.rich_text[0].text.content, "First line\nsecond line");
  assert.equal(blocks[4].to_do.checked, false);
  assert.equal(blocks[5].to_do.checked, true);
  assert.equal(blocks[10].code.language, "js");
  assert.equal(blocks[10].code.rich_text[0].text.content, "const a = 1;");
  assert.equal(blocks[0].object, "block");
});

test("refuses empty text, unclosed fences and too many blocks", () => {
  assert.throws(() => textToBlocks("\n\n"), /no blocks/);
  assert.throws(() => textToBlocks("```\nopen"), /unclosed/);
  const many = Array.from({ length: MAX_BLOCKS_PER_REQUEST + 1 }, (_, i) => `- item ${i}`);
  assert.throws(() => textToBlocks(many.join("\n")), /at most 100/);
  assert.equal(textToBlocks(many.slice(0, MAX_BLOCKS_PER_REQUEST).join("\n")).length, 100);
});

test("rate limiter spaces requests at least the minimum interval apart", async () => {
  const clock = fakeClock();
  const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });
  assert.equal(await limiter.acquire(), 0);
  assert.equal(await limiter.acquire(), MIN_REQUEST_INTERVAL_MS);
  assert.equal(await limiter.acquire(), MIN_REQUEST_INTERVAL_MS);
  assert.deepEqual(clock.sleeps, [MIN_REQUEST_INTERVAL_MS, MIN_REQUEST_INTERVAL_MS]);
  // After a long pause the next request goes straight through.
  await clock.sleep(5000);
  assert.equal(await limiter.acquire(), 0);
});

test("retry delay honours Retry-After, caps it, and backs off otherwise", () => {
  const withHeader = new Response("", { status: 429, headers: { "Retry-After": "2" } });
  assert.equal(retryDelayMs(withHeader, 0), 2000);
  const huge = new Response("", { status: 429, headers: { "Retry-After": "600" } });
  assert.equal(retryDelayMs(huge, 0), MAX_RETRY_DELAY_MS);
  const none = new Response("", { status: 503 });
  assert.equal(retryDelayMs(none, 0, () => 0), 1000);
  assert.equal(retryDelayMs(none, 2, () => 0), 4000);
  assert.equal(retryDelayMs(none, 1, () => 0.5), 2125);
});

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

test("every request carries the bearer token and the pinned Notion-Version", async () => {
  const fetch = fakeFetch(() => jsonResponse({ object: "user", id: "bot", name: "Example Bot" }));
  const { client } = clientWith(fetch);
  await client.me();
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://api.notion.com/v1/users/me");
  assert.equal(fetch.calls[0].headers.Authorization, `Bearer ${API_KEY}`);
  assert.equal(fetch.calls[0].headers["Notion-Version"], NOTION_VERSION);
  assert.equal(fetch.calls[0].headers["Content-Type"], undefined);
});

test("reads without a token fail before any request and name the variable", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const { client } = clientWith(fetch, { env: {} });
  await assert.rejects(() => client.me(), /Set NOTION_API_KEY in the environment/);
  assert.equal(fetch.calls.length, 0);
});

test("search posts the query and the object filter with a JSON body", async () => {
  const fetch = fakeFetch(() => jsonResponse({ object: "list", results: [], has_more: false }));
  const { client } = clientWith(fetch);
  await client.search({ query: "weekly notes", object: "database", size: 10 });
  const [call] = fetch.calls;
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/search");
  assert.equal(call.headers["Content-Type"], "application/json");
  assert.deepEqual(call.body, {
    page_size: 10,
    query: "weekly notes",
    filter: { property: "object", value: "data_source" },
  });
});

test("--all follows next_cursor until has_more is false and merges results", async () => {
  const pages = {
    undefined: { results: [{ id: "a" }], has_more: true, next_cursor: "cursor-two" },
    "cursor-two": { results: [{ id: "b" }], has_more: true, next_cursor: "cursor-three" },
    "cursor-three": { results: [{ id: "c" }], has_more: false, next_cursor: null },
  };
  const fetch = fakeFetch((call) =>
    jsonResponse({ object: "list", ...pages[call.body.start_cursor] }),
  );
  const { client } = clientWith(fetch);
  const result = await client.search({ query: "x", all: true });
  assert.equal(fetch.calls.length, 3);
  assert.equal(fetch.calls[1].body.start_cursor, "cursor-two");
  assert.deepEqual(
    result.results.map((entry) => entry.id),
    ["a", "b", "c"],
  );
  assert.equal(result.pages, 3);
  assert.equal(result.complete, true);
  assert.equal(result.next_cursor, null);
});

test("--all stops after the page cap and reports the cursor to continue from", async () => {
  const fetch = fakeFetch((call, calls) =>
    jsonResponse({
      object: "list",
      results: [{ id: `row-${calls.length}` }],
      has_more: true,
      next_cursor: `cursor-${calls.length}`,
    }),
  );
  const { client } = clientWith(fetch);
  const result = await client.blocks(PAGE_ID, { all: true });
  assert.equal(fetch.calls.length, MAX_ALL_PAGES);
  assert.equal(result.results.length, MAX_ALL_PAGES);
  assert.equal(result.complete, false);
  assert.equal(result.next_cursor, `cursor-${MAX_ALL_PAGES}`);
  assert.equal(fetch.calls[0].path, `/blocks/${PAGE_ID}/children?page_size=100`);
  assert.equal(
    fetch.calls[1].path,
    `/blocks/${PAGE_ID}/children?page_size=100&start_cursor=cursor-1`,
  );
});

test("requests in a burst are paced by the rate limiter", async () => {
  const fetch = fakeFetch(() => jsonResponse({ object: "page", id: PAGE_ID }));
  const { client, clock } = clientWith(fetch);
  for (let index = 0; index < 4; index += 1) await client.page(PAGE_ID);
  assert.equal(fetch.calls.length, 4);
  assert.deepEqual(clock.sleeps, [
    MIN_REQUEST_INTERVAL_MS,
    MIN_REQUEST_INTERVAL_MS,
    MIN_REQUEST_INTERVAL_MS,
  ]);
});

test("a 429 is retried after Retry-After seconds and then succeeds", async () => {
  const fetch = fakeFetch((call, calls) =>
    calls.length === 1
      ? jsonResponse({ code: "rate_limited", message: "slow down" }, 429, { "Retry-After": "2" })
      : jsonResponse({ object: "page", id: PAGE_ID }),
  );
  const { client, clock } = clientWith(fetch);
  const result = await client.page(PAGE_ID);
  assert.equal(result.id, PAGE_ID);
  assert.equal(fetch.calls.length, 2);
  assert.ok(clock.sleeps.includes(2000));
});

test("retries are bounded: repeated 429s surface the error without the token", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ code: "rate_limited", message: "slow down" }, 429, { "Retry-After": "1" }),
  );
  const { client } = clientWith(fetch);
  await assert.rejects(() => client.page(PAGE_ID), (error) => {
    assert.match(error.message, /failed \(429\): rate_limited: slow down/);
    assert.equal(error.status, 429);
    assert.ok(!error.message.includes(API_KEY));
    return true;
  });
  assert.equal(fetch.calls.length, MAX_RETRIES + 1);
});

test("5xx answers back off with jitter and 4xx answers are not retried", async () => {
  const flaky = fakeFetch((call, calls) =>
    calls.length === 1
      ? new Response("upstream down", { status: 503 })
      : jsonResponse({ object: "page", id: PAGE_ID }),
  );
  const { client, clock } = clientWith(flaky);
  await client.page(PAGE_ID);
  assert.equal(flaky.calls.length, 2);
  assert.ok(clock.sleeps.includes(1000));

  const forbidden = fakeFetch(() =>
    jsonResponse({ code: "object_not_found", message: "Could not find page" }, 404),
  );
  const missing = clientWith(forbidden);
  await assert.rejects(() => missing.client.page(PAGE_ID), /failed \(404\): object_not_found/);
  assert.equal(forbidden.calls.length, 1);
});

test("the API layer refuses every write without confirm and every unknown path", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const { client } = clientWith(fetch);
  await assert.rejects(
    () => client.apiRequest(`/blocks/${PAGE_ID}/children`, { method: "PATCH", body: {} }),
    /needs --confirm/,
  );
  await assert.rejects(
    () => client.apiRequest("/pages", { method: "POST", body: {} }),
    /needs --confirm/,
  );
  await assert.rejects(
    () => client.apiRequest(`/pages/${PAGE_ID}`, { method: "PATCH", body: { in_trash: true } }),
    /not allowed/,
  );
  await assert.rejects(
    () => client.apiRequest(`/blocks/${PAGE_ID}`, { method: "DELETE" }),
    /not allowed/,
  );
  assert.equal(fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Commands through main
// ---------------------------------------------------------------------------

test("--help prints usage without touching the network or the environment", async () => {
  const fetch = fakeFetch(() => {
    throw new Error("must not be called");
  });
  const result = await runMain(["--help"], { env: {}, fetch });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: node notion\.mjs/);
  assert.match(result.stdout, new RegExp(NOTION_VERSION));
  assert.equal(fetch.calls.length, 0);
});

test("status masks the token, reports the bot and never prints the secret", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({
      object: "user",
      id: "bot-id",
      name: "Example Bot",
      type: "bot",
      bot: { workspace_name: "Example Workspace" },
    }),
  );
  const result = await runMain(["status"], { fetch });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.api_key, "configured");
  assert.equal(report.notion_version, NOTION_VERSION);
  assert.equal(report.connection, "ok");
  assert.deepEqual(report.bot, {
    id: "bot-id",
    name: "Example Bot",
    workspace_name: "Example Workspace",
  });
  assert.ok(!result.stdout.includes(API_KEY));
});

test("status scrubs the token from a failed connection on stdout", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ code: "unauthorized", message: `bad token ${API_KEY}` }, 401),
  );
  const result = await runMain(["status"], { fetch });
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.api_key, "configured");
  assert.match(report.connection, /failed \(401\): unauthorized: bad token \*\*\*/);
  assert.ok(!result.stdout.includes(API_KEY));
  assert.ok(!result.stderr.includes(API_KEY));
});

test("status without a token reports missing and makes no request", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const result = await runMain(["status"], { env: {}, fetch });
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.api_key, "missing");
  assert.match(report.connection, /NOTION_API_KEY missing/);
  assert.equal(fetch.calls.length, 0);
});

test("an error message that echoes the token is scrubbed on stderr", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ code: "unauthorized", message: `bad token ${API_KEY}` }, 401),
  );
  const result = await runMain(["me"], { fetch });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unauthorized: bad token \*\*\*/);
  assert.ok(!result.stderr.includes(API_KEY));
});

test("page, blocks, database and data-source build their paths from any id form", async () => {
  const fetch = fakeFetch((call) => jsonResponse({ object: "ok", path: call.path }));
  for (const [argv, expected] of [
    [["page", PAGE_ID_BARE], `/pages/${PAGE_ID}`],
    [["blocks", PAGE_ID], `/blocks/${PAGE_ID}/children?page_size=100`],
    [["database", DATABASE_ID], `/databases/${DATABASE_ID}`],
    [["data-source", DATA_SOURCE_ID], `/data_sources/${DATA_SOURCE_ID}`],
  ]) {
    const result = await runMain(argv, { fetch });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).path, expected);
  }
  assert.equal(fetch.calls.length, 4);
});

test("query resolves the single data source of a database, then POSTs the query", async () => {
  const fetch = fakeFetch((call) => {
    if (call.path === `/databases/${DATABASE_ID}`) {
      return jsonResponse({
        object: "database",
        id: DATABASE_ID,
        data_sources: [{ id: DATA_SOURCE_ID, name: "Tasks" }],
      });
    }
    return jsonResponse({ object: "list", results: [{ id: "row" }], has_more: false });
  });
  const filter = JSON.stringify({ property: "Status", status: { equals: "Open" } });
  const result = await runMain(["query", DATABASE_ID, "--filter-json", filter], { fetch });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.data_source_id, DATA_SOURCE_ID);
  assert.equal(output.data_source_source, "database");
  assert.equal(fetch.calls[1].method, "POST");
  assert.equal(fetch.calls[1].path, `/data_sources/${DATA_SOURCE_ID}/query`);
  assert.deepEqual(fetch.calls[1].body, {
    page_size: 100,
    filter: { property: "Status", status: { equals: "Open" } },
  });
});

test("query with several data sources asks for --data-source, which skips resolution", async () => {
  const fetch = fakeFetch((call) => {
    if (call.path === `/databases/${DATABASE_ID}`) {
      return jsonResponse({
        object: "database",
        data_sources: [
          { id: DATA_SOURCE_ID, name: "Tasks" },
          { id: OTHER_DATA_SOURCE_ID, name: "Archive" },
        ],
      });
    }
    return jsonResponse({ object: "list", results: [], has_more: false });
  });
  const ambiguous = await runMain(["query", DATABASE_ID], { fetch });
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /several data sources/);
  assert.match(ambiguous.stderr, new RegExp(OTHER_DATA_SOURCE_ID));

  const explicit = await runMain(
    ["query", DATABASE_ID, "--data-source", OTHER_DATA_SOURCE_ID],
    { fetch },
  );
  assert.equal(explicit.code, 0, explicit.stderr);
  const last = fetch.calls.at(-1);
  assert.equal(last.path, `/data_sources/${OTHER_DATA_SOURCE_ID}/query`);
  assert.equal(fetch.calls.length, 2);
});

test("validation errors exit 1 before any request", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  for (const [argv, pattern] of [
    [["page", "nope"], /must be a Notion id/],
    [["query", DATABASE_ID, "--filter-json", "{not json"], /must be valid JSON/],
    [["query", DATABASE_ID, "--filter-json", "[]"], /must be a JSON object/],
    [["search", "x", "--object", "user"], /--object must be/],
    [["search", "x", "--page-size", "0"], /Page size must be/],
    [["blocks", PAGE_ID, "--cursor", "bad cursor!"], /unexpected characters/],
    [["append", PAGE_ID], /requires --text/],
    [["create-page", "--parent", PAGE_ID], /--title must not be empty/],
    [["create-page", "--parent", PAGE_ID, "--title", "T", "--parent-type", "block"], /--parent-type/],
    [["page"], /requires exactly one/],
    [["me", "extra"], /does not take/],
    [["unknown"], /Unknown command/],
    [["page", PAGE_ID, "--bogus"], /Unsupported option/],
  ]) {
    const result = await runMain(argv, { fetch });
    assert.equal(result.code, 1, argv.join(" "));
    assert.match(result.stderr, pattern);
  }
  assert.equal(fetch.calls.length, 0);
});

test("append without --confirm is a dry run that masks the token and makes no request", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const result = await runMain(
    ["append", PAGE_ID_BARE, "--text", "# Note\n\n- one\n- two"],
    { fetch },
  );
  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.page_id, PAGE_ID);
  assert.equal(plan.block_count, 3);
  assert.equal(plan.request.method, "PATCH");
  assert.equal(plan.request.url, `https://api.notion.com/v1/blocks/${PAGE_ID}/children`);
  assert.equal(plan.request.headers.Authorization, "Bearer ***");
  assert.equal(plan.request.headers["Notion-Version"], NOTION_VERSION);
  assert.equal(plan.request.body.children[0].type, "heading_1");
  assert.match(plan.next_step, /--confirm/);
  assert.ok(!result.stdout.includes(API_KEY));
  assert.equal(fetch.calls.length, 0);
});

test("append --confirm PATCHes the children once", async () => {
  const fetch = fakeFetch(() => jsonResponse({ object: "list", results: [{ id: "new-block" }] }));
  const result = await runMain(["append", PAGE_ID, "--text", "Hello there", "--confirm"], {
    fetch,
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.dry_run, false);
  assert.equal(output.result.results[0].id, "new-block");
  assert.equal(fetch.calls.length, 1);
  const [call] = fetch.calls;
  assert.equal(call.method, "PATCH");
  assert.equal(call.path, `/blocks/${PAGE_ID}/children`);
  assert.equal(call.headers.Authorization, `Bearer ${API_KEY}`);
  assert.deepEqual(call.body, {
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", text: { content: "Hello there" } }] },
      },
    ],
  });
});

test("a 5xx on a confirmed write is never resent", async () => {
  const fetch = fakeFetch(() => new Response("upstream down", { status: 503 }));
  const { client, clock } = clientWith(fetch);
  await assert.rejects(
    () => client.append(PAGE_ID, { text: "Hello there", confirm: true }),
    /failed \(503\)/,
  );
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, "PATCH");
  assert.deepEqual(clock.sleeps, []);

  const created = fakeFetch(() => new Response("upstream down", { status: 502 }));
  const creating = clientWith(created);
  await assert.rejects(
    () => creating.client.createPage({ parent: PAGE_ID, title: "T", confirm: true }),
    /failed \(502\)/,
  );
  assert.equal(created.calls.length, 1);

  // A 429 was not processed, so a write may be resent after Retry-After.
  const limited = fakeFetch((call, calls) =>
    calls.length === 1
      ? jsonResponse({ code: "rate_limited", message: "slow down" }, 429, { "Retry-After": "1" })
      : jsonResponse({ object: "list", results: [] }),
  );
  const retried = clientWith(limited);
  await retried.client.append(PAGE_ID, { text: "Hello there", confirm: true });
  assert.equal(limited.calls.length, 2);
});

test("append reads --text-file only from inside the workspace", async () => {
  const cwd = await emptyDir();
  await fs.writeFile(path.join(cwd, "note.md"), "- from a file\n");
  const outside = path.join(await emptyDir(), "outside.md");
  await fs.writeFile(outside, "- outside\n");
  const fetch = fakeFetch(() => jsonResponse({}));

  const inside = await runMain(["append", PAGE_ID, "--text-file", "note.md"], { fetch, cwd });
  assert.equal(inside.code, 0, inside.stderr);
  assert.equal(JSON.parse(inside.stdout).request.body.children[0].type, "bulleted_list_item");

  const escaped = await runMain(["append", PAGE_ID, "--text-file", outside], { fetch, cwd });
  assert.equal(escaped.code, 1);
  assert.match(escaped.stderr, /inside the workspace/);

  // A symlink inside the workspace that points outside it is refused too,
  // and so is a file reached through a symlinked directory.
  await fs.symlink(outside, path.join(cwd, "link.md"));
  const linked = await runMain(["append", PAGE_ID, "--text-file", "link.md"], { fetch, cwd });
  assert.equal(linked.code, 1);
  assert.match(linked.stderr, /inside the workspace/);
  await fs.symlink(path.dirname(outside), path.join(cwd, "linked-dir"));
  const viaDir = await runMain(
    ["append", PAGE_ID, "--text-file", "linked-dir/outside.md"],
    { fetch, cwd },
  );
  assert.equal(viaDir.code, 1);
  assert.match(viaDir.stderr, /inside the workspace/);

  const both = await runMain(
    ["append", PAGE_ID, "--text", "x", "--text-file", "note.md"],
    { fetch, cwd },
  );
  assert.equal(both.code, 1);
  assert.match(both.stderr, /either --text or --text-file/);
  assert.equal(fetch.calls.length, 0);
});

test("create-page under a page is a dry run until --confirm, then POSTs once", async () => {
  const fetch = fakeFetch(() => jsonResponse({ object: "page", id: "created-page" }));
  const dry = await runMain(
    ["create-page", "--parent", PAGE_ID, "--title", "Agent notes", "--text", "First entry"],
    { fetch },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.parent_type, "page");
  assert.equal(plan.request.method, "POST");
  assert.equal(plan.request.url, "https://api.notion.com/v1/pages");
  assert.equal(plan.request.headers.Authorization, "Bearer ***");
  assert.deepEqual(plan.request.body.parent, { type: "page_id", page_id: PAGE_ID });
  assert.equal(plan.request.body.properties.title.title[0].text.content, "Agent notes");
  assert.equal(plan.request.body.children.length, 1);
  assert.equal(fetch.calls.length, 0);

  const done = await runMain(
    ["create-page", "--parent", PAGE_ID, "--title", "Agent notes", "--confirm"],
    { fetch },
  );
  assert.equal(done.code, 0, done.stderr);
  assert.equal(JSON.parse(done.stdout).result.id, "created-page");
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, "POST");
  assert.equal(fetch.calls[0].path, "/pages");
  assert.equal(fetch.calls[0].body.children, undefined);
});

test("create-page under a database resolves the data source, reading only during the dry run", async () => {
  const fetch = fakeFetch((call) => {
    if (call.path === `/databases/${DATABASE_ID}`) {
      return jsonResponse({
        object: "database",
        data_sources: [{ id: DATA_SOURCE_ID, name: "Tasks" }],
      });
    }
    return jsonResponse({ object: "page", id: "created-row" });
  });
  const dry = await runMain(
    ["create-page", "--parent", DATABASE_ID, "--parent-type", "database", "--title", "New row"],
    { fetch },
  );
  assert.equal(dry.code, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.data_source_id, DATA_SOURCE_ID);
  assert.deepEqual(plan.request.body.parent, {
    type: "data_source_id",
    data_source_id: DATA_SOURCE_ID,
  });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].method, "GET");

  const done = await runMain(
    [
      "create-page",
      "--parent",
      DATABASE_ID,
      "--parent-type",
      "database",
      "--data-source",
      DATA_SOURCE_ID,
      "--title",
      "New row",
      "--confirm",
    ],
    { fetch },
  );
  assert.equal(done.code, 0, done.stderr);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[1].method, "POST");
  assert.equal(fetch.calls[1].path, "/pages");
});

test("--compact prints one line", async () => {
  const fetch = fakeFetch(() => jsonResponse({ object: "user", id: "bot" }));
  const result = await runMain(["me", "--compact"], { fetch });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '{"object":"user","id":"bot"}');
});
