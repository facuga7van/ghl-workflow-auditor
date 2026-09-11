// node test-flow.js  -- the service worker state machine, end to end.
// core.js has test.js. This one covers the part that cannot be eyeballed: the
// popup reads nothing but chrome.storage.session, so a run that never writes
// "done" leaves it spinning forever with no error anywhere.
const assert = require("assert");
const fs = require("fs"), vm = require("vm"), path = require("path");

const LOC = "AAAAAAAAAAAAAAAAAAAA";
const b64u = o => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = mins => `eyJhbGciOiJIUzI1NiJ9.${b64u({ exp: Math.floor(Date.now()/1000) + mins*60 })}.sig`;

function harness({ token = jwt(60), tabUrl = `https://app.gohighlevel.com/v2/location/${LOC}/automation`,
                   workflows = [{ id:"w1", name:"WF 1", status:"published", version:2 }],
                   failList = false, poisonId = null } = {}){
  const store = {}, local = {};
  const listeners = [];
  const calls = [];

  const respond = url => {
    calls.push(url);
    if (url.includes("/workflows/?locationId=")) {
      if (failList) throw new Error("HTTP 404");
      return { workflows };
    }
    if (url.includes("/list?limit=") || url.includes("/workflow/?locationId=")) throw new Error("HTTP 404");
    if (url.includes("/customFields")) return { customFields: [{ id:"f1", fieldKey:"contact.lead_status" }] };
    if (url.includes("/custom-fields/")) throw new Error("HTTP 404");
    if (url.includes("/tags")) return { tags: [{ name:"qualified" }] };
    if (url.includes("/trigger?")) return [{ type:"contact_tag", conditions:[{ field:"contact.tags", value:["qualified"] }] }];
    if (url.includes("count-per-step")) return [];
    // A detail payload whose shape we cannot read at all. Stands in for whatever
    // GHL ships next that today's parser chokes on.
    if (poisonId && url.includes(`/${poisonId}?`))
      return { get workflowData(){ throw new TypeError("x.forEach is not a function"); } };
    return { stopOnResponse:true, allowMultiple:true, workflowData:{ templates:[
      { id:"s1", type:"add_contact_tag", next:null, attributes:{ tags:["qualified"] } } ] } };
  };

  const ctx = {
    console, JSON, Date, Math, Promise, Set, Map, Object, Array, String, Number, Boolean,
    RegExp, Error, URL, Symbol, isNaN, parseInt,
    setInterval: () => 1, clearInterval: () => {}, setTimeout, queueMicrotask,
    atob: s => Buffer.from(s, "base64").toString("binary"),
    importScripts: () => {},                       // the files are loaded by hand below
    fetch: async url => {
      try { const body = respond(url); return { ok:true, json: async () => body }; }
      catch (e) { return { ok:false, status: Number(e.message.replace(/\D/g,"")) || 500 }; }
    },
    chrome: {
      runtime: {
        getPlatformInfo: async () => ({ os:"win" }),
        getManifest: () => ({ version: "9.9.9" }),
        onMessage: { addListener: fn => listeners.push(fn) },
      },
      tabs: {
        get: async id => ({ id, url: tabUrl, title: "Acme Co | HighLevel" }),
        query: async () => [{ id: 7, url: tabUrl, title: "Acme Co | HighLevel" }],
      },
      scripting: { executeScript: async () => [{ result: token }, { result: "" }] },
      storage: { local: {
        get: async k => Object.fromEntries([].concat(k).map(x => [x, local[x]])),
        set: async o => { Object.assign(local, o); },
      }, session: {
        set: async o => { Object.assign(store, o); },
        get: async k => Object.fromEntries([].concat(k).map(x => [x, store[x]])),
        remove: async k => { delete store[k]; },
      } },
    },
  };
  ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const f of ["core.js", "audit.js", "background.js"])
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, { filename: f });

  return { ctx, store, local, calls, send: msg => listeners[0](msg, {}, () => {}) };
}

const settle = async (store, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (store.prog && store.prog.status !== "running") return store.prog;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("the run never left `running`: the popup would spin forever");
};

(async () => {
  // --- happy path ----------------------------------------------------------
  {
    const { store, send, calls } = harness();
    send({ type: "start", tabId: 7 });
    const prog = await settle(store);

    assert.strictEqual(prog.status, "done", prog.error || "");
    assert.strictEqual(prog.loc, LOC, "the location must come off the tab URL");
    assert.strictEqual(prog.title, "Acme Co", "the | HighLevel suffix is noise");
    assert.ok(prog.tokenMins > 55 && prog.tokenMins <= 60, "token life must be reported");
    assert.strictEqual(prog.done, prog.total, "progress must land on 100%");

    assert.ok(store.result, "a finished run must leave a result for the popup and the panel");
    assert.strictEqual(store.result.loc, LOC);
    assert.ok(store.result.report.includes("# Workflow audit"), "the .md must be ready to download");
    assert.strictEqual(store.result.bundle.summary.workflows, 1);
    assert.ok(calls.some(u => u.includes("count-per-step")), "in-flight counts must be pulled");
    assert.strictEqual(store.result.bundle.meta.toolVersion, "9.9.9",
      "the dump must say which build produced it, or a .json in an old ticket is unreadable");
  }

  // --- an expired token must fail loudly, not audit with it ----------------
  {
    const { store, send, calls } = harness({ token: jwt(-5) });
    send({ type: "start", tabId: 7 });
    const prog = await settle(store);
    assert.strictEqual(prog.status, "error");
    assert.match(prog.error, /expired/i);
    assert.ok(!calls.length, "nothing may be requested with a dead token");
    assert.ok(!store.result, "a failed run must not leave a stale result behind");
  }

  // --- a tab outside a sub-account has no location: say so -----------------
  {
    const { store, send } = harness({ tabUrl: "https://app.gohighlevel.com/v2/dashboard" });
    send({ type: "start", tabId: 7 });
    const prog = await settle(store);
    assert.strictEqual(prog.status, "error");
    assert.match(prog.error, /not inside a sub-account/i);
  }

  // --- the token is nowhere on the page ------------------------------------
  {
    const { store, send } = harness({ token: "" });
    send({ type: "start", tabId: 7 });
    const prog = await settle(store);
    assert.strictEqual(prog.status, "error");
    assert.match(prog.error, /Could not read the session/i);
  }

  // --- every list endpoint is gone: the shape changed, do not fail silently -
  {
    const { store, send } = harness({ failList: true });
    send({ type: "start", tabId: 7 });
    const prog = await settle(store);
    assert.strictEqual(prog.status, "error");
    assert.match(prog.error, /changed the internal list endpoint/i);
  }

  // --- a run that FAILS must not leave the previous account's result on screen
  // This is the one that matters: on success the result is overwritten anyway,
  // so only a failed run can show you one account's findings under another's name.
  {
    const h = harness({ failList: true });
    h.store.result = { loc: "OLDOLDOLDOLDOLDOLDOL", report: "stale", bundle: {} };
    h.send({ type: "start", tabId: 7 });
    const prog = await settle(h.store);
    assert.strictEqual(prog.status, "error");
    assert.ok(!h.store.result, "a failed run must clear the previous account's result, not keep it");
  }

  // --- one unreadable workflow must not cost you the other two -------------
  // This is the containment for the live "(a.workflow_id || []).forEach is not a
  // function" crash: before, ONE odd workflow returned zero audit for the account.
  {
    const h = harness({
      workflows: ["w1","w2","w3"].map(id => ({ id, name:`WF ${id}`, status:"published" })),
      poisonId: "w2",
    });
    h.send({ type: "start", tabId: 7 });
    const prog = await settle(h.store);

    assert.strictEqual(prog.status, "done", "one bad workflow must not fail the whole run");
    const b = h.store.result.bundle;
    assert.strictEqual(b.summary.workflows, 3, "the bad one is reported, not dropped from the count");

    const skipped = b.workflows.filter(w => w.parseError);
    assert.strictEqual(skipped.length, 1, "exactly the poisoned workflow must be marked");
    assert.strictEqual(skipped[0].id, "w2");

    const shout = b.findings.find(f => f.rule === "could not be parsed");
    assert.ok(shout, "a skipped workflow must appear as a finding, not only in the JSON");
    assert.strictEqual(shout.severity, "HIGH", "silently skipping is exactly what we refuse to do");
    assert.strictEqual(b.workflows.filter(w => w.steps.length).length, 2, "the healthy two must still be parsed");
    assert.ok(b.workflows.filter(w => !w.parseError).every(w => w.writes.tags.includes("qualified")),
      "the healthy workflows must be fully read, not half-parsed");
  }

  // --- a second start while one is in flight must not double-run -----------
  {
    const h = harness({ workflows: Array.from({ length: 6 }, (_, i) => ({ id:`w${i}`, name:`WF ${i}`, status:"published" })) });
    h.send({ type: "start", tabId: 7 });
    h.send({ type: "start", tabId: 7 });
    await settle(h.store);
    const listCalls = h.calls.filter(u => u.includes("/workflows/?locationId=")).length;
    assert.strictEqual(listCalls, 1, "a concurrent start must be ignored, not queued");
  }

  // --- a second run reports what changed since the first ------------------
  // This is what turns a one-off audit into something you open twice.
  {
    const wf = v => [{ id:"w1", name:"WF 1", status:"published", version:v },
                     { id:"w2", name:"WF 2", status:"draft", version:1 }];
    const h = harness({ workflows: wf(2) });
    h.send({ type: "start", tabId: 7 });
    await settle(h.store);
    assert.ok(!h.store.result.bundle.changedSinceLastAudit, "the first run has nothing to compare against");
    assert.ok(h.local["snap:" + LOC], "the snapshot must persist across runs");

    // same account, one workflow edited and one published since
    const h2 = harness({ workflows: [{ id:"w1", name:"WF 1", status:"published", version:5 },
                                     { id:"w2", name:"WF 2", status:"published", version:1 }] });
    Object.assign(h2.local, h.local);
    h2.send({ type: "start", tabId: 7 });
    const prog = await settle(h2.store);
    assert.strictEqual(prog.status, "done");

    const d = h2.store.result.bundle.changedSinceLastAudit;
    assert.ok(d, "a second run against a changed account must say what moved");
    assert.strictEqual(d.changed.length, 2);
    assert.ok(h2.store.result.report.includes("Changed since the last audit"),
      "and it has to be at the top of the report, not only in the JSON");
    assert.ok(d.changed.some(c => c.how.includes("v2 -> v5")));
    assert.ok(d.changed.some(c => c.how.includes("draft -> published")));
  }

  console.log("ok  -  service worker flow: 9 scenarios");
})().catch(e => { console.error("FAIL  " + e.message); process.exit(1); });
