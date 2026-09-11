// A made-up account, so the report can be shown to someone without exposing a
// real client's workflows. Used for the Store screenshots and as the empty
// state: `panel.html?demo=1`.
//
// These are INPUTS, not results. The findings you see are produced by the real
// detectors running over this data, exactly as they would over a live account.
// Nothing here is a hand-written finding, which is why the demo cannot drift
// away from what the tool actually does.

const DEMO_ACCOUNT = "Northwind Plumbing";
const DEMO_LOC = "DEMOLOCATIONID000000";

const D = (id, type, next, attributes = {}, name) => ({ id, type, next, attributes, name });
const sms = (id, next, message, name) => D(id, "sms", next, { message }, name);
const tag = (id, next, tags, name) => D(id, "add_contact_tag", next, { tags }, name);
const wait = (id, next, a, name) => D(id, "wait", next, a, name || "Wait");
const opp = (id, type, next, pipe, stage, name) => D(id, type, next, {
  ...(type.includes("create") ? { pipelineId: pipe } : {}),
  __customInputFields__: [
    { filterField: "name", value: "{{contact.first_name}} {{contact.last_name}}" },
    ...(stage ? [{ filterField: "pipelineStageId", dataType: "SINGLE_OPTIONS", value: stage }] : []),
  ],
}, name);

const TAG_TRIGGER = (...v) => [{ type: "contact_tag", conditions: [{ field: "contact.tags", operator: "is", value: v }] }];

// Each entry is a workflow someone could plausibly have built, with a mistake
// of the kind this tool exists to catch.
const DEMO_WORKFLOWS = [
  {
    id: "wf-intake", name: "01 - New Lead Intake", status: "published", version: 12,
    inFlight: [{ count: 34 }],
    triggers: [{ type: "form_submission", conditions: [] }],
    steps: [
      opp("i1", "internal_create_opportunity", "i2", "pipe-sales", "stage-new", "Create opportunity"),
      opp("i2", "internal_update_opportunity", "i3", "pipe-sales", "stage-contacted", "Move to Contacted"),
      D("i3", "assign_user", "i4", { user_list: [], traffic_split: "equally" }, "Assign to rep"),
      sms("i4", "i5", "Hi {{contact.first_name}}, thanks for reaching out about {{contact.job_type}}. When works for a quick call?", "Opener"),
      wait("i5", "i6", { type: "reply", startAfter: { type: "hour", value: 24, when: "after" } }, "Wait for reply"),
      tag("i6", null, ["lead-contacted"], "Tag contacted"),
    ],
  },
  {
    id: "wf-estimate", name: "02 - Estimate Follow-up", status: "published", version: 7,
    inFlight: [{ count: 112 }],
    triggers: TAG_TRIGGER("estimate-sent"),
    steps: [
      sms("e1", "e2", "Hey {{contact.first_name}}, did you get a chance to look at the estimate?", "Day 1"),
      wait("e2", "e3", { type: "time", startAfter: { type: "days", value: 2, when: "after" } }),
      sms("e3", "e4", "Just checking in on that estimate for {{contact.address}}.", "Day 3"),
      wait("e4", "e5", { type: "time", startAfter: { type: "days", value: 4, when: "after" } }),
      sms("e5", "e6", "Last nudge from us. Happy to revise the numbers if something is off.", "Day 7"),
      D("e6", "goto", null, { targetNodeId: "e1" }, "Go To"),
    ],
  },
  {
    id: "wf-reminders", name: "03 - Appointment Reminders", status: "published", version: 19,
    inFlight: [{ count: 8 }],
    triggers: [{ type: "appointment", conditions: [] }],
    steps: [
      wait("r1", "r2", { type: "appointment", appointmentStartAfter: { when: "before", type: "hours", value: 24 } }, "24h before"),
      sms("r2", "r3", "Reminder: we are booked for {{appointment.start_time}} at {{contact.address}}.", "24h reminder"),
      wait("r3", "r4", { type: "appointment", appointmentStartAfter: { when: "before", type: "hours", value: 1 } }, "1h before"),
      sms("r4", null, "See you in an hour. Our tech is {{contact.assigned_tech}}.", "1h reminder"),
    ],
  },
  {
    id: "wf-router", name: "04 - Qualified Router", status: "published", version: 4,
    inFlight: [],
    triggers: TAG_TRIGGER("QUALIFIED"),
    steps: [
      D("q1", "if_else", ["q2"], { branches: [{ id: "q2", name: "commercial", segments: [
        { conditions: [{ conditionType: "custom_field", conditionSubType: "job_type", conditionOperator: "==" }] }] }] }, "Commercial?"),
      D("q2", "assign_user", "q3", { user_list: ["user-a", "user-b"], traffic_split: "equally" }, "Assign commercial rep"),
      tag("q3", null, ["estimate-sent"], "Mark estimate sent"),
    ],
  },
  {
    id: "wf-router2", name: "05 - Qualified Router (copy)", status: "published", version: 2,
    inFlight: [],
    triggers: TAG_TRIGGER("QUALIFIED"),
    steps: [
      sms("c1", null, "A team member will be in touch shortly.", "Ack"),
    ],
  },
  {
    id: "wf-disq", name: "06 - Disqualified Nurture", status: "published", version: 3,
    inFlight: [{ count: 61 }],
    triggers: TAG_TRIGGER("DISQUALIFIED"),
    steps: [
      wait("d1", "d2", { type: "time", startAfter: { type: "days", value: 30, when: "after" } }),
      sms("d2", "d3", "Hi {{contact.first_name}} - still thinking about that job? Rates changed since we last spoke.", "30 day check-in"),
      wait("d3", null, { type: "time", startAfter: { type: "days", value: 999, when: "after" } }, "Park"),
    ],
  },
  {
    id: "wf-review", name: "07 - Review Request", status: "published", version: 9,
    inFlight: [],
    triggers: TAG_TRIGGER("job-complete"),
    steps: [
      wait("v1", "v2", { type: "time", startAfter: { type: "days", value: 1, when: "after" } }),
      sms("v2", "v3", "Thanks for choosing us! Mind leaving a review? https://g.page/northwind-plumbing/review", "Ask"),
      D("v3", "webhook", null, { url: "https://hooks.zapier.com/hooks/catch/1234567/abcdef/" }, "Notify Zapier"),
    ],
  },
  {
    id: "wf-winback", name: "08 - Winback - Dormant 6mo", status: "published", version: 5,
    inFlight: [{ count: 203 }],
    triggers: [{ type: "contact_changed", conditions: [] }],
    steps: [
      sms("w1", "w2", "It has been a while, {{contact.first_name}} — em dash test —. Anything need a look?", "Winback 1"),
      wait("w2", "w3", { type: "time", startAfter: { type: "minutes", value: 30, when: "after" } }),
      sms("w3", null, "We are running a maintenance special this month.", "Winback 2"),
    ],
  },
  {
    id: "wf-emergency", name: "09 - Emergency Dispatch", status: "published", version: 15,
    inFlight: [{ count: 2 }],
    triggers: TAG_TRIGGER("emergency-call"),
    steps: [
      D("m1", "assign_user", "m2", { user_list: [], customUserList: "{{contact.preferred_tech_id}}" }, "Assign on-call tech"),
      D("m2", "internal_notification", "m3", {}, "Alert dispatcher"),
      sms("m3", null, "We have you down as urgent. {{contact.assigned_tech}} is on the way.", "Confirm"),
    ],
  },
  {
    id: "wf-maint", name: "10 - Maintenance Plan Upsell", status: "draft", version: 1,
    inFlight: [],
    triggers: TAG_TRIGGER("plan-eligible"),
    steps: [
      sms("p1", "p2", "Want to lock in twice-yearly service?", "Pitch"),
      wait("p2", null, { type: "time", startAfter: { type: "days", value: 3, when: "after" } }),
      sms("p-orphan", null, "Leftover draft copy, never wired up.", "Orphan"),
    ],
  },
  {
    id: "wf-quote", name: "11 - Quote Approved", status: "published", version: 6,
    inFlight: [],
    triggers: TAG_TRIGGER("quote-approved"),
    steps: [
      opp("k1", "internal_create_opportunity", "k2", "pipe-jobs", "", "Create job"),
      D("k2", "internal_notification", "k3", {}, "Notify ops"),
      tag("k3", null, ["job-complete"], "Mark job complete"),
    ],
  },
  {
    id: "wf-handoff", name: "12 - Human Handoff", status: "published", version: 2,
    inFlight: [],
    triggers: TAG_TRIGGER("needs-human"),
    steps: [
      D("h1", "internal_notification", "h2", {}, "Ping the team"),
      sms("h2", null, "One of our people is picking this up now.", "Bridge"),
    ],
  },
  {
    id: "wf-empty", name: "13 - Seasonal Promo (unbuilt)", status: "draft", version: 1,
    inFlight: [], triggers: [], steps: [],
  },
];

const DEMO_FIELDS = [
  { id: "f-job", fieldKey: "contact.job_type", dataType: "TEXT" },
  { id: "f-addr", fieldKey: "contact.address", dataType: "TEXT" },
  { id: "f-tech", fieldKey: "contact.assigned_tech", dataType: "TEXT" },
];
const DEMO_TAGS = ["QUALIFIED", "DISQUALIFIED", "estimate-sent", "job-complete", "routed",
                   "lead-contacted", "emergency-call", "plan-eligible", "quote-approved"]
  .map(name => ({ name }));

// Runs the demo account through the real pipeline: same extract, same
// detectors, same bundle. If a detector changes, the demo changes with it.
function demoResult(){
  const fieldById = Object.fromEntries(
    DEMO_FIELDS.map(f => [f.id, { key: f.fieldKey.replace("contact.", "") }]));
  const models = DEMO_WORKFLOWS.map(w => extract(
    { id: w.id, name: w.name, status: w.status, version: w.version },
    { workflowData: { templates: w.steps.map(s => ({ ...s })) },
      stopOnResponse: w.id === "wf-estimate" ? false : true,
      allowMultiple: w.id === "wf-reminders" ? false : true },
    w.triggers, w.inFlight, fieldById));

  const findings = detect(models, new Set(DEMO_FIELDS.map(f => f.fieldKey.replace("contact.", ""))),
    new Set(DEMO_TAGS.map(t => t.name)));
  const edges = graph(models);
  const bundle = buildBundle(DEMO_LOC, models, findings, edges, DEMO_FIELDS, DEMO_TAGS);
  bundle.meta.account = DEMO_ACCOUNT;
  bundle.meta.demo = true;

  return { loc: DEMO_LOC, title: DEMO_ACCOUNT, demo: true,
           report: toMarkdown(DEMO_LOC, models, findings, edges), bundle };
}
