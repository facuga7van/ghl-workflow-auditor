// Agency rules live in chrome.storage.local, never in the source. That is what
// lets you pull updates to the extension without ever touching your own setup,
// and what keeps this repo generic for everybody else.

const $ = s => document.querySelector(s);

const list = s => String(s || "").split(",").map(x => x.trim()).filter(Boolean);
const show = (s, arr) => { $(s).value = (arr || []).join(", "); };

function say(text, bad){
  $("#msg").textContent = text;
  $("#msg").className = "msg " + (bad ? "bad" : "ok");
  setTimeout(() => { $("#msg").textContent = ""; }, 4000);
}

function fromForm(){
  const swap = list($("#swap").value);
  return {
    deprecatedTagPrefixes: list($("#dep").value),
    deprecatedTagReplace: swap.length === 2 ? { from: swap[0], to: swap[1] } : null,
    routingTagPrefixes: list($("#route").value),
    funnelIdPattern: $("#funnel").value.trim(),
  };
}

function toForm(r){
  r = r || {};
  show("#dep", r.deprecatedTagPrefixes);
  show("#route", r.routingTagPrefixes);
  $("#swap").value = r.deprecatedTagReplace
    ? `${r.deprecatedTagReplace.from}, ${r.deprecatedTagReplace.to}` : "";
  $("#funnel").value = r.funnelIdPattern || "";
}

// A broken regex here would silently kill one detector on every future run, and
// you would never know why. Catch it at save time, while you can still fix it.
function badRegex(p){
  if (!p) return "";
  try { new RegExp(p); } catch (e) { return e.message; }
  return /\(/.test(p) ? "" : "no capture group: wrap the id part in parentheses";
}

$("#save").onclick = async () => {
  const rules = fromForm();
  const err = badRegex(rules.funnelIdPattern);
  if (err) return say("Funnel pattern: " + err, true);
  await chrome.storage.local.set({ rules });
  say("Saved. It applies to the next audit you run.");
};

$("#load").onclick = async () => {
  const { rules } = await chrome.storage.local.get("rules");
  $("#json").value = JSON.stringify(rules || fromForm(), null, 2);
  say("Exported below.");
};

$("#apply").onclick = () => {
  try {
    toForm(JSON.parse($("#json").value));
    say("Loaded into the fields. Hit Save to keep it.");
  } catch (e) { say("That is not valid JSON: " + e.message, true); }
};

$("#clear").onclick = async () => {
  await chrome.storage.local.remove("rules");
  toForm(null);
  $("#json").value = "";
  say("Reset. Only the universal checks run now.");
};

chrome.storage.local.get("rules").then(({ rules }) => toForm(rules));
