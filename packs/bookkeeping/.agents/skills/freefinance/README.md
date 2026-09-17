# freefinance skill

An agent skill that reads a FreeFinance (Austria) client through the public API v2 and
uploads documents to the DMS staging folder after an explicit confirmation. Nothing else is
written.

The skill's instructions, required environment variables, commands and Getting started
declarations live in [SKILL.md](./SKILL.md). Start there. The `SKILL.md` is
platform-neutral: it declares what the skill needs, asks, writes and schedules, and the
agent runtime that installs it turns those declarations into its own secret and schedule
mechanisms.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | What the agent reads: conventions, commands, the Getting started declarations |
| `client.mjs` | Zero-dependency Node 24 command line client (`node client.mjs --help`) |
| `test/client.test.mjs` | `node --test` suite with a fake fetch, no network |
| `package.json` | `npm test` only; there are no dependencies to install |

## Install

In Instafy, send this line in a chat:

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --start
```

Or open the Studio deep link, which creates a space and sends the same line after login:

```text
https://instafy.dev/studio?prompt=/skills%20import%20https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance%20--start
```

On another agent runtime, copy the folder to where that runtime looks for skills and set
the environment variables named in `SKILL.md`.

## Develop

```sh
cd packs/bookkeeping/.agents/skills/freefinance
npm test
node client.mjs --help
```

The tests never reach the network and use obviously fake fixtures. Keep it that way: no real
client numbers, UUIDs, IBANs or company names belong in this folder.
