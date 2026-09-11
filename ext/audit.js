// The engine. Runs in the service worker, never in a view: a Chrome popup is
// destroyed the moment it loses focus, and a big account takes a minute or two.
// Depends on core.js being loaded first (importScripts in background.js).

const B = "https://backend.leadconnectorhq.com";

// Keep this in sync with host_permissions in manifest.json. A white-label domain
// has to be added in BOTH places or the tab is invisible to the extension.
const GHL_HOSTS = [
  "https://app.gohighlevel.com/*",
  "https://*.gohighlevel.com/*",
  "https://*.msgsndr.com/*",
];
const LOC_RE = /\/location\/([A-Za-z0-9]{15,})|[?&]locationId=([A-Za-z0-9]{15,})/;

const decodeJwt = t => JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
const minsLeft = t => Math.round((decodeJwt(t).exp * 1000 - Date.now()) / 60000);

// ---------- session ----------

// Runs INSIDE the GoHighLevel page, once per frame. executeScript serializes it,
// so it must not close over anything out here. Returns the longest-lived live JWT
// it can find, or "".
function scanForToken(){
  const RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_.-]{20,}/g;
  const dec = t => JSON.parse(atob(t.split(".")[1].replace(/-/g,"+").replace(/_/g,"/")));
  const alive = t => { try { return dec(t).exp * 1000 > Date.now(); } catch(e){ return false; } };
  const found = new Set();
  const scan = txt => { if(!txt) return;
    for (const m of String(txt).matchAll(RE)) if (alive(m[0])) found.add(m[0]); };
  try {
    for (const st of [localStorage, sessionStorage])
      for (let i = 0; i < st.length; i++) scan(st.getItem(st.key(i)));
  } catch(e){}
  scan(document.cookie);
  return (async () => {
    try {
      for (const info of await indexedDB.databases()) {
        await new Promise(res => {
          const rq = indexedDB.open(info.name);
          rq.onerror = () => res();
          rq.onsuccess = () => {
            const db = rq.result; let left = db.objectStoreNames.length;
            if (!left) { db.close(); return res(); }
            const done = () => { if (!--left) { db.close(); res(); } };
            for (const sn of db.objectStoreNames) {
              try { const g = db.transaction(sn,"readonly").objectStore(sn).getAll();
                    g.onsuccess = () => { scan(JSON.stringify(g.result)); done(); };
                    g.onerror = done;
              } catch(e){ done(); }
            }
          };
        });
      }
    } catch(e){}
    if (!found.size) return "";
    return [...found].sort((x,y) => dec(y).exp - dec(x).exp)[0];
  })();
}

async function pickGhlTab(hintTabId){
  if (hintTabId) {
    try { const t = await chrome.tabs.get(hintTabId); if (t && LOC_RE.test(t.url || "")) return t; } catch(e){}
  }
  const tabs = await chrome.tabs.query({ url: GHL_HOSTS });
  // Prefer a tab sitting on a sub-account: only those carry the location id.
  return tabs.find(t => LOC_RE.test(t.url || "")) || tabs[0] || null;
}

// Read on every run. The token is good for exactly one hour, so grabbing it fresh
// at click time is what kills the whole "token expired" class of failure.
async function grabSession(hintTabId){
  const tab = await pickGhlTab(hintTabId);
  if (!tab) throw new Error(
    "No GoHighLevel tab open. Open your sub-account in a tab and try again.");

  const m = String(tab.url || "").match(LOC_RE);
  const loc = m ? (m[1] || m[2]) : "";
  if (!loc) throw new Error(
    "That GoHighLevel tab is not inside a sub-account. Open the account (the URL has /location/...) and try again.");

  const hits = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: scanForToken,
  });
  const toks = hits.map(h => h && h.result).filter(Boolean);
  if (!toks.length) throw new Error(
    "Could not read the session from that tab. Open Automations and any workflow, then try again.");

  const tok = toks.sort((x,y) => decodeJwt(y).exp - decodeJwt(x).exp)[0];
  if (minsLeft(tok) <= 0) throw new Error("The session in that tab is expired. Reload GoHighLevel and try again.");

  return { tok, loc, title: (tab.title || "GoHighLevel").replace(/\s*\|\s*HighLevel.*$/i, ""), host: new URL(tab.url).host };
}

// ---------- API ----------
async function api(url, tok){
  const r = await fetch(url, { headers: {
    "accept": "application/json, text/plain, */*",
    "authorization": "Bearer " + tok,
    "channel": "APP", "source": "WEB_USER", "version": "2021-07-28",
  }});
  if (!r.ok) throw new Error("HTTP " + r.status + " on " + url.split("?")[0].split("/").slice(-1));
  return r.json();
}

// ---------- the run ----------
// `say(line, done, total)` is called on every step so a view can follow along.
async function runAudit(session, say, rules){
  const { tok, loc } = session;

  say("listing workflows...");
  // Confirmed 2026-09-11 against a live account. Note: it does NOT accept &limit (422).
  const CANDS = [
    `${B}/workflows/?locationId=${loc}`,
    `${B}/workflow/${loc}/list?limit=500`,
    `${B}/workflow/?locationId=${loc}`,
  ];
  const pick = o => Array.isArray(o) ? o
    : (o && (o.workflows || o.rows || o.data || o.items || o.results)) || null;
  let entries = null, usedUrl = "";
  for (const u of CANDS){
    try {
      const r = pick(await api(u, tok));
      if (r && r.length && r[0] && (r[0].id || r[0]._id)){ entries = r; usedUrl = u; break; }
    } catch (_) {}
  }
  if (!entries) throw new Error(
    "Could not list the workflows. None of the " + CANDS.length +
    " endpoints answered. GoHighLevel changed the internal list endpoint: " +
    "please open an issue at github.com/facuga7van/ghl-workflow-auditor");
  say(`list via ${usedUrl.replace(B,"")}`);
  entries = entries.map(w => ({ id: w.id || w._id, name: w.name, status: w.status || "?", version: w.version }));
  say(`${entries.length} workflows`, 0, entries.length);

  let fieldById = {}, fieldKeys = new Set(), accountTags = new Set();
  let rawFields = [], rawTags = [];
  for (const u of [`${B}/locations/${loc}/customFields`,
                   `${B}/custom-fields/?locationId=${loc}&model=contact`]){
    try {
      const cf = await api(u, tok);
      const arr = cf.customFields || cf.customField || (Array.isArray(cf) ? cf : []);
      if (!arr.length) continue;
      rawFields = arr;
      for (const f of arr){
        const key = (f.fieldKey || "").replace("contact.", "");
        fieldById[f.id] = { key }; fieldKeys.add(key);
      }
      say(`${fieldKeys.size} custom fields`); break;
    } catch (_) {}
  }
  if (!fieldKeys.size) say("! could not read custom fields: fields will show as ids");

  try {
    const tg = await api(`${B}/locations/${loc}/tags`, tok);
    rawTags = tg.tags || [];
    for (const t of rawTags) accountTags.add(t.name);
    say(`${accountTags.size} tags`);
  } catch { say("! could not read tags: skipping the missing-tag checks"); }

  const models = [];
  for (let i = 0; i < entries.length; i++){
    const w = entries[i];
    const [detail, triggers, counts] = await Promise.all([
      api(`${B}/workflow/${loc}/${w.id}?includeScheduledPauseInfo=true`, tok).catch(() => null),
      api(`${B}/workflow/${loc}/trigger?workflowId=${w.id}`, tok).catch(() => []),
      api(`${B}/workflows/status/search/count-per-step?workflowId=${w.id}&locationId=${loc}`, tok).catch(() => []),
    ]);
    // A shape we have never seen costs us THAT workflow, not the audit. It comes
    // back as a HIGH finding, so it is impossible to miss in the report.
    let model;
    try { model = extract(w, detail, triggers, counts, fieldById, (rules||{}).funnelIdPattern); }
    catch (e) { model = brokenModel(w, e); }
    models.push(model);
    say(`  ${w.name}${model.parseError ? "   [could not parse: skipped]" : ""}`, i + 1, entries.length);
  }

  const findings = detect(models, fieldKeys, accountTags, rules);
  const edges = graph(models);
  return {
    report: toMarkdown(loc, models, findings, edges),
    bundle: buildBundle(loc, models, findings, edges, rawFields, rawTags),
  };
}
