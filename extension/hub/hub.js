// The hub: Mor's popup (the Twitch tab it was opened on) and, opened as a page, the place to add VPN servers
// (a popup closes when a file picker opens, so files are chosen on the page).
"use strict";

const isPage = new URLSearchParams(location.search).has("page");
document.body.classList.toggle("page", isPage);
browser.runtime.connect({ name: "mor-hub" }); // keeps the helper up while the hub is open

const $ = (id) => document.getElementById(id);
let tabId = null;
let state = null;
let servers = [];
let serverError = null;
let serversKnown = false; // the helper has said which servers there are
let guideOpened = false; // the guide opens by itself once, while there are no servers

async function currentTab() {
  if (isPage) return null;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

function setSwitch(el, on, enabled = true) {
  el.setAttribute("aria-checked", on ? "true" : "false");
  el.disabled = !enabled;
}

function show(el, visible) { el.hidden = !visible; }

function renderHelper() {
  const h = state.helper;
  // without its helper, nothing else works: the hub shows how to set it up instead
  show($("setup"), Boolean(h.missing));
  for (const id of ["filter-card", "unlock-card"]) show($(id), !h.missing);
  const el = $("helper");
  el.className = "helper " + (h.connected ? "up" : h.error || h.missing ? "down" : "");
  el.textContent = h.connected ? "Helper on" : h.missing ? "Helper missing"
    : h.error ? "Helper stopped" : "Starting helper";
  const problems = [];
  if (h.error && !h.missing) problems.push(h.error);
  if (h.connected && h.javascript === false) {
    problems.push("Node.js missing: run Install Mor.cmd again");
  }
  if (h.lastError) problems.push(h.lastError);
  const mine = browser.runtime.getManifest().version;
  if (h.connected && Mor.helperOutdated(h.version, mine)) {
    problems.push(`Helper ${h.version} is older than Mor ${mine}: run Install Mor.cmd from the latest release`);
  }
  $("helper-error").textContent = problems.join("\n");
  show($("helper-error"), problems.length > 0);
}

// A status line: a few words, and under them a problem's whole story when it says more.
function showStatus(prefix, text, detail, kind) {
  $(`${prefix}-text`).textContent = text;
  $(`${prefix}-detail`).textContent = detail || "";
  show($(`${prefix}-detail`), Boolean(detail));
  $(`${prefix}-status`).classList.toggle("problem", kind === "bad");
  $(`${prefix}-dot`).className = "dot " + kind;
}

function renderFilter() {
  const tab = state.tab;
  const channel = tab && tab.channel;
  $("filter-channel").textContent = channel || "No stream open";
  setSwitch($("filter-switch"), Boolean(tab && tab.filterOn), Boolean(channel));
  const on = Boolean(tab && tab.filterOn && channel);
  show($("filter-status"), on);
  if (!on) return;
  const f = tab.filter;
  const row = Mor.rowText(true, f, tab.audio, Date.now());
  showStatus("filter", row.text, row.detail, row.problem ? "bad" : f.state === "filtering" ? "on" : "");
  const wait = Math.max(0, Math.ceil((f.retryAt - Date.now()) / 1000));
  $("filter-retry").disabled = wait > 0 || !state.helper.connected;
  $("filter-wait").textContent = wait > 0 ? `${wait} s` : "";
}

function unlockReadiness() {
  const missing = [];
  if (!state.loggedIn) missing.push("Twitch login");
  if (servers.length === 0) missing.push("VPN server");
  if (state.helper.connected && state.helper.tunnel === false) missing.push("tunnel program");
  if (missing.length) return [`Needs ${missing.join(", ")}`, false];
  return [`${servers.length} server${servers.length === 1 ? "" : "s"}`, true];
}

function renderUnlock() {
  const [readiness, ready] = unlockReadiness();
  $("unlock-sub").textContent = state.unlockOn ? readiness : "Off";
  setSwitch($("unlock-switch"), state.unlockOn);
  const tab = state.tab;
  const u = tab && tab.unlock;
  let text = null, detail = null, kind = "";
  const problem = (told) => { [text, detail] = Mor.splitProblem(told); kind = "bad"; };
  if (state.unlockOn && tab && tab.channel) {
    if (tab.hevc === false) problem("No HEVC | This Firefox can't play HEVC, which 1440p is sent in");
    else if (u && u.error) problem(u.error);
    else if (u && u.via) { text = `${u.extra.join(", ")} via ${Mor.serverLabel(u.server)[1]}`; kind = "good"; }
    else if (u && u.checking) text = "Asking Twitch via VPN";
    else if (u && u.nothingLocked) text = "Nothing locked";
    else if (ready) text = "Waiting for stream";
  }
  show($("unlock-status"), Boolean(text));
  if (text) showStatus("unlock", text, detail, kind);
}

function renderServers() {
  const list = $("servers");
  list.textContent = "";
  for (const name of servers) {
    const [code, label] = Mor.serverLabel(name);
    const li = document.createElement("li");
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = code || "·";
    const text = document.createElement("span");
    text.className = "name";
    text.textContent = label;
    text.title = name;
    li.append(badge, text);
    if (state && state.inUse === name) {
      const use = document.createElement("span");
      use.className = "use";
      use.textContent = "in use";
      li.append(use);
    }
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.setAttribute("aria-label", `Remove ${label}`);
    remove.append(crossIcon());
    remove.addEventListener("click", () => serversReply(browser.runtime.sendMessage({ type: "server-remove",
      name: `${name}.conf` })));
    li.append(remove);
    list.append(li);
  }
  show($("servers-empty"), servers.length === 0);
  $("servers-summary").textContent = servers.length
    ? `VPN servers (${servers.length})` : "VPN servers: none yet";
  $("servers-error").textContent = serverError || "";
  show($("servers-error"), Boolean(serverError));
  if (serversKnown && !guideOpened) {
    // with no servers, the drawer and its guide open by themselves: that's what's needed next
    $("guide").open = servers.length === 0;
    $("servers-drawer").open = isPage || servers.length === 0;
    guideOpened = true;
  }
}

function crossIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 12 12");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M2 2l8 8M10 2l-8 8");
  svg.append(path);
  return svg;
}

function render() {
  if (!state) return;
  renderHelper();
  renderFilter();
  renderUnlock();
  renderServers();
}

async function refresh() {
  state = await browser.runtime.sendMessage({ type: "hub-state", tabId });
  if (state.helper.connected && !servers.length && state.servers.length) servers = state.servers;
  render();
}

async function serversReply(promise) {
  const reply = await promise;
  servers = reply.servers || [];
  serverError = reply.error || null;
  serversKnown = true;
  render();
}

$("setup-check").addEventListener("click", async () => {
  $("setup-check").disabled = true;
  $("setup-check").textContent = "Checking";
  state = await browser.runtime.sendMessage({ type: "helper-check", tabId }) || state;
  $("setup-check").disabled = false;
  $("setup-check").textContent = state.helper.missing ? "Still not found, check again" : "Check again";
  render();
});

$("filter-switch").addEventListener("click", async () => {
  state = await browser.runtime.sendMessage({ type: "toggle-filter", tabId }) || state;
  render();
});

$("unlock-switch").addEventListener("click", async () => {
  state = await browser.runtime.sendMessage({ type: "toggle-unlock", tabId }) || state;
  render();
});

$("filter-retry").addEventListener("click", async () => {
  $("filter-retry").disabled = true;
  const sent = await browser.runtime.sendMessage({ type: "retry", tabId });
  if (!sent) {
    state.tab.filter.problem = "Retry failed | Couldn't reach the music filter to retry";
  }
  refresh();
});

$("add-servers").addEventListener("click", () => {
  if (isPage) $("files").click();
  else {
    browser.tabs.create({ url: browser.runtime.getURL("hub/hub.html?page") });
    window.close();
  }
});

$("files").addEventListener("change", async () => {
  const errors = [];
  let reply = null;
  for (const file of $("files").files) {
    let text;
    try {
      text = await file.text();
    } catch (error) {
      errors.push(`Couldn't read ${file.name}: ${error.message}`);
      continue;
    }
    reply = await browser.runtime.sendMessage({ type: "server-add", name: file.name, text });
    if (reply.error) errors.push(reply.error);
  }
  $("files").value = "";
  if (reply) servers = reply.servers || servers;
  serverError = errors.join("\n") || null;
  render();
});

(async () => {
  tabId = await currentTab();
  await refresh();
  serversReply(browser.runtime.sendMessage({ type: "servers" }));
  setInterval(refresh, 500);
})();
