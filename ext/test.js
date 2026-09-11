// node test.js  -- run it before touching core.js.
// One synthetic account that trips the rules that have actually broken builds.
const assert = require("assert");
const { parseCurl, orderSteps, extract, brokenModel, detect, graph, toMarkdown, buildBundle } = require("./core.js");

const has = (fs, rule) => fs.some(f => f.rule === rule);
const sevOf = (fs, rule) => (fs.find(f => f.rule === rule) || {}).sev;

// --- 1. execution order comes from `next`, never from `order` ---------------
{
  const steps = [
    { id: "c", order: 1, next: null },
    { id: "a", order: 9, next: "b" },
    { id: "b", order: 5, next: "c" },
    { id: "orphan", order: 2, next: null },   // branch tail of an if/else
  ];
  const ids = orderSteps(steps).map(s => s.id);
  assert.deepStrictEqual(ids, ["a", "b", "c", "orphan"], "order must follow the next pointer");
  assert.deepStrictEqual(orderSteps([]), [], "empty workflow must not throw");
}

// --- 2. a cycle must terminate --------------------------------------------
{
  const ids = orderSteps([{ id: "x", next: "y" }, { id: "y", next: "x" }]).map(s => s.id);
  assert.strictEqual(ids.length, 2, "a next-pointer loop must not hang");
}

// --- 3. plan B: token and location out of a raw "Copy as cURL" -------------
{
  const curl = `curl --url ^"https://backend.leadconnectorhq.com/workflow/LOCATIONIDEXAMPLE001/abc?x=1^" `
             + `-H ^"authorization: Bearer eyJhbG.eyJhdXRo.firma_x-1^"`;
  const r = parseCurl(curl);
  assert.strictEqual(r.loc, "LOCATIONIDEXAMPLE001", "the location is the FIRST segment, not the workflow id");
  assert.strictEqual(r.tok, "eyJhbG.eyJhdXRo.firma_x-1");

  const fromUrl = parseCurl("https://app.gohighlevel.com/v2/location/LOCATIONIDEXAMPLE002/automation");
  assert.strictEqual(fromUrl.loc, "LOCATIONIDEXAMPLE002", "a plain /location/ URL must work too");
  assert.strictEqual(parseCurl("").tok, "", "empty input must not throw");
}

// --- GHL sends a SCALAR for one value and an ARRAY for several ---------------
// Reported live: "(a.workflow_id || []).forEach is not a function" on an account
// whose Remove From Workflow step only removed ONE workflow. Same field, same
// step type, different shape. Every attribute we iterate has to survive both.
{
  const one = extract(
    { id:"S", name:"Scalar shapes", status:"published" },
    { workflowData: { templates: [
      { id:"s1", type:"remove_from_workflow", next:"s2", attributes:{ workflow_id: "wf-solo" } },
      { id:"s2", type:"add_to_workflow",      next:"s3", attributes:{ workflow_id: "wf-next" } },
      { id:"s3", type:"add_contact_tag",      next:"s4", attributes:{ tags: "solo-tag" } },
      { id:"s4", type:"remove_contact_tag",   next:"s5", attributes:{ tags: "gone-tag" } },
      { id:"s5", type:"update_contact_field", next:"s6", attributes:{ fields: { field:"f1" } } },
      { id:"s6", type:"sms", next:null, name:"One", attributes:{ messages: { body:"hi there" } } },
    ] } },
    { type:"contact_tag", conditions: { field:"contact.tags", value:"solo-trigger" } },
    null, { f1:{ key:"lead_status" } });

  assert.deepStrictEqual([...one.wfRemoved], ["wf-solo"], "a scalar workflow_id must still be read");
  assert.deepStrictEqual([...one.wfAdded],   ["wf-next"]);
  assert.deepStrictEqual([...one.tagsAdded], ["solo-tag"], "a scalar tag must not iterate as characters");
  assert.deepStrictEqual([...one.tagsRemoved], ["gone-tag"]);
  assert.deepStrictEqual([...one.fieldsWritten], ["lead_status"], "a scalar field object must resolve");
  assert.deepStrictEqual([...one.tagsTrigger], ["solo-trigger"], "a scalar trigger condition must be read");
  assert.ok(one.copy.some(c => c.body.includes("hi there")), "a scalar messages object must still yield copy");
  assert.ok(!one.parseError, "none of this is an error, it is just the other shape");

  // junk in the arrays must not become phantom tags or crash the run
  const junk = extract({ id:"J", name:"Junk", status:"draft" },
    { workflowData:{ templates:[ null, "nope",
      { id:"j1", type:"add_contact_tag", next:null, attributes:{ tags:[null, "", "real"] } } ] } },
    [null, "nope"], null, {});
  assert.deepStrictEqual([...junk.tagsAdded], ["real"], "empty and null tags must be dropped, not added");
}

// --- a workflow we cannot parse must cost that workflow, not the audit -------
{
  const bad = brokenModel({ id:"X", name:"Weird WF", status:"published" }, new TypeError("boom is not a function"));
  assert.ok(bad.parseError.includes("boom"), "the reason must survive for the report");
  assert.deepStrictEqual(bad.steps, [], "a skipped workflow reads as empty");

  const good = extract({ id:"G", name:"Fine WF", status:"published" },
    { workflowData:{ templates:[{ id:"g1", type:"add_contact_tag", next:null, attributes:{ tags:["ok"] } }] } },
    [], [], {});

  const fs2 = detect([bad, good], new Set(), new Set());
  assert.strictEqual(sevOf(fs2, "could not be parsed"), "HIGH", "a skipped workflow must shout, not hide");
  // ...and the detectors must not also invent findings about the empty shell
  assert.ok(!fs2.some(f => f.wf === "Weird WF" && f.rule !== "could not be parsed"),
    "a skipped workflow must not generate 'empty workflow' or 'no trigger' noise on top");

  const b = buildBundle("loc", [bad, good], fs2, [], [], []);
  assert.strictEqual(b.workflows[0].parseError, bad.parseError, "the bundle must tell the agent it was skipped");
  assert.ok(!("parseError" in b.workflows[1]), "a workflow that parsed must not carry the flag");
}

const fieldById = { f1: { key: "lead_status" } };

const wfA = extract(
  { id: "A", name: "WF A: Qualifier", status: "published", version: 3 },
  { workflowData: { templates: [
    { id: "a1", type: "add_contact_tag", next: "a2", attributes: { tags: ["qualified"] } },
    { id: "a2", type: "add_contact_tag", next: "a3", attributes: { tags: ["legacy-human-needed"] } },
    { id: "a3", type: "add_contact_tag", next: "a4", attributes: { tags: ["disqualified"] } },
    { id: "a4", type: "update_contact_field", next: "a5", attributes: { fields: [{ field: "f1" }] } },
    { id: "a5", type: "sms", next: null, name: "Opener",
      attributes: { message: "Hey — book here https://example.com/book and see {{contact.custom.foo}}" } },
  ] } },
  [], [], fieldById);

const wfB = extract(
  { id: "B", name: "WF B: Router", status: "published", version: 1 },
  { workflowData: { templates: [
    { id: "b1", type: "wait", next: null, attributes: {} },
  ] } },
  [
    { type: "contact_tag", conditions: [{ field: "contact.tags", value: ["qualified"] }] },
    { type: "contact_tag", conditions: [{ field: "contact.tags", value: ["ghost-tag"] }] },
    { type: "contact_changed", conditions: [] },
    { type: "appointment", conditions: [] },
  ], [], fieldById);

// --- 3. the model picks up what each workflow writes and reads --------------
assert.deepStrictEqual([...wfA.tagsAdded].sort(), ["disqualified", "legacy-human-needed", "qualified"]);
assert.ok(wfA.fieldsWritten.has("lead_status"), "field id must resolve to its key");
assert.ok(wfB.tagsTrigger.has("qualified"), "trigger tags must be collected");
assert.strictEqual(wfA.steps[0].id, "a1", "extract must keep the resolved order");

// --- 4. detectors ----------------------------------------------------------
const models = [wfA, wfB];
const accountTags = new Set(["qualified", "disqualified", "legacy-human-needed"]);
const RULES = { deprecatedTagPrefixes: ["legacy-"], deprecatedTagReplace: { from: "legacy-", to: "current-" } };
const findings = detect(models, new Set(["lead_status"]), accountTags, RULES);

assert.strictEqual(sevOf(findings, "deprecated tag family"), "HIGH", "a configured deprecated prefix must be flagged HIGH");
assert.ok(findings.find(f => f.rule === "deprecated tag family").msg.includes("current-human-needed"),
  "the finding must name the live tag, not make you remember the mapping");
assert.strictEqual(sevOf(findings, "trigger with no watched field"), "HIGH", "Contact Changed with no field loops");
assert.strictEqual(sevOf(findings, "appointment trigger with no calendar"), "HIGH");
assert.strictEqual(sevOf(findings, "tag does not exist"), "HIGH", "ghost-tag is not in the account");
assert.strictEqual(sevOf(findings, "invalid merge field"), "HIGH", "the .custom. segment does not exist");
assert.strictEqual(sevOf(findings, "contains collision"), "HIGH", "`qualified` lives inside `disqualified`");
assert.strictEqual(sevOf(findings, "encoding in copy"), "MEDIUM", "the em dash breaks in the plugin");
assert.strictEqual(sevOf(findings, "bare link"), "LOW", "a URL with no trigger link fires nothing");

// The MEDIUM path needs a tag that exists in the account and that no workflow writes.
{
  const only = detect([wfB], new Set(), new Set(["qualified", "ghost-tag"]));
  assert.strictEqual(sevOf(only, "tag nobody writes"), "MEDIUM",
    "a trigger tag no workflow applies must still surface");
}
// With no tag list back from the API, membership checks must go quiet, not fire blind.
{
  const blind = detect(models, new Set(["lead_status"]), new Set(), RULES);
  assert.ok(!has(blind, "tag does not exist"), "no tag list means no existence claims");
}

// --- agency rules are OPT-IN -----------------------------------------------
// A fresh install must only report what is broken in ANY GoHighLevel account.
// If these fired on defaults, every new user would open a report full of
// findings about conventions that are not theirs, and stop trusting it.
{
  const plain = detect(models, new Set(["lead_status"]), accountTags);
  assert.ok(!has(plain, "deprecated tag family"), "no configured prefixes means no deprecation findings");
  assert.ok(!has(plain, "routes nowhere"), "no configured routing prefixes means no routing findings");
  // ...while the universal checks must still run, config or no config
  assert.strictEqual(sevOf(plain, "trigger with no watched field"), "HIGH",
    "the universal checks never depend on configuration");
  assert.strictEqual(sevOf(plain, "invalid merge field"), "HIGH");
}

// A routing tag that does not exist in the account routes into the void.
{
  const r = { routingTagPrefixes: ["route-"] };
  const wf = extract({ id:"R", name:"Router", status:"published" },
    { workflowData:{ templates:[
      { id:"r1", type:"add_contact_tag", next:"r2", attributes:{ tags:["route-alive"] } },
      { id:"r2", type:"add_contact_tag", next:null, attributes:{ tags:["route-ghost"] } } ] } },
    [], [], {});
  const f = detect([wf], new Set(), new Set(["route-alive"]), r);
  const hit = f.find(x => x.rule === "routes nowhere");
  assert.ok(hit && hit.msg.includes("route-ghost"), "only the tag that does not exist may be flagged");
  assert.ok(!hit.msg.includes("route-alive"), "a routing tag that exists is not a finding");

  // and with the tag list missing we must not claim anything at all
  assert.ok(!has(detect([wf], new Set(), new Set(), r), "routes nowhere"),
    "no tag list means no existence claims, for agency rules too");
}

// A funnel pattern is opt-in, and a broken one must never cost the audit.
{
  const steps = [
    { id:"h1", type:"webhook", next:"h2", attributes:{ url:"https://x.io/funnel/aaaaaaaaaaaa/go" } },
    { id:"h2", type:"webhook", next:null, attributes:{ url:"https://x.io/funnel/bbbbbbbbbbbb/go" } },
  ];
  const pat = "/funnel/([a-f0-9]{12,})";

  const off = extract({ id:"W", name:"Hooks", status:"published" },
    { workflowData:{ templates: steps } }, [], [], {});
  assert.strictEqual(off.funnels.size, 0, "with no pattern configured, webhooks are not inspected");

  const on = extract({ id:"W", name:"Hooks", status:"published" },
    { workflowData:{ templates: steps } }, [], [], {}, pat);
  assert.strictEqual(on.funnels.size, 2, "two different funnel ids must both be seen");
  assert.strictEqual(sevOf(detect([on], new Set(), new Set()), "multiple funnel ids"), "HIGH",
    "two ids sharing a trigger tag is split attribution");

  const broken = extract({ id:"W", name:"Hooks", status:"published" },
    { workflowData:{ templates: steps } }, [], [], {}, "([unclosed");
  assert.strictEqual(broken.funnels.size, 0, "a bad regex from the options page must not throw");
  assert.ok(!broken.parseError, "...and must not mark the workflow as unreadable either");
}

// --- 5. the implicit edge: A writes a tag B triggers on --------------------
const edges = graph(models);
assert.ok(edges.some(e => e.fromId === "A" && e.toId === "B" && e.via === "tag qualified"),
  "the tag edge is the one nobody sees in the UI");

// --- 6. markdown renders and carries the numbers ---------------------------
const md = toMarkdown("locXYZ", models, findings, edges);
assert.ok(md.includes("# Workflow audit - locXYZ"));
assert.ok(md.includes("WF A: Qualifier"));
assert.ok(md.includes(`**${findings.length} findings**`));

// --- workflow-level toggles: invisible on the canvas, silent when wrong ------
{
  const mk = (type, id) => ({ id, type, next: null, attributes: {} });
  const seq = [mk("sms","s1"), mk("email","s2"), mk("sms","s3")];

  // an outreach sequence that keeps firing after the lead replied
  const noStop = extract({ id:"w1", name:"Blast", status:"published" },
    { stopOnResponse:false, allowMultiple:true, workflowData:{ templates: seq } }, [], [], {});
  assert.strictEqual(noStop.settings.stopOnResponse, false, "settings must come off the raw detail");
  assert.ok(has(detect([noStop], new Set(), new Set()), "outreach that never stops"),
    "3+ sends with Stop on Response OFF must be flagged");

  // same sequence with the toggle on: nothing to say
  const withStop = extract({ id:"w2", name:"Blast OK", status:"published" },
    { stopOnResponse:true, allowMultiple:true, workflowData:{ templates: seq } }, [], [], {});
  assert.ok(!has(detect([withStop], new Set(), new Set()), "outreach that never stops"),
    "Stop on Response ON must not be flagged");

  // two sends is a confirmation pair, not a campaign
  const two = extract({ id:"w3", name:"Confirm", status:"published" },
    { stopOnResponse:false, allowMultiple:true, workflowData:{ templates: seq.slice(0,2) } }, [], [], {});
  assert.ok(!has(detect([two], new Set(), new Set()), "outreach that never stops"),
    "under 3 sends must not be flagged");

  // an appointment flow that drops anyone who reschedules
  const appt = extract({ id:"w4", name:"Reminders", status:"published" },
    { stopOnResponse:true, allowMultiple:false, workflowData:{ templates:[mk("sms","a1")] } },
    [{ type:"appointment", conditions:[{ field:"calendar.id" }] }], [], {});
  assert.ok(has(detect([appt], new Set(), new Set()), "appointment flow without re-entry"),
    "appointment trigger with Allow Re-Entry OFF must be flagged");

// an appointment reminder sequence must NOT be flagged: reminders are supposed
  // to keep firing after the lead replies
  const reminders = extract({ id:"w5", name:"Appointment Reminders", status:"published" },
    { stopOnResponse:false, allowMultiple:true, workflowData:{ templates: seq } },
    [{ type:"appointment", conditions:[{ field:"calendar.id" }] }], [], {});
  assert.ok(!has(detect([reminders], new Set(), new Set()), "outreach that never stops"),
    "appointment reminder flows must not be flagged as runaway outreach");

  // and the toggles must survive into the bundle for the agent to read
  const b = buildBundle("loc", [noStop], [], [], [], []);
  assert.strictEqual(b.workflows[0].settings.stopOnResponse, false, "settings must reach the bundle");
}

console.log(`ok  -  ${findings.length} findings, ${edges.length} edges on the fixture`);
