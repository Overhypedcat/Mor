// Where the music filter's text goes in Twitch's controls: left of every button on the right, Twitch's and other
// extensions' (7TV's) alike, against a stand-in for the page.
const test = require("node:test");
const assert = require("node:assert");

const FOLLOWING = 4;

class FakeElement {
  constructor(name, width = 30) {
    this.name = name;
    this.width = width;
    this.parentElement = null;
    this.children = [];
    this.moves = 0;
  }

  getBoundingClientRect() { return { width: this.width, height: this.width ? 30 : 0 }; }

  compareDocumentPosition(other) {
    const siblings = this.parentElement.children;
    return siblings.indexOf(other) > siblings.indexOf(this) ? FOLLOWING : 2;
  }

  insertBefore(element, before) {
    this.detach(element);
    this.children.splice(this.children.indexOf(before), 0, element);
    element.parentElement = this;
    this.moves += 1;
  }

  prepend(element) {
    this.detach(element);
    this.children.unshift(element);
    element.parentElement = this;
    this.moves += 1;
  }

  append(...elements) {
    for (const element of elements) {
      this.detach(element);
      this.children.push(element);
      element.parentElement = this;
    }
  }

  detach(element) {
    if (element.parentElement) {
      const list = element.parentElement.children;
      list.splice(list.indexOf(element), 1);
    }
  }

  remove() { this.detach(this); this.parentElement = null; }
}

global.Node = { DOCUMENT_POSITION_FOLLOWING: FOLLOWING };
global.Mor = require("../lib/shared.js");
function fake(tag) {
  const element = new FakeElement(tag);
  const listeners = {};
  const classes = new Set();
  return Object.assign(element, {
    attachShadow: () => fake("#shadow"),
    setAttribute: () => {},
    addEventListener: (kind, fn) => { (listeners[kind] = listeners[kind] || []).push(fn); },
    fire(kind) {
      let stopped = false;
      for (const fn of listeners[kind] || []) fn({ stopPropagation: () => { stopped = true; } });
      return stopped;
    },
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (n) => classes.has(n) },
  });
}
global.document = { createElement: fake, createElementNS: (ns, tag) => fake(tag) };
const { Row, retryWait } = require("../content/player-row.js");

function bar(...names) {
  const group = new FakeElement("group");
  for (const name of names) group.append(new FakeElement(name, name.startsWith("empty") ? 0 : 30));
  return group;
}

const order = (group) => group.children.map((c) => c.name);

test("first among Twitch's buttons, past its empty placeholders", () => {
  const group = bar("empty1", "empty2", "settings", "theatre", "fullscreen");
  const row = new Row();
  row.place(group);
  assert.deepStrictEqual(order(group), ["empty1", "empty2", "div", "settings", "theatre", "fullscreen"]);
});

test("another extension's buttons added in front: the text goes left of them, not between them", () => {
  const group = bar("settings", "fullscreen");
  const row = new Row();
  row.place(group);
  // 7TV adds its buttons at the start of the group after Mor did
  group.children.unshift(Object.assign(new FakeElement("7tv-b"), { parentElement: group }));
  group.children.unshift(Object.assign(new FakeElement("7tv-a"), { parentElement: group }));
  row.place(group);
  assert.deepStrictEqual(order(group), ["div", "7tv-a", "7tv-b", "settings", "fullscreen"]);
});

test("left where it is when it's already first: no moving back and forth", () => {
  const group = bar("7tv", "settings");
  const row = new Row();
  row.place(group);
  const moves = group.moves;
  for (let i = 0; i < 5; i++) row.place(group);
  assert.strictEqual(group.moves, moves);
});

test("Twitch rendering its controls afresh: the text goes into the new group", () => {
  const row = new Row();
  row.place(bar("settings"));
  const fresh = bar("settings", "fullscreen");
  row.place(fresh);
  assert.deepStrictEqual(order(fresh), ["div", "settings", "fullscreen"]);
});

test("an empty group still gets the text", () => {
  const group = bar("empty");
  const row = new Row();
  row.place(group);
  assert.deepStrictEqual(order(group), ["div", "empty"]);
});

const filtering = { state: "filtering", problem: null, step: "Removing A - B", retryAt: 0 };

test("the retry button sits left of the text, and pressing it retries (and stays Mor's click)", () => {
  let retried = 0;
  const row = new Row(() => { retried += 1; });
  row.update({ on: true, filter: filtering, audio: null, running: true }, 1000);
  assert.strictEqual(row.text.textContent, "Removing A - B");
  assert.strictEqual(row.retry.disabled, false);
  const capsule = row.retry.parentElement;
  assert.deepStrictEqual(capsule.children.map((c) => c.name), ["button", "span"]);
  assert.strictEqual(row.retry.fire("click"), true); // Twitch's player doesn't get the click
  assert.strictEqual(retried, 1);
});

test("the retry button waits while Shazam can't be asked, and until the filter has started", () => {
  let retried = 0;
  const row = new Row(() => { retried += 1; });
  row.update({ on: true, filter: { ...filtering, retryAt: 5500 }, audio: null, running: true }, 1000);
  assert.strictEqual(row.retry.disabled, true);
  assert.match(row.retry.title, /in 5 s/);
  row.retry.fire("click");
  assert.strictEqual(retried, 0);
  row.update({ on: true, filter: { ...filtering, retryAt: 5500 }, audio: null, running: true }, 6000);
  assert.strictEqual(row.retry.disabled, false);
  row.update({ on: true, filter: filtering, audio: null, running: false }, 6000);
  assert.strictEqual(row.retry.disabled, true);
});

test("hidden while the filter is off; problems in red", () => {
  const row = new Row();
  row.update({ on: false, filter: filtering, audio: null, running: false });
  assert.strictEqual(row.host.hidden, true);
  row.update({ on: true, filter: { ...filtering, problem: "Shazam is busy" }, audio: null, running: true });
  assert.strictEqual(row.host.hidden, false);
  assert.strictEqual(row.text.textContent, "Shazam is busy");
  assert.strictEqual(row.text.classList.contains("problem"), true);
});

test("seconds to wait for a retry", () => {
  assert.strictEqual(retryWait({ retryAt: 0 }, 1000), 0);
  assert.strictEqual(retryWait({ retryAt: 3001 }, 1000), 3);
  assert.strictEqual(retryWait(null, 1000), 0);
});
