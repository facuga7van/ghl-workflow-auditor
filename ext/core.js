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

// Opportunity and pipeline steps do NOT keep their values as plain properties.
// They live in `__customInputFields__` as a list of {filterField, value} pairs,
// which is why an audit that reads `attributes.stageId` finds nothing at all.
const inputs = a => Object.fromEntries(
  arr((a || {}).__customInputFields__)
    .filter(f => f && f.filterField)
    .map(f => [f.filterField, f.value]));

function textOf(node){
  const a = node.attributes || {}, out = [];
  for (const k of ["message","body","text","sms","html","subject"]) if (typeof a[k] === "string") out.push(a[k]);
  for (const m of arr(a.messages)) if (m && typeof m === "object")
    out.push(...Object.values(m).filter(v => typeof v === "string"));
  if (a.customData) out.push(JSON.stringify(a.customData));
  return out.join("\n");
}

// A workflow is a GRAPH, not a list. `next` is a string on a linear step and an
// ARRAY on anything that branches, and a `goto` jumps via attributes instead of
// `next` entirely. Walking it as a chain used to stop dead at the first if/else:
// measured against a real 66-workflow account, that left 73% of the steps out of
// the traversal, piled at the end in arbitrary order — while the JSON dump told
// whoever read it that this was "real execution order".
//
// Returns every outgoing edge of a step as {to, label}, where the label is the
// branch name a human sees on the canvas.
function exits(s){
  const a = s.attributes || {};
  if (s.type === "goto")
    return a.targetNodeId ? [{ to: a.targetNodeId, label: "go to" }] : [];

  const nx = arr(s.next).filter(Boolean);
  if (s.type === "if_else"){
    const br = arr(a.branches);
    // GHL ships one entry in `branches` per condition and then ONE MORE id in
    // `next` for the implicit else. If the counts match there is no else arm.
    return nx.map((to, i) => ({
      to,
      label: (br[i] && br[i].name) || (i >= br.length ? "else" : `branch ${i + 1}`),
      isElse: i >= br.length,
    }));
  }
  if (s.type === "workflow_split"){
    const tr = arr(a.transitions);
    return nx.map((to, i) => ({ to, label: (tr[i] && tr[i].name) || `path ${i + 1}` }));
  }
  return nx.map(to => ({ to, label: "" }));
}

// Depth-first from the entry node, which is the order a human reads the canvas:
// a branch is followed to its end before the next one starts.
//
//   steps[]      in traversal order, each carrying `path`, `depth` and `unreachable`
//   edges[]      {from, to, label} inside this workflow
//   cycles[]     step ids that close a loop back onto themselves
//   unreachable  steps no path from the entry node can ever hit
function walk(all){
  const steps = arr(all).filter(s => s && typeof s === "object" && s.id);
  if (!steps.length) return { steps: [], edges: [], cycles: [], unreachable: [] };

  const byId = Object.fromEntries(steps.map(s => [s.id, s]));
  const edges = [];
  for (const s of steps) for (const e of exits(s))
    if (byId[e.to]) edges.push({ from: s.id, to: e.to, label: e.label });

  // The entry node is the one nothing points at. A `goto` target can also be
  // pointed at, which is exactly why a workflow can have no clean entry at all.
  const pointedAt = new Set(edges.map(e => e.to));
  const head = steps.find(s => !pointedAt.has(s.id)) || steps[0];

  const out = [], seen = new Set(), cycles = [], stack = new Set();
  const byFrom = {};
  for (const e of edges) (byFrom[e.from] ||= []).push(e);

  (function go(id, path, depth){
    const s = byId[id];
    if (!s) return;
    if (stack.has(id)){ cycles.push(id); return; }   // loops back on itself
    if (seen.has(id)) return;                        // branches rejoining is normal
    seen.add(id); stack.add(id);
    s.path = path; s.depth = depth;
    out.push(s);
    for (const e of (byFrom[id] || []))
      go(e.to, e.label ? `${path} > ${e.label}` : path, depth + (e.label ? 1 : 0));
    stack.delete(id);
  })(head.id, "main", 0);

  // Anything left cannot be reached from the entry node. That is a finding, not
  // a parsing problem: those steps will never run.
  const unreachable = [];
  for (const s of steps) if (!seen.has(s.id)){
    s.path = "(unreachable)"; s.depth = 0; s.unreachable = true;
    unreachable.push(s.id); out.push(s);
  }
  return { steps: out, edges, cycles, unreachable };
}

// Kept for callers that only want the ordering.
const orderSteps = steps => walk(steps).steps;

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
  const flow = walk(raw);
  const steps = flow.steps;
  const dd = detail || {};
  const m = { id: entry.id, name: entry.name, status: entry.status, version: entry.version,
    // workflow-level toggles: invisible on the canvas, and they break things silently
    settings: { stopOnResponse: dd.stopOnResponse ?? null, allowReEntry: dd.allowMultiple ?? null,
                removeContactFromLastStep: dd.removeContactFromLastStep ?? null,
                timezone: dd.timezone ?? null },
    steps, flow, triggers: arr(triggers).filter(t => t && typeof t === "object"), counts: arr(counts),
    tagsAdded:new Set(), tagsRemoved:new Set(), tagsTrigger:new Set(),
    fieldsWritten:new Set(), fieldsWatched:new Set(), wfRemoved:new Set(), wfAdded:new Set(),
    merge:new Set(), copy:[], funnels:new Set(),
    pipelines:new Set(), stages:new Set(), opps:[], assigns:[] };
  const fname = ref => (fieldById[ref] || fieldById[String(ref).replace("contact.","")] || {}).key
                       || String(ref).replace("contact.","");
  for (const s of steps){
    const a = s.attributes || {};
    if (s.type === "add_contact_tag") arr(a.tags).forEach(t => t && m.tagsAdded.add(t));
    else if (s.type === "remove_contact_tag") arr(a.tags).forEach(t => t && m.tagsRemoved.add(t));
    else if (s.type === "update_contact_field") arr(a.fields).forEach(f => f && m.fieldsWritten.add(fname(f.field)));
    else if (s.type === "remove_from_workflow") arr(a.workflow_id).forEach(w => w && m.wfRemoved.add(w));
    else if (s.type === "add_to_workflow") arr(a.workflow_id).forEach(w => w && m.wfAdded.add(w));
    // Pipelines, stages and ownership: a fifth of the steps in a real sales
    // account, and the part the business actually looks at every morning.
    if (/opportunity/.test(s.type)){
      const f = inputs(a);
      const pipe = a.pipelineId || f.pipelineId || f.pipeline_id || "";
      const stage = f.pipelineStageId || "";
      if (pipe) m.pipelines.add(pipe);
      if (stage) m.stages.add(stage);
      m.opps.push({ stepId: s.id, node: s.name || s.type, path: s.path,
                    action: s.type.includes("create") ? "create"
                          : s.type.includes("find") ? "find" : "update",
                    pipeline: pipe, stage });
    }
    if (s.type === "assign_user" || s.type === "internal-add-opportunity-owner")
      m.assigns.push({ stepId: s.id, node: s.name || s.type, path: s.path,
                       users: arr(a.user_list).length,
                       mergeField: String(a.customUserList || ""),
                       onlyUnassigned: !!a.only_unassigned_contact });

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

// Every step that can be reached BEFORE the given one. This is what makes
// "is this gated?" answerable at all, and it is only possible now that the
// traversal follows branches instead of stopping at the first one.
function ancestry(flow){
  const back = {};
  for (const e of arr(flow && flow.edges)) (back[e.to] ||= []).push(e.from);
  return id => {
    const out = new Set(), q = [id];
    while (q.length){
      for (const p of (back[q.pop()] || [])) if (!out.has(p)){ out.add(p); q.push(p); }
    }
    return out;
  };
}

// Field keys a step tests for presence, wherever GHL hides its conditions.
function gatedFields(s){
  const a = s.attributes || {};
  const out = new Set();
  const scan = branches => {
    for (const br of arr(branches)) for (const sg of arr(br && br.segments))
      for (const c of arr(sg && sg.conditions)){
        if (!c) continue;
        const op = String(c.conditionOperator || "");
        if (op === "has_value" || op === "has_no_value" || op === "==" || op === "is-any-of")
          out.add(String(c.conditionSubType || c.field || "").toLowerCase());
      }
  };
  scan(a.branches);                       // if_else
  scan((a.condition || {}).branches);     // wait, type: condition
  return out;
}

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
    // ---- structure: only answerable since the walk follows branches ----------
    const up = ancestry(m.flow);
    const byId = Object.fromEntries(m.steps.map(s => [s.id, s]));

    for (const id of arr(m.flow && m.flow.cycles)){
      ctxStep = id;
      add("HIGH", wf, "loops back on itself",
          `\`${(byId[id] || {}).name || id}\` is reached again from its own branch: contacts go round forever, sending every message on the way`);
      ctxStep = null;
    }
    for (const id of arr(m.flow && m.flow.unreachable)){
      ctxStep = id;
      add("MEDIUM", wf, "unreachable step",
          `\`${(byId[id] || {}).name || id}\` cannot be reached from the start of this workflow: it will never run`);
      ctxStep = null;
    }

    for (const s of m.steps){
      const a = s.attributes || {};
      ctxStep = s.id;

      // An if/else with no else arm: whoever fails the condition stops here.
      if (s.type === "if_else"){
        const outs = exits(s);
        if (outs.length && !outs.some(e => e.isElse))
          add("HIGH", wf, "branch with no else",
              `\`${s.name || "If/Else"}\` has no else arm: a contact that does not match the condition stops here and never reaches the rest of the workflow`);
      }

      if (s.type === "wait"){
        // Convention across every account that runs an AI agent: waiting for a
        // reply switches the agent off. The fix is a custom field plus a
        // condition wait, which is why this is worth calling out by name.
        if (a.type === "reply")
          add("HIGH", wf, "wait for reply",
              `\`${s.name || "Wait"}\` waits for a reply. If an AI agent is answering on this channel, this step switches it off. Use a custom field and a condition wait instead`);

        // A condition wait tests whether something is TRUE, not whether it
        // CHANGED. If the field is already set when the contact arrives, the
        // wait is satisfied instantly and the whole pause does nothing.
        if (a.type === "condition"){
          const watched = gatedFields(s);
          const before = up(s.id);
          const cleared = [...before].some(pid => {
            const p = byId[pid];
            return p && p.type === "update_contact_field" &&
              arr((p.attributes || {}).fields).some(f =>
                f && (f.value === "" || f.value == null) &&
                [...watched].some(w => w && String(f.field || "").toLowerCase().includes(w)));
          });
          if (watched.size && !cleared)
            add("MEDIUM", wf, "condition wait never resets",
                `\`${s.name || "Wait"}\` waits for a condition that nothing clears beforehand: if it is already true when the contact arrives, the wait ends immediately`);
        }

        const sa = a.startAfter || {};
        if (sa.type === "days" && Number(sa.value) >= 365)
          add("MEDIUM", wf, "parked forever",
              `\`${s.name || "Wait"}\` waits ${sa.value} days: this is a dead end, and anyone reaching it stays inside the workflow indefinitely`);
      }

      // Assigns nobody. Empty user list, no round-robin, no merge field.
      if (s.type === "assign_user" || s.type === "internal-add-opportunity-owner"){
        const users = arr(a.user_list).length;
        if (!users && !String(a.customUserList || ""))
          add("HIGH", wf, "assigns to nobody",
              `\`${s.name || "Assign"}\` has an empty user list: the lead stays unowned and no one is told about it`);
        else if (!users && String(a.customUserList || "").includes("{{"))
          add("MEDIUM", wf, "owner from a merge field",
              `\`${s.name || "Assign"}\` assigns via \`${a.customUserList}\`. If that value is empty the step assigns nobody, silently`);
      }

      // A webhook still pointing at a development machine.
      if (s.type === "webhook"){
        const u = String(a.url || "");
        if (/localhost|127\.0\.0\.1|\.ngrok|:\d{4,5}\/|webhook\.site|requestbin|\/test\//i.test(u))
          add("HIGH", wf, "webhook points at a test endpoint",
              `\`${s.name || "Webhook"}\` posts to \`${u.slice(0, 60)}\`: that looks like a development endpoint left in a live workflow`);
      }

      ctxStep = null;
    }

    // A merge field in a message with nothing upstream checking it is there.
    // GoHighLevel does not abort on an empty merge field, it sends "Hey its ,".
    for (const c of m.copy){
      if (!["sms","email","drip"].includes(c.type)) continue;
      const used = [...String(c.body).matchAll(MERGE_RE)]
        .map(x => x[1]).filter(f => f.startsWith("contact."))
        .map(f => f.replace("contact.", "").toLowerCase());
      if (!used.length) continue;
      const before = up(c.stepId);
      const gates = new Set();
      for (const pid of before) for (const g of gatedFields(byId[pid] || {})) gates.add(g);
      const ungated = used.filter(f => ![...gates].some(g => g && (g.includes(f) || f.includes(g))));
      if (ungated.length){
        ctxStep = c.stepId;
        add("MEDIUM", wf, "merge field with no gate",
            `\`${c.node}\` sends \`{{contact.${ungated[0]}}}\` and nothing upstream checks it has a value: an empty one goes out as-is, mid-sentence`);
        ctxStep = null;
      }
    }

    // Opportunity hygiene.
    const creates = m.opps.filter(o => o.action === "create");
    const finds = m.opps.filter(o => o.action === "find");
    for (const o of creates){
      ctxStep = o.stepId;
      if (!finds.length)
        add("MEDIUM", wf, "opportunity with no lookup",
            `\`${o.node}\` creates an opportunity and nothing in this workflow looks for an existing one first: a returning contact gets a duplicate`);
      if (!o.stage)
        add("MEDIUM", wf, "opportunity with no stage",
            `\`${o.node}\` creates an opportunity without setting a stage: it lands wherever the pipeline defaults to`);
      ctxStep = null;
    }
    // Created in one stage and moved in the same run: the first stage is crossed
    // in zero seconds, so every report and automation keyed to it never sees it.
    for (const o of creates){
      const moved = m.opps.find(x => x.action === "update" && x.stage && x.stage !== o.stage &&
                                     up(x.stepId).has(o.stepId));
      const waited = moved && [...up(moved.stepId)].some(pid => (byId[pid] || {}).type === "wait");
      if (moved && !waited){
        ctxStep = moved.stepId;
        add("MEDIUM", wf, "stage crossed instantly",
            `the opportunity is created and then moved to another stage with no wait in between: the first stage lasts zero seconds and nothing keyed to it will ever fire`);
        ctxStep = null;
      }
    }

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

  // Two published workflows listening for exactly the same thing. Both fire,
  // in no guaranteed order, and whichever writes last wins. In an account you
  // inherited this is the single most common way two builds collide.
  const sig = tr => JSON.stringify([tr.type, arr(tr.conditions).filter(Boolean)
    .map(c => [c.field, c.operator, JSON.stringify(c.value)]).sort()]);
  const byTrigger = {};
  for (const m of models){
    if (m.parseError || m.status !== "published") continue;
    for (const tr of m.triggers) (byTrigger[sig(tr)] ||= new Set()).add(m.name);
  }
  for (const [s, owners] of Object.entries(byTrigger)){
    if (owners.size < 2) continue;
    const type = (JSON.parse(s)[0] || "trigger");
    add("MEDIUM", "(account)", "duplicate trigger",
        `${owners.size} published workflows fire on the same \`${type}\` with identical conditions: ` +
        `${[...owners].join(", ")}. They all run, in no guaranteed order`);
  }

  // A stage that every workflow moves opportunities INTO and none reacts to, or
  // one nothing ever writes. Both mean the pipeline column is decorative.
  const stagesWritten = new Set(models.flatMap(m => [...(m.stages || [])]));
  if (stagesWritten.size){
    const pipes = new Set(models.flatMap(m => [...(m.pipelines || [])]));
    if (pipes.size > 1)
      add("LOW", "(account)", "opportunities across pipelines",
          `workflows in this account write into ${pipes.size} different pipelines: ` +
          `check that nothing moves the same opportunity between them, because it stays the SAME opportunity`);
  }

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

  // Severity is the rule. Impact is whether it is happening to anyone RIGHT NOW.
  // A HIGH in a draft nobody is in outranks nothing; a HIGH in a published
  // workflow with 200 contacts sitting in it is what you fix this morning.
  const byId2 = Object.fromEntries(models.map(m => [m.id, m]));
  const live = m => m && m.status === "published";
  const inFlight = m => arr(m && m.counts).reduce((a, c) => a + ((c && c.count) || 0), 0);
  for (const f of seen.values()){
    const m = byId2[f.workflowId];
    f.live = f.wf === "(account)" ? true : live(m);
    f.contacts = f.wf === "(account)" ? 0 : inFlight(m);
    // rank: live findings first, then by how many people are exposed
    f.impact = (f.live ? 2 : 0) + (f.contacts > 0 ? 1 : 0);
  }

  const order = { HIGH:0, MEDIUM:1, LOW:2 };
  return [...seen.values()].sort((a,b) =>
    order[a.sev] - order[b.sev] ||
    b.impact - a.impact ||
    b.contacts - a.contacts ||
    a.wf.localeCompare(b.wf));
}

// Where the chain leaves the workflows. A trigger tag that no workflow applies
// is not a dead end: an AI agent, a person or an integration writes it. Saying
// so is the difference between an incomplete map and a map that knows its edge.
function boundaries(models){
  const written = new Set(models.flatMap(m => [...m.tagsAdded]));
  const out = [];
  for (const m of models) for (const t of m.tagsTrigger)
    if (!written.has(t)) out.push({ workflow: m.name, workflowId: m.id, waitsFor: t });
  return out;
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

// A finding you can click beats a finding you have to go hunt for by name.
const ghlLink = (loc, wfId) =>
  `https://app.gohighlevel.com/v2/location/${loc}/automation/workflows/${wfId}`;

// `audit-Acme-Co-2026-09-11.md` explains itself in a ticket. The location id
// does not. Falls back to the id when there is no readable account name.
function fileStem(title, loc){
  const s = String(title || "").trim()
    .replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-")
    .replace(/^-|-$/g, "").slice(0, 40).replace(/-$/, "");
  return `${s || loc}-${new Date().toISOString().slice(0, 10)}`;
}

// ---------- full data bundle, meant to be handed to an AI coding agent ----------
function buildBundle(loc, models, findings, edges, rawFields, rawTags){
  return {
    _readme: [
      "Full GoHighLevel sub-account workflow dump, produced by the GHL Audit Chrome extension.",
      "Meant to be read by an AI coding agent so it can write a runbook: what to change and exactly where.",
      "",
      "workflows[].steps is in TRAVERSAL ORDER: depth-first from the entry node, so a branch runs",
      "to its end before the next one starts. The `order` field GHL returns is unreliable, do not",
      "sort by it. Every step keeps its original `id`, `type` and full `attributes`, so any change",
      "can be addressed precisely as workflow.id + step.id.",
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
      "A workflow is a GRAPH. `next` is a string on a linear step and an ARRAY on anything that",
      "branches, and a `goto` jumps through attributes.targetNodeId instead of `next`. Do not read",
      "steps[] as a straight line: each step carries `path` (the branch route, e.g. `main > Lead`)",
      "and `depth`. workflows[].flow.edges holds every internal edge with its branch label,",
      "flow.cycles lists steps that loop back onto themselves, and flow.unreachable lists steps no",
      "path can reach. A step marked `unreachable: true` never runs.",
      "",
      "opportunities[] and assigns[] are resolved from __customInputFields__, where GoHighLevel",
      "hides pipeline, stage and ownership values as {filterField, value} pairs rather than plain",
      "properties. An assign with users: 0 and no mergeField assigns NOBODY.",
      "",
      "boundaries[] is where the chain leaves the workflows: a tag some trigger waits for that no",
      "workflow applies. An AI agent, a person or an integration writes it, and none of that is in",
      "this file. Treat those as open ends, not dead ends.",
      "",
      "findings[] are ordered by severity and then by IMPACT: `live` means the workflow is",
      "published, `contactsInWorkflow` is how many people are sitting in it right now. A HIGH in a",
      "draft nobody is in matters less than a MEDIUM happening to 200 people.",
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
               findings: findings.length, edges: edges.length,
               live: findings.filter(f => f.live).length },
    findings: findings.map(f => ({ severity: f.sev, workflow: f.wf, workflowId: f.workflowId || null,
                                   stepId: f.stepId || null, rule: f.rule, detail: f.msg, occurrences: f.n,
                                   live: !!f.live, contactsInWorkflow: f.contacts || 0,
                                   openInGhl: f.workflowId ? ghlLink(loc, f.workflowId) : null })),
    graph: edges,
    // Where the chain leaves the workflows: tags a trigger waits for that no
    // workflow writes. Something outside does it, and this file cannot see it.
    boundaries: boundaries(models.filter(m => !m.parseError)),
    account: { customFields: rawFields, tags: rawTags,
               pipelines: [...new Set(models.flatMap(m => [...(m.pipelines || [])]))],
               stages: [...new Set(models.flatMap(m => [...(m.stages || [])]))] },
    workflows: models.map(m => ({
      id: m.id, name: m.name, status: m.status, version: m.version,
      openInGhl: ghlLink(loc, m.id),
      // Present only when the workflow could not be parsed. Everything below is
      // EMPTY in that case, which means "not read", never "nothing there".
      ...(m.parseError ? { parseError: m.parseError } : {}),
      settings: m.settings,
      triggers: m.triggers,
      steps: m.steps.map((s, i) => ({ position: i + 1, id: s.id, name: s.name || null,
                                      type: s.type, path: s.path || "main", depth: s.depth || 0,
                                      ...(s.unreachable ? { unreachable: true } : {}),
                                      next: s.next || null, attributes: s.attributes || {} })),
      // The shape of the workflow, resolved: every internal edge with the branch
      // label a human sees on the canvas, plus anything that loops or is orphaned.
      flow: { edges: arr(m.flow && m.flow.edges), cycles: arr(m.flow && m.flow.cycles),
              unreachable: arr(m.flow && m.flow.unreachable) },
      writes: { tags: [...m.tagsAdded], removesTags: [...m.tagsRemoved], fields: [...m.fieldsWritten],
                addsToWorkflows: [...m.wfAdded], removesFromWorkflows: [...m.wfRemoved],
                pipelines: [...(m.pipelines || [])], stages: [...(m.stages || [])] },
      opportunities: m.opps || [],
      assigns: m.assigns || [],
      reads: { triggerTags: [...m.tagsTrigger], watchedFields: [...m.fieldsWatched] },
      inFlight: m.counts || [],
    })),
  };
}

// What changed since the last audit of this account. GoHighLevel bumps a
// workflow's `version` on every save, so drift is free to detect: no diffing of
// step trees, just a number. Indexed by id, never by name — a rename is a
// CHANGE, not a delete plus an add.
function snapshotOf(models){
  return models.map(m => ({ id: m.id, name: m.name, status: m.status, version: m.version }));
}

function diffSnapshots(before, now){
  if (!arr(before).length) return null;
  const was = Object.fromEntries(arr(before).map(w => [w.id, w]));
  const is  = Object.fromEntries(arr(now).map(w => [w.id, w]));
  const out = { added: [], removed: [], changed: [] };
  for (const w of arr(now)){
    const b = was[w.id];
    if (!b){ out.added.push({ name: w.name, status: w.status }); continue; }
    const how = [];
    if (b.version !== w.version) how.push(`edited (v${b.version} -> v${w.version})`);
    if (b.status !== w.status) how.push(`${b.status} -> ${w.status}`);
    if (b.name !== w.name) how.push(`renamed from "${b.name}"`);
    if (how.length) out.changed.push({ name: w.name, how: how.join(", ") });
  }
  for (const w of arr(before)) if (!is[w.id]) out.removed.push({ name: w.name });
  return (out.added.length || out.removed.length || out.changed.length) ? out : null;
}

function toMarkdown(loc, models, findings, edges, diff){
  const pub = models.filter(m => m.status === "published").length;
  const steps = models.reduce((a,m) => a + m.steps.length, 0);
  const today = new Date().toISOString().slice(0,10);
  const live = findings.filter(f => f.live).length;
  return [`# Workflow audit - ${loc}`, "", `generated ${today} by the GHL Audit extension`, "",
    `**${models.length} workflows** (${pub} published) - ${steps} steps - **${findings.length} findings** (${live} in published workflows) - ${edges.length} edges`, "",
    ...(diff ? ["## Changed since the last audit", "",
      ...diff.changed.map(c => `- **${esc(c.name)}** - ${c.how}`),
      ...diff.added.map(c => `- **${esc(c.name)}** - NEW (${c.status})`),
      ...diff.removed.map(c => `- ~~${esc(c.name)}~~ - gone`),
      "", "Audit these first: the rest of the account has not been touched.", ""] : []),
    "## Findings", "",
    findings.length ? ["| Sev | Live | In WF | Workflow | Rule | What happens |","|---|---|---|---|---|---|",
      ...findings.map(f => `| ${f.sev} | ${f.live?"yes":"draft"} | ${f.contacts||""} | ${esc(f.wf)} | ${f.rule} | ${esc(f.msg)}${f.n>1?` (x${f.n})`:""} |`)].join("\n") : "None.",
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
  { SHAPE_VERSION, arr, inputs, parseCurl, fileStem, ghlLink, textOf, exits, walk, orderSteps, extract, brokenModel,
    detect, graph, boundaries, buildBundle, toMarkdown, snapshotOf, diffSnapshots };
