// node test-graph.js
//
// A workflow is a GRAPH, not a list. Everything in here was impossible to
// assert while the traversal walked `next` as a chain and stopped dead at the
// first branch. Measured against a real 66-workflow account, that left 73% of
// the steps out of the traversal while the JSON dump claimed they were in
// execution order.
const assert = require("assert");
const { walk, exits, extract, detect, boundaries, diffSnapshots } = require("./core.js");

const has = (fs, rule) => fs.some(f => f.rule === rule);
const sevOf = (fs, rule) => (fs.find(f => f.rule === rule) || {}).sev;
const step = (id, type, next, attributes = {}, name) => ({ id, type, next, attributes, name });
const only = (name, templates, triggers = [], counts = [], status = "published") =>
  extract({ id: name, name, status }, { workflowData: { templates } }, triggers, counts, {});

// --- branches: `next` is an ARRAY, and the walk has to follow all of them ----
{
  const steps = [
    step("s1", "sms", "s2", {}, "Opener"),
    step("s2", "if_else", ["b1", "b2"], { branches: [{ id: "b1", name: "yes" }] }, "Replied?"),
    step("b1", "sms", "b1a", {}, "Yes path"),
    step("b1a", "add_contact_tag", null, { tags: ["won"] }),
    step("b2", "sms", null, {}, "Else path"),
  ];
  const f = walk(steps);
  assert.strictEqual(f.steps.length, 5, "every step must be reached, not just the trunk");
  assert.deepStrictEqual(f.steps.map(s => s.id), ["s1", "s2", "b1", "b1a", "b2"],
    "depth first: a branch runs to its end before the next one starts");
  assert.strictEqual(f.steps.find(s => s.id === "b1a").path, "main > yes",
    "a step must know which branch it is on, by the name shown on the canvas");
  assert.strictEqual(f.steps.find(s => s.id === "b2").path, "main > else",
    "the id past the configured branches is the implicit else arm");
  assert.strictEqual(f.edges.length, 4, "s1>s2, s2>b1, s2>b2, b1>b1a");
  assert.deepStrictEqual(f.unreachable, []);
  assert.deepStrictEqual(f.cycles, []);
}

// --- workflow_split names its paths through `transitions` -------------------
{
  const f = walk([
    step("sp", "workflow_split", ["t1", "t2"],
      { transitions: [{ id: "t1", name: "Path A" }, { id: "t2", name: "Path B" }] }),
    step("t1", "sms", null), step("t2", "sms", null),
  ]);
  assert.deepStrictEqual(f.steps.map(s => s.path), ["main", "main > Path A", "main > Path B"]);
}

// --- goto jumps through attributes, not next, and can close a loop ----------
{
  const steps = [
    step("s1", "sms", "s2"),
    step("s2", "wait", "s3", { type: "time", startAfter: { type: "days", value: 1 } }),
    step("s3", "goto", null, { targetNodeId: "s1" }, "Go To"),
  ];
  const f = walk(steps);
  assert.strictEqual(f.steps.length, 3, "a goto target must be followed");
  assert.deepStrictEqual(f.cycles, ["s1"], "a goto pointing back up is an infinite loop");
  assert.strictEqual(sevOf(detect([only("Looper", steps)], new Set(), new Set()), "loops back on itself"),
    "HIGH", "a loop sends a message per lap: it cannot be anything but HIGH");
}

// --- steps nothing points at will never run ---------------------------------
{
  const steps = [step("s1", "sms", null), step("orphan", "sms", null, {}, "Left over")];
  const f = walk(steps);
  assert.deepStrictEqual(f.unreachable, ["orphan"]);
  assert.ok(f.steps.find(s => s.id === "orphan").unreachable);
  assert.strictEqual(sevOf(detect([only("Orphan", steps)], new Set(), new Set()), "unreachable step"), "MEDIUM");
}

// --- an if/else with no else arm strands whoever fails the condition ---------
{
  const steps = [
    step("s1", "if_else", ["b1"], { branches: [{ id: "b1", name: "yes" }] }, "Qualified?"),
    step("b1", "sms", null),
  ];
  assert.ok(!exits(steps[0]).some(e => e.isElse), "one next per branch means no else arm");
  assert.strictEqual(sevOf(detect([only("No else", steps)], new Set(), new Set()), "branch with no else"), "HIGH");

  // An if_else with NO branches configured is not that bug. Reporting it would
  // have produced 18 false positives on the first real account this ran against.
  const empty = [step("s1", "if_else", ["b1"], { branches: [] }), step("b1", "sms", null)];
  assert.ok(!has(detect([only("Unconfigured", empty)], new Set(), new Set()), "branch with no else"),
    "an unconfigured if/else must not be reported as a missing else");
}

// --- opportunity values hide in __customInputFields__ -----------------------
// Reading `attributes.stageId` finds nothing. On a real account that was 84
// steps and 14 stages the audit could not see at all.
{
  const opp = (id, type, next, pipe, stage) => step(id, type, next, {
    ...(type.includes("create") ? { pipelineId: pipe } : {}),
    __customInputFields__: [
      { filterField: "name", value: "{{contact.first_name}}" },
      ...(stage ? [{ filterField: "pipelineStageId", dataType: "SINGLE_OPTIONS", value: stage }] : []),
      ...(type.includes("update") ? [{ filterField: "pipelineId", value: pipe }] : []),
    ],
  });

  const m = only("Sales", [
    opp("o1", "internal_create_opportunity", "o2", "PIPE1", "STAGE_NEW"),
    opp("o2", "internal_update_opportunity", null, "PIPE1", "STAGE_WON"),
  ]);
  assert.deepStrictEqual([...m.pipelines], ["PIPE1"], "the pipeline must resolve");
  assert.deepStrictEqual([...m.stages].sort(), ["STAGE_NEW", "STAGE_WON"], "stages must resolve");
  assert.strictEqual(m.opps.length, 2);
  assert.strictEqual(m.opps[0].action, "create");

  const f = detect([m], new Set(), new Set());
  assert.strictEqual(sevOf(f, "stage crossed instantly"), "MEDIUM",
    "created then moved with no wait: the first stage lasts zero seconds");
  assert.strictEqual(sevOf(f, "opportunity with no lookup"), "MEDIUM",
    "create with no find first hands a returning contact a duplicate");

  const ok = only("Sales OK", [
    step("f0", "find_opportunity", "o1", { __customInputFields__: [{ filterField: "pipeline_id", value: "PIPE1" }] }),
    opp("o1", "internal_create_opportunity", "w1", "PIPE1", "STAGE_NEW"),
    step("w1", "wait", "o2", { type: "time", startAfter: { type: "minutes", value: 30 } }),
    opp("o2", "internal_update_opportunity", null, "PIPE1", "STAGE_WON"),
  ]);
  const f2 = detect([ok], new Set(), new Set());
  assert.ok(!has(f2, "stage crossed instantly"), "a wait in between makes the stage real");
  assert.ok(!has(f2, "opportunity with no lookup"), "a find_opportunity first is the fix");
}

// --- an assign step with an empty user list owns nothing --------------------
// 22 of these were live in the first real account this ran against.
{
  const mk = (attrs, name) => only(name, [step("a1", "assign_user", null, attrs, "Assign")]);
  assert.strictEqual(sevOf(detect([mk({ user_list: [] }, "Nobody")], new Set(), new Set()),
    "assigns to nobody"), "HIGH");
  assert.strictEqual(sevOf(detect([mk({ user_list: [], customUserList: "{{appointment.user.id}}" }, "Merge")],
    new Set(), new Set()), "owner from a merge field"), "MEDIUM",
    "a merge field owner is fine until it is empty, and that is silent");
  assert.ok(!has(detect([mk({ user_list: ["u1", "u2"] }, "Real")], new Set(), new Set()), "assigns to nobody"),
    "an actual round robin is not a finding");
}

// --- a merge field nothing checked goes out as-is, mid sentence -------------
{
  const ungated = only("Blast", [
    step("s1", "wait", "s2", { type: "time", startAfter: { type: "minutes", value: 5 } }),
    step("s2", "sms", null, { message: "Hey {{contact.first_name}}, about {{contact.city}}" }, "Opener"),
  ]);
  assert.strictEqual(sevOf(detect([ungated], new Set(), new Set()), "merge field with no gate"), "MEDIUM",
    "GoHighLevel does not abort on an empty merge field, it sends the sentence with a hole in it");

  // An upstream if/else testing the field is the fix, and the walk has to find
  // it ACROSS the branch, which is the whole point of the rewrite.
  const gated = only("Gated", [
    step("g1", "if_else", ["s2", "x"], { branches: [{ id: "s2", name: "has name", segments: [
      { conditions: [{ conditionSubType: "first_name", conditionOperator: "has_value" }] }] }] }),
    step("s2", "sms", null, { message: "Hey {{contact.first_name}}" }, "Opener"),
    step("x", "sms", null, { message: "no name on file" }),
  ]);
  assert.ok(!has(detect([gated], new Set(), new Set()), "merge field with no gate"),
    "a has_value check upstream is the gate");
}

// --- two published workflows listening for the same thing ------------------
{
  const tr = [{ type: "contact_tag", conditions: [{ field: "contact.tags", operator: "is", value: ["hot"] }] }];
  const f = detect([only("Router A", [], tr), only("Router B", [], tr), only("Draft C", [], tr, [], "draft")],
    new Set(), new Set());
  const hit = f.find(x => x.rule === "duplicate trigger");
  assert.ok(hit, "identical triggers on two live workflows both fire, in no guaranteed order");
  assert.ok(hit.msg.includes("Router A") && hit.msg.includes("Router B"));
  assert.ok(!hit.msg.includes("Draft C"), "a draft is not competing with anything yet");
}

// --- impact: the same finding in a live workflow outranks one in a draft ----
{
  const mk = (name, status, counts) =>
    extract({ id: name, name, status },
      { workflowData: { templates: [step("s1", "assign_user", null, { user_list: [] })] } }, [], counts, {});
  const f = detect([mk("Draft one", "draft", []), mk("Live one", "published", [{ count: 200 }])],
    new Set(), new Set());
  const hits = f.filter(x => x.rule === "assigns to nobody");
  assert.strictEqual(hits[0].wf, "Live one", "what is happening to 200 people goes first");
  assert.strictEqual(hits[0].contacts, 200);
  assert.strictEqual(hits[1].live, false);

  // Nobody is in either one, so the head count cannot be what decides. Published
  // still has to outrank draft: one is running in production, the other is not.
  const tie = detect([mk("A draft", "draft", []), mk("B live", "published", [])], new Set(), new Set())
    .filter(x => x.rule === "assigns to nobody");
  assert.strictEqual(tie[0].wf, "B live",
    "with an equal head count, being published is what breaks the tie");
  assert.strictEqual(tie[0].impact, 2);
  assert.strictEqual(tie[1].impact, 0);
}

// --- the graph has to admit where it ends ----------------------------------
{
  const writer = only("Writer", [step("s1", "add_contact_tag", null, { tags: ["known"] })]);
  const waiter = only("Waiter", [], [{ type: "contact_tag",
    conditions: [{ field: "contact.tags", value: ["known", "written-by-an-agent"] }] }]);
  assert.deepStrictEqual(boundaries([writer, waiter]).map(x => x.waitsFor), ["written-by-an-agent"],
    "a tag no workflow writes is an open end, not a dead end: something outside writes it");
}

// --- drift between runs is free: GHL bumps `version` on every save ---------
{
  const before = [{ id: "w1", name: "One", status: "published", version: 3 },
                  { id: "w2", name: "Two", status: "draft", version: 1 },
                  { id: "w3", name: "Gone", status: "published", version: 9 }];
  const now = [{ id: "w1", name: "One renamed", status: "published", version: 4 },
               { id: "w2", name: "Two", status: "published", version: 1 },
               { id: "w4", name: "Brand new", status: "draft", version: 1 }];
  const d = diffSnapshots(before, now);
  assert.strictEqual(d.changed.length, 2);
  assert.ok(d.changed[0].how.includes("v3 -> v4") && d.changed[0].how.includes("renamed"),
    "an edit plus a rename on one workflow is ONE change: indexed by id, never by name");
  assert.ok(d.changed[1].how.includes("draft -> published"), "publishing is a change worth seeing");
  assert.deepStrictEqual(d.added.map(x => x.name), ["Brand new"]);
  assert.deepStrictEqual(d.removed.map(x => x.name), ["Gone"]);
  assert.strictEqual(diffSnapshots([], now), null, "no baseline means no diff section");
  assert.strictEqual(diffSnapshots(now, now), null, "nothing changed means nothing to say");
}

// --- a webhook left pointing at a dev machine ------------------------------
{
  const hook = u => detect([only("Hook", [step("s1", "webhook", null, { url: u }, "Post")])], new Set(), new Set());
  assert.strictEqual(sevOf(hook("https://abc123.ngrok.io/hook"), "webhook points at a test endpoint"), "HIGH");
  assert.strictEqual(sevOf(hook("http://localhost:3000/hook"), "webhook points at a test endpoint"), "HIGH");
  assert.ok(!has(hook("https://api.acme.com/leads"), "webhook points at a test endpoint"),
    "a real endpoint is not a finding");
}

// --- wait nodes: reply switches an AI agent off, 999 days is a dead end ----
{
  const w = (a, name) => detect([only(name, [step("s1", "wait", null, a, name)])], new Set(), new Set());
  assert.strictEqual(sevOf(w({ type: "reply" }, "Wait reply"), "wait for reply"), "HIGH");
  assert.strictEqual(sevOf(w({ type: "time", startAfter: { type: "days", value: 999 } }, "Park"),
    "parked forever"), "MEDIUM");
  assert.ok(!has(w({ type: "time", startAfter: { type: "days", value: 3 } }, "Normal"), "parked forever"));
}


// --- a filename you recognise in a ticket, not a location id ---------------
{
  const { fileStem } = require("./core.js");
  const day = new Date().toISOString().slice(0, 10);
  assert.strictEqual(fileStem("Acme Co", "LOC123"), `Acme-Co-${day}`);
  assert.strictEqual(fileStem("", "LOC123"), `LOC123-${day}`, "no account name falls back to the id");
  assert.strictEqual(fileStem(null, "LOC123"), `LOC123-${day}`);
  assert.strictEqual(fileStem("Bob's Plumbing & Air, LLC", "L"), `Bobs-Plumbing-Air-LLC-${day}`,
    "punctuation a filesystem would choke on has to go");
  assert.ok(!fileStem("x".repeat(90), "L").startsWith("x".repeat(41)), "long names get cut");
  assert.ok(!/--|-\d{4}-\d\d-\d\d$/.test(fileStem("A   B", "L").replace(/-\d{4}-\d\d-\d\d$/, "")),
    "collapsed spaces must not leave double dashes");
  assert.strictEqual(fileStem("  Trailing  ", "L"), `Trailing-${day}`, "no dangling dash before the date");
}

// --- the demo account has to keep working ----------------------------------
// It is what the Web Store screenshots are taken from and what someone sees
// before they run their first audit. Its findings come from the REAL detectors,
// so if one changes and the demo stops showing a spread of them, the screenshots
// quietly become a lie about what the tool does.
{
  const vm = require("vm");
  const ctx = { console, JSON, Date, Math, Set, Map, Object, Array, String,
                Number, Boolean, RegExp, Error, Symbol };
  vm.createContext(ctx);
  for (const f of ["core.js", "demo.js"])
    vm.runInContext(require("fs").readFileSync(require("path").join(__dirname, f), "utf8"), ctx, { filename: f });

  const r = vm.runInContext("demoResult()", ctx);
  const b = r.bundle;

  assert.ok(r.demo && b.meta.demo, "the demo must be labelled as one, on screen and in the dump");
  assert.strictEqual(b.meta.account, "Northwind Plumbing");
  assert.ok(!/[0-9a-f]{20}/i.test(b.meta.locationId), "the demo location id must not look like a real one");

  assert.ok(b.summary.workflows >= 10, "a two-workflow screenshot does not show anything");
  assert.ok(b.summary.findings >= 25, "got " + b.summary.findings + " findings");
  assert.ok(b.summary.edges >= 2, "the graph section must not be empty in a screenshot");
  assert.ok(b.boundaries.length >= 1, "and neither must the boundaries section");

  const rules = new Set(b.findings.map(f => f.rule));
  assert.ok(rules.size >= 18, "only " + rules.size + " distinct rules: the demo stopped covering the catalogue");
  for (const must of ["loops back on itself", "assigns to nobody", "merge field with no gate",
                      "wait for reply", "contains collision", "duplicate trigger",
                      "stage crossed instantly", "unreachable step", "branch with no else"])
    assert.ok(rules.has(must), "the demo no longer demonstrates: " + must);

  assert.ok(b.findings[0].live && b.findings[0].contactsInWorkflow > 0,
    "the top row is the screenshot: it has to be something happening to real people");
  // ...and among equals, the most exposed goes first. Two HIGH findings both
  // live and both with people in them can only be ordered by head count.
  const highs = b.findings.filter(f => f.severity === "HIGH" && f.contactsInWorkflow > 0);
  assert.ok(highs.length >= 2, "the demo needs at least two comparable HIGH findings");
  // Spread both sides here on purpose: these objects come out of a vm context,
  // so their Array prototype is not this realm's and deepStrictEqual would fail
  // on identical values.
  const counts = [...highs.map(f => f.contactsInWorkflow)];
  assert.deepStrictEqual(counts, [...counts].sort((x, y) => y - x),
    "equally severe findings must be ordered by how many people are exposed");
  assert.ok(r.report.includes("# Workflow audit"), "the demo must also produce a downloadable report");
}

// --- the five detectors that had no test at all -----------------------------
// Found by diffing the rules in detect() against the strings any test asserts
// on. Changing one of these used to break nothing.
{
  // A channel filter only fails when the channel arrives through a custom
  // provider. Native WhatsApp exists, so this asks you to check rather than
  // asserting the filter is broken -- and it is MEDIUM for that reason.
  const chan = only("Channel", [], [{ type: "customer_reply",
    conditions: [{ field: "message.channel", operator: "is", value: "WhatsApp" }] }]);
  assert.strictEqual(sevOf(detect([chan], new Set(), new Set()), "channel filter"), "MEDIUM",
    "asserting it never matches would be a confident falsehood on a native setup");
  const plain = only("Plain", [], [{ type: "customer_reply",
    conditions: [{ field: "message.channel", operator: "is", value: "SMS" }] }]);
  assert.ok(!has(detect([plain], new Set(), new Set()), "channel filter"), "SMS is not a finding");

  // A condition wait tests whether something is TRUE, not whether it CHANGED.
  const cond = a => only("Waiter" + a, [
    step("c0", "update_contact_field", "c1", { fields: a ? [{ field: "reply_status", value: "" }] : [] }),
    step("c1", "wait", null, { type: "condition", condition: { branches: [{ segments: [
      { conditions: [{ conditionSubType: "reply_status", conditionOperator: "has_value" }] }] }] } }, "Wait"),
  ]);
  assert.strictEqual(sevOf(detect([cond(false)], new Set(), new Set()), "condition wait never resets"), "MEDIUM",
    "nothing clears the field, so an already-set value ends the wait instantly");
  assert.ok(!has(detect([cond(true)], new Set(), new Set()), "condition wait never resets"),
    "clearing the field upstream is exactly the fix");

  // People sitting inside a workflow right now, which is what makes editing it risky.
  const busy = extract({ id: "B", name: "Busy", status: "published" },
    { workflowData: { templates: [step("s1", "wait", null, { type: "time" })] } },
    [], [{ count: 40 }, { count: 2 }], {});
  const f = detect([busy], new Set(), new Set());
  assert.strictEqual(sevOf(f, "contacts in flight"), "MEDIUM");
  assert.ok(f.find(x => x.rule === "contacts in flight").msg.includes("42"),
    "the count has to be the total across steps, not just the first one");
  assert.ok(!has(detect([only("Quiet", [step("s1", "wait", null, {})])], new Set(), new Set()),
    "contacts in flight"), "an empty workflow is not busy");

  // A field a trigger watches that no workflow writes: someone or something
  // outside has to set it.
  const watch = extract({ id: "W", name: "Watcher", status: "published" },
    { workflowData: { templates: [step("s1", "sms", null, { message: "hi" })] } },
    [{ type: "contact_changed", conditions: [{ field: "contact.lead_score" }] }], [], {});
  assert.strictEqual(sevOf(detect([watch], new Set(["lead_score"]), new Set()),
    "field written outside workflows"), "LOW");

  // An opportunity with no stage lands on whatever the pipeline defaults to.
  const noStage = only("NoStage", [step("o1", "internal_create_opportunity", null,
    { pipelineId: "P", __customInputFields__: [{ filterField: "name", value: "x" }] }, "Create")]);
  assert.strictEqual(sevOf(detect([noStage], new Set(), new Set()), "opportunity with no stage"), "MEDIUM");
}

console.log("ok  -  graph traversal, opportunities, assignment, impact, drift");
