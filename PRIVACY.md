# Privacy Policy

**GHL Workflow Auditor** — last updated 11 September 2026

## The short version

This extension has no server, no account and no analytics. Nothing it reads ever leaves your computer, except for the requests it makes to GoHighLevel on your behalf — the same requests the GoHighLevel web app already makes when you use it.

There is nowhere for your data to go. There is no backend to send it to.

## What it reads, and why

| What | Why | Where it goes |
|---|---|---|
| The GoHighLevel session token in your open tab | To call GoHighLevel's API as you, so it can read your workflows | Used immediately for those requests. Never stored, never transmitted anywhere else |
| The URL and title of your GoHighLevel tab | To know which sub-account you are auditing, and to name the downloaded file | Stays in your browser |
| Your workflows, custom fields, tags and pipelines | They are what the audit is about | Held in your browser's in-memory session storage, cleared when Chrome closes |
| The rules you configure on the options page | So you do not have to set them up again | Your browser's local storage. Nowhere else |
| A snapshot of workflow names, ids, statuses and version numbers | To tell you what changed since your last audit | Your browser's local storage. No message content, no contact data |

## What it does NOT do

- **It does not send your data anywhere.** The only network requests it makes are to `backend.leadconnectorhq.com`, which is GoHighLevel's own API. There is no other destination in the code
- **It does not store your session token.** The token is read from the page at the moment you run an audit and used for that run only. It is never written to disk or to any storage API
- **It does not write to your GoHighLevel account.** Every request is a GET. The extension cannot create, edit or delete anything
- **It has no analytics, telemetry, crash reporting or remote configuration**
- **It does not use remote code.** Everything it runs ships inside the extension
- **It does not read any site other than GoHighLevel.** Its host permissions list exactly four domains

## Where results live

Audit results are held in `chrome.storage.session`, which is **in memory**. They are gone when you close Chrome. This is deliberate: a client's workflow dump should not sit on your disk by accident.

Files you explicitly download with the Download buttons are yours, saved wherever your browser puts them. The extension does not touch them afterwards.

## Permissions, one by one

- **`scripting`** — to read the session token out of the GoHighLevel tab you have open. Without it there is no way to call the API as you, and you would have to paste a token by hand
- **`storage`** — to remember the rules you configure, the snapshot used for change detection, and to hold the current result while you look at it
- **Host access to `app.gohighlevel.com`, `*.gohighlevel.com`, `*.msgsndr.com`** — these are the domains GoHighLevel serves its app from, including white-label setups. Needed to find your tab and read the session from it
- **Host access to `*.leadconnectorhq.com`** — GoHighLevel's API. This is where the workflow data is read from

## Verify it yourself

The entire source is public and has no build step — what you install is what is in the repository, in plain JavaScript.

If you want to check the claims above, `ext/audit.js` is the only file that makes network requests. It is about 180 lines.

https://github.com/facuga7van/ghl-workflow-auditor

## Changes

Any change to this policy will be committed to that repository, with history.

## Contact

Open an issue: https://github.com/facuga7van/ghl-workflow-auditor/issues
