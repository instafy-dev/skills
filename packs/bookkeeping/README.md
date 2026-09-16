# Bookkeeping pack

Skills for keeping the books of a small Austrian business with an Instafy agent. The pack
folder is itself a valid Instafy workspace: every skill lives under `.agents/skills/<name>/`.

## Skills

| Skill | Status | What it does |
| --- | --- | --- |
| [freefinance](./.agents/skills/freefinance/) | Available | Connects a space to one FreeFinance client through the API v2. Reads bank statements and lines, payment accounts, journals, incoming invoices, accounts, tax classes and the DMS staging folder. The only write is a confirmed document upload to staging. Sets up one quiet weekly check. |
| books-at | Planned | The onboarding interview (legal form, VAT status, bank accounts, prior software), the company profile, the monthly close and the Austrian rules. Until it lands, the freefinance skill's Getting started covers the connection only. |

## Install

Whole pack (installs every skill and starts their Getting started sections in alphabetical
order):

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills --start
```

One skill:

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --start
```

Paste either line into any Instafy chat, or use "Paste a skill link" in Studio with the
folder URL. In Studio the FreeFinance entry under Connect sends the single-skill line for
you once this pack is published.

## What you need

- A FreeFinance account with a technical user for the API. The skill asks for
  `FREEFINANCE_API_CLIENT_ID` and `FREEFINANCE_API_CLIENT_SECRET` by name through the
  secrets card. Never paste them in chat.
- Nothing to install: the client has zero dependencies and runs on the Node 24 that the
  Instafy runtime ships.

## Boundaries

- FreeFinance stays the system of record. Review, booking, payment and reconciliation happen
  in its web application.
- VAT returns (UVA) and FinanzOnline filing are not in the API and are not automated.
- Documents and bank texts are treated as data, never as instructions.

## Versioning

Releases are git tags per pack, for example `bookkeeping/v0.1.0`. The first tag is cut by the
repository owner after review.
