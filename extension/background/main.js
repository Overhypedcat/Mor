// Mor's background: the hub's state, the connection to the helper, the music filter's messages between each Twitch
// tab and the helper, and the 1440p unlock (the playlist swap and the tab's video through the VPN tunnel).
//
// The helper only runs while something needs it: a tab with the music filter on, a stream through the tunnel, an
// unlock being asked, or the hub open. Then it's let go, and Firefox ends it.
"use strict";

const HELPER = "mor_helper";
const IDLE_MS = 30000; // nothing needed the helper this long: it's let go
const UNLOCK_WAIT_MS = 45000; // the longest a stream's start waits for the VPN's answer (servers are tried in turn)
const TUNNEL_HOSTS = ["*://*.ttvnw.net/*", "*://*.live-video.net/*"];
const DIRECT_HOSTS = new Set(["usher.ttvnw.net"]); // the playlist Twitch gives Firefox is compared, never tunneled

const settings = { filtered: [], unlock: true };
const tabs = new Map(); // tabId -> {port, channel, hevc, sid, filter: {...}, audio, unlock: {...}}
const sids = new Map(); // music filter session -> tabId
const vpnTabs = new Map(); // tabId -> {channel, port (socks), server, extra}

// settings

async function loadSettings() {
  const saved = await browser.storage.local.get(["filtered", "unlock"]);
  if (Array.isArray(saved.filtered)) settings.filtered = saved.filtered;
  if (typeof saved.unlock === "boolean") settings.unlock = saved.unlock;
}

function saveSettings() {
  return browser.storage.local.set({ filtered: settings.filtered, unlock: settings.unlock });
}

// the helper

const helper = {
  port: null,
  error: null, // why it isn't connected, as the hub shows it
  hello: null, // what it said it has
  lastError: null, // the latest thing it said went wrong
  servers: null, // {servers, inUse}
  waiting: new Map(), // unlock id -> resolve
  serverWaiters: [],
  hubOpen: 0,
  idleTimer: null,
  nextId: 1,

  connect() {
    if (this.port) return this.port;
    let port;
    try {
      port = browser.runtime.connectNative(HELPER);
    } catch (error) {
      this.error = describeHelperError(error.message);
      return null;
    }
    this.port = port;
    this.error = null;
    port.onMessage.addListener((message) => onHelperMessage(message));
    port.onDisconnect.addListener((p) => {
      const why = p.error ? p.error.message : null;
      const wasUp = Boolean(this.hello);
      this.port = null;
      this.hello = null;
      this.error = why ? describeHelperError(why) : (this.letGo ? null : "Mor's helper stopped");
      this.letGo = false;
      onHelperGone(wasUp);
    });
    port.postMessage({ type: "hello" });
    this.touch();
    return port;
  },

  post(message) {
    const port = this.connect();
    if (!port) return false;
    try {
      port.postMessage(message);
    } catch (error) {
      this.error = `Couldn't reach Mor's helper: ${error.message}`;
      return false;
    }
    if (message.type !== "heard") this.touch();
    return true;
  },

  needed() {
    return this.hubOpen > 0 || sids.size > 0 || vpnTabs.size > 0 || this.waiting.size > 0;
  },

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.port && !this.needed()) {
        this.letGo = true;
        this.port.disconnect();
        this.port = null;
        this.hello = null;
      } else if (this.port) {
        this.touch();
      }
    }, IDLE_MS);
  },

  ask(message, timeout) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ error: "Mor's helper didn't answer in time" });
      }, timeout);
      this.waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      if (!this.post({ ...message, id })) {
        this.waiting.delete(id);
        clearTimeout(timer);
        resolve({ error: this.error || "Mor's helper isn't running" });
      }
    });
  },

  askServers(message) {
    return new Promise((resolve) => {
      if (!this.post(message)) {
        resolve({ servers: [], error: this.error });
        return;
      }
      const timer = setTimeout(() => resolve({ servers: [], error: "Mor's helper didn't answer in time" }), 10000);
      this.serverWaiters.push((reply) => { clearTimeout(timer); resolve(reply); });
    });
  },
};

function describeHelperError(text) {
  if (/no such native application|not found|manifest/i.test(text || "")) {
    return "Mor's helper isn't installed on this PC: run Install Mor.cmd from Mor's folder";
  }
  return `Mor's helper stopped: ${text}`;
}

function onHelperMessage(message) {
  switch (message.type) {
    case "hello":
      helper.hello = message;
      break;
    case "status": {
      const tab = tabs.get(sids.get(message.sid));
      if (tab && tab.sid === message.sid) tab.filter = Mor.applyStatus(tab.filter, message.line, Date.now());
      break;
    }
    case "copy":
    case "playing": {
      const tab = tabs.get(sids.get(message.sid));
      if (tab && tab.sid === message.sid) tab.port.postMessage(message);
      if (message.type === "playing" && tab && tab.sid === message.sid) {
        tab.filter = { ...tab.filter, playing: message.playing ? songName(message.playing) : null };
      }
      break;
    }
    case "unlock": {
      const resolve = helper.waiting.get(message.id);
      helper.waiting.delete(message.id);
      if (resolve) resolve(message);
      break;
    }
    case "servers":
      helper.servers = message;
      if (helper.hello) helper.hello.servers = message.servers;
      for (const resolve of helper.serverWaiters.splice(0)) resolve(message);
      break;
    case "tunnel":
      break;
    case "error":
      helper.lastError = message.text;
      for (const resolve of helper.serverWaiters.splice(0)) resolve({ servers: [], error: message.text });
      break;
    default:
      break;
  }
}

function songName(playing) {
  return playing.artist ? `${playing.artist} - ${playing.title}` : playing.title;
}

function onHelperGone(wasUp) {
  // a filter mid-song keeps the sound going unfiltered: its tab is told; when the helper had been running (it
  // crashed), the filter starts again with a fresh one, once (one that can't start at all isn't tried over and over)
  for (const [tabId, tab] of tabs) {
    if (tab.sid) {
      tab.filter = { ...tab.filter, problem: helper.error || "Mor's helper stopped", state: "listening", playing: null };
      tab.port.postMessage({ type: "playing", sid: tab.sid, seq: -1, playing: null });
      sids.delete(tab.sid);
      tab.sid = null;
      if (wasUp) tab.port.postMessage({ type: "filter", on: filterOn(tab.channel), restart: true });
    }
    if (vpnTabs.has(tabId)) {
      vpnTabs.delete(tabId);
      tab.unlock = { via: false, error: helper.error || "Mor's helper stopped, the VPN went with it" };
    }
  }
  for (const resolve of helper.waiting.values()) resolve({ error: helper.error || "Mor's helper stopped" });
  helper.waiting.clear();
  for (const resolve of helper.serverWaiters.splice(0)) resolve({ servers: [], error: helper.error });
}

// the tabs

function filterOn(channel) {
  return Boolean(channel) && settings.filtered.includes(channel);
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "mor-tab" || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  const tab = { port, channel: null, hevc: null, sid: null, filter: freshFilter(), audio: null, unlock: null };
  tabs.set(tabId, tab);
  port.onMessage.addListener((message) => onTabMessage(tabId, tab, message));
  // (a page going away doesn't end the tab's tunnel: the next page's stream may already be using it; the tunnel
  // follows the tab's address instead, below)
  port.onDisconnect.addListener(() => {
    if (tabs.get(tabId) === tab) tabs.delete(tabId);
    endFilter(tab);
  });
});

function freshFilter() {
  return { state: "listening", problem: null, step: null, retryAt: 0, playing: null };
}

function onTabMessage(tabId, tab, message) {
  switch (message.type) {
    case "page":
      if (message.channel !== tab.channel) {
        tab.channel = message.channel;
        tab.unlock = null;
        if (vpnTabs.has(tabId) && vpnTabs.get(tabId).channel !== message.channel) leaveTunnel(tabId);
      }
      tab.hevc = message.hevc;
      tab.port.postMessage({ type: "filter", on: filterOn(tab.channel) });
      break;
    case "filter-start":
      endFilter(tab);
      tab.sid = message.sid;
      tab.filter = freshFilter();
      sids.set(message.sid, tabId);
      if (!helper.post({ type: "filter-start", sid: message.sid })) {
        tab.filter.problem = helper.error;
      }
      break;
    case "filter-stop":
      if (tab.sid === message.sid) endFilter(tab);
      break;
    case "heard":
      if (tab.sid === message.sid && helper.port) {
        const bytes = new Uint8Array(message.samples.buffer, message.samples.byteOffset, message.samples.byteLength);
        helper.post({ type: "heard", sid: message.sid, data: Mor.toBase64(bytes) });
      }
      break;
    case "broken":
      if (tab.sid === message.sid) {
        tab.filter = { ...tab.filter, problem: message.text };
        helper.post({ type: "broken", sid: message.sid, text: message.text });
      }
      break;
    case "audio":
      tab.audio = message.problem || null;
      break;
    default:
      break;
  }
}

function endFilter(tab) {
  if (!tab.sid) return;
  sids.delete(tab.sid);
  if (helper.port) helper.post({ type: "filter-stop", sid: tab.sid });
  tab.sid = null;
  tab.filter = freshFilter();
}

// The tab went to another channel, or off Twitch: its stream no longer goes through the tunnel.
browser.tabs.onUpdated.addListener((tabId, change) => {
  const entry = vpnTabs.get(tabId);
  if (entry && change.url && Mor.pageChannel(change.url) !== entry.channel) leaveTunnel(tabId);
}, { properties: ["url"] });

browser.tabs.onRemoved.addListener((tabId) => {
  const tab = tabs.get(tabId);
  if (tab) endFilter(tab);
  tabs.delete(tabId);
  leaveTunnel(tabId);
});

// the 1440p unlock

function leaveTunnel(tabId) {
  if (!vpnTabs.delete(tabId)) return;
  if (vpnTabs.size === 0 && helper.port) helper.post({ type: "tunnel-stop" });
}

async function twitchToken(cookieStoreId) {
  try {
    const cookie = await browser.cookies.get({ url: "https://www.twitch.tv/", name: "auth-token",
      ...(cookieStoreId ? { storeId: cookieStoreId } : {}) });
    return cookie && cookie.value ? cookie.value : null;
  } catch (error) {
    return null;
  }
}

// Why the unlock can't be tried for this stream, or null when it can.
function unlockBlocker(tab, token) {
  if (!settings.unlock) return "off";
  if (tab && tab.hevc === false) return "This Firefox can't play HEVC, which 1440p streams are sent in";
  if (!token) return "Log in to Twitch in Firefox to unlock 1440p";
  if (helper.hello && !helper.hello.tunnel) return "The tunnel program is missing, run Install Mor.cmd again";
  if (helper.hello && helper.hello.servers.length === 0) return "Add a VPN server to unlock 1440p";
  return null;
}

browser.webRequest.onBeforeRequest.addListener((details) => {
  const channel = Mor.usherChannel(details.url);
  if (!channel || details.tabId < 0) return {}; // not a live stream's playlist: nothing to decide
  if (!settings.unlock) {
    leaveTunnel(details.tabId);
    return {};
  }
  const filter = browser.webRequest.filterResponseData(details.requestId);
  const parts = [];
  const answer = decideUnlock(details, channel);
  filter.ondata = (event) => parts.push(new Uint8Array(event.data));
  filter.onerror = () => { /* the request itself failed: Twitch's player says so */ };
  filter.onstop = async () => {
    const direct = new TextDecoder().decode(join(parts));
    let master = null;
    try {
      master = await answer(direct);
    } catch (error) {
      noteUnlock(details.tabId, { via: false, error: `The 1440p unlock ran into an error: ${error.message}` });
    }
    if (master) filter.write(new TextEncoder().encode(master));
    else for (const part of parts) filter.write(part);
    filter.close();
  };
  return {};
}, { urls: ["https://usher.ttvnw.net/*"] }, ["blocking"]);

// The swapped playlist has another length than Twitch's: its stated length goes, so nothing is cut off.
browser.webRequest.onHeadersReceived.addListener((details) => {
  if (!Mor.usherChannel(details.url) || !settings.unlock) return {};
  return { responseHeaders: details.responseHeaders.filter((h) => h.name.toLowerCase() !== "content-length") };
}, { urls: ["https://usher.ttvnw.net/*"] }, ["blocking", "responseHeaders"]);

function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function noteUnlock(tabId, unlock) {
  const tab = tabs.get(tabId);
  if (tab) tab.unlock = unlock;
}

// Starts the VPN's ask right away (while Twitch answers Firefox), and returns what decides between the two once
// Twitch's own playlist is in: the tunnel's when it offers more, else null (Twitch's goes through untouched).
function decideUnlock(details, channel) {
  const tabId = details.tabId;
  const asked = (async () => {
    const token = await twitchToken(details.cookieStoreId);
    const blocker = unlockBlocker(tabs.get(tabId), token);
    if (blocker) return { error: blocker === "off" ? null : blocker };
    noteUnlock(tabId, { via: false, checking: true });
    return helper.ask({ type: "unlock", channel, token }, UNLOCK_WAIT_MS);
  })();
  return async (direct) => {
    const reply = await asked;
    const directQualities = Mor.qualities(direct);
    if (!reply.master) {
      leaveTunnel(tabId);
      noteUnlock(tabId, { via: false, error: reply.error || null });
      return null;
    }
    const unlocked = Mor.qualities(reply.master);
    if (!Mor.needsVpn("best", directQualities, unlocked)) {
      leaveTunnel(tabId);
      noteUnlock(tabId, { via: false, nothingLocked: true, direct: directQualities, unlocked });
      return null;
    }
    for (const entry of vpnTabs.values()) entry.port = reply.port; // one tunnel: every tab follows it
    const extra = Mor.unlockedOnly(directQualities, unlocked);
    vpnTabs.set(tabId, { channel, port: reply.port, server: reply.server, extra });
    noteUnlock(tabId, { via: true, server: reply.server, extra });
    return reply.master;
  };
}

browser.proxy.onRequest.addListener((details) => {
  const entry = vpnTabs.get(details.tabId);
  if (!entry || !entry.port) return { type: "direct" };
  let host;
  try { host = new URL(details.url).hostname; } catch (error) { return { type: "direct" }; }
  if (DIRECT_HOSTS.has(host)) return { type: "direct" };
  return { type: "socks", host: "127.0.0.1", port: entry.port, proxyDNS: true };
}, { urls: TUNNEL_HOSTS });

browser.proxy.onError.addListener((error) => {
  for (const [tabId] of vpnTabs) noteUnlock(tabId, { via: true, error: `The VPN tunnel failed: ${error.message}` });
});

// the hub

function reloadChannelTabs(filter) {
  for (const [tabId, tab] of tabs) if (tab.channel && filter(tabId, tab)) browser.tabs.reload(tabId);
}

async function hubState(tabId) {
  const tab = tabs.get(tabId);
  let token = null;
  try {
    const info = tabId != null ? await browser.tabs.get(tabId) : null;
    token = await twitchToken(info && info.cookieStoreId);
  } catch (error) { /* the tab is gone */ }
  return {
    helper: { connected: Boolean(helper.port && helper.hello), error: helper.error, lastError: helper.lastError,
      version: helper.hello ? helper.hello.version : null, tunnel: helper.hello ? helper.hello.tunnel : null,
      javascript: helper.hello ? helper.hello.javascript : null },
    servers: helper.hello ? helper.hello.servers : [],
    inUse: [...vpnTabs.values()].map((v) => v.server)[0] || null,
    unlockOn: settings.unlock,
    loggedIn: Boolean(token),
    tab: tab ? { channel: tab.channel, hevc: tab.hevc, filterOn: filterOn(tab.channel), filter: tab.filter,
      audio: tab.audio, unlock: tab.unlock, via: vpnTabs.has(tabId) } : null,
    now: Date.now(),
  };
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "mor-hub") return;
  helper.hubOpen += 1;
  helper.connect();
  port.onDisconnect.addListener(() => { helper.hubOpen -= 1; helper.touch(); });
});

browser.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case "hub-state":
      return hubState(message.tabId);
    case "toggle-filter": {
      const tab = tabs.get(message.tabId);
      if (!tab || !tab.channel) return Promise.resolve(null);
      const list = settings.filtered.filter((c) => c !== tab.channel);
      if (!filterOn(tab.channel)) list.push(tab.channel);
      settings.filtered = list;
      return saveSettings().then(() => {
        for (const t of tabs.values()) if (t.channel) t.port.postMessage({ type: "filter", on: filterOn(t.channel) });
        return hubState(message.tabId);
      });
    }
    case "toggle-unlock":
      settings.unlock = !settings.unlock;
      return saveSettings().then(() => {
        // like a quality pick: the stream starts again, through the tunnel or past it
        if (settings.unlock) reloadChannelTabs((tabId) => tabId === message.tabId);
        else {
          const through = [...vpnTabs.keys()];
          for (const tabId of through) leaveTunnel(tabId);
          reloadChannelTabs((tabId) => through.includes(tabId));
        }
        return hubState(message.tabId);
      });
    case "retry": {
      const tab = tabs.get(message.tabId);
      if (!tab || !tab.sid) return Promise.resolve(false);
      if (!helper.post({ type: "retry", sid: tab.sid })) return Promise.resolve(false);
      tab.filter = { ...tab.filter, retryAt: Date.now() + 3000 }; // until the helper says how its budget is
      return Promise.resolve(true);
    }
    case "servers":
      return helper.askServers({ type: "servers" });
    case "server-add":
      return helper.askServers({ type: "server-add", name: message.name, text: message.text });
    case "server-remove":
      return helper.askServers({ type: "server-remove", name: message.name });
    case "reload-tab":
      return browser.tabs.reload(message.tabId);
    default:
      return undefined;
  }
});

loadSettings();
