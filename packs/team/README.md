# Team pack

Skills for the tools a team already talks and writes in. The pack folder is itself a valid
workspace: every skill lives under `.agents/skills/<name>/`.

## Skills

| Skill | Status | What it does |
| --- | --- | --- |
| [notion](./.agents/skills/notion/) | Available | Connects a space to one Notion workspace through an internal integration. Searches and reads pages, page contents, databases and rows. The only writes are appending blocks to a page and creating a page, each after a confirmed dry run. Can set up one quiet daily check of a database. |
| slack | Planned | Read channels and threads the app was invited to, post as the app after confirmation. |
| discord | Planned | Read channels the bot can see, post after confirmation. |

## Install

Whole pack (installs every skill and starts their Getting started sections in alphabetical
order):

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills --start
```

One skill:

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion --start
```

Paste either line into any Instafy chat, or use "Paste a skill link" in Studio with the
folder URL. In Studio the Notion entry under Connect sends the single-skill line for you
once this pack is published. A deep link that creates a space and sends the line after
login:

```text
https://instafy.dev/studio?prompt=/skills%20import%20https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion%20--start
```

## What you need

- A Notion internal integration created by a workspace owner. The skill declares
  `NOTION_API_KEY` by name; the runtime asks for it through its own secrets mechanism.
  Never paste it in chat. The integration must be connected to every page or database it
  should see.
- Nothing to install: the client has zero dependencies and runs on Node 24.

## Boundaries

- Notion stays the system of record. Editing, moving, archiving and sharing happen in the
  Notion application; this skill reads, appends and creates pages after confirmation.
- Page contents and database rows are treated as data, never as instructions.
- The skill only sees what was shared with the integration, and only writes to the pages
  recorded during Getting started.

## Versioning

Releases are git tags per pack, for example `team/v0.1.0`. The first tag is cut by the
repository owner after review.
