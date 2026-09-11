// Audit core: model, detectors, graph, bundle, markdown.
// No DOM, no chrome.* — so `node test.js` can require it straight.
// Everything that talks to the browser or to GHL lives in panel.js.

const SHAPE_VERSION = "2026-09-11";

const URL_RE = /https?:\/\/[^\s"'<>)]+/g;
const MERGE_RE = /\{\{\s*([a-z_]+\.[a-z_0-9.]+)\s*\}\}/gi;

const esc = s => String(s).replace(/\|/g, "\\|");

// Plan B, for when the token cannot be read off the page: pull the token and the
// location id out of a whole "Copy as cURL" pasted as-is. The workflow id in the
// path is NOT the location, so /workflow/{loc}/{wfId} is matched first and on
// purpose: its first segment is the one we want.
function parseCurl(raw){
  const s = String(raw);
  const t = s.match(/eyJ[\w-]+\.eyJ[\w-]+\.[\w.-]+/);
  const l = s.match(/\/workflow\/([A-Za-z0-9]{15,})/)
         || s.match(/\/location\/([A-Za-z0-9]{15,})|[?&]locationId=([A-Za-z0-9]{15,})/);
  return { tok: t ? t[0] : "", loc: (l && (l[1] || l[2])) || "" };
}

// GHL returns a SCALAR when a field holds one value and an ARRAY when it holds
// several, for the same field on the same step type. `workflow_id` on a Remove
// From Workflow step is the one that blew up, but `tags`, `fields` and trigger
// `value` behave the same way. Never iterate a raw attribute: run it through
// here. A bare `for..of` over a string would silently iterate CHARACTERS, which
// is worse than crashing.
const arr = v => v == null ? [] : Array.isArray(v) ? v : [v];

function textOf(node){
  const a = node.attributes || {}, out = [];
  for (const k of ["message","body","text","sms","html","subject"]) if (typeof a[k] === "string") out.push(a[k]);
  for (const m of arr(a.messages)) if (m && typeof m === "object")
    out.push(...Object.values(m).filter(v => typeof v === "string"));
  if (a.customData) out.push(JSON.stringify(a.customData));
  return out.join("\n");
}

// Real execution order comes from the `next` pointer, not the `order` field.
function orderSteps(steps){
  if (!steps.length) return [];
  const byId = Object.fromEntries(steps.map(s => [s.id, s]));
  const targets = new Set(steps.map(s => s.next).filter(Boolean));
  const head = steps.find(s => !targets.has(s.id)) || steps[0];
  const out = [], seen = new Set();
  let cur = head;
  while (cur && !seen.has(cur.id)){ seen.add(cur.id); out.push(cur); cur = byId[cur.next]; }
  for (const s of steps) if (!seen.has(s.id)) out.push(s);   // branch tails of if/else
  return out;
}

// One workflow with a shape we have never seen must not cost you the other 60.
// DESIGN.md says an unexpected shape has to abort and shout rather than fail
// silently, and it still does: the workflow is skipped, marked, and comes back
// as a HIGH finding at the top of the report. It shouts WITHOUT taking the rest
// of the audit down with it.
function brokenModel(entry, err){
  const m = extract(entry, null, [], [], {});
  m.parseError = String((err && err.message) || err);
  return m;
}

function extract(entry, detail, triggers, counts, fieldById, funnelIdPattern){
  const raw = arr(((detail||{}).workflowData || {}).templates).filter(s => s && typeof s === "object");
  const steps = orderSteps(raw);
  const dd = detail || {};
  const m = { id: entry.id, name: entry.name, status: entry.status, version: entry.version,
    // workflow-level toggles: invisible on the canvas, and they break things silently
    settings: { stopOnResponse: dd.stopOnResponse ?? null, allowReEntry: dd.allowMultiple ?? null,
                removeContactFromLastStep: dd.removeContactFromLastStep ?? null,
                timezone: dd.timezone ?? null },
    steps, triggers: arr(triggers).filter(t => t && typeof t === "object"), counts: arr(counts),
    tagsAdded:new Set(), tagsRemoved:new Set(), tagsTrigger:new Set(),
    fieldsWritten:new Set(), fieldsWatched:new Set(), wfRemoved:new Set(), wfAdded:new Set(),
    merge:new Set(), copy:[], funnels:new Set() };
  const fname = ref => (fieldById[ref] || fieldById[String(ref).replace("contact.","")] || {}).key
                       || String(ref).replace("contact.","");
  for (const s of steps){
    const a = s.attributes || {};
    if (s.type === "add_contact_tag") arr(a.tags).forEach(t => t && m.tagsAdded.add(t));
    else if (s.type === "remove_contact_tag") arr(a.tags).forEach(t => t && m.tagsRemoved.add(t));
    else if (s.type === "update_contact_field") arr(a.fields).forEach(f => f && m.fieldsWritten.add(fname(f.field)));
    else if (s.type === "remove_from_workflow") arr(a.workflow_id).forEach(w => w && m.wfRemoved.add(w));
    else if (s.type === "add_to_workflow") arr(a.workflow_id).forEach(w => w && m.wfAdded.add(w));
    // Only when you configured a pattern: a bad regex must never cost the audit.
    if (s.type === "webhook" && funnelIdPattern){
      try {
        const fm = String(a.url || "").match(new RegExp(funnelIdPattern));
        if (fm) m.funnels.add(fm[1] || fm[0]);
      } catch (e) { /* invalid regex from the options page: ignore, not fatal */ }
    }
    const body = textOf(s);
    if (body){
      m.copy.push({ node: s.name || s.type, stepId: s.id, body, type: s.type });
      for (const mm of body.matchAll(MERGE_RE)) m.merge.add(mm[1]);
    }
  }
  for (const tr of m.triggers) for (const c of arr(tr.conditions)){
    const f = String((c||{}).field||"");
    if (f === "contact.tags") arr(c.value).forEach(v => typeof v === "string" && m.tagsTrigger.add(v));
    else if (f.startsWith("contact.")) m.fieldsWatched.add(fname(f));
  }
  return m;
}

// Agency-specific rules. Empty by default, so a fresh install only reports
// things that are wrong in ANY GoHighLevel account. Fill these in on the
// options page to teach the auditor your own conventions.
const NO_RULES = {
  deprecatedTagPrefixes: [],   // tag prefixes your stack no longer reads
  deprecatedTagReplace: null,  // {from, to} to suggest the live name
  routingTagPrefixes: [],      // prefixes that route to a line/inbox/channel
  funnelIdPattern: "",         // regex with ONE capture group, matched on webhook URLs
};

// ---------- detectors: each one is a hard rule learned from a broken build ----------
function detect(models, fieldKeys, accountTags, rules){
  const R = { ...NO_RULES, ...(rules || {}) };
  const startsAny = (s, prefixes) => arr(prefixes).some(p => p && s.startsWith(p));
  const out = [];
  let ctxWf = null, ctxStep = null;
  const add = (sev, wf, rule, msg) =>
    out.push({ sev, wf, rule, msg, workflowId: ctxWf, stepId: ctxStep });
  const written = new Set(models.flatMap(m => [...m.fieldsWritten]));
  const tagsWritten = new Set(models.flatMap(m => [...m.tagsAdded]));
  // The tags endpoint returns no contact count, so "does this tag exist in the
  // account" is the strongest check available. Membership only means anything
  // when the tag list actually came back.
  const knowTags = accountTags && accountTags.size > 0;

  for (const m of models){
    const wf = m.name;
    ctxWf = m.id; ctxStep = null;
    if (m.parseError){
      add("HIGH", wf, "could not be parsed",
          `this workflow did not match the expected shape and was SKIPPED: ${m.parseError}. ` +
          `Nothing below covers it, so open it by hand. Everything else in this report is complete`);
      continue;
    }
    for (const tr of m.triggers){
      const conds = arr(tr.conditions).filter(Boolean);
      const fields = conds.map(c => String(c.field||""));
      if (tr.type === "contact_changed" && !fields.some(f => f.startsWith("contact.")))
        add("HIGH", wf, "trigger with no watched field",
            "Contact Changed with no field set: fires on any edit to the contact and loops on itself");
      if (["appointment","customer_appointment"].includes(tr.type) && !fields.some(f => f.includes("calendar")))
        add("HIGH", wf, "appointment trigger with no calendar",
            "appointment trigger has no calendar filter: fires for EVERY calendar in the account");
      for (const c of conds)
        if (/imessage|whatsapp/i.test(JSON.stringify(c.value || "")))
          add("HIGH", wf, "channel filter",
              "every channel is overridden to SMS: a filter on iMessage/WhatsApp never matches");
    }
    for (const tg of [...m.tagsAdded, ...m.tagsRemoved])
      if (startsAny(tg, R.deprecatedTagPrefixes)){
        const live = R.deprecatedTagReplace && R.deprecatedTagReplace.from
          ? ` The live name is \`${tg.replace(R.deprecatedTagReplace.from, R.deprecatedTagReplace.to || "")}\`.` : "";
        add("HIGH", wf, "deprecated tag family",
            `applies \`${tg}\`, which matches a tag prefix you marked as deprecated: nothing reads it any more.${live}`);
      }
    for (const tg of m.tagsAdded)
      if (startsAny(tg, R.routingTagPrefixes) && knowTags && !accountTags.has(tg))
        add("HIGH", wf, "routes nowhere",
            `applies \`${tg}\` and that tag does not exist in the account: it routes to a destination nobody is on`);
    for (const tg of m.tagsTrigger){
      if (knowTags && !accountTags.has(tg))
        add("HIGH", wf, "tag does not exist", `trigger filters on \`${tg}\` and that tag does NOT exist in the account`);
      else if (!tagsWritten.has(tg))
        add("MEDIUM", wf, "tag nobody writes",
            `trigger waits for \`${tg}\` and no workflow in this account applies it: something outside (an AI agent, a person, an integration) has to, or it never fires`);
    }
    for (const f of m.fieldsWatched)
      if (f && fieldKeys.has(f) && !written.has(f))
        add("LOW", wf, "field written outside workflows",
            `watches \`${f}\` and no workflow writes it: an agent or a person has to`);
    for (const mf of m.merge)
      if (mf.includes(".custom."))
        add("HIGH", wf, "invalid merge field", `\`{{${mf}}}\` uses the .custom. segment, which does not exist in GHL`);
    for (const c of m.copy){
      if (!["sms","email","drip"].includes(c.type)) continue;
      ctxStep = c.stepId;
      const urls = (c.body.match(URL_RE) || []).filter(u => !u.includes("{{"));
      if (urls.length && !c.body.includes("trigger_link"))
        add("LOW", wf, "bare link", `URL with no trigger link in \`${c.node}\`: clicking it fires nothing`);
      const bad = [...new Set([...c.body].filter(ch => ch.charCodeAt(0) > 127))];
      if (bad.length)
        add("MEDIUM", wf, "encoding in copy",
            `\`${c.node}\` has non-ASCII characters (${bad.slice(0,6).join("")}): they break in the plugin`);
      ctxStep = null;
    }
    if (Array.isArray(m.counts) && m.counts.length){
      const tot = m.counts.reduce((a,c) => a + (c.count||0), 0);
      if (tot) add("MEDIUM", wf, "contacts in flight", `${tot} contact(s) sitting inside this workflow right now`);
    }
    // Appointment flows are reminders: they SHOULD keep firing after the lead replies.
    // Only nurture/outreach sequences are meant to stop.
    const isApptFlow = m.triggers.some(t => ["appointment","customer_appointment"].includes(t.type));
    const sends = m.steps.filter(x => ["sms","email","drip"].includes(x.type)).length;
    if (sends >= 3 && !isApptFlow && m.settings && m.settings.stopOnResponse === false)
      add("HIGH", wf, "outreach that never stops",
          `${sends} outbound messages and Stop on Response is OFF: a lead who replies on message 2 still gets the rest`);
    if (m.settings && m.settings.allowReEntry === false
        && m.triggers.some(t => ["appointment","customer_appointment"].includes(t.type)))
      add("MEDIUM", wf, "appointment flow without re-entry",
          "appointment trigger with Allow Re-Entry OFF: anyone who reschedules drops out and gets no reminders");
    if (!m.steps.length)
      add("MEDIUM", wf, "empty workflow", "not a single step: a shell someone left half-built");
    if (!m.triggers.length && m.status === "published" && m.steps.length)
      add("LOW", wf, "no trigger", "published with no trigger: only reachable via Add to Workflow from somewhere else");
  }
  ctxWf = null; ctxStep = null;

  // Attribution split. If you run two landing pages / funnels off the same
  // trigger tag, every postback still fires at ONE fixed id, so one campaign gets
  // credited the other's conversions. Silent: it never shows up as an error.
  // Only checked when you give a funnelIdPattern on the options page.
  const funnelOwners = {};
  for (const m of models) for (const f of m.funnels) (funnelOwners[f] ||= []).push(m.name);
  const funnels = Object.keys(funnelOwners);
  if (funnels.length > 1)
    add("HIGH", "(account)", "multiple funnel ids",
        `${funnels.length} different funnel ids are posted to from this account: ` +
        funnels.map(f => `\`${f.slice(0,10)}\` (${funnelOwners[f].join(", ")})`).join("  vs  ") +
        ". If they share a trigger tag, one campaign gets credited the other's conversions");

  const vocab = [...new Set(models.flatMap(m => [...m.tagsAdded, ...m.tagsTrigger]))].sort();
  for (const a of vocab) for (const b of vocab)
    if (a !== b && b.includes(a))
      add("HIGH", "(account)", "contains collision",
          `\`${a}\` is a substring of \`${b}\`: a contains \`${a}\` filter matches both`);

  const seen = new Map();
  for (const f of out){
    const k = f.wf + "|" + f.rule;
    if (seen.has(k)) seen.get(k).n++; else seen.set(k, { ...f, n: 1 });
  }
  const order = { HIGH:0, MEDIUM:1, LOW:2 };
  return [...seen.values()].sort((a,b) => order[a.sev] - order[b.sev] || a.wf.localeCompare(b.wf));
}

function graph(models){
  const byId = Object.fromEntries(models.map(m => [m.id, m]));
  const e = new Map();
  const put = (a,b,via) => e.set(`${a.id}|${b.id}|${via}`,
    { from:a.name, fromId:a.id, to:b.name, toId:b.id, via });
  for (const a of models){
    for (const b of models){
      if (a.id === b.id) continue;
      for (const t of a.tagsAdded) if (b.tagsTrigger.has(t)) put(a,b,`tag ${t}`);
      for (const f of a.fieldsWritten) if (b.fieldsWatched.has(f)) put(a,b,`field ${f}`);
    }
    for (const w of a.wfAdded) if (byId[w]) put(a,byId[w],"Add to Workflow");
    for (const w of a.wfRemoved) if (byId[w]) put(a,byId[w],"Remove From Workflow (cuts it)");
  }
  return [...e.values()].sort((x,y) => x.from.localeCompare(y.from));
}

// ---------- full data bundle, meant to be handed to an AI coding agent ----------
function buildBundle(loc, models, findings, edges, rawFields, rawTags){
  return {
    _readme: [
      "Full GoHighLevel sub-account workflow dump, produced by the GHL Audit Chrome extension.",
      "Meant to be read by an AI coding agent so it can write a runbook: what to change and exactly where.",
      "",
      "workflows[].steps is in REAL EXECUTION ORDER, resolved by following each step's `next`",
      "pointer. The `order` field GHL returns is unreliable, do not sort by it. Every step keeps",
      "its original `id`, `type` and full `attributes`, so any change can be addressed precisely",
      "as workflow.id + step.id.",
      "",
      "workflows[].writes / .reads are the resolved tag and field names each workflow touches.",
      "graph[] holds the implicit chains: A fires B because A writes a tag or field that B",
      "triggers on. These appear NOWHERE in the GHL UI and are the usual cause of a broken build.",
      "",
      "findings[] carry workflowId and, where it applies, stepId.",
      "account.customFields maps field ids to fieldKey and dataType. Steps reference fields by id,",
      "so resolve them through that list. Note that Add Contact Info on a Conversations AI agent",
      "can only write TEXT and LARGE_TEXT fields, never SINGLE_OPTIONS or CHECKBOX.",
      "",
      "workflows[].settings holds the workflow-level toggles that break things silently:",
      "stopOnResponse (UI: Stop on Response) and allowReEntry (UI: Allow Re-Entry). Neither of",
      "them is visible on the canvas. An outreach sequence with stopOnResponse false keeps firing",
      "after the lead already replied; an appointment flow with allowReEntry false drops anyone",
      "who reschedules, with no error anywhere.",
      "",
      "inFlight is count-per-step: contacts sitting inside the workflow RIGHT NOW, not history.",
      "An empty array is normal and does not mean the workflow is dead.",
      "",
      "If a workflow carries a `parseError`, its shape could not be read and it was SKIPPED.",
      "Its steps, writes and reads are empty because nothing was parsed, NOT because it is",
      "empty. Never conclude anything about that workflow from this file: open it in the UI.",
      "",
      "NOT in here: Conversations AI agents (no API exposes them, internal or public) and whether",
      "the copy is right for the business. Both still need a human.",
    ].join("\n"),
    meta: { locationId: loc, generatedAt: new Date().toISOString(), shapeVersion: SHAPE_VERSION,
            tool: "ghl-audit extension", source: "backend.leadconnectorhq.com (internal API)" },
    summary: { workflows: models.length, published: models.filter(m => m.status === "published").length,
               steps: models.reduce((a,m) => a + m.steps.length, 0),
               findings: findings.length, edges: edges.length },
    findings: findings.map(f => ({ severity: f.sev, workflow: f.wf, workflowId: f.workflowId || null,
                                   stepId: f.stepId || null, rule: f.rule, detail: f.msg, occurrences: f.n })),
    graph: edges,
    account: { customFields: rawFields, tags: rawTags },
    workflows: models.map(m => ({
      id: m.id, name: m.name, status: m.status, version: m.version,
      // Present only when the workflow could not be parsed. Everything below is
      // EMPTY in that case, which means "not read", never "nothing there".
      ...(m.parseError ? { parseError: m.parseError } : {}),
      settings: m.settings,
      triggers: m.triggers,
      steps: m.steps.map((s, i) => ({ position: i + 1, id: s.id, name: s.name || null,
                                      type: s.type, next: s.next || null, attributes: s.attributes || {} })),
      writes: { tags: [...m.tagsAdded], removesTags: [...m.tagsRemoved], fields: [...m.fieldsWritten],
                addsToWorkflows: [...m.wfAdded], removesFromWorkflows: [...m.wfRemoved] },
      reads: { triggerTags: [...m.tagsTrigger], watchedFields: [...m.fieldsWatched] },
      inFlight: m.counts || [],
    })),
  };
}

function toMarkdown(loc, models, findings, edges){
  const pub = models.filter(m => m.status === "published").length;
  const steps = models.reduce((a,m) => a + m.steps.length, 0);
  const today = new Date().toISOString().slice(0,10);
  return [`# Workflow audit - ${loc}`, "", `generated ${today} by the GHL Audit extension`, "",
    `**${models.length} workflows** (${pub} published) - ${steps} steps - **${findings.length} findings** - ${edges.length} edges`, "",
    "## Findings", "",
    findings.length ? ["| Sev | Workflow | Rule | What happens |","|---|---|---|---|",
      ...findings.map(f => `| ${f.sev} | ${esc(f.wf)} | ${f.rule} | ${esc(f.msg)}${f.n>1?` (x${f.n})`:""} |`)].join("\n") : "None.",
    "", "## What fires what", "",
    edges.length ? "```\n" + edges.map(e => `  ${e.from}  ->  ${e.to}     [${e.via}]`).join("\n") + "\n```"
                 : "None.",
    "", "## Inventory", "",
    ["| Workflow | Status | Steps | Triggers | Writes tags | Writes fields |","|---|---|---|---|---|---|",
     ...[...models].sort((a,b)=>a.name.localeCompare(b.name)).map(m =>
      `| ${esc(m.name)} | ${m.status} | ${m.steps.length} | ${m.triggers.map(t=>t.type).join(", ")||"-"} | ${[...m.tagsAdded].join(", ")||"-"} | ${[...m.fieldsWritten].filter(Boolean).join(", ")||"-"} |`)].join("\n"),
  ].join("\n");
}

if (typeof module !== "undefined") module.exports =
  { SHAPE_VERSION, arr, parseCurl, textOf, orderSteps, extract, brokenModel, detect, graph, buildBundle, toMarkdown };
