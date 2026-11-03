// The background against a fake Firefox: the helper's connection, the music filter's routing, and the 1440p
// unlock's decisions (which playlist the player gets, which requests go through the tunnel, when they stop).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MASTER_DIRECT = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,IVS-NAME="1080p60"
https://a/1080`;
const MASTER_TUNNEL = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,FRAME-RATE=60.000,IVS-NAME="1440p60"
https://b/1440
#EXT-X-STREAM-INF:BANDWIDTH=8000000,RESOLUTION=1920x1080,FRAME-RATE=60.000,IVS-NAME="1080p60"
https://b/1080`;

function event() {
  const listeners = [];
  return { listeners, addListener: (fn) => listeners.push(fn), fire: (...a) => listeners.map((fn) => fn(...a)) };
}

function fakePort(name, sender) {
  const port = { name, sender, sent: [], onMessage: event(), onDisconnect: event(),
    postMessage: (m) => port.sent.push(m), disconnect: () => { port.disconnected = true; } };
  return port;
}

function load({ cookie = "tok", nativeFails = false, nativeMissing = false } = {}) {
  const opened = [];
  const natives = [];
  const filters = [];
  const reloaded = [];
  const stored = {};
  const browser = {
    storage: { local: { get: async () => ({ ...stored }), set: async (v) => Object.assign(stored, v) } },
    runtime: {
      onConnect: event(), onMessage: event(), onInstalled: event(), getURL: (p) => `moz-extension://x/${p}`,
      connectNative: () => {
        if (nativeFails) throw new Error("No such native application mor_helper");
        const port = fakePort("native");
        natives.push(port);
        // as Firefox does it: the port opens, then closes at once saying why
        if (nativeMissing) setTimeout(() => port.onDisconnect.fire({ error: { message: "No such native application mor_helper" } }), 1);
        return port;
      },
    },
    tabs: { onRemoved: event(), onUpdated: event(), reload: async (id) => reloaded.push(id),
      create: async (props) => opened.push(props.url),
      get: async (id) => ({ id, cookieStoreId: "firefox-default" }) },
    cookies: { get: async () => (cookie ? { value: cookie } : null) },
    webRequest: {
      onBeforeRequest: event(), onHeadersReceived: event(),
      filterResponseData: () => {
        const f = { written: [], write: (d) => f.written.push(d), close: () => { f.closed = true; } };
        filters.push(f);
        return f;
      },
    },
    proxy: { onRequest: event(), onError: event() },
  };
  // the background's waits (letting the helper go, an unlock's longest wait) never hold the tests open
  const unrefTimeout = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return t; };
  const context = { browser, console, setTimeout: unrefTimeout, clearTimeout, Date, URL, TextDecoder, TextEncoder, btoa, atob,
    Promise, Error };
  vm.createContext(context);
  for (const file of ["../lib/shared.js", "../background/main.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context, { filename: file });
  }
  const api = {
    browser, natives, filters, reloaded, stored, context, opened,
    tab(id, channel) {
      const port = fakePort("mor-tab", { tab: { id } });
      browser.runtime.onConnect.fire(port);
      port.onMessage.fire({ type: "page", channel, hevc: true });
      return port;
    },
    helperSays(message) { natives.at(-1).onMessage.fire(message); },
    ask(message) { return browser.runtime.onMessage.listeners[0](message); },
    usher(tabId, channel) {
      return browser.webRequest.onBeforeRequest.listeners[0]({ url: `https://usher.ttvnw.net/api/v2/channel/hls/${channel}.m3u8?x=1`,
        tabId, requestId: "r" + tabId, cookieStoreId: "firefox-default" });
    },
    route(tabId, url) { return browser.proxy.onRequest.listeners[0]({ tabId, url }); },
  };
  return api;
}

// objects made inside the background's sandbox have its prototypes: compared as plain data
const plain = (x) => JSON.parse(JSON.stringify(x));
const same = (actual, expected) => assert.deepStrictEqual(plain(actual), plain(expected));

// what a tab was told, without the player row's state updates in between
const told = (port) => port.sent.filter((m) => m.type !== "state");

const tick = () => new Promise((r) => setTimeout(r, 5));

async function answerUnlock(m, master, extra = {}) {
  await tick();
  const ask = m.natives.at(-1).sent.find((x) => x.type === "unlock");
  m.helperSays({ type: "unlock", id: ask.id, master, port: 5555, server: "wg-NL-FREE-1", error: master ? null : "No VPN server answered", ...extra });
  return ask;
}

async function finish(filter, text) {
  filter.ondata({ data: new TextEncoder().encode(text).buffer });
  await filter.onstop();
  return new TextDecoder().decode(filter.written[0]);
}

test("a stream with more through the VPN gets the tunnel's playlist, and its video goes through the tunnel", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  const ask = await answerUnlock(m, MASTER_TUNNEL);
  same([ask.channel, ask.token], ["someone", "tok"]);
  const played = await finish(m.filters[0], MASTER_DIRECT);
  assert.strictEqual(played, MASTER_TUNNEL);
  same(m.route(1, "https://euc1.playlist.ttvnw.net/v1/playlist/x"),
    { type: "socks", host: "127.0.0.1", port: 5555, proxyDNS: true });
  assert.strictEqual(m.route(1, "https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8").type, "direct");
  assert.strictEqual(m.route(2, "https://euc1.playlist.ttvnw.net/v1/playlist/x").type, "direct"); // other tabs
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  same({ ...state.tab.unlock }, { via: true, server: "wg-NL-FREE-1", extra: ["1440p60"] });
});

test("nothing more through the VPN: Twitch's own playlist, nothing tunneled, the tunnel let go", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, MASTER_DIRECT);
  const played = await finish(m.filters[0], MASTER_DIRECT);
  assert.strictEqual(played, MASTER_DIRECT);
  assert.strictEqual(m.route(1, "https://euc1.playlist.ttvnw.net/v1/playlist/x").type, "direct");
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  assert.strictEqual(state.tab.unlock.nothingLocked, true);
});

test("a failed ask plays the stream normally and says why", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, null);
  assert.strictEqual(await finish(m.filters[0], MASTER_DIRECT), MASTER_DIRECT);
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  assert.strictEqual(state.tab.unlock.error, "No VPN server answered");
});

test("without a Twitch login nothing is asked, and the hub says what's needed", async () => {
  const m = load({ cookie: null });
  m.tab(1, "someone");
  m.usher(1, "someone");
  await tick();
  assert.strictEqual(await finish(m.filters[0], MASTER_DIRECT), MASTER_DIRECT);
  assert.ok(!m.natives.some((p) => p.sent.some((x) => x.type === "unlock")));
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  assert.match(state.tab.unlock.error, /Log in to Twitch/);
});

test("leaving the channel takes the tab off the tunnel; the last one off stops it", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, MASTER_TUNNEL);
  await finish(m.filters[0], MASTER_DIRECT);
  m.browser.tabs.onUpdated.fire(1, { url: "https://www.twitch.tv/someone?x=1" }); // same channel: stays
  assert.strictEqual(m.route(1, "https://a.hls.ttvnw.net/v1/segment/x").type, "socks");
  m.browser.tabs.onUpdated.fire(1, { url: "https://www.twitch.tv/directory" });
  assert.strictEqual(m.route(1, "https://a.hls.ttvnw.net/v1/segment/x").type, "direct");
  assert.ok(m.natives.at(-1).sent.some((x) => x.type === "tunnel-stop"));
});

test("a page going away doesn't take the next page's stream off the tunnel", async () => {
  const m = load();
  const old = m.tab(1, null);
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, MASTER_TUNNEL);
  await finish(m.filters[0], MASTER_DIRECT);
  old.onDisconnect.fire();
  assert.strictEqual(m.route(1, "https://a.hls.ttvnw.net/v1/segment/x").type, "socks");
});

test("switching the unlock off takes tabs off the tunnel and starts their streams again", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, MASTER_TUNNEL);
  await finish(m.filters[0], MASTER_DIRECT);
  const state = await m.ask({ type: "toggle-unlock", tabId: 1 });
  assert.strictEqual(state.unlockOn, false);
  assert.strictEqual(m.route(1, "https://a.hls.ttvnw.net/v1/segment/x").type, "direct");
  same(m.reloaded, [1]);
  assert.strictEqual(m.stored.unlock, false);
});

test("the music filter: on for every channel at first, switched off per channel and kept", async () => {
  const m = load();
  const port = m.tab(1, "someone");
  same(told(port).at(-1), { type: "filter", on: true });
  const other = m.tab(2, "someone_else");
  let state = await m.ask({ type: "toggle-filter", tabId: 1 });
  assert.strictEqual(state.tab.filterOn, false);
  same(m.stored.filterOff, ["someone"]);
  same(told(port).at(-1), { type: "filter", on: false });
  same(told(other).at(-1), { type: "filter", on: true }); // other channels stay on
  state = await m.ask({ type: "toggle-filter", tabId: 1 });
  assert.strictEqual(state.tab.filterOn, true);
  same(m.stored.filterOff, []);
});

test("the music filter: the tab's sound to the helper, the helper's news to the tab", async () => {
  const m = load();
  const port = m.tab(1, "someone");
  same(told(port).at(-1), { type: "filter", on: true });
  port.onMessage.fire({ type: "filter-start", sid: "s1" });
  const native = m.natives.at(-1);
  same(native.sent.at(-1), { type: "filter-start", sid: "s1" });
  port.onMessage.fire({ type: "heard", sid: "s1", samples: new Float32Array([0.5, -0.5]) });
  const heard = native.sent.at(-1);
  assert.strictEqual(heard.type, "heard");
  same(Array.from(new Float32Array(Uint8Array.from(Buffer.from(heard.data, "base64")).buffer)), [0.5, -0.5]);
  m.helperSays({ type: "status", sid: "s1", line: "step Removing A - B" });
  m.helperSays({ type: "status", sid: "s1", line: "filtering" });
  m.helperSays({ type: "copy", sid: "s1", copy: "v", part: 0, parts: 1, length: 1, data: "AAAAAA==" });
  m.helperSays({ type: "playing", sid: "s1", seq: 1, playing: { key: "k", title: "B", artist: "A", copy: "v", offset: 0, round: 0 } });
  m.helperSays({ type: "status", sid: "other", line: "problem not for this tab" });
  same(told(port).slice(-2).map((x) => x.type), ["copy", "playing"]);
  // the player's row hears each change
  same(port.sent.filter((x) => x.type === "state").at(-1).filter.state, "filtering");
  const after = await m.ask({ type: "hub-state", tabId: 1 });
  assert.strictEqual(after.tab.filter.state, "filtering");
  assert.strictEqual(after.tab.filter.step, "Removing A - B");
  assert.strictEqual(after.tab.filter.playing, "A - B");
  assert.strictEqual(after.tab.filter.problem, null);
  assert.strictEqual(await m.ask({ type: "retry", tabId: 1 }), true);
  same(native.sent.at(-1), { type: "retry", sid: "s1" });
  port.onMessage.fire({ type: "filter-stop", sid: "s1" });
  same(native.sent.at(-1), { type: "filter-stop", sid: "s1" });
});

test("a helper that isn't installed is said in words the user can act on", async () => {
  const m = load({ nativeFails: true });
  const port = m.tab(1, "someone");
  port.onMessage.fire({ type: "filter-start", sid: "s1" });
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  assert.match(state.helper.error, /Mor needs its helper on this PC: click Mor's button in the toolbar/);
  assert.strictEqual(state.helper.missing, true); // the hub shows how to set it up
  assert.match(state.tab.filter.problem, /Mor needs its helper/); // and the player says so
});

test("a helper that stops is told to each tab using it", async () => {
  const m = load();
  const port = m.tab(1, "someone");
  port.onMessage.fire({ type: "filter-start", sid: "s1" });
  m.helperSays({ type: "hello", version: "0.1.0", tunnel: true, javascript: true, servers: [] });
  m.natives.at(-1).onDisconnect.fire({ error: { message: "crashed" } });
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  assert.strictEqual(state.helper.error, "Mor's helper stopped: crashed");
  assert.strictEqual(state.tab.filter.problem, "Mor's helper stopped: crashed");
  same(told(port).at(-1), { type: "filter", on: true, restart: true }); // once, with a fresh helper
});

test("servers are asked of the helper and its answer handed to the hub", async () => {
  const m = load();
  const reply = m.ask({ type: "server-add", name: "a.conf", text: "x" });
  await tick();
  same(m.natives.at(-1).sent.at(-1), { type: "server-add", name: "a.conf", text: "x" });
  m.helperSays({ type: "servers", servers: ["a"], inUse: null, error: null });
  same((await reply).servers, ["a"]);
});

test("an ad blocker's backup playlists pass straight through, never held up or swapped", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, MASTER_TUNNEL);
  await finish(m.filters[0], MASTER_DIRECT);
  const asks = m.natives.at(-1).sent.filter((x) => x.type === "unlock").length;
  const backup = m.usher(1, "someone"); // vaft asking for an ad-free copy of the same stream
  same(backup, {});
  assert.strictEqual(m.filters.length, 1); // not filtered: Twitch's answer goes to it untouched
  assert.strictEqual(m.natives.at(-1).sent.filter((x) => x.type === "unlock").length, asks);
  assert.strictEqual(m.route(1, "https://a.hls.ttvnw.net/v1/segment/x").type, "socks"); // still unlocked
  const state = await m.ask({ type: "hub-state", tabId: 1 });
  assert.strictEqual(state.tab.unlock.via, true); // no error shown
});

test("a new page in the tab decides its stream afresh", async () => {
  const m = load();
  m.tab(1, "someone");
  m.usher(1, "someone");
  await answerUnlock(m, MASTER_DIRECT);
  await finish(m.filters[0], MASTER_DIRECT);
  m.browser.webRequest.onBeforeRequest.listeners[1]({ tabId: 1, url: "https://www.twitch.tv/someone", type: "main_frame" });
  m.usher(1, "someone");
  assert.strictEqual(m.filters.length, 2);
});

test("installed without its helper: the setup page opens by itself, once", async () => {
  const m = load({ nativeMissing: true });
  m.browser.runtime.onInstalled.fire({ reason: "install" });
  await tick();
  assert.deepStrictEqual(m.opened, ["moz-extension://x/hub/hub.html?page"]);
  const state = await m.ask({ type: "hub-state", tabId: null });
  assert.strictEqual(state.helper.missing, true);
  // the hub's "Check again" tries once more: still missing, no second page
  await m.ask({ type: "helper-check", tabId: null });
  await tick();
  assert.strictEqual(m.opened.length, 1);
});

test("an update, or a helper that's there, opens nothing", async () => {
  const m = load({ nativeMissing: true });
  m.browser.runtime.onInstalled.fire({ reason: "update" });
  await tick();
  assert.deepStrictEqual(m.opened, []);
  const n = load();
  n.browser.runtime.onInstalled.fire({ reason: "install" });
  n.helperSays({ type: "hello", version: "1.0.1", tunnel: true, javascript: true, servers: [] });
  await tick();
  assert.deepStrictEqual(n.opened, []);
  assert.strictEqual((await n.ask({ type: "hub-state", tabId: null })).helper.missing, false);
});
