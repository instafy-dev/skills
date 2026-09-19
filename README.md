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
- The "What it is" cell opens with the provider's own on-screen name for the value, in the
  provider's capitalisation, as the first noun phrase after the article. That phrase is what
  a person reads in the provider's UI, so it is what the setup calls the value too.
- The first sentence of the "What it is" cell, and the first sentence of the "Where the user
  gets it" cell, must be safe to render verbatim beside an input: plain words, no links, no
  markup, no backticks, no em dash, under 200 characters. Anything that needs formatting goes
  in the sentences after it. An agent shows those first sentences to the person while setup
  waits on the value, so a sentence written at the agent rather than at the person reads as
  a leak.
- A pack that asks for a human login credential (a password, a passphrase, a PIN, a card
  number, a recovery phrase) will be refused by the product, so do not declare one. Ask for
  the machine credential the provider issues instead.
- The secrets table is read by the product, not only by the agent. Keep the header row
  `| Name | Sensitive | What it is | Where the user gets it |`: the columns are matched by
  their header text, so they may be reordered and "Where to get it" also reads, but a column
  the reader does not recognise is one it ignores, and a row whose cell count does not match
  the header is skipped whole.
- Name cells hold the exact variable inside a code span. Sensitive cells open with `Yes` or
  `No`; anything else is read as unsaid and the value is hidden by default.
- Only the FIRST sentence of "What it is" and of "Where the user gets it" ever reaches a
  person. A trailing clause carrying a link, a host or a code span is cut at the comma before
  it, so "The Installation access token of an internal connection, starting with `ntn_`."
  still reads; a first sentence that cannot be recovered that way is dropped entirely, and
  the card falls back to its own wording. Later sentences are never promoted, so a
  terminology footnote in sentence two cannot end up on a card.
- A "## Getting started" walkthrough is spoken to the person in the chat, so it is the place
  to be as thorough as the reader needs. Assume someone who has never made an API token and
  has never seen the provider's developer screens: name the screens, say what to click, and
  say what to do when the menu the provider documents is not there. The card beside the chat
  carries one sentence, which is an address, not a lesson.
- Write provider addresses in a walkthrough as a backticked host with no scheme, like
  `app.notion.com/developers/connections`. The chat renders a backticked host as inert text,
  while a full `https://` address becomes a link the person can click. A link a pack wrote
  is a link a reader of that pack chose, so the product writes the real host out beside any
  label it does not recognise. Never write a link and tell the person to click it.
- Where-to-get first sentences are refused, not shortened, past 160 characters. Put the
  screen the value sits on in that sentence, and the caveats, recovery steps and naming
  disputes after it.
- Per-skill caps: 256 files and 8 MiB.

## Packs

| Pack | Skills | Notes |
| --- | --- | --- |
| [bookkeeping](./packs/bookkeeping/) | freefinance (books-at planned) | Austrian small-business books with FreeFinance as the system of record |
| [team](./packs/team/) | notion (slack, discord planned) | The tools a team talks and writes in, starting with Notion pages and databases |

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
