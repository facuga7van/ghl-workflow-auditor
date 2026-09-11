// The full report view. Renders whatever the last run left in storage.session
// and nothing else: the audit itself belongs to the service worker.

const $ = s => document.querySelector(s);
const h = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));

let RESULT = null;

function render(b){
  const s = b.summary;
  const high = b.findings.filter(f => f.severity === "HIGH").length;

  let out = `<h3>Result</h3><div class="stat">
    <div><b>${s.workflows}</b>workflows</div><div><b>${s.published}</b>published</div>
    <div><b>${s.steps}</b>steps</div><div><b class="${high?'HIGH':''}">${s.findings}</b>findings</div>
    <div><b>${s.edges}</b>edges</div></div>`;

  out += `<h3>Findings</h3>`;
  out += b.findings.length
    ? `<table><tr><th>Sev</th><th>Workflow</th><th>Rule</th><th>What happens</th></tr>` +
      b.findings.map(f => `<tr><td class="sev ${f.severity}">${f.severity}</td><td>${h(f.workflow)}</td><td>${h(f.rule)}</td>
        <td>${h(f.detail).replace(/`([^`]+)`/g, "<code>$1</code>")}${f.occurrences>1?` <i>(x${f.occurrences})</i>`:""}</td></tr>`).join("") +
      `</table>`
    : `<p class="hint">None.</p>`;

  out += `<h3>What fires what</h3>`;
  out += b.graph.length
    ? `<pre>${h(b.graph.map(e => `${e.from}  ->  ${e.to}     [${e.via}]`).join("\n"))}</pre>
       <div class="note">Edges via <b>tag</b> and <b>field</b> are implicit: they show up nowhere in the UI, and they are the ones that break builds.</div>`
    : `<p class="hint">None: these workflows don't chain into each other.</p>`;

  out += `<h3>Inventory</h3><table>
    <tr><th>Workflow</th><th>Status</th><th>Steps</th><th>Triggers</th><th>Writes tags</th><th>Writes fields</th></tr>` +
    [...b.workflows].sort((x,y) => x.name.localeCompare(y.name)).map(w =>
      `<tr><td>${h(w.name)}</td><td>${h(w.status)}</td><td>${w.steps.length}</td>
       <td>${h(w.triggers.map(t => t.type).join(", ") || "-")}</td>
       <td>${h(w.writes.tags.join(", ") || "-")}</td>
       <td>${h(w.writes.fields.filter(Boolean).join(", ") || "-")}</td></tr>`).join("") + `</table>`;

  out += `<div class="note">This tells you <b>where to look</b>. It does not tell you whether the copy is right, whether the business actually wants that workflow, or anything about Conversations AI agents: none of that is exposed by any API.<br><br>
        For a full rebuild plan, download the <b>.json</b> and hand it to your AI coding agent. It carries every step in real execution order, with ids you can point at.</div>`;
  $("#out").innerHTML = out;
}

function download(text, name, mime){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
}
const stamp = () => `${RESULT.loc}-${new Date().toISOString().slice(0,10)}`;
$("#dlmd").onclick   = () => download(RESULT.report, `audit-${stamp()}.md`, "text/markdown");
$("#dljson").onclick = () => download(JSON.stringify(RESULT.bundle, null, 1), `workflows-${stamp()}.json`, "application/json");

async function load(){
  const { result, prog } = await chrome.storage.session.get(["result", "prog"]);
  if (!result){
    $("#head").textContent = prog && prog.status === "running"
      ? "Audit still running: leave this open, it will fill in."
      : "Nothing audited yet. Open your sub-account in GoHighLevel and click the extension icon.";
    return;
  }
  RESULT = result;
  $("#head").innerHTML =
    `<code>${h(result.loc)}</code> &nbsp;&middot;&nbsp; ${new Date(result.bundle.meta.generatedAt).toLocaleString()}`
    + ` &nbsp;&middot;&nbsp; v${h(chrome.runtime.getManifest().version)}`;
  $("#dlmd").classList.remove("hidden");
  $("#dljson").classList.remove("hidden");
  render(result.bundle);
}

// A run started from the popup finishes here without a refresh.
chrome.storage.session.onChanged.addListener(c => { if (c.result) load(); });
load();
