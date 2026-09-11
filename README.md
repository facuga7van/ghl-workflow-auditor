# GHL Workflow Auditor

A Chrome extension that reads every workflow in a GoHighLevel sub-account and tells you **where it is silently broken**.

Open the account, click the icon. That's the whole interaction.

You get a findings report you can paste into a ticket, and a full JSON dump of every step of every workflow — in real execution order — meant to be handed to an AI coding agent.

```
 66 workflows · 41 published · 613 steps · 35 findings · 18 edges

 HIGH    Nurture 03      trigger with no watched field
         Contact Changed with no field set: fires on any edit to the
         contact and loops on itself

 HIGH    Booking Flow    appointment trigger with no calendar
         fires for EVERY calendar in the account

 HIGH    (account)       contains collision
         `QUALIFIED` is a substring of `DISQUALIFIED`: a contains
         `QUALIFIED` filter matches both
```

---

## Why this exists

GoHighLevel workflows fail **silently**. That is the whole problem.

A tag with a typo doesn't error, it creates a new tag and the workflow simply never fires. A `contains` filter on `QUALIFIED` also matches `DISQUALIFIED`. An empty merge field doesn't abort the send, it texts your lead `"Hey its ,"`. A Contact Changed trigger with no field watched loops on itself forever. None of these show up as an error anywhere — not in the UI, not in a log.

Worse, workflows trigger each other through **tags and custom fields**, and those edges are invisible. Workflow A adds a tag, workflow B triggers on that tag. Nothing in the GoHighLevel UI will ever draw you that line. You find it when something breaks in production.

So when you inherit an account with 60 workflows in it, the honest options are: open all 60 by hand and hold the graph in your head, or guess.

This reads all of them in a couple of minutes and hands you the graph.

## What it actually does

1. Lists every workflow in the sub-account you have open
2. Pulls the full step tree, the triggers, and the live in-flight contact counts for each one
3. Resolves the **real execution order** of the steps
4. Builds the **trigger graph**, including the implicit tag and field edges
5. Runs every detector against it
6. Gives you a `.md` report and a `.json` dump

It is entirely read-only. It never writes anything to your account.

## Install

There is no Chrome Web Store listing. Install it unpacked:

1. Download and unzip a [release](https://github.com/facuga7van/ghl-workflow-auditor/releases), or `git clone` this repo
2. Go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. **Load unpacked** → select the `ext` folder
5. Pin the icon to your toolbar

> The folder picker will look empty when you are inside `ext`. That is normal — it only lists subfolders and there are none. Just click "Select folder".

**Keep the folder where it is.** Chrome loads the extension from that exact path on every start. Move it or delete it and the extension breaks.

## Use

Open the sub-account in GoHighLevel. Any screen works, as long as the URL has `/location/<id>/` in it. Click the icon.

The audit starts on its own. **You can close the popup while it runs** — the work happens in the service worker, not in the window. Reopen it and the progress is right there.

When it finishes:

| Button | What you get |
|---|---|
| **Download report (.md)** | The findings, the graph and the inventory. Readable, pasteable |
| **Download full data (.json)** | Every step of every workflow, with ids. For an AI agent |
| **Open full report** | The whole thing as a page |

### The JSON is the interesting one

The `.md` tells a human where to look. The `.json` is built to be handed to an AI coding agent so it can say *"in workflow X, step 7, change this"* instead of talking in generalities.

It carries an embedded `_readme` that explains the structure and the traps to whatever reads it:

- `workflows[].steps` is in **real execution order**, resolved by following each step's `next` pointer. The `order` field GoHighLevel returns is unreliable — don't sort by it
- Every step keeps its original `id`, `type` and full `attributes`, so any change can be addressed as `workflow.id` + `step.id`
- `graph[]` holds the implicit chains: A fires B because A writes a tag or field that B triggers on
- `account.customFields` maps field ids to keys — steps reference fields by id
- `inFlight` is contacts sitting inside the workflow **right now**, not history. An empty array is normal

A 90-step account produces roughly 100 KB. A 600-step account, about 700 KB.

## What it detects

Everything here is something that produces **no error message** in GoHighLevel. That is the selection criterion — if it shows up as a red box in the UI, it is not in this list.

### Triggers

| Finding | Why it matters |
|---|---|
| `trigger with no watched field` | Contact Changed with no field set fires on *any* edit to the contact, including its own writes. Infinite loop |
| `appointment trigger with no calendar` | Fires for **every** calendar in the account, not just yours |
| `tag does not exist` | The trigger waits for a tag that is not in the account. It will never fire, and nothing tells you |
| `tag nobody writes` | The tag exists, but no workflow applies it. Something outside has to, or the workflow is dead |
| `no trigger` | Published, with steps, no trigger. Only reachable via Add to Workflow from somewhere else |

### Copy and links

| Finding | Why it matters |
|---|---|
| `invalid merge field` | `{{contact.custom.x}}` — that segment does not exist in GoHighLevel. The field renders empty |
| `bare link` | A URL in an SMS with no trigger link. The click fires nothing, and you have no attribution |
| `encoding in copy` | Non-ASCII characters (em dashes, curly quotes, accents) that break in some SMS providers |

### Vocabulary

| Finding | Why it matters |
|---|---|
| `contains collision` | One tag is a substring of another. `contains "no"` matches `"now"` and `"November"`. This one has broken more builds than everything else on this list |

### Workflow settings

These are toggles that are invisible on the canvas — you have to open the settings panel of each workflow to see them.

| Finding | Why it matters |
|---|---|
| `outreach that never stops` | 3+ sends with **Stop on Response** off: you keep texting a lead who already replied |
| `appointment flow without re-entry` | An appointment workflow with **Allow Re-Entry** off drops anyone who reschedules — they stop getting reminders |

### Health

| Finding | Why it matters |
|---|---|
| `contacts in flight` | People sitting inside this workflow right now. Matters a lot before you edit or delete it |
| `empty workflow` | Not a single step. A shell someone left half-built |
| `could not be parsed` | The shape of this one could not be read, so it was **skipped**. Open it by hand |

### Your own rules (opt-in)

Every agency has conventions the tool cannot guess. These are **off by default** and configured on the options page — click **rules** at the bottom of the popup.

| Finding | You configure | What it catches |
|---|---|---|
| `deprecated tag family` | tag prefixes you migrated away from | Something still writes the old tag, and nothing reads it any more |
| `routes nowhere` | prefixes that pick a line / inbox / channel | A workflow routes to a destination that does not exist in the account |
| `multiple funnel ids` | a regex for your funnel ids in webhook URLs | Two campaigns sharing a trigger tag: one gets credited the other's conversions |

You can **Export** your setup as JSON and have your team **Import** it. The extension itself stays generic, so you can pull updates without ever touching your config — it lives in `chrome.storage`, not in the source.

## What it does NOT do

Being honest about this matters more than the feature list:

- **It does not tell you if the copy is right.** It checks encoding and links, not the message
- **It does not know what the business wants.** A workflow can be technically perfect and still be pointless
- **It does not see Conversations AI agents.** No GoHighLevel API exposes them — public or internal. Those are still UI-only, and the audit says nothing about them
- **It does not write anything.** Read-only, by design

The report tells you **where to look**. The judgement is still yours.

## How it works

```
popup  ──{start, tabId}──▶  service worker
                                  │
                          chrome.storage.session
                            prog    progress, throttled
                            result  report + JSON dump
                                  │
                    ┌─────────────┴─────────────┐
                    ▼                           ▼
             popup (live)                panel (full report)
```

### Where the session comes from

The extension does not ask you for a token or an API key. It reads the session that is **already in the tab you have open**, at the moment you run it, using `chrome.scripting.executeScript` across every frame of the page.

That is not a shortcut, it is the whole design. It means:

- Nothing to copy or paste, ever
- No credential is stored anywhere — not in a file, not in `storage`, not in the repo
- The token is always fresh, so the entire "it expired" class of failure does not exist
- The account id comes from the tab URL, so you cannot audit the wrong one by typo

If the session cannot be read, the popup falls back to asking for a **Copy as cURL** pasted in — the token and the account id are pulled out of it.

### Why the audit is not in the popup

A Chrome popup is destroyed the instant it loses focus. A large account takes a minute or two, so the run would be cut every time you looked away. The engine lives in the service worker; the popup and the report page are views that only read `chrome.storage.session`.

`session` and not `local` on purpose: it is in-memory, so a client's workflow dump **never touches the disk**. It is gone when Chrome closes.

Two things the platform forces you to handle explicitly, both in `background.js`:

1. A service worker is killed after ~30s idle. Calling an extension API resets that timer, so there is a ping every 20s while an audit is in flight. Without it a slow account dies halfway with no error
2. If it dies anyway, the state would read `running` forever. Every progress write carries a timestamp, and a view treats a run with 60s of silence as dead and offers a retry. An eternal spinner is exactly the silent failure this tool exists to prevent

### Files

| File | What it is |
|---|---|
| `ext/core.js` | Model, detectors, graph, report. **No DOM, no `chrome.*`** — which is why it is testable from node |
| `ext/audit.js` | The engine: read the session, call the API |
| `ext/background.js` | Service worker. Runs the audit, publishes state |
| `ext/popup.*` | Progress and downloads. Reads state, runs nothing |
| `ext/panel.*` | The full report. Renders the dump, runs nothing |
| `ext/options.*` | Your own rules |
| `ext/test.js` | Core logic |
| `ext/test-flow.js` | The service worker, end to end |
| `pack.sh` | Builds a distributable zip |

### The API it uses

GoHighLevel's **public** API does not return workflow steps — `GET /workflows/{id}` is a 404. There is no supported way to read what is inside a workflow. So this uses the same internal endpoints the GoHighLevel web app calls:

```
GET {backend}/workflows/?locationId={loc}
GET {backend}/workflow/{loc}/{id}?includeScheduledPauseInfo=true
GET {backend}/workflow/{loc}/trigger?workflowId={id}
GET {backend}/workflows/status/search/count-per-step?workflowId={id}&locationId={loc}
GET {backend}/locations/{loc}/customFields
GET {backend}/locations/{loc}/tags
```

with `authorization`, `channel: APP`, `source: WEB_USER` and `version: 2021-07-28`. The version header is **required** on `count-per-step` and tolerated by the rest.

**This will break.** Internal endpoints change without notice. When it does, it breaks in `audit.js` and nowhere else — `core.js` works on the normalized model. Bump `SHAPE_VERSION`, grab a fresh Copy as cURL from the network tab, and compare.

## Development

```bash
node ext/test.js        # model, detectors, graph, report
node ext/test-flow.js   # the service worker, with chrome and fetch mocked
bash pack.sh            # build dist/ghl-workflow-auditor-v{version}.zip
```

No dependencies, no build step, no framework. It is plain JavaScript that a browser runs directly.

`pack.sh` runs both suites and refuses to build if either fails.

### On the tests

The assertions are **mutation tested** — deliberately breaking the logic has been verified to break the tests. An assertion that cannot fail is worse than no assertion, because it hands out confidence for free.

`test-flow.js` loads `core.js`, `audit.js` and `background.js` into a `vm` with a fake `chrome` and a fake `fetch`, and runs the whole state machine. It covers the parts you cannot check by looking at the screen: that a run always lands on `done` or `error` and never hangs on `running`, that an expired token fires zero requests, that a failed run clears the previous account's result instead of showing it under the new account's name, and that one unreadable workflow does not cost you the other 65.

### Adding a detector

Detectors live in `detect()` in `ext/core.js`. One `add(severity, workflow, rule, message)` call, plus a test in `ext/test.js`.

The bar for a new detector: **it has to be something GoHighLevel does not already tell you.** If the UI shows a red box, it does not belong here. The value of this tool is the failures that look fine.

Keep the message concrete — say what will happen in production, not what is wrong in the abstract. `"fires for EVERY calendar in the account"` beats `"missing calendar filter"`.

### White-label domains

If your agency serves GoHighLevel from its own domain, add it in **two places** or the tab is invisible to the extension:

1. `host_permissions` in `ext/manifest.json`
2. `GHL_HOSTS` at the top of `ext/audit.js`

Then reload the extension.

## Security and scope

- **Read-only.** It performs no writes to your GoHighLevel account
- **No credentials stored.** The session is read from your open tab at run time and used immediately. It is not written to disk, not put in `storage`, not sent anywhere
- **No network destination other than GoHighLevel.** There is no telemetry, no analytics, no remote config. Read `ext/audit.js` — it is the only file that makes requests
- **Results stay in memory.** `chrome.storage.session` is cleared when Chrome closes
- It uses GoHighLevel's internal API with **your own session** to read **your own data**. That is unsupported by them and may break at any time. Use it on accounts you are authorized to access

## Contributing

Issues and PRs welcome, especially:

- **A detector for a failure mode that bit you.** That is the whole point of the project
- **Endpoint or payload shape changes** when GoHighLevel moves something
- Fixes for `could not be parsed` — if you hit one, the workflow id and the error message are enough to work with

New logic needs a test. Run both suites before opening a PR.

## License

MIT. See [LICENSE](LICENSE).

Not affiliated with, endorsed by, or supported by GoHighLevel.
