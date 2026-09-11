// The full report view. Renders whatever the last run left in storage.session
// and nothing else: the audit itself belongs to the service worker.

const $ = s => document.querySelector(s);
const h = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const code = s => h(s).replace(/`([^`]+)`/g, "<code>$1</code>");

let RESULT = null;
// A hundred findings in one flat table is a scroll, not a report.
const view = { sev: { HIGH: true, MEDIUM: true, LOW: true }, liveOnly: false, q: "", grouped: false };

const stamp = () => fileStem(RESULT.title, RESULT.loc);   // core.js

function visible(){
  const q = view.q.toLowerCase();
  return RESULT.bundle.findings.filter(f =>
    view.sev[f.severity] &&
    (!view.liveOnly || f.live) &&
    (!q || (f.workflow + " " + f.rule + " " + f.detail).toLowerCase().includes(q)));
}

function row(f){
  const where = f.openInGhl
    ? `<a href="${h(f.openInGhl)}" target="_blank" rel="noopener">${h(f.workflow)}</a>`
    : h(f.workflow);
  return `<tr>
    <td class="sev ${f.severity}">${f.severity}</td>
    <td class="live">${f.live ? "live" : "draft"}</td>
    <td class="num">${f.contactsInWorkflow || ""}</td>
    <td>${where}</td>
    <td>${h(f.rule)}</td>
    <td>${code(f.detail)}${f.occurrences > 1 ? ` <i>(x${f.occurrences})</i>` : ""}
        <button class="copy" data-copy="${h(f.severity + " - " + f.workflow + " - " + f.rule + ": " + f.detail)}">copy</button></td>
  </tr>`;
}

function findingsTable(){
  const rows = visible();
  if (!rows.length){
    const none = !RESULT.bundle.findings.length;
    return `<p class="empty">${none
      ? "<b>Nothing found.</b> Every check passed on all " + RESULT.bundle.summary.workflows +
        " workflows. That is rarer than it sounds."
      : "No findings match these filters."}</p>`;
  }
  const head = `<tr><th>Sev</th><th>State</th><th>In WF</th><th>Workflow</th><th>Rule</th><th>What happens</th></tr>`;

  if (!view.grouped) return `<table>${head}${rows.map(row).join("")}</table>`;

  // Grouped: everything wrong with one workflow together, so fixing it is one
  // trip into the GoHighLevel UI instead of six.
  const by = {};
  for (const f of rows) (by[f.workflow] ||= []).push(f);
  return Object.entries(by)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([wf, fs]) => {
      const link = fs[0].openInGhl
        ? `<a href="${h(fs[0].openInGhl)}" target="_blank" rel="noopener">${h(wf)}</a>` : h(wf);
      return `<h4>${link} <span class="count">${fs.length}</span></h4><table>${head}${fs.map(row).join("")}</table>`;
    }).join("");
}

function paintFindings(){
  $("#findings").innerHTML = findingsTable();
  const shown = visible().length, all = RESULT.bundle.findings.length;
  $("#shown").textContent = shown === all ? `${all}` : `${shown} of ${all}`;
}

function render(b){
  const s = b.summary;
  const sev = k => b.findings.filter(f => f.severity === k).length;

  $("#stats").innerHTML = `
    <div><b>${s.workflows}</b>workflows</div><div><b>${s.published}</b>published</div>
    <div><b>${s.steps}</b>steps</div>
    <div><b class="${sev("HIGH") ? "HIGH" : ""}">${sev("HIGH")}</b>high</div>
    <div><b>${sev("MEDIUM")}</b>medium</div><div><b>${sev("LOW")}</b>low</div>
    <div><b>${s.live ?? 0}</b>live</div><div><b>${s.edges}</b>edges</div>`;

  if (b.changedSinceLastAudit){
    const d = b.changedSinceLastAudit;
    $("#changed").innerHTML = `<h3>Changed since the last audit</h3><ul>` +
      d.changed.map(c => `<li><b>${h(c.name)}</b> - ${h(c.how)}</li>`).join("") +
      d.added.map(c => `<li><b>${h(c.name)}</b> - NEW (${h(c.status)})</li>`).join("") +
      d.removed.map(c => `<li><s>${h(c.name)}</s> - gone</li>`).join("") +
      `</ul><p class="hint">Audit these first: nothing else in the account was touched.</p>`;
    $("#changed").classList.remove("hidden");
  }

  paintFindings();

  $("#graph").innerHTML = `<h3>What fires what</h3>` + (b.graph.length
    ? `<pre>${h(b.graph.map(e => `${e.from}  ->  ${e.to}     [${e.via}]`).join("\n"))}</pre>
       <div class="note">Edges via <b>tag</b> and <b>field</b> are implicit: they show up nowhere in the UI, and they are the ones that break builds.</div>`
    : `<p class="hint">None: these workflows don't chain into each other.</p>`)
    + (b.boundaries && b.boundaries.length
    ? `<h3>Where the chain leaves the workflows</h3><pre>${h(b.boundaries
        .map(x => `${x.workflow}  waits for  ${x.waitsFor}`).join("\n"))}</pre>
       <div class="note">No workflow writes these tags. An AI agent, a person or an integration does, and none of that is visible to any API. Open ends, not dead ends.</div>` : "");

  $("#inventory").innerHTML = `<h3>Inventory</h3><table>
    <tr><th>Workflow</th><th>Status</th><th>Steps</th><th>Triggers</th><th>Writes tags</th><th>Writes fields</th></tr>` +
    [...b.workflows].sort((x,y) => x.name.localeCompare(y.name)).map(w =>
      `<tr><td>${w.openInGhl ? `<a href="${h(w.openInGhl)}" target="_blank" rel="noopener">${h(w.name)}</a>` : h(w.name)}</td>
       <td>${h(w.status)}</td><td class="num">${w.steps.length}</td>
       <td>${h(w.triggers.map(t => t.type).join(", ") || "-")}</td>
       <td>${h(w.writes.tags.join(", ") || "-")}</td>
       <td>${h(w.writes.fields.filter(Boolean).join(", ") || "-")}</td></tr>`).join("") + `</table>
    <div class="note">This tells you <b>where to look</b>. It does not tell you whether the copy is right, whether the business actually wants that workflow, or anything about Conversations AI agents: none of that is exposed by any API.</div>`;
}

// ---------- actions ----------
function download(text, name, mime){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
}

async function copy(text, btn){
  const was = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "copied"; }
  catch { btn.textContent = "press ctrl+c"; }
  setTimeout(() => { btn.textContent = was; }, 1500);
}

$("#dlmd").onclick   = () => download(RESULT.report, `audit-${stamp()}.md`, "text/markdown");
$("#dljson").onclick = () => download(JSON.stringify(RESULT.bundle, null, 1), `workflows-${stamp()}.json`, "application/json");
// Straight to the clipboard beats download, open the folder, drag it in.
$("#cpmd").onclick   = e => copy(RESULT.report, e.target);
$("#cpjson").onclick = e => copy(JSON.stringify(RESULT.bundle, null, 1), e.target);

// One click per finding, for pasting a single line into a ticket.
document.addEventListener("click", e => {
  if (e.target.classList.contains("copy")) copy(e.target.dataset.copy, e.target);
});

for (const k of ["HIGH","MEDIUM","LOW"]) $("#f" + k).onclick = e => {
  view.sev[k] = !view.sev[k];
  e.target.classList.toggle("off", !view.sev[k]);
  paintFindings();
};
$("#flive").onclick = e => {
  view.liveOnly = !view.liveOnly;
  e.target.classList.toggle("on", view.liveOnly);
  paintFindings();
};
$("#fgroup").onclick = e => {
  view.grouped = !view.grouped;
  e.target.classList.toggle("on", view.grouped);
  paintFindings();
};
$("#q").addEventListener("input", e => { view.q = e.target.value; paintFindings(); });

async function load(){
  const { result, prog } = await chrome.storage.session.get(["result", "prog"]);
  if (!result){
    $("#head").textContent = prog && prog.status === "running"
      ? "Audit still running: leave this open, it will fill in."
      : "Nothing audited yet. Open a workflow in GoHighLevel and click the extension icon.";
    return;
  }
  RESULT = result;
  document.title = (result.title || result.loc) + " - GHL Audit";
  $("#head").innerHTML = `<b>${h(result.title || "")}</b> <code>${h(result.loc)}</code>`
    + ` &nbsp;&middot;&nbsp; ${new Date(result.bundle.meta.generatedAt).toLocaleString()}`
    + ` &nbsp;&middot;&nbsp; v${h(chrome.runtime.getManifest().version)}`;
  $("#actions").classList.remove("hidden");
  $("#filters").classList.remove("hidden");
  render(result.bundle);
}

// A run started from the popup finishes here without a refresh.
chrome.storage.session.onChanged.addListener(c => { if (c.result) load(); });
load();
