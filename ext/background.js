importScripts("core.js", "audit.js");

// The audit runs HERE, not in the popup. A Chrome popup is destroyed the moment
// it loses focus, and a big account takes a minute or two. The views only read
// state out of chrome.storage.session, so closing the popup costs nothing.
//
// storage.session (not .local) on purpose: it is in-memory, so a client's
// workflow dump never hits the disk. It clears when Chrome closes.

const MAX_LINES = 80;

const setProg = p => chrome.storage.session.set({ prog: { ...p, at: Date.now() } });

// A service worker is killed after ~30s idle. Calling an extension API resets
// that timer, so ping while the audit is in flight. Without this a slow account
// dies halfway through with no error.
let ping = null;
const keepAlive = on => {
  if (on && !ping) ping = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  if (!on && ping) { clearInterval(ping); ping = null; }
};

let running = false;

async function start(tabId){
  if (running) return;
  running = true;
  keepAlive(true);
  const lines = [];
  let base = { status: "running", loc: "", title: "", host: "", tokenMins: 0, done: 0, total: 0, error: "" };

  try {
    await setProg({ ...base, lines: ["reading the session from the tab..."] });
    await chrome.storage.session.remove("result");

    const s = await grabSession(tabId);
    base = { ...base, loc: s.loc, title: s.title, host: s.host, tokenMins: minsLeft(s.tok) };
    await setProg({ ...base, lines });

    let last = 0, pending = Promise.resolve();
    const say = (line, done, total) => {
      lines.push(line);
      if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
      if (done !== undefined) { base.done = done; base.total = total; }
      // Throttle: one storage write per workflow is fine, ten per second is not.
      const now = Date.now();
      if (now - last > 150 || done === total) { last = now; pending = setProg({ ...base, lines: [...lines] }); }
    };

    const { rules } = await chrome.storage.local.get("rules");
    const { report, bundle } = await runAudit(s, say, rules);

    // The last progress tick is fire-and-forget. Let it land before writing the
    // final state, or a stray "running" can overwrite "done" and hang the popup.
    await pending;
    // Stamp the build into the dump. A .json that lands in a ticket months later
    // has to say which parser produced it.
    bundle.meta.toolVersion = chrome.runtime.getManifest().version;
    await chrome.storage.session.set({ result: { loc: s.loc, report, bundle } });
    await setProg({ ...base, status: "done", done: base.total,
                    lines: [...lines, `done: ${bundle.summary.findings} findings`] });
  } catch (e) {
    await setProg({ ...base, status: "error", error: e.message, lines });
  } finally {
    running = false;
    keepAlive(false);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === "start"){ start(msg.tabId); reply({ ok: true }); }
  return false;
});
