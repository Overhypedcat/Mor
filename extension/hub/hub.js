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
  const el = $("helper");
  el.className = "helper " + (h.connected ? "up" : h.error ? "down" : "");
  el.textContent = h.connected ? "Helper running" : h.error ? "Helper stopped" : "Starting helper";
  const problems = [];
  if (h.error) problems.push(h.error);
  if (h.connected && h.javascript === false) {
    problems.push("Getting songs from YouTube needs Node.js: run Install Mor.cmd again");
  }
  if (h.lastError) problems.push(h.lastError);
  $("helper-error").textContent = problems.join("\n");
  show($("helper-error"), problems.length > 0);
}

function renderFilter() {
  const tab = state.tab;
  const channel = tab && tab.channel;
  $("filter-channel").textContent = channel
    ? `Takes the songs out of ${channel}'s sound, keeps the voice and the game`
    : "Open a Twitch channel's live stream";
  setSwitch($("filter-switch"), Boolean(tab && tab.filterOn), Boolean(channel));
  const on = Boolean(tab && tab.filterOn && channel);
  show($("filter-status"), on);
  if (!on) return;
  const f = tab.filter;
  const problem = tab.audio || f.problem;
  let text;
  if (problem) text = problem;
  else if (f.state === "filtering") text = f.step || (f.playing ? `Removing ${f.playing}` : "Removing the song");
  else text = f.step || "Listening for music";
  $("filter-text").textContent = text;
  $("filter-status").classList.toggle("problem", Boolean(problem));
  $("filter-dot").className = "dot " + (problem ? "bad" : f.state === "filtering" ? "on" : "");
  const wait = Math.max(0, Math.ceil((f.retryAt - Date.now()) / 1000));
  $("filter-retry").disabled = wait > 0 || !state.helper.connected;
  $("filter-wait").textContent = wait > 0 ? `${wait} s` : "";
}

function unlockReadiness() {
  const missing = [];
  if (!state.loggedIn) missing.push("a Twitch login in Firefox");
  if (servers.length === 0) missing.push("a VPN server");
  if (state.helper.connected && state.helper.tunnel === false) missing.push("the tunnel program");
  if (missing.length) return [`Needs ${missing.join(" and ")}`, false];
  return [`Ready, ${servers.length} server${servers.length === 1 ? "" : "s"}`, true];
}

function renderUnlock() {
  const [readiness, ready] = unlockReadiness();
  $("unlock-sub").textContent = state.unlockOn
    ? readiness
    : "Plays region-locked 1440p streams through your VPN, only while you watch them";
  setSwitch($("unlock-switch"), state.unlockOn);
  const tab = state.tab;
  const u = tab && tab.unlock;
  let text = null, kind = "";
  if (state.unlockOn && tab && tab.channel) {
    if (tab.hevc === false) { text = "This Firefox can't play HEVC, which 1440p is sent in"; kind = "bad"; }
    else if (u && u.via) {
      text = u.error || `Playing ${u.extra.join(", ")} through ${Mor.serverLabel(u.server)[1]}`;
      kind = u.error ? "bad" : "good";
    } else if (u && u.checking) text = "Asking Twitch through the VPN";
    else if (u && u.error) { text = u.error; kind = "bad"; }
    else if (u && u.nothingLocked) text = `${tab.channel} has no locked qualities right now`;
    else if (ready) text = "Checked when the stream starts";
  }
  show($("unlock-status"), Boolean(text));
  if (text) {
    $("unlock-text").textContent = text;
    $("unlock-status").classList.toggle("problem", kind === "bad");
    $("unlock-dot").className = "dot " + kind;
  }
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
  $("servers-error").textContent = serverError || "";
  show($("servers-error"), Boolean(serverError));
  if (serversKnown && !guideOpened) {
    $("guide").open = servers.length === 0;
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
    state.tab.filter.problem = "Couldn't reach the music filter to retry";
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
