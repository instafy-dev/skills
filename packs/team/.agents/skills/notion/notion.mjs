#!/usr/bin/env node
// Notion API client for the notion skill.
//
// Zero dependencies, Node 24, ESM. The token comes from the environment only:
//   NOTION_API_KEY   internal connection token (sensitive)
//
// Every command is a read except `append --confirm` and `create-page --confirm`,
// the two allowed writes. The request policy is enforced in one place
// (classifyRequest plus the confirm gate in apiRequest) so no other method or
// path can ever be sent, whatever the command layer does. The token is never
// printed: status masks it, dry runs mask the Authorization header, and both
// stdout and stderr are scrubbed of it before anything is written.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const API_BASE_URL = "https://api.notion.com/v1";
// Pinned to the version current when this skill was written. It is the one
// that separates databases (containers) from data sources (tables), which is
// why `query` resolves a data source first.
export const NOTION_VERSION = "2026-03-11";
export const MAX_PAGE_SIZE = 100;
export const MAX_ALL_PAGES = 20;
export const MAX_REQUESTS_PER_SECOND = 3;
export const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_REQUESTS_PER_SECOND);
export const MAX_RETRIES = 3;
// Notion documents two rate limits (developers.notion.com/reference/request-limits,
// read 2026-09-18). The per-connection one resets within its 60-second window,
// so its Retry-After "is at most 60 seconds". The per-workspace one is shared
// across every connection in the workspace and its "Retry-After for this limit
// can be longer than a minute". A 60-second ceiling therefore truncated a wait
// the API asked for, retried while still limited, and burned every attempt.
export const MAX_RETRY_DELAY_MS = 300_000;
export const MAX_RICH_TEXT_CHARS = 2000;
export const MAX_BLOCKS_PER_REQUEST = 100;
export const MAX_TEXT_BYTES = 100 * 1024;
export const MAX_TITLE_CHARS = 2000;

// 429 is the one status Notion refuses before doing any work, so a 429 may be
// resent as it stands, a write included.
export const UNAPPLIED_STATUSES = new Set([429]);

// Notion's remedy for a 409 conflict_error is "Make sure the parameters are up
// to date and try again" (developers.notion.com/reference/status-codes, read
// 2026-09-18). It does NOT promise the transaction was rolled back, and it
// names a second cause: a file-upload storage provider that already took the
// content. So a 409 is resent only for reads, exactly as a 5xx is, and a
// confirmed write that answers 409 surfaces instead of risking duplicate
// blocks on the user's page.
export const READ_ONLY_RETRY_STATUSES = new Set([409]);

const HEX_ID = /^[0-9a-f]{32}$/;
const ID_IN_PATH = /[0-9a-f]{32}(?![0-9a-f])/gi;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function notionId(value, label = "ID") {
  let text = String(value ?? "").trim();
  if (!text) throw new Error(`${label} is required.`);
  // A page or database link is accepted; the id is taken from the link's path.
  if (/^https?:\/\//i.test(text)) {
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw new Error(`${label} link is not a valid URL.`);
    }
    if (!/(^|\.)notion\.(so|site)$/i.test(parsed.hostname)) {
      throw new Error(`${label} link must point at notion.so or notion.site.`);
    }
    const matches = parsed.pathname.match(ID_IN_PATH) ?? [];
    if (matches.length === 0) {
      throw new Error(`${label} link does not contain a Notion id.`);
    }
    text = matches[matches.length - 1];
  }
  const bare = text.replace(/-/g, "").toLowerCase();
  if (!HEX_ID.test(bare)) {
    throw new Error(
      `${label} must be a Notion id: 32 hex characters, with or without dashes.`,
    );
  }
  return `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`;
}

export function pageSize(value = MAX_PAGE_SIZE) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 1 || normalized > MAX_PAGE_SIZE) {
    throw new Error(`Page size must be an integer from 1 to ${MAX_PAGE_SIZE}.`);
  }
  return normalized;
}

export function nonEmptyText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  return normalized;
}

export function cursorValue(value) {
  if (value === undefined || value === null) return null;
  const normalized = nonEmptyText(value, "Cursor");
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(normalized)) {
    throw new Error("Cursor contains unexpected characters.");
  }
  return normalized;
}

export function parseJsonObject(value, label) {
  if (value === undefined || value === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

export function searchObjectFilter(value) {
  if (value === undefined) return null;
  const normalized = nonEmptyText(value, "Object filter").toLowerCase();
  // Under this API version a database is a container of data sources, and
  // search returns data sources. `database` is accepted as the familiar word.
  if (normalized === "page") return "page";
  if (normalized === "database" || normalized === "data_source") return "data_source";
  throw new Error("--object must be 'page' or 'database'.");
}

export function maskToken(value) {
  return String(value ?? "") ? "configured" : "missing";
}

export function scrub(text, secret) {
  const message = String(text ?? "");
  if (!secret) return message;
  return message.split(secret).join("***");
}

// ---------------------------------------------------------------------------
// Request policy (pure)
// ---------------------------------------------------------------------------

const READS = [
  ["GET", /^\/users\/me$/],
  ["GET", /^\/pages\/[0-9a-f-]{36}$/],
  ["GET", /^\/blocks\/[0-9a-f-]{36}\/children$/],
  ["GET", /^\/databases\/[0-9a-f-]{36}$/],
  ["GET", /^\/data_sources\/[0-9a-f-]{36}$/],
  ["POST", /^\/search$/],
  ["POST", /^\/data_sources\/[0-9a-f-]{36}\/query$/],
];

const WRITES = [
  ["PATCH", /^\/blocks\/[0-9a-f-]{36}\/children$/],
  ["POST", /^\/pages$/],
];

export function classifyRequest(method, resourcePath) {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  if (typeof resourcePath !== "string" || !resourcePath.startsWith("/")) {
    throw new Error("API resource path must start with '/'.");
  }
  if (resourcePath.includes("..")) {
    throw new Error("API resource path must not contain '..'.");
  }
  const bare = resourcePath.split("?")[0];
  const matches = ([m, pattern]) => m === normalizedMethod && pattern.test(bare);
  if (READS.some(matches)) return "read";
  if (WRITES.some(matches)) return "write";
  throw new Error(
    `Request policy: ${normalizedMethod} ${bare} is not allowed. The only writes this skill performs are appending blocks to a page and creating a page.`,
  );
}

// ---------------------------------------------------------------------------
// Text to blocks (pure)
// ---------------------------------------------------------------------------

export function richText(text) {
  const chunks = [];
  const value = String(text ?? "");
  for (let index = 0; index < value.length; index += MAX_RICH_TEXT_CHARS) {
    chunks.push({
      type: "text",
      text: { content: value.slice(index, index + MAX_RICH_TEXT_CHARS) },
    });
  }
  if (chunks.length === 0) chunks.push({ type: "text", text: { content: "" } });
  return chunks;
}

function block(type, body) {
  return { object: "block", type, [type]: body };
}

// A small, predictable subset of Markdown. Lines are read top to bottom:
// `# `, `## `, `### ` headings; `- [ ] ` and `- [x] ` to-dos; `- ` or `* `
// bullets; `1. ` numbered items; `> ` quotes; `---` dividers; fenced code
// between ``` lines; everything else is a paragraph, and consecutive plain
// lines join into one paragraph. Inline formatting is not interpreted.
export function textToBlocks(text) {
  const value = String(text ?? "").replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new Error(`Text must be at most ${MAX_TEXT_BYTES} bytes.`);
  }
  const blocks = [];
  let paragraph = [];
  let code = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push(block("paragraph", { rich_text: richText(paragraph.join("\n")) }));
    paragraph = [];
  };

  for (const line of value.split("\n")) {
    if (code) {
      if (line.trim() === "```") {
        blocks.push(
          block("code", {
            rich_text: richText(code.lines.join("\n")),
            language: code.language,
          }),
        );
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const fence = /^```([A-Za-z0-9_+#-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      code = { language: fence[1] ? fence[1].toLowerCase() : "plain text", lines: [] };
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    let match;
    if ((match = /^(#{1,3}) (.+)$/.exec(line))) {
      flushParagraph();
      blocks.push(
        block(`heading_${match[1].length}`, { rich_text: richText(match[2].trim()) }),
      );
    } else if ((match = /^[-*] \[([ xX])\] (.+)$/.exec(line))) {
      flushParagraph();
      blocks.push(
        block("to_do", {
          rich_text: richText(match[2].trim()),
          checked: match[1] !== " ",
        }),
      );
    } else if ((match = /^[-*] (.+)$/.exec(line))) {
      flushParagraph();
      blocks.push(block("bulleted_list_item", { rich_text: richText(match[1].trim()) }));
    } else if ((match = /^\d+[.)] (.+)$/.exec(line))) {
      flushParagraph();
      blocks.push(block("numbered_list_item", { rich_text: richText(match[1].trim()) }));
    } else if ((match = /^> ?(.*)$/.exec(line))) {
      flushParagraph();
      blocks.push(block("quote", { rich_text: richText(match[1].trim()) }));
    } else if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushParagraph();
      blocks.push(block("divider", {}));
    } else {
      paragraph.push(line);
    }
  }
  if (code) {
    throw new Error("Text has an unclosed ``` code fence.");
  }
  flushParagraph();

  if (blocks.length === 0) throw new Error("Text produced no blocks.");
  if (blocks.length > MAX_BLOCKS_PER_REQUEST) {
    throw new Error(
      `Text produced ${blocks.length} blocks; at most ${MAX_BLOCKS_PER_REQUEST} can be sent in one request. Split it.`,
    );
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Rate limiter and HTTP layer
// ---------------------------------------------------------------------------

export function createRateLimiter({
  intervalMs = MIN_REQUEST_INTERVAL_MS,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let nextAllowedAt = 0;
  return {
    async acquire() {
      const current = now();
      const wait = Math.max(0, nextAllowedAt - current);
      nextAllowedAt = Math.max(current, nextAllowedAt) + intervalMs;
      if (wait > 0) await sleep(wait);
      return wait;
    },
  };
}

export function retryDelayMs(response, attempt, random = Math.random, body = null) {
  const header = response?.headers?.get?.("retry-after");
  const seconds = Number(header);
  if (header !== null && header !== undefined && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_DELAY_MS);
  }
  // Per-connection 429s repeat the same wait in the body as
  // `additional_data.retry_after`, an integer number of seconds sent as a
  // string, for clients that cannot read response headers
  // (developers.notion.com/reference/request-limits, read 2026-09-18).
  const fromBody = Number(body?.additional_data?.retry_after);
  if (Number.isFinite(fromBody) && fromBody >= 0) {
    return Math.min(Math.ceil(fromBody * 1000), MAX_RETRY_DELAY_MS);
  }
  const base = 1000 * 2 ** attempt;
  const jitter = Math.floor(random() * 250);
  return Math.min(base + jitter, MAX_RETRY_DELAY_MS);
}

export function readSettings(env = process.env) {
  return {
    baseUrl: API_BASE_URL,
    version: NOTION_VERSION,
    apiKey: String(env.NOTION_API_KEY ?? "").trim(),
  };
}

function requireToken(settings) {
  if (!settings.apiKey) {
    throw new Error("Set NOTION_API_KEY in the environment.");
  }
}

function errorDetail(body, status) {
  if (body && typeof body === "object") {
    const code = body.code ? `${body.code}: ` : "";
    return `${code}${body.message ?? `HTTP ${status}`}`;
  }
  if (typeof body === "string" && body) return body.slice(0, 200);
  return `HTTP ${status}`;
}

export function createClient({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  cwd = process.cwd(),
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random = Math.random,
} = {}) {
  const settings = readSettings(env);
  const limiter = createRateLimiter({ now, sleep });

  function requestHeaders(body) {
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
      "Notion-Version": settings.version,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    return headers;
  }

  function planRequest(method, resourcePath, body) {
    const headers = requestHeaders(body);
    return {
      method,
      url: `${settings.baseUrl}${resourcePath}`,
      headers: { ...headers, Authorization: "Bearer ***" },
      body: body ?? null,
    };
  }

  async function apiRequest(resourcePath, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    const kind = classifyRequest(method, resourcePath);
    if (kind === "write" && options.confirm !== true) {
      throw new Error(
        `Write policy: ${method} ${resourcePath.split("?")[0]} needs --confirm.`,
      );
    }
    requireToken(settings);

    const url = `${settings.baseUrl}${resourcePath}`;
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const context = `Notion ${method} ${resourcePath.split("?")[0]}`;

    for (let attempt = 0; ; attempt += 1) {
      await limiter.acquire();
      const response = await fetchImpl(url, {
        method,
        headers: requestHeaders(options.body),
        body,
      });
      const raw = await response.text();
      let parsed = null;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      if (response.ok) return parsed;

      // A 429 was refused before any work, so any request may be resent. A 409
      // or a 5xx may already have been applied before the answer was lost, so
      // only reads are resent; a failed write surfaces at once and is never
      // repeated, because a repeated append would duplicate blocks.
      const retryable =
        UNAPPLIED_STATUSES.has(response.status) ||
        ((READ_ONLY_RETRY_STATUSES.has(response.status) || response.status >= 500) &&
          kind === "read");
      if (retryable && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(response, attempt, random, parsed));
        continue;
      }
      const error = new Error(
        `${context} failed (${response.status}): ${errorDetail(parsed, response.status)}`,
      );
      error.status = response.status;
      error.code = parsed?.code ?? null;
      throw error;
    }
  }

  // Walks a paginated endpoint. `send(cursor)` performs one request; the
  // result merges `results` and reports how many pages were read.
  async function paginate(send, { all = false, cursor = null } = {}) {
    if (!all) return send(cursor);
    const results = [];
    let next = cursor;
    let pages = 0;
    let hasMore = false;
    while (pages < MAX_ALL_PAGES) {
      const page = await send(next);
      pages += 1;
      results.push(...(Array.isArray(page?.results) ? page.results : []));
      hasMore = Boolean(page?.has_more) && Boolean(page?.next_cursor);
      if (!hasMore) break;
      next = page.next_cursor;
    }
    return {
      object: "list",
      results,
      pages,
      complete: !hasMore,
      next_cursor: hasMore ? next : null,
    };
  }

  async function me() {
    return apiRequest("/users/me");
  }

  async function status() {
    // `ok` is what a scheduled check acts on: the report always prints, and only
    // the exit code differs, so a revoked token cannot read as a healthy one.
    const report = {
      api_base_url: settings.baseUrl,
      notion_version: settings.version,
      api_key: maskToken(settings.apiKey),
      connection: null,
      bot: null,
      ok: false,
    };
    if (!settings.apiKey) {
      report.connection = "skipped: NOTION_API_KEY missing";
      return report;
    }
    // A token never has whitespace inside it. Words saved in place of the
    // value (a label, a sentence from the portal) would otherwise go to Notion
    // and come back as a 401 about the header's format, which says nothing a
    // person can act on. Named here instead, from a boolean about the value,
    // with no request made and nothing of the value printed.
    if (/\s/.test(settings.apiKey)) {
      report.connection =
        "failed: NOTION_API_KEY is not a token: it has spaces inside it, so words were copied in place of the value";
      return report;
    }
    try {
      const user = await me();
      report.connection = "ok";
      report.ok = true;
      report.bot = {
        id: user?.id ?? null,
        name: user?.name ?? null,
        workspace_name: user?.bot?.workspace_name ?? null,
      };
    } catch (error) {
      report.connection = `failed: ${scrub(error.message, settings.apiKey)}`;
    }
    return report;
  }

  async function search({ query = "", object, all = false, cursor, size } = {}) {
    const filterValue = searchObjectFilter(object);
    const limit = pageSize(size);
    return paginate(
      (start) => {
        const body = { page_size: limit };
        if (query) body.query = String(query);
        if (filterValue) body.filter = { property: "object", value: filterValue };
        if (start) body.start_cursor = start;
        return apiRequest("/search", { method: "POST", body });
      },
      { all, cursor: cursorValue(cursor) },
    );
  }

  async function page(id) {
    return apiRequest(`/pages/${notionId(id, "Page ID")}`);
  }

  async function blocks(id, { all = false, cursor, size } = {}) {
    const blockId = notionId(id, "Block or page ID");
    const limit = pageSize(size);
    return paginate(
      (start) => {
        const query = new URLSearchParams({ page_size: String(limit) });
        if (start) query.set("start_cursor", start);
        return apiRequest(`/blocks/${blockId}/children?${query}`);
      },
      { all, cursor: cursorValue(cursor) },
    );
  }

  async function database(id) {
    return apiRequest(`/databases/${notionId(id, "Database ID")}`);
  }

  async function dataSource(id) {
    return apiRequest(`/data_sources/${notionId(id, "Data source ID")}`);
  }

  // A database holds one or more data sources (tables); most hold exactly one.
  // The id in hand may be either kind and the two are not interchangeable: a
  // notion.so link carries the database's id, while `search` returns the data
  // source's id. So a database id is read first and resolved through its
  // `data_sources` list, and an id that is not a database is tried as a data
  // source before anything is blamed on sharing.
  async function resolveDataSource(id, explicit = null) {
    if (explicit !== null && explicit !== undefined) {
      return { id: notionId(explicit, "Data source ID"), source: "flag" };
    }
    const wanted = notionId(id, "Database or data source ID");
    let found;
    try {
      found = await database(wanted);
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await dataSource(wanted);
      } catch (retry) {
        if (retry.status !== 404) throw retry;
        throw new Error(
          `Neither a database nor a data source with id ${wanted} is visible to this connection. Both kinds of id were tried, so this is not a database-versus-data-source mix-up. Either the id is not one from this workspace (compare it with what \`search\` returned), or the connection has not been given access to it yet: open it in Notion, choose the \`...\` menu, then Connections, then add the connection.`,
        );
      }
      return { id: wanted, source: "data_source" };
    }
    const sources = Array.isArray(found?.data_sources) ? found.data_sources : [];
    if (sources.length === 1) {
      return { id: notionId(sources[0].id, "Data source ID"), source: "database" };
    }
    if (sources.length === 0) {
      throw new Error("The database reports no data sources.");
    }
    const listing = sources
      .map((entry) => `${entry.id} (${entry.name ?? "unnamed"})`)
      .join(", ");
    throw new Error(
      `The database has several data sources. Pass --data-source <id>. Available: ${listing}.`,
    );
  }

  // The positional id may be a database id or a data source id; see
  // resolveDataSource.
  async function query(databaseId, { dataSource: explicit, filter, sorts, all = false, cursor, size } = {}) {
    const target = notionId(databaseId, "Database or data source ID");
    const filterBody = parseJsonObject(filter, "--filter-json");
    let sortsBody = null;
    if (sorts !== undefined) {
      try {
        sortsBody = JSON.parse(String(sorts));
      } catch {
        throw new Error("--sorts-json must be valid JSON.");
      }
      if (!Array.isArray(sortsBody)) throw new Error("--sorts-json must be a JSON array.");
    }
    const limit = pageSize(size);
    const resolved = await resolveDataSource(target, explicit);
    const result = await paginate(
      (start) => {
        const body = { page_size: limit };
        if (filterBody) body.filter = filterBody;
        if (sortsBody) body.sorts = sortsBody;
        if (start) body.start_cursor = start;
        return apiRequest(`/data_sources/${resolved.id}/query`, { method: "POST", body });
      },
      { all, cursor: cursorValue(cursor) },
    );
    return { data_source_id: resolved.id, data_source_source: resolved.source, ...result };
  }

  async function readText({ text, textFile }) {
    if (text !== undefined && textFile !== undefined) {
      throw new Error("Pass either --text or --text-file, not both.");
    }
    if (text !== undefined) return String(text);
    if (textFile === undefined) return null;
    const absolutePath = path.resolve(cwd, String(textFile));
    const insideWorkspace = (relativePath) =>
      Boolean(relativePath) &&
      !relativePath.startsWith("..") &&
      !path.isAbsolute(relativePath);
    if (!insideWorkspace(path.relative(cwd, absolutePath))) {
      throw new Error("--text-file must be inside the workspace.");
    }
    // Symlinks are refused and the real paths are compared, so a link inside
    // the workspace cannot feed a file from outside it.
    if ((await fs.lstat(absolutePath)).isSymbolicLink()) {
      throw new Error("--text-file must be inside the workspace, not a symlink.");
    }
    const realCwd = await fs.realpath(cwd);
    const realPath = await fs.realpath(absolutePath);
    if (!insideWorkspace(path.relative(realCwd, realPath))) {
      throw new Error("--text-file must be inside the workspace.");
    }
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) throw new Error("--text-file is not a regular file.");
    if (stats.size > MAX_TEXT_BYTES) {
      throw new Error(`--text-file must be at most ${MAX_TEXT_BYTES} bytes.`);
    }
    return fs.readFile(realPath, "utf8");
  }

  async function append(id, { text, textFile, confirm = false } = {}) {
    const pageId = notionId(id, "Page ID");
    const content = await readText({ text, textFile });
    if (content === null) throw new Error("append requires --text or --text-file.");
    const children = textToBlocks(content);
    const resourcePath = `/blocks/${pageId}/children`;
    const body = { children };
    const plan = {
      action: "append blocks to page",
      page_id: pageId,
      block_count: children.length,
      request: planRequest("PATCH", resourcePath, body),
    };
    if (!confirm) {
      return { dry_run: true, ...plan, next_step: "Re-run with --confirm to append." };
    }
    const result = await apiRequest(resourcePath, { method: "PATCH", body, confirm: true });
    return { dry_run: false, ...plan, result };
  }

  async function createPage({
    parent,
    parentType = "page",
    dataSource: explicit,
    title,
    text,
    textFile,
    confirm = false,
  } = {}) {
    const type = nonEmptyText(parentType, "--parent-type").toLowerCase();
    if (type !== "page" && type !== "database") {
      throw new Error("--parent-type must be 'page' or 'database'.");
    }
    const parentId = notionId(parent, "Parent ID");
    const pageTitle = nonEmptyText(title, "--title");
    if (pageTitle.length > MAX_TITLE_CHARS) {
      throw new Error(`--title must be at most ${MAX_TITLE_CHARS} characters.`);
    }
    const content = await readText({ text, textFile });
    const children = content === null ? [] : textToBlocks(content);

    let parentBody;
    let dataSourceId = null;
    if (type === "page") {
      parentBody = { type: "page_id", page_id: parentId };
    } else {
      const resolved = await resolveDataSource(parentId, explicit);
      dataSourceId = resolved.id;
      parentBody = { type: "data_source_id", data_source_id: resolved.id };
    }

    const body = {
      parent: parentBody,
      // "title" is the fixed id of the title property, whatever its name.
      properties: { title: { title: richText(pageTitle) } },
    };
    if (children.length > 0) body.children = children;

    const plan = {
      action: "create page",
      parent_type: type,
      parent_id: parentId,
      data_source_id: dataSourceId,
      title: pageTitle,
      block_count: children.length,
      request: planRequest("POST", "/pages", body),
    };
    if (!confirm) {
      return { dry_run: true, ...plan, next_step: "Re-run with --confirm to create the page." };
    }
    const result = await apiRequest("/pages", { method: "POST", body, confirm: true });
    return { dry_run: false, ...plan, result };
  }

  return {
    settings,
    apiRequest,
    me,
    status,
    search,
    page,
    blocks,
    database,
    dataSource,
    resolveDataSource,
    query,
    append,
    createPage,
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS = {
  "--json": { key: "json", boolean: true },
  "--compact": { key: "compact", boolean: true },
};

const PAGINATION_FLAGS = {
  "--page-size": { key: "size" },
  "--cursor": { key: "cursor" },
  "--all": { key: "all", boolean: true },
};

const TEXT_FLAGS = {
  "--text": { key: "text" },
  "--text-file": { key: "textFile" },
  "--confirm": { key: "confirm", boolean: true },
};

const COMMANDS = {
  me: { flags: {} },
  status: { flags: {} },
  search: { positional: "query", optionalPositional: true, flags: { ...PAGINATION_FLAGS, "--object": { key: "object" } } },
  page: { positional: "page id", flags: {} },
  blocks: { positional: "page or block id", flags: PAGINATION_FLAGS },
  database: { positional: "database id", flags: {} },
  "data-source": { positional: "data source id", flags: {} },
  query: {
    positional: "database or data source id",
    flags: {
      ...PAGINATION_FLAGS,
      "--data-source": { key: "dataSource" },
      "--filter-json": { key: "filter" },
      "--sorts-json": { key: "sorts" },
    },
  },
  append: { positional: "page id", flags: TEXT_FLAGS },
  "create-page": {
    flags: {
      ...TEXT_FLAGS,
      "--parent": { key: "parent" },
      "--parent-type": { key: "parentType" },
      "--data-source": { key: "dataSource" },
      "--title": { key: "title" },
    },
  },
};

export function parseArgs(args, flagSpec) {
  const spec = { ...GLOBAL_FLAGS, ...flagSpec };
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const specification = spec[token];
    if (!specification) throw new Error(`Unsupported option '${token}'.`);
    if (specification.boolean) {
      options[specification.key] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) throw new Error(`${token} requires a value.`);
    index += 1;
    if (options[specification.key] !== undefined) {
      throw new Error(`${token} must not be repeated.`);
    }
    options[specification.key] = value;
  }
  return { options, positional };
}

export function helpText() {
  return `Usage: node notion.mjs <command> [options]

Reads a Notion workspace through the public API (Notion-Version ${NOTION_VERSION}).
Output is JSON. The token comes from the environment: NOTION_API_KEY. Only pages
and databases the connection has been given access to are visible.

Commands:
  me                                The connection's bot user
  status                            Masked token check and connection test (no secrets)
  search [query]                    Search connected pages and data sources
      [--object page|database] [--page-size 1..${MAX_PAGE_SIZE}] [--cursor <c>] [--all]
  page <id>                         One page's properties (not its content)
  blocks <id>                       Children of a page or block [--page-size] [--cursor] [--all]
  database <id>                     A database and its data sources
  data-source <id>                  One data source and its property schema
  query <database or data source id>
                                    Rows of a database [--filter-json <json>]
      [--sorts-json <json>] [--data-source <id>] [--page-size] [--cursor] [--all]
  append <page id>                  Dry run of appending blocks (a write)
      --text <text> | --text-file <path> [--confirm]
  create-page --parent <id>         Dry run of creating a page (a write)
      --title <text> [--parent-type page|database] [--data-source <id>]
      [--text <text> | --text-file <path>] [--confirm]

Global options:
  --json                  Accepted for clarity; JSON is always the output
  --compact               Print JSON on one line

Ids are 32 hex characters with or without dashes; a notion.so link works too.
A database contains data sources (the tables) and rows live in a data source.
The two ids are not interchangeable: a notion.so link carries the database id,
while search returns the data source id. query and create-page --parent-type
database accept either and resolve the rest themselves.
--all walks pages of results (at most ${MAX_ALL_PAGES}). Requests are limited to
${MAX_REQUESTS_PER_SECOND} per second. A 429 is retried at most ${MAX_RETRIES} times, a write included, because
Notion refused it before doing any work. A 409 or a 5xx is retried for reads
only: Notion does not promise either was rolled back, so a confirmed write that
answers 409 or 5xx surfaces at once rather than risk duplicate blocks. Check the
page before running it again. Waits follow Retry-After (or the same wait in the
body), capped at ${MAX_RETRY_DELAY_MS / 1000} seconds, because a workspace-wide 429 can ask for
longer than a minute.
Writes are refused without --confirm; the dry run prints the planned request.
`;
}

function printJson(write, value, compact, secret) {
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  write(scrub(text, secret));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const secret = String((deps.env ?? process.env).NOTION_API_KEY ?? "").trim();

  try {
    const [command, ...rest] = argv;
    if (!command || command === "help" || command === "--help") {
      stdout(helpText());
      return 0;
    }
    const definition = COMMANDS[command];
    if (!definition) {
      throw new Error(`Unknown command '${command}'. Run with --help.`);
    }
    const { options, positional } = parseArgs(rest, definition.flags);
    if (definition.positional) {
      const allowed = definition.optionalPositional ? [0, 1] : [1];
      if (!allowed.includes(positional.length)) {
        throw new Error(`${command} requires exactly one ${definition.positional}.`);
      }
    } else if (positional.length > 0) {
      throw new Error(`${command} does not take positional arguments.`);
    }

    const client = createClient(deps);
    const out = (value) => printJson(stdout, value, Boolean(options.compact), secret);

    switch (command) {
      case "me":
        out(await client.me());
        return 0;
      case "status": {
        // The report always prints, healthy or not; only the exit code differs,
        // so a schedule can tell a revoked token from a working one.
        const report = await client.status();
        out(report);
        return report.ok ? 0 : 1;
      }
      case "search":
        out(await client.search({ query: positional[0] ?? "", ...options }));
        return 0;
      case "page":
        out(await client.page(positional[0]));
        return 0;
      case "blocks":
        out(await client.blocks(positional[0], options));
        return 0;
      case "database":
        out(await client.database(positional[0]));
        return 0;
      case "data-source":
        out(await client.dataSource(positional[0]));
        return 0;
      case "query":
        out(await client.query(positional[0], options));
        return 0;
      case "append":
        out(await client.append(positional[0], options));
        return 0;
      case "create-page":
        out(await client.createPage(options));
        return 0;
      default:
        throw new Error(`Unknown command '${command}'.`);
    }
  } catch (error) {
    stderr(`error: ${scrub(error?.message ?? String(error), secret)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
