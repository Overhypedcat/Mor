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
  // sound.can: whether an AudioContext can start (false: resume() is never answered, as Firefox does before a
  // click and with no speaker connected); sound.clicked: the page has been clicked
  const sound = { can: true, clicked: false };
  const clock = { ahead: 0 };
  const contexts = [];
  const pageListeners = {};
  // As Firefox: a window whose sound couldn't start once stays stuck, for every context made in it later too.
  const pageWindow = { stuck: false };
  const frames = [];
  const rows = [];
  const intervals = [];
  const makeContext = (win = pageWindow) => ({
    state: (win.stuck = win.stuck || !sound.can) ? "suspended" : "running",
    closed: false,
    window: win,
    destination: new Node("speakers"),
    audioWorklet: { addModule: async () => {} },
    resume() {
      if (!sound.can) win.stuck = true;
      if (win.stuck) return new Promise(() => {});
      this.state = "running";
      return Promise.resolve();
    },
    close() { this.closed = true; return Promise.resolve(); },
    createMediaElementSource(v) {
      const s = new Node(`source of ${v.id}`);
      s.video = v;
      sources.push(s);
      return s;
    },
  });
  const context = makeContext();
  class Clock extends Date { static now() { return Date.now() + clock.ahead; } }
  function AudioWorkletNode() {
    const n = new Node("filter");
    n.port = { messages: [], postMessage(m) { this.messages.push(m); }, onmessage: null };
    nodes.push(n);
    return n;
  }
  const document = {
    querySelectorAll: (sel) => (sel === "video" ? videos : []),
    addEventListener: (kind, fn) => { (pageListeners[kind] = pageListeners[kind] || []).push(fn); },
    createElement: (tag) => {
      assert.strictEqual(tag, "iframe");
      const win = { stuck: false };
      const frame = {
        isConnected: false, style: {}, attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        remove() { this.isConnected = false; },
        contentWindow: {
          AudioContext: function () { const made = makeContext(win); contexts.push(made); return made; },
          AudioWorkletNode,
        },
      };
      frames.push(frame);
      return frame;
    },
    documentElement: { append: (frame) => { frame.isConnected = true; } },
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
    AudioContext: function () {
      const made = contexts.length ? makeContext() : Object.assign(context, { state: makeContext().state });
      contexts.push(made);
      return made;
    },
    AudioWorkletNode,
    navigator: { userActivation: { get hasBeenActive() { return sound.clicked; } } },
    WeakMap, Date: Clock, Math, URL, Promise, Error, JSON, ArrayBuffer, Uint8Array, Int16Array, console,
    setInterval: (fn) => { intervals.push(fn); return 0; },
    rows,
    setTimeout: (fn) => setTimeout(fn, 1), // (the wait for the sound's start, cut short)
    getComputedStyle: () => ({ opacity: "0", visibility: "visible", position: "relative" }),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../lib/shared.js"), "utf8"), sandbox);
  // the player's row needs a real page; here it's a stand-in that draws nothing
  vm.runInContext("var PlayerRow = { Row: class { constructor(onRetry) { this.onRetry = onRetry; rows.push(this); } "
    + "place() {} remove() {} update(model) { this.model = model; } } };", sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../content/twitch.js"), "utf8"), sandbox);
  const video = (id, size = 1000) => {
    const within = { querySelector: () => within }; // Twitch's player around it, its controls, their right group
    return { id, paused: false, getBoundingClientRect: () => ({ width: size, height: size / 2 }), closest: () => within };
  };
  return {
    sent, videos, sources, nodes, context, contexts, frames, page, video, sound, clock,
    row: () => { intervals[1](); return rows[0]; }, // the player's row, as last drawn
    starts: () => sent.filter((m) => m.type === "filter-start").length,
    say: async (m) => { for (const fn of listeners) fn(m); await new Promise((r) => setTimeout(r, 5)); },
    click: async () => {
      sound.clicked = true;
      for (const fn of pageListeners.pointerdown || []) fn({});
      await new Promise((r) => setTimeout(r, 5));
    },
    problems: () => sent.filter((m) => m.type === "audio").map((m) => m.problem),
  };
}

test("the sound can't start before a click: said, not waited for without end, and a click starts the filter", async () => {
  const t = load();
  t.sound.can = false;
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  assert.match(t.problems().at(-1), /^Click the stream \| /);
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-start").length, 0);
  t.sound.can = true; // (a click is what lets it)
  await t.click();
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-start").length, 1);
  assert.strictEqual(t.problems().at(-1), null);
  const used = t.contexts.at(-1);
  assert.deepStrictEqual(t.sources[0].to, [t.nodes[0]]);
  assert.deepStrictEqual(t.nodes[0].to, [used.destination]);
});

test("no speaker connected: said, and the filter starts by itself once there is one", async () => {
  const t = load();
  t.sound.can = false;
  t.sound.clicked = true;
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  assert.match(t.problems().at(-1), /^No sound output \| /);
  t.sound.can = true; // the headphones connect
  await t.say({ type: "filter", on: true }); // (a tick, too soon: not tried over and over)
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-start").length, 0);
  t.clock.ahead = 6000;
  await t.say({ type: "filter", on: true }); // (a tick)
  assert.strictEqual(t.sent.filter((m) => m.type === "filter-start").length, 1);
  assert.strictEqual(t.problems().at(-1), null);
  // the page's own never starts once it couldn't: the new one is of a hidden inner frame, a window of its own
  assert.strictEqual(t.contexts.length, 2);
  assert.strictEqual(t.contexts[0].closed, true);
  assert.strictEqual(t.frames.length, 1);
  assert.strictEqual(t.frames[0].isConnected, true);
  assert.strictEqual(t.frames[0].style.display, "none");
  assert.notStrictEqual(t.contexts[1].window, t.contexts[0].window);
  assert.deepStrictEqual(t.nodes[0].to, [t.contexts[1].destination]);
});

test("still no speaker at the next try: that frame is given up too, none pile up", async () => {
  const t = load();
  t.sound.can = false;
  t.sound.clicked = true;
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  for (const ahead of [6000, 12000, 18000]) {
    t.clock.ahead = ahead;
    await t.say({ type: "filter", on: true }); // (a tick)
  }
  assert.strictEqual(t.starts(), 0);
  assert.match(t.problems().at(-1), /^No sound output \| /);
  assert.strictEqual(t.frames.length, 3);
  assert.strictEqual(t.frames.filter((f) => f.isConnected).length, 1); // the one being tried
  t.sound.can = true;
  t.clock.ahead = 24000;
  await t.say({ type: "filter", on: true });
  assert.strictEqual(t.starts(), 1);
  assert.strictEqual(t.frames.filter((f) => f.isConnected).length, 1);
});

test("the retry button tries the sound's start again at once; the hub's does too", async () => {
  const t = load();
  t.sound.can = false;
  t.sound.clicked = true;
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  assert.strictEqual(t.row().model.running, true); // the button can be pressed while the sound hasn't started
  t.sound.can = true;
  t.row().onRetry(); // (well before the next try by itself)
  await new Promise((r) => setTimeout(r, 5));
  assert.strictEqual(t.starts(), 1);
  assert.ok(!t.sent.some((m) => m.type === "retry")); // nothing to look for afresh yet

  const u = load();
  u.sound.can = false;
  u.videos.push(u.video("a"));
  await u.say({ type: "filter", on: true });
  u.sound.can = true;
  await u.say({ type: "start-again" });
  assert.strictEqual(u.starts(), 1);
});

test("the page removing the frame the sound plays through: said, as only loading the page again helps", async () => {
  const t = load();
  t.sound.can = false;
  t.sound.clicked = true;
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  t.sound.can = true;
  t.clock.ahead = 6000;
  await t.say({ type: "filter", on: true });
  assert.strictEqual(t.starts(), 1);
  t.frames[0].isConnected = false;
  await t.say({ type: "filter", on: true }); // (a tick)
  assert.match(t.problems().at(-1), /^Reload the page \| /);
  assert.ok(t.sent.some((m) => m.type === "filter-stop"));
  assert.strictEqual(t.row().model.running, false); // nothing the retry button could do
  t.clock.ahead = 60000;
  await t.say({ type: "filter", on: true });
  assert.strictEqual(t.starts(), 1);
});

test("a context that has run is kept: its videos' sound is tied to it", async () => {
  const t = load();
  t.videos.push(t.video("a"));
  await t.say({ type: "filter", on: true });
  await t.say({ type: "filter", on: false });
  t.context.state = "suspended";
  t.sound.can = false;
  t.sound.clicked = true;
  await t.say({ type: "filter", on: true });
  assert.match(t.problems().at(-1), /^No sound output \| /);
  assert.strictEqual(t.contexts.length, 1);
  assert.strictEqual(t.context.closed, false);
});

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
