# Chrome Web Store submission

Everything the Developer Dashboard asks for, written out. Copy and paste.
Keep this file updated when the extension changes — the listing has to stay true.

---

## Store listing

**Name**

```
GHL Workflow Auditor
```

**Short description** (132 characters max — this one is 118)

```
Reads every workflow in a GoHighLevel sub-account and reports the failures that produce no error message anywhere.
```

**Category:** Developer Tools
**Language:** English

**Detailed description**

```
GoHighLevel workflows fail silently. That is the whole problem this solves.

A tag with a typo does not error, it creates a new tag and the workflow simply never fires. A "contains" filter on QUALIFIED also matches DISQUALIFIED. An empty merge field does not abort the send, it texts your lead a sentence with a hole in it. A Contact Changed trigger with no field watched loops on itself forever. None of these show up as an error anywhere, in the UI or in a log.

Worse, workflows trigger each other through tags and custom fields, and those connections are invisible. Workflow A adds a tag, workflow B triggers on that tag. Nothing in the GoHighLevel interface will ever draw you that line.

So when you inherit an account with sixty workflows in it, the honest options are to open all sixty by hand and hold the graph in your head, or to guess.

This reads all of them in a couple of minutes and hands you the map.


HOW IT WORKS

Open a workflow in GoHighLevel and click the icon. That is the whole interaction. There is no token to paste, no API key, no account to create.

The audit runs in the background, so you can close the popup and keep working. When it finishes you get a findings report to paste into a ticket, and a full JSON dump of every step of every workflow, structured to be handed to an AI coding agent.


WHAT IT FINDS

Structure: loops a contact can never escape, steps no path reaches, If/Else branches with no else arm, waits that switch off an AI agent, condition waits nothing resets, and waits set a year out.

Triggers: Contact Changed with no field watched, appointment triggers with no calendar filter, triggers waiting on tags that do not exist, and two published workflows listening for exactly the same thing.

Pipelines and ownership: assign steps with an empty user list that own nobody, opportunities created with no lookup first, opportunities with no stage, and stages crossed in zero seconds.

Copy: merge fields nothing checked the value of, tag values that are substrings of other tag values, invalid merge field syntax, links with no trigger link, characters that break in SMS, and webhooks still pointing at a development machine.

Settings: the toggles that are invisible on the canvas, like an outreach sequence that keeps sending after the lead already replied, or an appointment flow that drops anyone who reschedules.

Findings are ranked by impact, not just severity: published before draft, then by how many contacts are sitting inside the workflow right now.


WHAT IT DOES NOT DO

It is read only. It never creates, edits or deletes anything in your account.

It does not tell you whether your copy is good, whether the business actually wants a workflow, and it cannot see Conversations AI agents, because no GoHighLevel API exposes them.

It tells you where to look. The judgement stays yours.


PRIVACY

There is no server, no account, no analytics and no telemetry. The only network requests it makes are to GoHighLevel's own API, as you, using the session already in your open tab. Your session token is never stored or transmitted anywhere. Results are held in memory and cleared when you close Chrome.

The entire source is public, has no build step and no dependencies, so what you install is exactly what is in the repository:
https://github.com/facuga7van/ghl-workflow-auditor

Not affiliated with or endorsed by GoHighLevel.
```

---

## Privacy tab

**Single purpose**

```
The extension has one purpose: to audit the automation workflows inside a GoHighLevel sub-account that the user is already signed into, and report configuration problems that GoHighLevel itself does not surface as errors.

Every feature serves that single purpose: reading the workflows, analysing them, and presenting the resulting report.
```

### Permission justifications

**`scripting`**

```
Used to read the GoHighLevel session token out of the tab the user already has open, so the extension can query GoHighLevel's API as that user and retrieve their own workflows.

The injected function only searches the page's own storage for the session token that GoHighLevel itself placed there. It does not modify the page, read page content, or interact with the user interface. It runs only when the user clicks the extension's icon, never automatically.

Without this permission the user would have to open developer tools and copy a token by hand for every audit.
```

**`storage`**

```
Used for three things, all local to the browser:

1. The optional detection rules the user configures on the options page, so they persist between sessions.
2. A snapshot of workflow ids, names, statuses and version numbers, used to report what changed since the previous audit.
3. Holding the current audit result while the user views and downloads it. This uses session storage, which is in memory and cleared when the browser closes.

No data is synced, uploaded or shared. The session token is never written to storage.
```

**Host access to `app.gohighlevel.com`, `*.gohighlevel.com`, `*.msgsndr.com`**

```
These are the domains GoHighLevel serves its application from, including the white-label domains agencies use. The extension needs to identify which GoHighLevel tab the user has open and read the existing session from it, so it can query that user's own account.
```

**Host access to `*.leadconnectorhq.com`**

```
This is GoHighLevel's own API backend. Every request the extension makes goes here, to read the user's workflows, custom fields and tags. These are read-only GET requests, made with the user's own existing session.
```

**Remote code**

```
No, I am not using remote code.
```

### Data usage — what to tick

Tick **Authentication information**, and only that.

Reason: the extension reads the user's existing GoHighLevel session token from their open tab in order to call GoHighLevel's API on their behalf. It is used for that request and discarded.

Leave **unticked**: personally identifiable information, health information, financial information, personal communications, location, web history, user activity, website content.

> Website content is arguably borderline, since workflow definitions come from the site. They are the user's own configuration data, retrieved from the user's own account through the official API, and never leave the machine. If a reviewer asks, that is the answer — do not argue it, just explain it.

Then tick all three certifications:

- I do not sell or transfer user data to third parties, apart from the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**

```
https://facuga7van.github.io/ghl-workflow-auditor/PRIVACY
```

(Enable GitHub Pages on the repository first: Settings → Pages → Deploy from branch → `main` → `/root`.)

---

## Distribution

**Visibility:** Unlisted — installable by link, does not appear in search.
**Regions:** all.

---

## Screenshots

At least one, 1280x800 PNG. Take them yourself on a real account — a fabricated screenshot is grounds for rejection, and it would be a lie besides.

Worth capturing, in order of usefulness:

1. **The full report with findings.** Open the report page, turn on `group by workflow`. Zoom the browser out so a good number of rows fit.
2. **The popup just after a run.** Shows the HIGH / MEDIUM / LOW breakdown and the buttons.
3. **The popup mid-run.** The progress bar with a workflow name under it makes what it does obvious at a glance.

Blur or rename anything that identifies a client before uploading. The account name sits at the top of the report page and in the popup title.

---

## After you submit

Review takes days, not hours. If they come back with a question it lands in the dashboard and by email — answer it there rather than resubmitting.

The most likely question is about host permissions or about reading authentication information. Both are answered above; reuse that wording.
