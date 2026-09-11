# GHL Workflow Auditor

A Chrome extension that reads every workflow in a GoHighLevel sub-account and tells you **where it is silently broken** — the failures that produce no error message anywhere.

Open a workflow, click the icon. That's the whole interaction.

```
 66 workflows · 41 published · 613 steps · 102 findings (78 live) · 18 edges

 HIGH   live   112   Nurture 03       trigger with no watched field
        Contact Changed with no field set: fires on any edit to the
        contact and loops on itself

 HIGH   live     8   Booking Flow     assigns to nobody
        `Assign rep` has an empty user list: the lead stays unowned
        and no one is told about it

 HIGH   live     -   Follow-up 02     loops back on itself
        `Go To` is reached again from its own branch: contacts go
        round forever, sending every message on the way

 HIGH   draft    -   (account)        contains collision
        `QUALIFIED` is a substring of `DISQUALIFIED`: a contains
        `QUALIFIED` filter matches both
```

You get a findings report to paste into a ticket, and a JSON dump of every step of every workflow — the whole branch structure resolved, not a flattened list — meant to be handed to an AI coding agent.

Read-only. It never writes to your account.

## Install

Install it unpacked (a Chrome Web Store listing is in review):

1. Download a [release](https://github.com/facuga7van/ghl-workflow-auditor/releases) and unzip, or `git clone` this repo
2. `chrome://extensions` → turn on **Developer mode** (top right)
3. **Load unpacked** → select the `ext` folder
4. Pin the icon to your toolbar

> The folder picker looks empty when you're inside `ext` — it only lists subfolders and there are none. Just click "Select folder".

**Keep the folder where it is.** Chrome loads from that exact path on every start.

## Use

**Go to Automations and open any workflow. Then click the icon.**

That part matters: GoHighLevel only loads the session token once a workflow builder is open. From the dashboard, or a sub-account list, the extension has nothing to read and will tell you so.

The audit starts on its own. **You can close the popup while it runs** — the work happens in the service worker. Reopen it and the progress is there.

| Button | What you get |
|---|---|
| **Download report (.md)** | Findings, trigger graph, inventory |
| **Download full data (.json)** | Every step of every workflow, with ids |
| **copy** | Same thing straight to the clipboard — skip the Downloads folder |
| **Open full report** | The whole thing as a page, with filters |

Files are named after the account, not its id: `audit-Acme-Co-2026-09-11.md`.

Never audited anything yet? The report page has a **see an example report** link: a fictional account run through the real detectors, so you can see what the output looks like without opening a client.

In the full report you can filter by severity, show **published only**, search, and **group by workflow** so everything wrong with one is together. Every workflow name is a link straight into GoHighLevel, and every finding has a one-click copy for pasting into a ticket.

The JSON carries an embedded `_readme` explaining its own structure, so you can hand it straight to an AI agent and it will know that a workflow is a graph rather than a list, that every step carries the branch it's on (`main > Lead`), that fields are referenced by id, and that `inFlight` is people inside the workflow *right now*.

## What it detects

Everything here produces **no error message** in GoHighLevel. That's the selection criterion — if the UI shows a red box, it's not in this list.

**Structure** — a workflow is a graph, and these come from walking it:

| Finding | What actually happens |
|---|---|
| `loops back on itself` | A branch or a `goto` returns to a step already on its own path. Contacts go round forever, sending every message on the way |
| `unreachable step` | No path from the start reaches it. It will never run |
| `branch with no else` | An If/Else with no else arm: whoever fails the condition stops there |
| `wait for reply` | Waiting on a reply switches off an AI agent answering that channel |
| `condition wait never resets` | A condition wait tests whether something is *true*, not whether it *changed*. If it's already set, the wait ends instantly |
| `parked forever` | A wait of a year or more. A dead end anyone who reaches it stays in |

**Triggers**

| Finding | What actually happens |
|---|---|
| `trigger with no watched field` | Contact Changed with no field set fires on *any* edit, including its own writes. Infinite loop |
| `appointment trigger with no calendar` | Fires for **every** calendar in the account, not just yours |
| `tag does not exist` | The trigger waits for a tag that isn't in the account. It will never fire |
| `tag nobody writes` | The tag exists, but no workflow applies it. Something outside has to, or it's dead |
| `duplicate trigger` | Two published workflows on the same trigger with identical conditions. Both run, in no set order |
| `no trigger` | Published, with steps, no trigger. Only reachable via Add to Workflow |

**Pipelines and ownership**

| Finding | What actually happens |
|---|---|
| `assigns to nobody` | An assign step with an empty user list. The lead stays unowned and nobody is told |
| `owner from a merge field` | Assignment via `{{...}}`: if that value is empty the step assigns nobody, silently |
| `opportunity with no lookup` | Create with no `find` first. A returning contact gets a duplicate |
| `opportunity with no stage` | Lands wherever the pipeline happens to default to |
| `stage crossed instantly` | Created in one stage and moved in the same run with no wait. The first stage lasts zero seconds, so nothing keyed to it ever fires |

**Copy and vocabulary**

| Finding | What actually happens |
|---|---|
| `contains collision` | One tag is a substring of another. `contains "no"` matches `"now"` and `"November"` |
| `merge field with no gate` | Nothing upstream checks the field has a value. GoHighLevel doesn't abort, it sends the sentence with a hole in it |
| `invalid merge field` | `{{contact.custom.x}}` — that segment doesn't exist. Renders empty |
| `bare link` | A URL in an SMS with no trigger link. The click fires nothing |
| `encoding in copy` | Em dashes, curly quotes, accents that break in some SMS providers |
| `webhook points at a test endpoint` | localhost, ngrok or webhook.site left in a live workflow |

**Settings and health** — toggles you can't see on the canvas, plus the obvious

| Finding | What actually happens |
|---|---|
| `outreach that never stops` | 3+ sends with **Stop on Response** off: you keep texting a lead who replied |
| `appointment flow without re-entry` | **Allow Re-Entry** off drops anyone who reschedules — no more reminders |
| `contacts in flight` | People sitting inside this workflow right now. Matters before you edit it |
| `empty workflow` | Not a single step. A shell someone left half-built |
| `could not be parsed` | Shape couldn't be read, so it was skipped. Open that one by hand |

### Ordered by what's actually happening

Severity is the rule; **impact** is whether anyone is exposed to it. Findings are sorted by severity, then by whether the workflow is published, then by how many contacts are sitting in it right now. A HIGH in a draft nobody is in ranks below a MEDIUM happening to 200 people.

### The trigger graph, and where it ends

It maps the implicit edges: workflow A adds a tag, workflow B triggers on it. Nothing in the GoHighLevel UI ever draws you that line.

It also reports its own **boundaries** — tags a trigger waits for that no workflow writes. Those aren't dead ends: an AI agent, a person or an integration writes them, and none of that is visible to any API. Saying so is the difference between an incomplete map and a map that knows where it stops.

### What changed since last time

Every run stores a snapshot of the account (four fields per workflow, no client content). The next run tells you what was edited, published, renamed, added or deleted since — at the top of the report. GoHighLevel bumps a workflow's `version` on every save, so drift costs nothing to detect.

That's what makes it worth opening twice: you re-audit the three workflows someone touched, not all sixty.

### Your own rules

Off by default. Click **rules** at the bottom of the popup.

| Finding | You configure | What it catches |
|---|---|---|
| `deprecated tag family` | prefixes you migrated away from | Something still writes the old tag |
| `routes nowhere` | prefixes that pick a line / inbox / channel | Routes to a destination that doesn't exist |
| `multiple funnel ids` | a regex for your funnel ids in webhook URLs | Two campaigns sharing a trigger tag: one steals the other's conversions |

Export as JSON, your team imports it. The config lives in `chrome.storage`, not in the source, so you can pull updates without touching it.

## What it does not do

- **Doesn't tell you if the copy is right.** It checks encoding and links, not the message
- **Doesn't know what the business wants.** A workflow can be perfect and still pointless
- **Doesn't see Conversations AI agents.** No GoHighLevel API exposes them, public or internal

It tells you where to look. The judgement is yours.

## How it works

It doesn't ask for a token or an API key. It reads the session already in your open tab, at the moment you run it, via `chrome.scripting.executeScript` across every frame.

That means nothing is stored anywhere — no credential in a file, in `storage`, or in this repo — the token is always fresh, and the account id comes from the tab URL so you can't audit the wrong one by typo. Results live in `chrome.storage.session`, which is in-memory: a client's workflow dump never touches disk, and it's gone when Chrome closes.

The engine runs in the service worker, not the popup. Views only read state.

GoHighLevel's **public** API doesn't return workflow steps (`GET /workflows/{id}` is a 404), so this calls the same internal endpoints the web app does:

```
GET {backend}/workflows/?locationId={loc}
GET {backend}/workflow/{loc}/{id}?includeScheduledPauseInfo=true
GET {backend}/workflow/{loc}/trigger?workflowId={id}
GET {backend}/workflows/status/search/count-per-step?workflowId={id}&locationId={loc}
GET {backend}/locations/{loc}/customFields
GET {backend}/locations/{loc}/tags
```

with `authorization`, `channel: APP`, `source: WEB_USER`, `version: 2021-07-28`. The version header is **required** on `count-per-step`.

**This will break.** Internal endpoints change without notice. When they do it breaks in `ext/audit.js` and nowhere else — `ext/core.js` works on a normalized model. Grab a fresh Copy as cURL and compare.

## Development

```bash
node ext/test.js        # model, detectors, report
node ext/test-graph.js  # graph traversal, pipelines, ownership, impact, drift
node ext/test-flow.js   # the service worker, with chrome and fetch mocked
bash pack.sh            # build a distributable zip
```

No dependencies, no build step. Plain JavaScript a browser runs directly.

`pack.sh` builds two zips: one for installing unpacked, and one with the manifest at the root for the Chrome Web Store. `tools/make-icons.js` regenerates the icons, which are drawn in code rather than kept only as binaries.

**Adding a detector:** one `add(severity, workflow, rule, message)` in `detect()` in `ext/core.js`, plus a test. The bar is that GoHighLevel doesn't already tell you — if the UI shows a red box, it doesn't belong. Keep the message concrete: say what happens in production, not what's wrong in the abstract.

**White-label domain?** Add it in two places or the tab is invisible: `host_permissions` in `ext/manifest.json` and `GHL_HOSTS` in `ext/audit.js`.

Issues and PRs welcome — especially a detector for a failure mode that bit you, or endpoint changes when GoHighLevel moves something.

## Privacy

No server, no account, no analytics. The only requests it makes go to GoHighLevel's own API, as you. Your session token is never stored or transmitted. Results live in memory and are cleared when Chrome closes. Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT. Not affiliated with or endorsed by GoHighLevel. It uses their internal API with your own session to read your own data — unsupported by them, and it may break at any time. Use it on accounts you're authorized to access.
