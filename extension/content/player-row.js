// The music filter's row on Twitch's player, bottom right beside Twitch's own buttons: its note (three dots step
// beside it while it listens for a song, struck through while it takes one out), what it's doing or what went wrong,
// its retry (a turning arrow, or the seconds until Shazam may be asked again) and its switch. It comes and goes
// with Twitch's controls; a problem brings it up on its own for a while, so nothing goes unsaid.
"use strict";

const PlayerRow = (() => {
  const NOTICE_MS = 10000; // how long a problem keeps the row up on its own
  const FADE_IN_MS = 120;
  const FADE_OUT_MS = 180; // it leaves a little slower than it comes, so it doesn't vanish abruptly
  const GAP = 8; // from Twitch's buttons
  const SVG = "http://www.w3.org/2000/svg";

  const STYLE = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .row {
      position: absolute; z-index: 10; display: flex; align-items: center; height: 34px; gap: 0;
      padding: 0 2px 0 0; border-radius: 12px; background: rgba(14, 14, 16, 0.78);
      font: 13px/1 Inter, "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #adadb8;
      opacity: 0; pointer-events: none; transition: opacity ${FADE_OUT_MS}ms ease;
      -webkit-font-smoothing: antialiased; user-select: none;
    }
    .row.shown { opacity: 1; pointer-events: auto; transition-duration: ${FADE_IN_MS}ms; }
    .note { flex: none; width: 34px; height: 34px; }
    .text { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 8px 0 4px; }
    .text.problem { color: #ff6b7a; }
    button {
      all: unset; flex: none; display: grid; place-items: center; cursor: pointer; border-radius: 9px;
      -webkit-tap-highlight-color: transparent;
    }
    button:hover { background: rgba(255, 255, 255, 0.12); }
    .retry { width: 26px; height: 26px; margin-right: 6px; color: #fff; font-size: 11px; }
    .retry.waiting { color: #adadb8; cursor: default; }
    .retry.waiting:hover { background: none; }
    .retry svg { width: 26px; height: 26px; }
    .switch { width: 40px; height: 30px; border-radius: 10px; }
    .track { position: relative; width: 28px; height: 16px; border-radius: 8px; background: #26262c; transition: background .15s; }
    .knob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform .15s; }
    .switch.on .track { background: #9146ff; }
    .switch.problem .track { background: #ff3b4f; }
    .switch.on .knob, .switch.problem .knob { transform: translateX(12px); }
  `;

  // The boxes of a group's children that show (Twitch keeps empty ones in its groups).
  function shown(group) {
    return [...group.children].map((c) => c.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
  }

  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  function svg(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  // The note, drawn about (cx, cy) = (12, 17) in a 34 x 34 box; dots and the strike as the state asks.
  function drawNote(box, state, phase) {
    box.replaceChildren();
    const color = "#fff";
    let cx = 12;
    const cy = 17;
    if (phase !== null) {
      cx -= 4; // room for the dots on the right
      for (let i = 0; i < 3; i++) {
        box.append(svg("circle", { cx: cx + 9 + i * 4.2, cy: cy + 5 - (i === phase ? 2.5 : 0), r: 1.5, fill: color }));
      }
    }
    box.append(svg("ellipse", { cx: cx - 3.5, cy: cy + 5, rx: 4.4, ry: 3.1, fill: color,
      transform: `rotate(-22 ${cx - 3.5} ${cy + 5})` }));
    const stem = cx + 0.1;
    box.append(svg("path", { d: `M${stem} ${cy + 4}V${cy - 8}C${stem + 2.4} ${cy - 6.6} ${stem + 4.6} ${cy - 5} ${stem + 5.6} ${cy - 2.4}`,
      fill: "none", stroke: color, "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    if (state === "filtering") {
      box.append(svg("path", { d: `M${cx - 8} ${cy - 8}L${cx + 8} ${cy + 8}`, stroke: color, "stroke-width": 1.8,
        "stroke-linecap": "round" }));
    }
  }

  // The retry's turning arrow: most of a turn clockwise from the top right, its head where it ends.
  function retryArrow() {
    const s = svg("svg", { viewBox: "0 0 26 26" });
    const r = 5.5, c = 13, rad = (a) => (a * Math.PI) / 180;
    const p = (a) => `${(c + r * Math.cos(rad(a))).toFixed(2)} ${(c + r * Math.sin(rad(a))).toFixed(2)}`;
    s.append(svg("path", { d: `M${p(-15)}A${r} ${r} 0 1 1 ${p(270)}`, fill: "none", stroke: "currentColor",
      "stroke-width": 2, "stroke-linecap": "round" }));
    const end = rad(-75), ex = c + r * Math.cos(end), ey = c + r * Math.sin(end);
    const tx = -Math.sin(end), ty = Math.cos(end);
    s.append(svg("path", { d: `M${ex + 4 * tx} ${ey + 4 * ty}L${ex - 3.5 * ty} ${ey + 3.5 * tx}L${ex + 3.5 * ty} ${ey - 3.5 * tx}Z`,
      fill: "currentColor", "stroke-linejoin": "round" }));
    return s;
  }

  class Row {
    constructor({ onToggle, onRetry }) {
      this.host = el("div");
      this.host.setAttribute("data-mor", "music-filter");
      const root = this.host.attachShadow({ mode: "closed" });
      const style = el("style");
      style.textContent = STYLE;
      this.row = el("div", "row");
      this.note = svg("svg", { class: "note", viewBox: "0 0 34 34" });
      this.text = el("span", "text");
      this.retry = el("button", "retry");
      this.retry.setAttribute("aria-label", "Ask Shazam again");
      this.retry.title = "Ask Shazam again";
      this.switch = el("button", "switch");
      this.switch.setAttribute("role", "switch");
      this.switch.setAttribute("aria-label", "Music filter");
      const track = el("span", "track");
      track.append(el("span", "knob"));
      this.switch.append(track);
      this.row.append(this.note, this.text, this.retry, this.switch);
      root.append(style, this.row);
      // clicks on the row are the row's: Twitch's player would otherwise pause or play
      for (const kind of ["click", "mousedown", "pointerdown", "dblclick"]) {
        this.row.addEventListener(kind, (e) => e.stopPropagation());
      }
      this.switch.addEventListener("click", () => onToggle());
      this.retry.addEventListener("click", () => { if (!this.retry.classList.contains("waiting")) onRetry(); });
      this.drawn = null;
      this.noticeUntil = 0;
      this.lastProblem = null;
    }

    // Puts the row on the player (once per player), and lays it out beside Twitch's buttons.
    place(container, controls, rightGroup) {
      if (this.host.parentElement !== container) {
        if (getComputedStyle(container).position === "static") container.style.position = "relative";
        container.append(this.host);
      }
      const box = container.getBoundingClientRect();
      // Twitch's groups are wider than their buttons (the right one's sit at its right end, the left one's at its
      // left): the row goes between the buttons themselves
      const group = rightGroup.getBoundingClientRect();
      const buttonsLeft = Math.min(group.right, ...shown(rightGroup).map((r) => r.left));
      const leftGroup = controls.querySelector(".player-controls__left-control-group");
      const bar = controls.getBoundingClientRect();
      const from = (leftGroup ? Math.max(bar.left, ...shown(leftGroup).map((r) => r.right)) : bar.left) + GAP;
      this.row.style.right = `${Math.round(box.right - buttonsLeft + GAP)}px`;
      this.row.style.bottom = `${Math.round(box.bottom - (group.top + group.height / 2) - 17)}px`;
      // never so narrow that what it says shrinks to nothing: the note, some text, the retry and the switch fit
      this.row.style.maxWidth = `${Math.max(240, Math.round(buttonsLeft - GAP - from))}px`;
    }

    remove() {
      this.host.remove();
    }

    // model: {on, filter, audio}; controlsUp: Twitch's controls are showing.
    update(model, controlsUp, now) {
      const { text, problem } = Mor.rowText(model.on, model.filter, model.audio);
      const state = Mor.rowState(model.on, model.filter, model.audio);
      if (problem && text !== this.lastProblem) this.noticeUntil = now + NOTICE_MS; // a new problem: said
      this.lastProblem = problem ? text : null;
      const shown = controlsUp || (problem && now < this.noticeUntil);
      this.row.classList.toggle("shown", Boolean(shown));
      const wait = model.on ? Mor.retryWait(model.filter, now) : null;
      const phase = Mor.musicPhase(state, now);
      const key = JSON.stringify([text, problem, state, wait, phase]);
      if (key === this.drawn) return;
      this.drawn = key;
      drawNote(this.note, state, phase);
      this.text.textContent = text;
      this.text.title = text;
      this.text.classList.toggle("problem", problem);
      this.retry.hidden = !model.on;
      this.retry.classList.toggle("waiting", wait > 0);
      this.retry.replaceChildren(wait > 0 ? `${wait}s` : retryArrow());
      this.switch.className = `switch${state === "problem" ? " problem" : state ? " on" : ""}`;
      this.switch.setAttribute("aria-checked", model.on ? "true" : "false");
    }
  }

  return { Row, NOTICE_MS };
})();

if (typeof module !== "undefined") module.exports = PlayerRow;
