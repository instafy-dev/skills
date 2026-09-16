import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  MAX_API_PAGE_SIZE,
  MAX_STAGING_BYTES,
  accountsPath,
  assertWriteAllowed,
  bankStatementLinesPath,
  bankStatementsPath,
  buildApiUrl,
  createClient,
  incomingInvoicesPath,
  invoiceBookingsPath,
  issuerTokenUrl,
  journalsPath,
  main,
  maskIdentity,
  mimeTypeFor,
  normalizeBaseUrl,
  paymentAccountsPath,
  rejectSideEffectFields,
  stagingPath,
  taxClassesPath,
} from "../client.mjs";

// Obviously fake fixtures. RFC 4122 example UUIDs, a placeholder Mandant id,
// and credentials that spell out what they are.
const CLIENT_ID = "12345";
const OTHER_CLIENT_ID = "67890";
const STATEMENT_UUID = "123e4567-e89b-12d3-a456-426614174000";
const INVOICE_UUID = "123e4567-e89b-12d3-a456-426614174001";
// The issuer must sit on the API's registrable domain, so both fixtures share
// example.test.
const BASE_URL = "https://demo.example.test";
const ISSUER_URL = "https://accounts.example.test/auth/realms/demo";
const API_CLIENT_ID = "11111_222222222";
const API_CLIENT_SECRET = "fake-secret-never-printed";

function fakeEnv(overrides = {}) {
  return {
    FREEFINANCE_API_BASE_URL: BASE_URL,
    FREEFINANCE_API_CLIENT_ID: API_CLIENT_ID,
    FREEFINANCE_API_CLIENT_SECRET: API_CLIENT_SECRET,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A fake fetch: records every call and answers from a handler. The handler gets
// the API path (after /api/2.0) for API calls, or "issuer" / "token".
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const text = String(url);
    if (text.endsWith("/api/2.0/auth/issuer")) {
      return jsonResponse({ realm: "demo", url: ISSUER_URL });
    }
    if (text.endsWith("/protocol/openid-connect/token")) {
      return jsonResponse({ access_token: `token-${calls.length}` });
    }
    const apiPath = text.slice(text.indexOf("/api/2.0") + "/api/2.0".length);
    return handler(apiPath, options, calls);
  };
  impl.calls = calls;
  impl.apiCalls = () =>
    calls.filter(
      (call) =>
        !call.url.endsWith("/auth/issuer") &&
        !call.url.endsWith("/protocol/openid-connect/token"),
    );
  impl.tokenCalls = () =>
    calls.filter((call) => call.url.endsWith("/protocol/openid-connect/token"));
  return impl;
}

async function runMain(argv, { env = fakeEnv(), fetch, cwd } = {}) {
  const stdout = [];
  const stderr = [];
  const code = await main(argv, {
    env,
    fetch,
    cwd: cwd ?? (await emptyDir()),
    sleep: async () => {},
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
  });
  return { code, stdout: stdout.join("\n"), stderr: stderr.join("\n") };
}

// Every temporary directory is removed when the suite ends.
const created = [];

async function emptyDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "freefinance-skill-test-"));
  created.push(dir);
  return dir;
}

after(async () => {
  for (const dir of created) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Pure helpers and path builders
// ---------------------------------------------------------------------------

test("normalises HTTPS base URLs and rejects plain HTTP", () => {
  assert.equal(normalizeBaseUrl("https://app.freefinance.at/"), "https://app.freefinance.at");
  assert.throws(() => normalizeBaseUrl("http://app.freefinance.at"), /HTTPS/);
  assert.throws(() => normalizeBaseUrl("not a url"), /not a valid URL/);
});

test("builds v2 API URLs and rejects traversal", () => {
  assert.equal(buildApiUrl(BASE_URL, "/clients"), `${BASE_URL}/api/2.0/clients`);
  assert.throws(() => buildApiUrl(BASE_URL, "/../secret"), /must not contain/);
  assert.throws(() => buildApiUrl(BASE_URL, "clients"), /must start with/);
});

test("builds bank statement and line paths with API parameter names", () => {
  assert.equal(
    bankStatementsPath(CLIENT_ID, {
      from: "2026-01-01",
      to: "2026-01-31",
      state: ["new", "IN_PROGRESS"],
    }),
    `/clients/${CLIENT_ID}/bsl/bank_statements?limit=500&from=2026-01-01&to=2026-01-31&states=NEW&states=IN_PROGRESS`,
  );
  assert.equal(
    bankStatementLinesPath(CLIENT_ID, STATEMENT_UUID, { lineType: "new", limit: 25 }),
    `/clients/${CLIENT_ID}/bsl/bank_statements/${STATEMENT_UUID}/lines?limit=25&line_type=NEW`,
  );
  assert.throws(
    () => bankStatementLinesPath(CLIENT_ID, "../../bookings"),
    /Bank statement ID must be a UUID/,
  );
  assert.throws(() => bankStatementsPath("12345/other"), /must be numeric/);
  assert.throws(
    () => bankStatementsPath(CLIENT_ID, { from: "2026-02-01", to: "2026-01-31" }),
    /must not be after/,
  );
  assert.throws(
    () => bankStatementsPath(CLIENT_ID, { from: "2026-02-30" }),
    /valid calendar date/,
  );
  assert.throws(
    () => bankStatementLinesPath(CLIENT_ID, STATEMENT_UUID, { lineType: "MAYBE" }),
    /Unsupported line type/,
  );
});

test("builds journal, invoice, booking, account, tax class and staging paths", () => {
  assert.equal(
    journalsPath(CLIENT_ID, "outgo", { from: "2026-01-01", search: "ER2026-1" }),
    `/clients/${CLIENT_ID}/cba/outgo_journals?limit=500&from=2026-01-01&search=ER2026-1`,
  );
  assert.throws(() => journalsPath(CLIENT_ID, "rebook"), /Journal type/);
  assert.equal(
    incomingInvoicesPath(CLIENT_ID, {
      search: "Example Supplier GmbH",
      paidState: "unpaid,OVERDUE",
      currency: "eur",
      includeCancelled: "false",
    }),
    `/clients/${CLIENT_ID}/cbi/incoming_invoices?limit=500&search_text=Example+Supplier+GmbH&paid_state=UNPAID&paid_state=OVERDUE&currency=EUR&include_cancelled=false`,
  );
  assert.throws(
    () => incomingInvoicesPath(CLIENT_ID, { paidState: "MAYBE" }),
    /Unsupported paid state/,
  );
  assert.equal(
    invoiceBookingsPath(CLIENT_ID, INVOICE_UUID),
    `/clients/${CLIENT_ID}/cbi/incoming_invoices/${INVOICE_UUID}/bookings?limit=500`,
  );
  assert.throws(() => invoiceBookingsPath(CLIENT_ID, "not-a-uuid"), /Invoice ID must be a UUID/);
  assert.equal(
    accountsPath(CLIENT_ID, {
      use: "expense",
      effectiveDate: "2026-01-31",
      search: "software & tools",
      available: "true",
    }),
    `/clients/${CLIENT_ID}/cbs/accounts?limit=500&use=EXPENSE&effective_date=2026-01-31&search_text=software+%26+tools&available=true`,
  );
  assert.throws(() => accountsPath(CLIENT_ID, { use: "NOT_A_USE" }), /Unsupported account use/);
  assert.equal(
    taxClassesPath(CLIENT_ID, { effectiveDate: "2026-01-31", sort: "code:ASC" }),
    `/clients/${CLIENT_ID}/fis/tax_classes?effective_date=2026-01-31&sort=code%3AASC`,
  );
  assert.equal(
    paymentAccountsPath(CLIENT_ID),
    `/clients/${CLIENT_ID}/cbs/payment_accounts?visible=true&limit=500`,
  );
  assert.equal(
    stagingPath(CLIENT_ID, { offset: 500 }),
    `/clients/${CLIENT_ID}/doc/providers/DMS/staging?limit=500&offset=500`,
  );
});

test("enforces the API page-size bounds", () => {
  assert.equal(MAX_API_PAGE_SIZE, 500);
  assert.throws(() => stagingPath(CLIENT_ID, { limit: 501 }), /integer from 1 to 500/);
  assert.throws(() => stagingPath(CLIENT_ID, { limit: 0 }), /integer from 1 to 500/);
  assert.throws(() => stagingPath(CLIENT_ID, { offset: -1 }), /non-negative integer/);
});

test("accepts only the supported staging file types", () => {
  assert.equal(mimeTypeFor("invoice.PDF"), "application/pdf");
  assert.equal(mimeTypeFor("invoice.xml"), "application/xml");
  assert.equal(mimeTypeFor("scan.jpeg"), "image/jpeg");
  assert.equal(mimeTypeFor("invoice.exe"), null);
  assert.equal(MAX_STAGING_BYTES, 2_097_152);
});

test("masks the technical user id to its last four characters and never expands short values", () => {
  assert.equal(maskIdentity(API_CLIENT_ID), "...2222");
  assert.equal(maskIdentity("123456789"), "configured");
  assert.equal(maskIdentity("short"), "configured");
  assert.equal(maskIdentity(""), "missing");
});

test("the token endpoint must be HTTPS on the API's own domain", () => {
  assert.equal(
    issuerTokenUrl(ISSUER_URL, BASE_URL),
    `${ISSUER_URL}/protocol/openid-connect/token`,
  );
  assert.equal(
    issuerTokenUrl("https://accounts.freefinance.at/auth/realms/at/", "https://app.freefinance.at"),
    "https://accounts.freefinance.at/auth/realms/at/protocol/openid-connect/token",
  );
  assert.throws(() => issuerTokenUrl("http://accounts.example.test/auth", BASE_URL), /HTTPS/);
  assert.throws(() => issuerTokenUrl("https://evil.example.org/auth", BASE_URL), /not on the API's domain/);
  assert.throws(() => issuerTokenUrl("not a url", BASE_URL), /not a valid URL/);
});

test("rejects side-effect fields recursively, in camel and snake case", () => {
  assert.throws(() => rejectSideEffectFields({ paid_date: "2026-01-01" }), /Unsafe/);
  assert.throws(() => rejectSideEffectFields({ nested: [{ bookedAt: 1 }] }), /Unsafe/);
  assert.throws(() => rejectSideEffectFields({ reconcileNow: true }), /Unsafe/);
  assert.doesNotThrow(() => rejectSideEffectFields({ description: "ok", skip_ocr: true }));
});

test("write policy allows only a POST to the DMS staging folder", () => {
  assert.doesNotThrow(() => assertWriteAllowed("GET", "/clients/12345/cbi/incoming_invoices"));
  assert.doesNotThrow(() =>
    assertWriteAllowed("POST", "/clients/12345/doc/providers/DMS/staging", { skip_ocr: true }),
  );
  assert.throws(
    () => assertWriteAllowed("POST", "/clients/12345/cbi/incoming_invoices", {}),
    /Write policy: POST/,
  );
  assert.throws(
    () => assertWriteAllowed("POST", "/clients/12345/doc/providers/DMS/staging/json", {}),
    /Write policy/,
  );
  assert.throws(
    () => assertWriteAllowed("DELETE", "/clients/12345/doc/providers/DMS/staging"),
    /Write policy: DELETE/,
  );
  assert.throws(
    () =>
      assertWriteAllowed("POST", "/clients/12345/doc/providers/DMS/staging", {
        paid_date: "2026-01-01",
      }),
    /Unsafe/,
  );
});

// ---------------------------------------------------------------------------
// Token minting
// ---------------------------------------------------------------------------

test("mints a token through issuer discovery and OIDC client credentials", async () => {
  const fetch = fakeFetch(() => jsonResponse({ content: [], total_count: 0 }));
  const client = createClient({ env: fakeEnv(), fetch });

  const token = await client.getAccessToken();
  assert.equal(token, "token-2");
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].url, `${BASE_URL}/api/2.0/auth/issuer`);
  assert.equal(fetch.calls[1].url, `${ISSUER_URL}/protocol/openid-connect/token`);
  assert.equal(fetch.calls[1].options.method, "POST");
  assert.equal(fetch.calls[1].options.body.get("grant_type"), "client_credentials");
  assert.equal(fetch.calls[1].options.body.get("client_id"), API_CLIENT_ID);
  for (const call of fetch.calls) {
    assert.ok(!call.url.includes(API_CLIENT_SECRET), "secret must never be in a URL");
  }

  // Cached within the process: a second call mints nothing.
  await client.getAccessToken();
  assert.equal(fetch.calls.length, 2);
});

test("a plain HTTP or foreign issuer never receives the secret", async () => {
  for (const issuerUrl of [
    "http://accounts.example.test/auth/realms/demo",
    "https://evil.example.org/auth/realms/demo",
  ]) {
    const fetch = fakeFetch(() => jsonResponse({}));
    const tampered = async (url, options) => {
      if (String(url).endsWith("/api/2.0/auth/issuer")) {
        fetch.calls.push({ url: String(url), options });
        return jsonResponse({ realm: "demo", url: issuerUrl });
      }
      return fetch(url, options);
    };
    const client = createClient({ env: fakeEnv(), fetch: tampered });
    await assert.rejects(client.getAccessToken(), /issuer URL/);
    assert.equal(fetch.tokenCalls().length, 0, issuerUrl);
    assert.equal(fetch.calls.length, 1, issuerUrl);
  }
});

test("re-mints once on 401 and retries the request exactly once", async () => {
  let apiHits = 0;
  const fetch = fakeFetch(() => {
    apiHits += 1;
    return apiHits === 1
      ? jsonResponse({ message: "expired" }, 401)
      : jsonResponse({ content: [{ id: 12345 }], total_count: 1 });
  });
  const client = createClient({ env: fakeEnv(), fetch });

  const result = await client.apiRequest("/clients?limit=500");
  assert.equal(result.total_count, 1);
  assert.equal(apiHits, 2);
  assert.equal(fetch.tokenCalls().length, 2);
  assert.equal(fetch.apiCalls()[1].options.headers.Authorization, "Bearer token-5");
});

test("fails after a second 401 instead of looping", async () => {
  const fetch = fakeFetch(() => jsonResponse({ message: "expired" }, 401));
  const client = createClient({ env: fakeEnv(), fetch });

  await assert.rejects(client.apiRequest("/clients?limit=500"), /failed \(401\).*expired/);
  assert.equal(fetch.apiCalls().length, 2);
});

test("token errors surface the response detail and not the secret", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  fetch.calls.length = 0;
  const failing = async (url, options) => {
    if (String(url).endsWith("/protocol/openid-connect/token")) {
      return jsonResponse({ error: "unauthorized_client", error_description: "bad credentials" }, 401);
    }
    return fetch(url, options);
  };
  const client = createClient({ env: fakeEnv(), fetch: failing });
  await assert.rejects(client.getAccessToken(), (error) => {
    assert.match(error.message, /token request failed \(401\): bad credentials/);
    assert.ok(!error.message.includes(API_CLIENT_SECRET));
    return true;
  });
});

// ---------------------------------------------------------------------------
// Reads, one per family, through the command line
// ---------------------------------------------------------------------------

test("clients lists the visible clients", async () => {
  const fetch = fakeFetch((apiPath) => {
    assert.equal(apiPath, "/clients?limit=500");
    return jsonResponse({ content: [{ id: 12345, display_name: "Example Company" }], total_count: 1 });
  });
  const { code, stdout } = await runMain(["clients"], { fetch });
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).content[0].display_name, "Example Company");
});

test("bank-statements maps --since and --until to from and to", async () => {
  const fetch = fakeFetch((apiPath) => {
    assert.equal(
      apiPath,
      `/clients/${CLIENT_ID}/bsl/bank_statements?limit=500&from=2026-03-01&to=2026-03-31`,
    );
    return jsonResponse({ content: [], total_count: 0 });
  });
  const { code } = await runMain(
    ["bank-statements", "--client", CLIENT_ID, "--since", "2026-03-01", "--until", "2026-03-31"],
    { fetch },
  );
  assert.equal(code, 0);
  assert.equal(fetch.apiCalls().length, 1);
});

test("bank-statement-lines filters by line type NEW", async () => {
  const fetch = fakeFetch((apiPath) => {
    assert.equal(
      apiPath,
      `/clients/${CLIENT_ID}/bsl/bank_statements/${STATEMENT_UUID}/lines?limit=500&line_type=NEW`,
    );
    return jsonResponse({ content: [{ line_type: "NEW" }], total_count: 1 });
  });
  const { code, stdout } = await runMain(
    ["bank-statement-lines", STATEMENT_UUID, "--client", CLIENT_ID, "--line-type", "NEW"],
    { fetch },
  );
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout).content[0].line_type, "NEW");
});

test("income-journals passes --search, incoming-invoices passes --paid-state", async () => {
  const seen = [];
  const fetch = fakeFetch((apiPath) => {
    seen.push(apiPath);
    return jsonResponse({ content: [], total_count: 0 });
  });
  assert.equal(
    (await runMain(["income-journals", "--client", CLIENT_ID, "--search", "example"], { fetch })).code,
    0,
  );
  assert.equal(
    (await runMain(["incoming-invoices", "--client", CLIENT_ID, "--paid-state", "UNPAID"], { fetch }))
      .code,
    0,
  );
  assert.deepEqual(seen, [
    `/clients/${CLIENT_ID}/cba/income_journals?limit=500&search=example`,
    `/clients/${CLIENT_ID}/cbi/incoming_invoices?limit=500&paid_state=UNPAID`,
  ]);
});

test("invoice-bookings, accounts, tax-classes, payment-accounts and staging build their paths", async () => {
  const seen = [];
  const fetch = fakeFetch((apiPath) => {
    seen.push(apiPath);
    return jsonResponse({ content: [], total_count: 0 });
  });
  const commands = [
    ["invoice-bookings", INVOICE_UUID],
    ["accounts", "--use", "EXPENSE"],
    ["tax-classes", "--effective-date", "2026-01-31"],
    ["payment-accounts"],
    ["staging"],
  ];
  for (const argv of commands) {
    const { code, stderr } = await runMain([...argv, "--client", CLIENT_ID], { fetch });
    assert.equal(code, 0, stderr);
  }
  assert.deepEqual(seen, [
    `/clients/${CLIENT_ID}/cbi/incoming_invoices/${INVOICE_UUID}/bookings?limit=500`,
    `/clients/${CLIENT_ID}/cbs/accounts?limit=500&use=EXPENSE`,
    `/clients/${CLIENT_ID}/fis/tax_classes?effective_date=2026-01-31`,
    `/clients/${CLIENT_ID}/cbs/payment_accounts?visible=true&limit=500`,
    `/clients/${CLIENT_ID}/doc/providers/DMS/staging?limit=500`,
  ]);
});

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

test("--limit and --offset are validated before any request", async () => {
  const fetch = fakeFetch(() => jsonResponse({ content: [] }));
  const tooBig = await runMain(["staging", "--client", CLIENT_ID, "--limit", "501"], { fetch });
  assert.equal(tooBig.code, 1);
  assert.match(tooBig.stderr, /integer from 1 to 500/);
  const negative = await runMain(["staging", "--client", CLIENT_ID, "--offset", "-1"], { fetch });
  assert.equal(negative.code, 1);
  assert.match(negative.stderr, /non-negative integer/);
  assert.equal(fetch.apiCalls().length, 0);
});

test("--all walks pages by total_count and merges content", async () => {
  const fetch = fakeFetch((apiPath) => {
    const offset = Number(new URL(`https://x${apiPath}`).searchParams.get("offset") ?? 0);
    const page = offset === 0 ? [{ n: 1 }, { n: 2 }] : [{ n: 3 }];
    return jsonResponse({ content: page, total_count: 3 });
  });
  const { code, stdout } = await runMain(
    ["staging", "--client", CLIENT_ID, "--all", "--limit", "2"],
    { fetch },
  );
  assert.equal(code, 0);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.content.map((entry) => entry.n), [1, 2, 3]);
  assert.equal(result.total_count, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(
    fetch.apiCalls().map((call) => call.url.split("/api/2.0")[1]),
    [
      `/clients/${CLIENT_ID}/doc/providers/DMS/staging?limit=2&offset=0`,
      `/clients/${CLIENT_ID}/doc/providers/DMS/staging?limit=2&offset=2`,
    ],
  );
});

// ---------------------------------------------------------------------------
// Mandant resolution
// ---------------------------------------------------------------------------

test("resolves the Mandant from --client, then env, then profile, then auto-select", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ content: [{ id: Number(OTHER_CLIENT_ID), display_name: "Only One" }], total_count: 1 }),
  );

  const flag = createClient({ env: fakeEnv({ FREEFINANCE_CLIENT_ID: "555" }), fetch });
  assert.deepEqual(await flag.resolveClientId(CLIENT_ID), { id: CLIENT_ID, source: "flag" });

  const env = createClient({ env: fakeEnv({ FREEFINANCE_CLIENT_ID: "555" }), fetch });
  assert.deepEqual(await env.resolveClientId(), { id: "555", source: "env" });

  const cwd = await emptyDir();
  await fs.mkdir(path.join(cwd, "bookkeeping"));
  await fs.writeFile(
    path.join(cwd, "bookkeeping", "profile.json"),
    JSON.stringify({ freefinance: { client_id: CLIENT_ID, display_name: "Example Company" } }),
  );
  const profile = createClient({ env: fakeEnv(), fetch, cwd });
  assert.deepEqual(await profile.resolveClientId(), { id: CLIENT_ID, source: "profile" });
  assert.equal(fetch.apiCalls().length, 0);

  const auto = createClient({ env: fakeEnv(), fetch, cwd: await emptyDir() });
  assert.deepEqual(await auto.resolveClientId(), { id: OTHER_CLIENT_ID, source: "auto" });
  assert.equal(fetch.apiCalls().length, 1);
});

test("several visible clients produce an error that lists them", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({
      content: [
        { id: 12345, display_name: "Example Company" },
        { id: 67890, display_name: "Second Example" },
      ],
      total_count: 2,
    }),
  );
  const { code, stderr } = await runMain(["staging"], { fetch });
  assert.equal(code, 1);
  assert.match(stderr, /Several FreeFinance clients are visible/);
  assert.match(stderr, /12345 \(Example Company\)/);
  assert.match(stderr, /67890 \(Second Example\)/);
  assert.match(stderr, /bookkeeping\/profile\.json/);
});

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

async function writeFixture(name, bytes) {
  const dir = await emptyDir();
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return { dir, file };
}

test("upload-staging without --confirm is a dry run that names the Mandant and makes no request", async () => {
  const { dir } = await writeFixture("receipt.pdf", Buffer.from("%PDF-1.4 fake"));
  const fetch = fakeFetch(() => jsonResponse({ content: [] }));
  const { code, stdout } = await runMain(
    [
      "upload-staging",
      "--client",
      CLIENT_ID,
      "--file",
      "receipt.pdf",
      "--description",
      "Example receipt",
      "--skip-ocr",
    ],
    { fetch, cwd: dir },
  );
  assert.equal(code, 0);
  const plan = JSON.parse(stdout);
  assert.equal(plan.dry_run, true);
  assert.equal(plan.client_id, CLIENT_ID);
  assert.equal(plan.client_source, "flag");
  assert.equal(plan.file, "receipt.pdf");
  assert.ok(!stdout.includes(dir), "the plan must not print an absolute path");
  assert.equal(plan.file_name, "receipt.pdf");
  assert.equal(plan.content_type, "application/pdf");
  assert.equal(plan.description, "Example receipt");
  assert.equal(plan.skip_ocr, true);
  assert.match(plan.next_step, /--confirm/);
  assert.equal(fetch.calls.length, 0);
});

test("the dry run takes the Mandant from the profile without any request", async () => {
  const { dir } = await writeFixture("receipt.pdf", Buffer.from("%PDF-1.4 fake"));
  await fs.mkdir(path.join(dir, "bookkeeping"));
  await fs.writeFile(
    path.join(dir, "bookkeeping", "profile.json"),
    JSON.stringify({ freefinance: { client_id: CLIENT_ID } }),
  );
  const fetch = fakeFetch(() => jsonResponse({ content: [] }));
  const { code, stdout } = await runMain(["upload-staging", "--file", "receipt.pdf"], {
    fetch,
    cwd: dir,
  });
  assert.equal(code, 0);
  const plan = JSON.parse(stdout);
  assert.equal(plan.client_id, CLIENT_ID);
  assert.equal(plan.client_source, "profile");
  assert.equal(fetch.calls.length, 0);
});

test("upload-staging --confirm lists staging then POSTs a multipart body", async () => {
  const { dir } = await writeFixture("receipt.pdf", Buffer.from("%PDF-1.4 fake"));
  const fetch = fakeFetch((apiPath, options) => {
    if (options.method === "POST") {
      return jsonResponse({ content: [{ file_name: "receipt.pdf", processing_state: "PENDING" }] });
    }
    return jsonResponse({ content: [{ file_name: "other.pdf" }], total_count: 1 });
  });
  const { code, stdout, stderr } = await runMain(
    ["upload-staging", "--client", CLIENT_ID, "--file", "receipt.pdf", "--description", "Example receipt", "--confirm"],
    { fetch, cwd: dir },
  );
  assert.equal(code, 0, stderr);
  const output = JSON.parse(stdout);
  assert.equal(output.dry_run, false);
  assert.equal(output.client_id, CLIENT_ID);
  assert.equal(output.file, "receipt.pdf");
  assert.equal(output.result.content[0].processing_state, "PENDING");

  const api = fetch.apiCalls();
  assert.equal(api.length, 2);
  assert.match(api[0].url, /\/doc\/providers\/DMS\/staging\?limit=500&offset=0$/);
  assert.equal(api[0].options.method, "GET");
  assert.equal(api[1].url, `${BASE_URL}/api/2.0/clients/${CLIENT_ID}/doc/providers/DMS/staging`);
  assert.equal(api[1].options.method, "POST");
  const body = api[1].options.body;
  assert.ok(body instanceof FormData);
  const content = body.get("content");
  assert.equal(content.name, "receipt.pdf");
  assert.equal(content.type, "application/pdf");
  assert.deepEqual(JSON.parse(await body.get("metadata").text()), {
    description: "Example receipt",
  });
});

test("upload-staging refuses duplicates, oversized files, unsupported types and files outside the workspace", async () => {
  const duplicate = await writeFixture("receipt.pdf", Buffer.from("%PDF"));
  const fetch = fakeFetch(() => jsonResponse({ content: [{ file_name: "receipt.pdf" }], total_count: 1 }));
  const dup = await runMain(
    ["upload-staging", "--client", CLIENT_ID, "--file", "receipt.pdf", "--confirm"],
    { fetch, cwd: duplicate.dir },
  );
  assert.equal(dup.code, 1);
  assert.match(dup.stderr, /already exists/);
  assert.equal(fetch.apiCalls().filter((call) => call.options.method === "POST").length, 0);
  const requestsSoFar = fetch.calls.length;

  const big = await writeFixture("big.pdf", Buffer.alloc(3 * 1024 * 1024));
  const oversized = await runMain(["upload-staging", "--file", "big.pdf"], { fetch, cwd: big.dir });
  assert.equal(oversized.code, 1);
  assert.match(oversized.stderr, /limited to 2 MiB/);

  const exe = await writeFixture("tool.exe", Buffer.from("MZ"));
  const unsupported = await runMain(["upload-staging", "--file", "tool.exe"], { fetch, cwd: exe.dir });
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.stderr, /Unsupported staging file type/);

  // A file next to the workspace, reached through .. or an absolute path.
  const outside = await writeFixture("outside.pdf", Buffer.from("%PDF"));
  const workspace = path.join(outside.dir, "workspace");
  await fs.mkdir(workspace);
  for (const source of ["../outside.pdf", outside.file, "."]) {
    const refused = await runMain(
      ["upload-staging", "--client", CLIENT_ID, "--file", source, "--confirm"],
      { fetch, cwd: workspace },
    );
    assert.equal(refused.code, 1, source);
    assert.match(refused.stderr, /inside the workspace/, source);
  }
  assert.equal(fetch.calls.length, requestsSoFar, "no request after the duplicate check");
});

test("the API layer refuses every write except the staging upload", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const client = createClient({ env: fakeEnv(), fetch });
  await assert.rejects(
    client.apiRequest(`/clients/${CLIENT_ID}/cbi/incoming_invoices`, { method: "POST", fields: {} }),
    /Write policy: POST/,
  );
  await assert.rejects(
    client.apiRequest(`/clients/${CLIENT_ID}/cbi/incoming_invoices/${INVOICE_UUID}`, { method: "DELETE" }),
    /Write policy: DELETE/,
  );
  await assert.rejects(
    client.apiRequest(`/clients/${CLIENT_ID}/doc/providers/DMS/staging`, {
      method: "POST",
      fields: { paid_date: "2026-01-01" },
    }),
    /Unsafe/,
  );
  assert.equal(fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Status and masking
// ---------------------------------------------------------------------------

test("status masks the id, reports the secret as configured, and prints neither", async () => {
  const fetch = fakeFetch(() =>
    jsonResponse({ content: [{ id: Number(CLIENT_ID), display_name: "Example Company" }], total_count: 1 }),
  );
  const { code, stdout } = await runMain(["status"], { fetch });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.base_url, BASE_URL);
  assert.equal(report.api_client_id, "...2222");
  assert.equal(report.api_client_secret, "configured");
  assert.equal(report.token, "ok");
  assert.equal(report.client_id, CLIENT_ID);
  assert.equal(report.client_source, "auto");
  assert.ok(!stdout.includes(API_CLIENT_ID));
  assert.ok(!stdout.includes(API_CLIENT_SECRET));
  assert.ok(!stdout.includes("token-"));
});

test("status without credentials reports missing and skips the token check", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const { code, stdout } = await runMain(["status"], {
    fetch,
    env: fakeEnv({ FREEFINANCE_API_CLIENT_ID: "", FREEFINANCE_API_CLIENT_SECRET: "" }),
  });
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.api_client_id, "missing");
  assert.equal(report.api_client_secret, "missing");
  assert.match(report.token, /skipped/);
  assert.equal(fetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Error surfaces
// ---------------------------------------------------------------------------

test("reads without credentials name the two project secrets", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const { code, stderr } = await runMain(["clients"], {
    fetch,
    env: fakeEnv({ FREEFINANCE_API_CLIENT_SECRET: "" }),
  });
  assert.equal(code, 1);
  assert.match(stderr, /FREEFINANCE_API_CLIENT_ID and FREEFINANCE_API_CLIENT_SECRET/);
  assert.equal(fetch.calls.length, 0);
});

test("validation errors exit 1 before any request", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const cases = [
    [["clients"], { FREEFINANCE_API_BASE_URL: "http://app.freefinance.at" }, /HTTPS/],
    [["staging", "--client", "12a"], {}, /must be numeric/],
    [["bank-statement-lines", "not-a-uuid", "--client", CLIENT_ID], {}, /must be a UUID/],
    [["bank-statements", "--client", CLIENT_ID, "--since", "01.03.2026"], {}, /YYYY-MM-DD/],
    [["bank-statements", "--client", CLIENT_ID, "--since", "2026-13-01"], {}, /valid calendar date/],
    [["bank-statements", "--client", CLIENT_ID, "--since", "2026-02-30"], {}, /valid calendar date/],
    [["staging", "--client", CLIENT_ID, "--bogus", "1"], {}, /Unsupported option/],
    [["staging", "--client"], {}, /requires a value/],
    [["staging", "extra", "--client", CLIENT_ID], {}, /does not take positional/],
    [["not-a-command"], {}, /Unknown command/],
  ];
  for (const [argv, envOverrides, pattern] of cases) {
    const { code, stderr } = await runMain(argv, { fetch, env: fakeEnv(envOverrides) });
    assert.equal(code, 1, argv.join(" "));
    assert.match(stderr, pattern, argv.join(" "));
  }
  assert.equal(fetch.apiCalls().length, 0);
});

test("--help prints usage without touching the network or the environment", async () => {
  const fetch = fakeFetch(() => jsonResponse({}));
  const { code, stdout } = await runMain(["--help"], { fetch, env: {} });
  assert.equal(code, 0);
  assert.match(stdout, /upload-staging --file/);
  assert.match(stdout, /FREEFINANCE_API_CLIENT_ID/);
  assert.equal(fetch.calls.length, 0);
});
