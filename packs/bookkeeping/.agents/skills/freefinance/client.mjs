#!/usr/bin/env node
// FreeFinance API v2 client for the freefinance skill.
//
// Zero dependencies, Node 24, ESM. Credentials come from the environment only:
//   FREEFINANCE_API_CLIENT_ID      technical user id (sensitive)
//   FREEFINANCE_API_CLIENT_SECRET  technical user secret (sensitive)
//   FREEFINANCE_CLIENT_ID          optional numeric Mandant override (not sensitive)
//   FREEFINANCE_API_BASE_URL       optional, defaults to https://app.freefinance.at
//
// Every command is a read (HTTP GET) except `upload-staging --confirm`, which is
// the single allowed write: a multipart POST to the DMS staging folder. The write
// policy is enforced in one place (assertWriteAllowed) so no other method or path
// can ever be sent, whatever the command layer does.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "https://app.freefinance.at";
export const PROFILE_RELATIVE_PATH = path.join("bookkeeping", "profile.json");
export const MAX_STAGING_BYTES = 2 * 1024 * 1024;
export const MAX_API_PAGE_SIZE = 500;
export const MAX_ALL_PAGES = 20;
export const PAGE_DELAY_MS = 150;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STAGING_WRITE_PATH = /^\/clients\/\d+\/doc\/providers\/DMS\/staging$/;

export const ACCOUNT_USES = new Set([
  "ASSET",
  "INCOME",
  "EXPENSE",
  "OUTGOING_INVOICE_CONTRA",
  "INCOMING_INVOICE_CONTRA",
  "MEANS_OF_PAYMENT",
  "CUSTOMER_DEFAULT",
  "SUPPLIER_DEFAULT",
  "PRIVATE_PART_ACCOUNTS",
  "RECEIVABLES",
  "RECEIVABLES_CUSTOMER",
  "PAYABLES",
  "PAYABLES_SUPPLIER",
  "BANK",
  "CASH",
  "MONEY_BOOKS",
  "POS",
  "POS_CONTRA",
  "INV",
  "INV_CONTRA",
  "PRIVATE_PART_DEFAULT",
  "RECEIVABLES_DEFAULT",
  "RECEIVABLES_CUSTOMER_DEFAULT",
  "PAYABLES_DEFAULT",
  "PAYABLES_SUPPLIER_DEFAULT",
  "ASSET_END_BOOK_VAL_DEFAULT",
  "OPENING_BALANCE_DEFAULT",
  "YEARLY_WINNINGS_LOSSES_DEFAULT",
  "GUV_DEFAULT",
  "ROUNDING_DIFFERENCE_INCOME",
  "DISCOUNT_INCOME",
  "ROUNDING_DIFFERENCE_OUTGO",
  "DISCOUNT_OUTGO",
  "IRRECOVERABLE_OUTGO",
]);

const PAID_STATES = new Set(["PAID", "UNPAID", "OVERDUE"]);
const STATEMENT_STATES = new Set(["NEW", "IN_PROGRESS", "RECONCILED", "DELETED"]);
const LINE_TYPES = new Set([
  "NEW",
  "SKIPPED",
  "RECONCILED",
  "BOOKED",
  "IN_PROGRESS",
  "BOOKED_AND_SKIPPED",
  "NOT_RECONCILED",
]);
const AMOUNT_TYPES = new Set(["ALL", "NEGATIVE", "POSITIVE"]);
const JOURNAL_RESOURCES = new Map([
  ["income", "income_journals"],
  ["outgo", "outgo_journals"],
]);

const SIDE_EFFECT_FIELD_TOKENS = new Set([
  "pay",
  "paid",
  "payment",
  "payments",
  "settle",
  "settled",
  "settlement",
  "book",
  "booked",
  "booking",
  "bookings",
  "reconcile",
  "reconciled",
  "reconciliation",
  "cancel",
  "cancelled",
  "cancellation",
  "delete",
  "finalize",
  "finalized",
  "submit",
  "transmit",
]);

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error("FreeFinance API base URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("FreeFinance API base URL must use HTTPS.");
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function buildApiUrl(baseUrl, resourcePath) {
  if (!resourcePath.startsWith("/")) {
    throw new Error("API resource path must start with '/'.");
  }
  if (resourcePath.includes("..")) {
    throw new Error("API resource path must not contain '..'.");
  }
  return `${normalizeBaseUrl(baseUrl)}/api/2.0${resourcePath}`;
}

export function numericClientId(clientId) {
  const value = String(clientId ?? "");
  if (!/^\d+$/.test(value)) {
    throw new Error("FreeFinance client ID must be numeric.");
  }
  return value;
}

export function resourceUuid(value, label) {
  const normalized = String(value ?? "");
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return normalized;
}

export function isoDate(value, label) {
  const normalized = String(value ?? "");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (!match) throw new Error(`${label} must use YYYY-MM-DD.`);

  const [, year, month, day] = match.map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a valid calendar date.`);
  }
  return normalized;
}

export function nonEmptyText(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} must be non-empty and contain no control characters.`);
  }
  return normalized;
}

export function booleanValue(value, label) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${label} must be 'true' or 'false'.`);
}

export function pageLimit(value = MAX_API_PAGE_SIZE) {
  const normalized = Number(value);
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_API_PAGE_SIZE
  ) {
    throw new Error(`API limit must be an integer from 1 to ${MAX_API_PAGE_SIZE}.`);
  }
  return String(normalized);
}

export function pageOffset(value = null) {
  if (value === null || value === undefined) return null;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error("API offset must be a non-negative integer.");
  }
  return String(normalized);
}

function enumValue(value, allowed, label) {
  const normalized = nonEmptyText(value, label).toUpperCase();
  if (!allowed.has(normalized)) {
    throw new Error(`Unsupported ${label.toLowerCase()} '${value}'.`);
  }
  return normalized;
}

function appendPagination(query, options) {
  query.set("limit", pageLimit(options.limit));
  const offset = pageOffset(options.offset);
  if (offset !== null) query.set("offset", offset);
  if (options.sort !== undefined) {
    query.set("sort", nonEmptyText(options.sort, "Sort expression"));
  }
}

export function ensureDateRange(options) {
  const from = options.from === undefined ? null : isoDate(options.from, "From date");
  const to = options.to === undefined ? null : isoDate(options.to, "To date");
  if (from && to && from > to) {
    throw new Error("From date must not be after to date.");
  }
  return { from, to };
}

function appendDateRange(query, options) {
  const { from, to } = ensureDateRange(options);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
}

function pathWithQuery(basePath, query) {
  const serialized = query.toString();
  return serialized ? `${basePath}?${serialized}` : basePath;
}

export function normalizedFieldTokens(field) {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function rejectSideEffectFields(value, location = "input") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      rejectSideEffectFields(entry, `${location}[${index}]`),
    );
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const [field, nestedValue] of Object.entries(value)) {
    if (
      normalizedFieldTokens(field).some((token) =>
        SIDE_EFFECT_FIELD_TOKENS.has(token),
      )
    ) {
      throw new Error(
        `Unsafe payment, booking, or reconciliation field '${location}.${field}' is not allowed.`,
      );
    }
    rejectSideEffectFields(nestedValue, `${location}.${field}`);
  }
}

export function assertWriteAllowed(method, resourcePath, fields) {
  const normalizedMethod = String(method ?? "GET").toUpperCase();
  if (normalizedMethod === "GET") return;

  const bare = resourcePath.split("?")[0];
  if (normalizedMethod !== "POST" || !STAGING_WRITE_PATH.test(bare)) {
    throw new Error(
      `Write policy: ${normalizedMethod} ${bare} is not allowed. The only write this skill performs is a document upload to the DMS staging folder.`,
    );
  }
  rejectSideEffectFields(fields ?? {}, "metadata");
}

export function mimeTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".pdf": "application/pdf",
    ".png": "image/png",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".webp": "image/webp",
    ".xml": "application/xml",
  };
  return types[extension] ?? null;
}

export function maskIdentity(value) {
  const text = String(value ?? "");
  // Reveal the last four characters only, and only when they are a small part
  // of the value. The status output is meant to be pasted into chat.
  if (text.length >= 12) return `...${text.slice(-4)}`;
  return text ? "configured" : "missing";
}

// Removes every credential value from text bound for stdout or stderr, so an
// error body that echoes one is never printed.
export function scrub(text, secrets) {
  let message = String(text ?? "");
  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    // Values shorter than eight characters are not credentials and would
    // mangle ordinary numbers in the output.
    if (typeof secret === "string" && secret.length >= 8) {
      message = message.split(secret).join("***");
    }
  }
  return message;
}

export function issuerTokenUrl(issuerUrl, baseUrl) {
  let parsed;
  try {
    parsed = new URL(String(issuerUrl));
  } catch {
    throw new Error("FreeFinance issuer URL is not a valid URL.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("FreeFinance issuer URL must use HTTPS.");
  }
  // The issuer may be the API host itself, or a sibling host under the API
  // host's parent (app.example.test allows accounts.example.test). Comparing
  // the last two labels would let any host on a public suffix such as co.uk
  // through, so the rule is anchored on the configured host instead.
  const baseHost = new URL(normalizeBaseUrl(baseUrl)).hostname;
  const issuerHost = parsed.hostname;
  const baseLabels = baseHost.split(".");
  const siblingSuffix =
    baseLabels.length >= 3 ? `.${baseLabels.slice(1).join(".")}` : null;
  const onApiDomain =
    issuerHost === baseHost ||
    (siblingSuffix !== null && issuerHost.endsWith(siblingSuffix));
  if (!onApiDomain) {
    throw new Error("FreeFinance issuer URL is not on the API's domain.");
  }
  parsed.search = "";
  parsed.hash = "";
  return `${parsed.toString().replace(/\/$/, "")}/protocol/openid-connect/token`;
}

// ---------------------------------------------------------------------------
// Resource path builders (pure)
// ---------------------------------------------------------------------------

export function clientsPath(options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  return pathWithQuery("/clients", query);
}

export function paymentAccountsPath(clientId, options = {}) {
  const query = new URLSearchParams();
  query.set(
    "visible",
    String(
      options.visible === undefined ? true : booleanValue(options.visible, "Visible"),
    ),
  );
  appendPagination(query, options);
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/cbs/payment_accounts`,
    query,
  );
}

export function bankStatementsPath(clientId, options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  appendDateRange(query, options);
  if (options.paymentAccount !== undefined) {
    query.set(
      "payment_account",
      resourceUuid(options.paymentAccount, "Payment account ID"),
    );
  }
  for (const state of listValues(options.state)) {
    query.append("states", enumValue(state, STATEMENT_STATES, "Statement state"));
  }
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/bsl/bank_statements`,
    query,
  );
}

export function bankStatementLinesPath(clientId, statementId, options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  appendDateRange(query, options);
  if (options.lineType !== undefined) {
    query.set("line_type", enumValue(options.lineType, LINE_TYPES, "Line type"));
  }
  if (options.amountType !== undefined) {
    query.set(
      "amount_type",
      enumValue(options.amountType, AMOUNT_TYPES, "Amount type"),
    );
  }
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/bsl/bank_statements/${resourceUuid(
      statementId,
      "Bank statement ID",
    )}/lines`,
    query,
  );
}

export function stagingPath(clientId, options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/doc/providers/DMS/staging`,
    query,
  );
}

export function journalsPath(clientId, journalType, options = {}) {
  const resource = JOURNAL_RESOURCES.get(journalType);
  if (!resource) throw new Error("Journal type must be 'income' or 'outgo'.");
  const query = new URLSearchParams();
  appendPagination(query, options);
  appendDateRange(query, options);
  if (options.search !== undefined) {
    query.set("search", nonEmptyText(options.search, "Search text"));
  }
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/cba/${resource}`,
    query,
  );
}

export function incomingInvoicesPath(clientId, options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  appendDateRange(query, options);
  if (options.search !== undefined) {
    query.set("search_text", nonEmptyText(options.search, "Search text"));
  }
  for (const state of listValues(options.paidState)) {
    query.append("paid_state", enumValue(state, PAID_STATES, "Paid state"));
  }
  if (options.currency !== undefined) {
    const currency = nonEmptyText(options.currency, "Currency").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new Error("Currency must be a three-letter ISO code.");
    }
    query.set("currency", currency);
  }
  if (options.includeCancelled !== undefined) {
    query.set(
      "include_cancelled",
      String(booleanValue(options.includeCancelled, "Include cancelled")),
    );
  }
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/cbi/incoming_invoices`,
    query,
  );
}

export function invoiceBookingsPath(clientId, invoiceId, options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/cbi/incoming_invoices/${resourceUuid(
      invoiceId,
      "Invoice ID",
    )}/bookings`,
    query,
  );
}

export function accountsPath(clientId, options = {}) {
  const query = new URLSearchParams();
  appendPagination(query, options);
  if (options.use !== undefined) {
    query.set("use", enumValue(options.use, ACCOUNT_USES, "Account use"));
  }
  if (options.effectiveDate !== undefined) {
    query.set("effective_date", isoDate(options.effectiveDate, "Effective date"));
  }
  if (options.code !== undefined) {
    query.set("code", nonEmptyText(options.code, "Account code"));
  }
  if (options.search !== undefined) {
    query.set("search_text", nonEmptyText(options.search, "Search text"));
  }
  for (const [option, parameter, label] of [
    ["visible", "visible", "Visible"],
    ["available", "available", "Available"],
    ["paymentAccounts", "payment_accounts", "Payment accounts"],
    ["used", "used", "Used"],
  ]) {
    if (options[option] !== undefined) {
      query.set(parameter, String(booleanValue(options[option], label)));
    }
  }
  return pathWithQuery(`/clients/${numericClientId(clientId)}/cbs/accounts`, query);
}

export function taxClassesPath(clientId, options = {}) {
  const query = new URLSearchParams();
  if (options.effectiveDate !== undefined) {
    query.set("effective_date", isoDate(options.effectiveDate, "Effective date"));
  }
  if (options.sort !== undefined) {
    query.set("sort", nonEmptyText(options.sort, "Sort expression"));
  }
  return pathWithQuery(
    `/clients/${numericClientId(clientId)}/fis/tax_classes`,
    query,
  );
}

function listValues(value) {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : String(value).split(",");
  if (values.length === 0) throw new Error("List option must not be empty.");
  return values;
}

// ---------------------------------------------------------------------------
// HTTP layer
// ---------------------------------------------------------------------------

async function fetchJson(fetchImpl, url, options, context) {
  const response = await fetchImpl(url, options);
  const raw = await response.text();
  let body = null;

  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (!response.ok) {
    const detail =
      body?.error_description ??
      body?.message ??
      body?.error ??
      (typeof body === "string" ? body.slice(0, 200) : "Request failed");
    const identifier = body?.identifier ? ` [${body.identifier}]` : "";
    const error = new Error(
      `${context} failed (${response.status})${identifier}: ${detail}`,
    );
    error.status = response.status;
    throw error;
  }

  return body;
}

export function readSettings(env = process.env) {
  const settings = {
    baseUrl: normalizeBaseUrl(env.FREEFINANCE_API_BASE_URL || DEFAULT_BASE_URL),
    apiClientId: String(env.FREEFINANCE_API_CLIENT_ID ?? "").trim(),
    apiClientSecret: String(env.FREEFINANCE_API_CLIENT_SECRET ?? ""),
    clientId: String(env.FREEFINANCE_CLIENT_ID ?? "").trim() || null,
  };
  return settings;
}

function requireCredentials(settings) {
  if (!settings.apiClientId || !settings.apiClientSecret) {
    throw new Error(
      "Set FREEFINANCE_API_CLIENT_ID and FREEFINANCE_API_CLIENT_SECRET in the environment.",
    );
  }
}

export function createClient({
  env = process.env,
  fetch: fetchImpl = globalThis.fetch,
  cwd = process.cwd(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const settings = readSettings(env);
  const credentials = [settings.apiClientSecret, settings.apiClientId];
  let cachedToken = null;

  async function mintToken() {
    requireCredentials(settings);
    const issuer = await fetchJson(
      fetchImpl,
      buildApiUrl(settings.baseUrl, "/auth/issuer"),
      { headers: { Accept: "application/json" } },
      "FreeFinance issuer discovery",
    );
    if (!issuer?.url) {
      throw new Error("FreeFinance issuer discovery returned no issuer URL.");
    }

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: settings.apiClientId,
      client_secret: settings.apiClientSecret,
    });
    // The secret is only ever posted to an HTTPS endpoint on the API's own
    // domain, whatever issuer discovery answers.
    const tokenUrl = issuerTokenUrl(issuer.url, settings.baseUrl);
    const token = await fetchJson(
      fetchImpl,
      tokenUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form,
      },
      "FreeFinance token request",
    );
    if (!token?.access_token) {
      throw new Error("FreeFinance token response contained no access token.");
    }
    cachedToken = token.access_token;
    return cachedToken;
  }

  async function getAccessToken() {
    return cachedToken ?? mintToken();
  }

  async function apiRequest(resourcePath, options = {}) {
    const method = String(options.method ?? "GET").toUpperCase();
    assertWriteAllowed(method, resourcePath, options.fields);

    const send = async (token) =>
      fetchJson(
        fetchImpl,
        buildApiUrl(settings.baseUrl, resourcePath),
        {
          method,
          body: options.body,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...options.headers,
          },
        },
        `FreeFinance ${method} ${resourcePath.split("?")[0]}`,
      );

    try {
      return await send(await getAccessToken());
    } catch (error) {
      if (error.status !== 401) throw error;
      // Tokens live about five minutes. Re-mint once with the same credentials.
      cachedToken = null;
      return send(await mintToken());
    }
  }

  async function listAll(buildPath, options) {
    const limit = Number(pageLimit(options.limit));
    let offset = Number(pageOffset(options.offset) ?? 0);
    const content = [];
    let totalCount = null;
    let pages = 0;

    while (pages < MAX_ALL_PAGES) {
      if (pages > 0) await sleep(PAGE_DELAY_MS);
      const page = await apiRequest(buildPath({ ...options, limit, offset }));
      pages += 1;
      const entries = Array.isArray(page?.content) ? page.content : [];
      content.push(...entries);
      if (typeof page?.total_count === "number") totalCount = page.total_count;
      offset += entries.length;
      const exhausted =
        entries.length < limit || (totalCount !== null && offset >= totalCount);
      if (exhausted) break;
    }

    return {
      content,
      total_count: totalCount ?? content.length,
      pages,
      complete: totalCount === null ? true : content.length >= totalCount,
    };
  }

  async function list(buildPath, options = {}) {
    if (options.all) return listAll(buildPath, options);
    return apiRequest(buildPath(options));
  }

  async function readProfileClientId() {
    let raw;
    try {
      raw = await fs.readFile(path.join(cwd, PROFILE_RELATIVE_PATH), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    let profile;
    try {
      profile = JSON.parse(raw);
    } catch {
      throw new Error(`${PROFILE_RELATIVE_PATH} is not valid JSON.`);
    }
    const value = profile?.freefinance?.client_id;
    return value === undefined || value === null || value === ""
      ? null
      : numericClientId(value);
  }

  async function resolveClientId(explicit = null) {
    if (explicit !== null && explicit !== undefined) {
      return { id: numericClientId(explicit), source: "flag" };
    }
    if (settings.clientId) {
      return { id: numericClientId(settings.clientId), source: "env" };
    }
    const fromProfile = await readProfileClientId();
    if (fromProfile) return { id: fromProfile, source: "profile" };

    const clients = await apiRequest(clientsPath());
    const visible = Array.isArray(clients?.content) ? clients.content : [];
    if (visible.length === 1) {
      return { id: numericClientId(visible[0].id), source: "auto" };
    }
    const listing = visible
      .map((client) => `${client.id} (${client.display_name ?? "unnamed"})`)
      .join(", ");
    throw new Error(
      visible.length === 0
        ? "No FreeFinance client is visible to this technical user."
        : `Several FreeFinance clients are visible. Pass --client <id>, set FREEFINANCE_CLIENT_ID, or record freefinance.client_id in ${PROFILE_RELATIVE_PATH}. Visible: ${listing}.`,
    );
  }

  async function uploadStaging({
    clientId,
    filePath,
    description = null,
    skipOcr = false,
    confirm = false,
  }) {
    if (!filePath) throw new Error("upload-staging requires --file <path>.");
    const absolutePath = path.resolve(cwd, filePath);
    const relativePath = path.relative(cwd, absolutePath);
    const insideWorkspace = (relative) =>
      Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
    if (!insideWorkspace(relativePath)) {
      throw new Error("Upload source must be inside the workspace.");
    }
    const fileName = path.basename(absolutePath);
    const contentType = mimeTypeFor(absolutePath);
    if (!contentType) {
      throw new Error(
        "Unsupported staging file type. Use pdf, xml, gif, jpg, jpeg, png, tif, tiff or webp.",
      );
    }
    // Symlinks are refused and the real paths are compared, so a link inside
    // the workspace cannot upload a file from outside it.
    if ((await fs.lstat(absolutePath)).isSymbolicLink()) {
      throw new Error("Upload source must be inside the workspace, not a symlink.");
    }
    const realCwd = await fs.realpath(cwd);
    const realPath = await fs.realpath(absolutePath);
    if (!insideWorkspace(path.relative(realCwd, realPath))) {
      throw new Error("Upload source must be inside the workspace.");
    }
    const stats = await fs.stat(realPath);
    if (!stats.isFile()) throw new Error("Upload source is not a regular file.");
    if (stats.size > MAX_STAGING_BYTES) {
      throw new Error("FreeFinance staging uploads are limited to 2 MiB.");
    }
    const metadata = {};
    if (description !== null) {
      metadata.description = nonEmptyText(description, "Description");
    }
    if (skipOcr) metadata.skip_ocr = true;

    // The Mandant is part of the plan the user confirms, so resolve it before
    // the dry run, not after.
    const resolved = await resolveClientId(clientId);

    const plan = {
      action: "upload to FreeFinance DMS staging",
      client_id: resolved.id,
      client_source: resolved.source,
      file: relativePath,
      file_name: fileName,
      bytes: stats.size,
      content_type: contentType,
      description: metadata.description ?? null,
      skip_ocr: skipOcr,
    };

    if (!confirm) {
      return {
        dry_run: true,
        ...plan,
        next_step: "Re-run with --confirm to perform this upload.",
      };
    }

    const existing = await listAll((options) => stagingPath(resolved.id, options), {});
    if (existing.content.some((file) => file.file_name === fileName)) {
      throw new Error(`A staging file named '${fileName}' already exists.`);
    }

    const bytes = await fs.readFile(realPath);
    const form = new FormData();
    if (Object.keys(metadata).length > 0) {
      form.append(
        "metadata",
        new Blob([JSON.stringify(metadata)], { type: "application/json" }),
      );
    }
    form.append("content", new Blob([bytes], { type: contentType }), fileName);

    const result = await apiRequest(
      `/clients/${resolved.id}/doc/providers/DMS/staging`,
      { method: "POST", body: form, fields: metadata },
    );
    return { dry_run: false, ...plan, result };
  }

  async function status(clientId) {
    const report = {
      base_url: settings.baseUrl,
      api_client_id: maskIdentity(settings.apiClientId),
      api_client_secret: settings.apiClientSecret ? "configured" : "missing",
      client_id: "not selected",
      client_source: null,
      token: null,
    };
    if (!settings.apiClientId || !settings.apiClientSecret) {
      report.token = "skipped: credentials missing";
      return report;
    }
    try {
      await mintToken();
      report.token = "ok";
    } catch (error) {
      report.token = `failed: ${scrub(error.message, credentials)}`;
      return report;
    }
    try {
      const resolved = await resolveClientId(clientId);
      report.client_id = resolved.id;
      report.client_source = resolved.source;
    } catch (error) {
      report.client_id = `not selected: ${scrub(error.message, credentials)}`;
    }
    return report;
  }

  return {
    settings,
    getAccessToken,
    apiRequest,
    list,
    resolveClientId,
    uploadStaging,
    status,
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const GLOBAL_FLAGS = {
  "--client": { key: "client" },
  "--json": { key: "json", boolean: true },
  "--compact": { key: "compact", boolean: true },
};

const PAGINATION_FLAGS = {
  "--limit": { key: "limit" },
  "--offset": { key: "offset" },
  "--sort": { key: "sort" },
  "--all": { key: "all", boolean: true },
};

const DATE_RANGE_FLAGS = {
  "--since": { key: "from" },
  "--until": { key: "to" },
};

const COMMANDS = {
  status: { flags: {} },
  clients: { flags: PAGINATION_FLAGS },
  "payment-accounts": {
    flags: { ...PAGINATION_FLAGS, "--visible": { key: "visible" } },
  },
  "bank-statements": {
    flags: {
      ...PAGINATION_FLAGS,
      ...DATE_RANGE_FLAGS,
      "--state": { key: "state", repeat: true },
      "--payment-account": { key: "paymentAccount" },
    },
  },
  "bank-statement-lines": {
    positional: "statement UUID",
    flags: {
      ...PAGINATION_FLAGS,
      ...DATE_RANGE_FLAGS,
      "--line-type": { key: "lineType" },
      "--amount-type": { key: "amountType" },
    },
  },
  "income-journals": {
    flags: { ...PAGINATION_FLAGS, ...DATE_RANGE_FLAGS, "--search": { key: "search" } },
  },
  "outgo-journals": {
    flags: { ...PAGINATION_FLAGS, ...DATE_RANGE_FLAGS, "--search": { key: "search" } },
  },
  "incoming-invoices": {
    flags: {
      ...PAGINATION_FLAGS,
      ...DATE_RANGE_FLAGS,
      "--search": { key: "search" },
      "--paid-state": { key: "paidState", repeat: true },
      "--currency": { key: "currency" },
      "--include-cancelled": { key: "includeCancelled" },
    },
  },
  "invoice-bookings": { positional: "invoice UUID", flags: PAGINATION_FLAGS },
  accounts: {
    flags: {
      ...PAGINATION_FLAGS,
      "--use": { key: "use" },
      "--effective-date": { key: "effectiveDate" },
      "--code": { key: "code" },
      "--search": { key: "search" },
      "--visible": { key: "visible" },
      "--available": { key: "available" },
      "--payment-accounts": { key: "paymentAccounts" },
      "--used": { key: "used" },
    },
  },
  "tax-classes": {
    flags: { "--effective-date": { key: "effectiveDate" }, "--sort": { key: "sort" } },
  },
  staging: { flags: PAGINATION_FLAGS },
  "upload-staging": {
    flags: {
      "--file": { key: "file" },
      "--description": { key: "description" },
      "--skip-ocr": { key: "skipOcr", boolean: true },
      "--confirm": { key: "confirm", boolean: true },
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
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${token} requires a value.`);
    }
    index += 1;
    if (specification.repeat) {
      options[specification.key] ??= [];
      options[specification.key].push(...value.split(","));
    } else {
      if (options[specification.key] !== undefined) {
        throw new Error(`${token} must not be repeated.`);
      }
      options[specification.key] = value;
    }
  }
  return { options, positional };
}

export function helpText() {
  return `Usage: node client.mjs <command> [options]

Reads a FreeFinance (API v2) client. Output is JSON. Credentials come from the
environment: FREEFINANCE_API_CLIENT_ID and FREEFINANCE_API_CLIENT_SECRET.

Commands:
  status                            Masked identity and a token check (no secrets)
  clients                           List the clients (Mandanten) this user can see
  payment-accounts                  List payment accounts [--visible true|false]
  bank-statements                   List bank statement headers
      [--since YYYY-MM-DD] [--until YYYY-MM-DD]
      [--state NEW|IN_PROGRESS|RECONCILED|DELETED] [--payment-account <uuid>]
  bank-statement-lines <uuid>       List the lines of one statement
      [--since] [--until] [--line-type NEW|SKIPPED|RECONCILED|BOOKED|IN_PROGRESS|
      BOOKED_AND_SKIPPED|NOT_RECONCILED] [--amount-type ALL|NEGATIVE|POSITIVE]
  income-journals                   Realised income journals [--since] [--until] [--search]
  outgo-journals                    Realised expense journals [--since] [--until] [--search]
  incoming-invoices                 Incoming invoices [--since] [--until] [--search]
      [--paid-state PAID|UNPAID|OVERDUE] [--currency EUR] [--include-cancelled true|false]
  invoice-bookings <uuid>           Bookings of one incoming invoice
  accounts                          Chart of accounts [--use <ACCOUNT_USE>]
      [--effective-date] [--code] [--search] [--visible] [--available]
  tax-classes                       Tax classes [--effective-date] [--sort]
  staging                           Files waiting in the DMS staging folder
  upload-staging --file <path>      Dry run of a staging upload (the only write)
      [--description <text>] [--skip-ocr] [--confirm]

Global options:
  --client <numeric id>   Mandant to use (else FREEFINANCE_CLIENT_ID, else
                          bookkeeping/profile.json, else the only visible client)
  --json                  Accepted for clarity; JSON is always the output
  --compact               Print JSON on one line

List options:
  --limit 1..500  --offset N  --sort <expr>  --all (walk every page, max ${MAX_ALL_PAGES})
`;
}

function printJson(write, value, compact, secrets) {
  const text = compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  write(scrub(text, secrets));
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const stdout = deps.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = deps.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  // Both credential values are scrubbed from everything written to stdout or
  // stderr, so an error body that echoes one never reaches the terminal.
  const env = deps.env ?? process.env;
  const secrets = [
    String(env.FREEFINANCE_API_CLIENT_SECRET ?? ""),
    String(env.FREEFINANCE_API_CLIENT_ID ?? "").trim(),
  ];

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
      if (positional.length !== 1) {
        throw new Error(`${command} requires exactly one ${definition.positional}.`);
      }
    } else if (positional.length > 0) {
      throw new Error(`${command} does not take positional arguments.`);
    }

    const client = createClient(deps);
    const clientFlag = options.client ?? null;
    const compact = Boolean(options.compact);
    const out = (value) => printJson(stdout, value, compact, secrets);
    const mandant = async () => (await client.resolveClientId(clientFlag)).id;

    switch (command) {
      case "status":
        out(await client.status(clientFlag));
        return 0;
      case "clients":
        out(await client.list(clientsPath, options));
        return 0;
      case "payment-accounts": {
        const id = await mandant();
        out(await client.list((o) => paymentAccountsPath(id, o), options));
        return 0;
      }
      case "bank-statements": {
        const id = await mandant();
        out(await client.list((o) => bankStatementsPath(id, o), options));
        return 0;
      }
      case "bank-statement-lines": {
        const id = await mandant();
        out(
          await client.list(
            (o) => bankStatementLinesPath(id, positional[0], o),
            options,
          ),
        );
        return 0;
      }
      case "income-journals":
      case "outgo-journals": {
        const id = await mandant();
        const type = command.replace("-journals", "");
        out(await client.list((o) => journalsPath(id, type, o), options));
        return 0;
      }
      case "incoming-invoices": {
        const id = await mandant();
        out(await client.list((o) => incomingInvoicesPath(id, o), options));
        return 0;
      }
      case "invoice-bookings": {
        const id = await mandant();
        out(
          await client.list((o) => invoiceBookingsPath(id, positional[0], o), options),
        );
        return 0;
      }
      case "accounts": {
        const id = await mandant();
        out(await client.list((o) => accountsPath(id, o), options));
        return 0;
      }
      case "tax-classes": {
        const id = await mandant();
        out(await client.apiRequest(taxClassesPath(id, options)));
        return 0;
      }
      case "staging": {
        const id = await mandant();
        out(await client.list((o) => stagingPath(id, o), options));
        return 0;
      }
      case "upload-staging":
        out(
          await client.uploadStaging({
            clientId: clientFlag,
            filePath: options.file,
            description: options.description ?? null,
            skipOcr: Boolean(options.skipOcr),
            confirm: Boolean(options.confirm),
          }),
        );
        return 0;
      default:
        throw new Error(`Unknown command '${command}'. Run with --help.`);
    }
  } catch (error) {
    stderr(scrub(error?.message ?? String(error), secrets));
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then((code) => {
    process.exitCode = code;
  });
}
