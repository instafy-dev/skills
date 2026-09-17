# notion skill

An agent skill that reads a Notion workspace through the public API and writes in exactly
two ways, appending blocks to a page and creating a page, each after an explicit
confirmation. Nothing else is written.

The skill's instructions, required environment variable, commands and Getting started
declarations live in [SKILL.md](./SKILL.md). Start there. The `SKILL.md` is
platform-neutral: it declares what the skill needs, asks, writes and schedules, and the
agent runtime that installs it turns those declarations into its own secret and schedule
mechanisms.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | What the agent reads: conventions, commands, the Getting started declarations |
| `notion.mjs` | Zero-dependency Node 24 command line client (`node notion.mjs --help`) |
| `test/notion.test.mjs` | `node --test` suite with a fake fetch, no network |
| `package.json` | `npm test` only; there are no dependencies to install |

## Install

In Instafy, send this line in a chat:

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion --start
```

Or open the Studio deep link, which creates a space and sends the same line after login:

```text
https://instafy.dev/studio?prompt=/skills%20import%20https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion%20--start
```

On another agent runtime, copy the folder to where that runtime looks for skills and set
the environment variable named in `SKILL.md`.

## Develop

```sh
cd packs/team/.agents/skills/notion
npm test
node notion.mjs --help
```

The client pins `Notion-Version: 2026-03-11`, the current version at the time of writing.
The tests never reach the network and use obviously fake fixtures. Keep it that way: no
real page ids, tokens, workspace names or people belong in this folder.
