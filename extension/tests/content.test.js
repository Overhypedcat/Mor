// The Twitch tab's script against a fake page and sound graph: the filter starts on the player's video, carries on
// when an ad blocker swaps the video element, and starts afresh for another channel.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Node {
  constructor(name) { this.name = name; this.to = []; }
  connect(other) { this.to.push(other); return other; }
  disconnect() { this.to = []; }
}

function load() {
  const sent = [];
  const listeners = [];
  const videos = [];
  const sources = [];
  const nodes = [];
  const page = { href: "https://www.twitch.tv/someone" };
  const context = {
    state: "running",
    destination: new Node("speakers"),
    audioWorklet: { addModule: async () => {} },
    resume: async () => {},
    createMediaElementSource(v) {
      const s = new Node(`source of ${v.id}`);
      s.video = v;
      sources.push(s);
      return s;
    },
  };
  function AudioWorkletNode() {
    const n = new Node("filter");
    n.port = { messages: [], postMessage(m) { this.messages.push(m); }, onmessage: null };
    nodes.push(n);
    return n;
  }
  const document = {
    querySelectorAll: (sel) => (sel === "video" ? videos : []),
    addEventListener: () => {},
  };
  const sandbox = {
    browser: {
      runtime: {
        connect: () => ({ postMessage: (m) => sent.push(m), onMessage: { addListener: (fn) => listeners.push(fn) } }),
        getURL: (p) => `moz-extension://x/${p}`,
      },
    },
    location: page,
    document,
    MediaSource: { isTypeSupported: () => true },
    AudioContext: function () { return context; },
    AudioWorkletNode,
    WeakMap, Date, Math, URL, Promise, Error, JSON, ArrayBuffer, Uint8Array, Int16Array, console,
    setInterval: () => 0,
    getComputedStyle: () => ({ opacity: "0", visibility: "visible", position: "relative" }),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib/shared.js"), "utf8"), sandbox);
  // the player's row needs a real page; here it's a stand-in that draws nothing
  vm.runInContext("var PlayerRow = { Row: class { place() {} remove() {} update() {} } };", sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../content/twitch.js"), "utf8"), sandbox);
  const video = (id, size = 1000) => {
    const v = { id, paused: false, getBoundingClientRect: () => ({ width: size, height: size / 2 }), closest: () => null };
    return v;
  };
  return {
    sent, videos, sources, nodes, context, page, video,
    say: async (m) => { for (const fn of listeners) fn(m); await new Promise((r) => setTimeout(r, 5)); },
  };
}

test("the filter starts on the player's video, and its sound goes through it to the speakers", async () => {
  const t = load();
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  const starts = t.sent.filter((m) => m.type === "filter-start");
  assert.strictEqual(starts.length, 1);
  const [source] = t.sources;
  const [node] = t.nodes;
  assert.deepStrictEqual(source.to, [node]);
  assert.deepStrictEqual(node.to, [t.context.destination]);
});

test("an ad blocker swapping the video: the same filter carries on with the new one", async () => {
  const t = load();
  const first = t.video("a");
  t.videos.push(first);
  await t.say({ type: "filter", on: true });
  const sid = t.sent.find((m) => m.type === "filter-start").sid;
  t.videos.length = 0;
  t.videos.push(t.video("b")); // the player reloaded into a new element
  await t.say({ type: "filter", on: true }); // (any tick)
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-start").length, 1); // no new session: no new search
  assert.ok(!t.sent.some((m) => m.type === "filter-stop"));
  const [oldSource, newSource] = t.sources;
  const [node] = t.nodes;
  assert.strictEqual(t.nodes.length, 1);
  assert.deepStrictEqual(newSource.to, [node]); // the new video's sound into the same filter
  assert.deepStrictEqual(oldSource.to, [t.context.destination]); // the old one straight out, as Twitch plays it
  // the helper's news still reaches the filter
  await t.say({ type: "playing", sid, seq: 2, playing: null });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(node.port.messages.at(-1))), { type: "playing", seq: 2, playing: null });
});

test("both videos up at once: the bigger one is the stream", async () => {
  const t = load();
  t.videos.push(t.video("preview", 200), t.video("stream", 1200));
  await t.say({ type: "filter", on: true });
  assert.strictEqual(t.sources[0].video.id, "stream");
});

test("another channel is another stream: the filter starts afresh", async () => {
  const t = load();
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  t.page.href = "https://www.twitch.tv/someone_else";
  await t.say({ type: "filter", on: true });
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-stop").length, 1);
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-start").length, 2);
  assert.strictEqual(t.sent.filter((m) => m.type === "page").at(-1).channel, "someone_else");
});

test("switched off: the sound goes straight through again", async () => {
  const t = load();
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  await t.say({ type: "filter", on: false });
  assert.ok(t.sent.some((m) => m.type === "filter-stop"));
  assert.deepStrictEqual(t.sources[0].to, [t.context.destination]);
});
