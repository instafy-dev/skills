# freefinance skill

An Instafy skill that reads a FreeFinance (Austria) client through the public API v2 and
uploads documents to the DMS staging folder after an explicit confirmation. Nothing else is
written.

The skill's instructions, secrets, commands and onboarding checklist live in
[SKILL.md](./SKILL.md). Start there.

## Files

| File | Purpose |
| --- | --- |
| `SKILL.md` | What the agent reads: conventions, commands, the Getting started checklist |
| `client.mjs` | Zero-dependency Node 24 command line client (`node client.mjs --help`) |
| `test/client.test.mjs` | `node --test` suite with a fake fetch, no network |
| `package.json` | `npm test` only; there are no dependencies to install |

## Install

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --start
```

## Develop

```sh
cd packs/bookkeeping/.agents/skills/freefinance
npm test
node client.mjs --help
```

The tests never reach the network and use obviously fake fixtures. Keep it that way: no real
client numbers, UUIDs, IBANs or company names belong in this folder.
