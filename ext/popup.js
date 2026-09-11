// The popup is a view, nothing else. The audit lives in the service worker, so
// closing this window mid-run costs nothing: reopen it and the progress is there.

const $ = s => document.querySelector(s);
const LOC_RE = /\/location\/([A-Za-z0-9]{15,})|[?&]locationId=([A-Za-z0-9]{15,})/;

// A run that has not written progress in this long is not coming back: the
// service worker was killed. Better to offer a retry than to spin forever.
const DEAD_MS = 60000;

let TAB_LOC = "";

const show = (sel, on) => $(sel).classList.toggle("hidden", !on);

async function activeLoc(){
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const m = String((tab && tab.url) || "").match(LOC_RE);
  return { tabId: tab && tab.id, loc: m ? (m[1] || m[2]) : "" };
}

function paint(prog, result){
  const stale = prog && prog.status === "running" && Date.now() - prog.at > DEAD_MS;
  const status = stale ? "error" : (prog && prog.status) || "idle";

  $("#dot").className = "dot" + ({ running:" run", done:" on", error:" bad" }[status] || "");
  if (prog && prog.title) $("#title").textContent = prog.title;
  if (prog && prog.loc)
    $("#meta").innerHTML = `<code>${prog.loc}</code> &middot; session valid ${prog.tokenMins} min`;

  show("#running", status === "running");
  show("#err", status === "error");
  show("#done", status === "done" && !!result);
  show("#go", status === "idle");
  show("#again", status === "done");

  if (status === "running"){
    const pct = prog.total ? Math.round(prog.done / prog.total * 100) : 4;
    $("#fill").style.width = pct + "%";
    $("#now").textContent = (prog.lines && prog.lines[prog.lines.length - 1]) || "";
  }
  if (status === "error"){
    $("#err").textContent = stale
      ? "The run stopped responding and was probably killed. Run it again."
      : prog.error;
    // Only a real run offers a retry. A "wrong tab" error has no run behind it,
    // and retrying from the same tab would fail exactly the same way.
    show("#again", !!prog.at);
  }
  if (status === "done" && result){
    const b = result.bundle;
    const sev = k => b.findings.filter(f => f.severity === k).length;
    $("#nhi").textContent = sev("HIGH");
    $("#nmd").textContent = sev("MEDIUM");
    $("#nlo").textContent = sev("LOW");
    // The number that decides whether you open this now or on Monday.
    $("#sum").textContent = b.findings.length
      ? `${b.summary.live ?? 0} of ${b.findings.length} are in published workflows`
      : `nothing found across ${b.summary.workflows} workflows`;
    $("#sum").className = "sum" + (b.findings.length ? "" : " clean");

    const d = b.changedSinceLastAudit;
    $("#changed").textContent = d
      ? `${d.changed.length + d.added.length + d.removed.length} workflows changed since the last audit`
      : (prog && prog.hadBaseline ? "nothing changed since the last audit" : "");
    show("#changed", !!$("#changed").textContent);
  }
}

async function refresh(){
  const { prog, result } = await chrome.storage.session.get(["prog", "result"]);
  paint(prog, result && result.loc === (prog && prog.loc) ? result : null);
}

chrome.storage.session.onChanged.addListener(refresh);

// ---------- actions ----------
async function start(){
  const { tabId, loc } = await activeLoc();
  if (!loc){
    paint({ status: "error", error: "This tab is not inside a GoHighLevel sub-account. Open Automations, open any workflow, and click the icon again." }, null);
    return;
  }
  await chrome.runtime.sendMessage({ type: "start", tabId });
}

function download(text, name, mime){
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
}

async function copy(text, btn){
  const was = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "copied"; }
  catch { btn.textContent = "could not copy"; }
  setTimeout(() => { btn.textContent = was; }, 1500);
}

const stamp = r => fileStem(r.title, r.loc);   // core.js

async function grab(){ return (await chrome.storage.session.get("result")).result; }

$("#go").onclick = start;
$("#again").onclick = start;

// Focus the report tab if it is already open. Clicking three times should not
// leave you with three identical tabs to close.
$("#open").onclick = async () => {
  const url = chrome.runtime.getURL("panel.html");
  try {
    const [open] = await chrome.tabs.query({ url });
    if (open) return chrome.tabs.update(open.id, { active: true });
  } catch (e) { /* fall through to opening a new one */ }
  chrome.tabs.create({ url });
};

$("#dlmd").onclick = async () => {
  const r = await grab(); download(r.report, `audit-${stamp(r)}.md`, "text/markdown");
};
$("#dljson").onclick = async () => {
  const r = await grab();
  download(JSON.stringify(r.bundle, null, 1), `workflows-${stamp(r)}.json`, "application/json");
};
// Straight to the clipboard beats download, open the folder, drag it in.
$("#cpmd").onclick = async e => copy((await grab()).report, e.target);
$("#cpjson").onclick = async e => copy(JSON.stringify((await grab()).bundle, null, 1), e.target);

// First thing to ask when someone reports a bug: which build are they on.
$("#ver").textContent = "v" + chrome.runtime.getManifest().version;
$("#opts").onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

// ---------- open ----------
(async () => {
  TAB_LOC = (await activeLoc()).loc;
  const { prog, result } = await chrome.storage.session.get(["prog", "result"]);
  const fresh = result && result.loc === TAB_LOC;
  const busy = prog && prog.status === "running" && Date.now() - prog.at <= DEAD_MS;

  // You clicked the icon from a sub-account: that IS the instruction. Only skip
  // the auto-run when there is something to look at already.
  if (!busy && !fresh && TAB_LOC) return start();
  await refresh();
})();
