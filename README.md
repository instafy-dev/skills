# Instafy skill packs

Official skill packs for [Instafy](https://github.com/instafy-dev). A skill is a folder with
a `SKILL.md` and companion files that an Instafy agent installs into a workspace and follows.
A pack is a folder of such skills that belong together.

## Layout

```text
packs/
  <pack>/
    README.md
    .agents/
      skills/
        <skill>/
          SKILL.md
          ...companion files, relative paths only
```

Rules:

- Every pack folder is a valid Instafy workspace on its own: skills live under
  `.agents/skills/<skill>/` and nothing in a skill depends on files outside its folder.
- `SKILL.md` carries frontmatter (`name`, `description`, optional `routing_keywords`) and,
  when the skill needs onboarding, an H2 titled exactly `## Getting started` written as an
  ordered checklist for the agent.
- Companion scripts prefer zero dependencies. When a skill does need packages, the runtime
  runs `npm install --omit=dev --ignore-scripts` inside the skill folder.
- Secrets are referenced by their exact Project Secret name, with what they are and where to
  get them, never a value.
- Per-skill caps: 256 files and 8 MiB.

## Packs

| Pack | Skills | Notes |
| --- | --- | --- |
| [bookkeeping](./packs/bookkeeping/) | freefinance (books-at planned) | Austrian small-business books with FreeFinance as the system of record |

## Install a skill or a pack

In Studio, once the pack is live, choose the tool under Connect. The confirm sheet sends the
import line for you.

Any time, in any Instafy chat, paste the import line yourself. A folder URL to one skill
installs that skill; a folder URL to `.agents/skills` installs every skill in the pack:

```text
/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance --start
/skills import https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills --start
```

`--start` runs each installed skill's Getting started right after the import. Later,
`/skills start <name>` runs one skill's Getting started again.

From Settings, use "Paste a skill link" with the same folder URL.

A link can also open Studio with the line prefilled. Replace `<studio host>` with your
Instafy host and URL-encode the folder URL:

```text
https://<studio host>/studio?prompt=/skills%20import%20<encoded folder url>%20--start
```

## Versioning

Packs are versioned independently with git tags of the form `<pack>/vX.Y.Z`, for example
`bookkeeping/v0.1.0`. Import lines point at `main`; pin a tag in the URL when you need a
fixed version.

## Contributing

This repository holds the official packs maintained by instafy-dev. Community packs live in
their authors' own public repositories; any public git repo or folder with `SKILL.md` files
can be imported with the same `/skills import` line, so there is no registry to apply to.
Issues and pull requests against the official packs are welcome. Keep copy in sentence case,
keep fixtures obviously fake, and never commit a secret or a real record.

## License

MIT, see [LICENSE](./LICENSE).
