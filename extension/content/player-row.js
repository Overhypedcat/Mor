// What the music filter is doing, in Twitch's player controls, first among the buttons on the right: a retry button
// and a line of text ("Listening for music", "Removing Artist - Song"; what went wrong, in red), framed together in a
// thin capsule. It's part of Twitch's control bar, so it shows, hides and lays out with Twitch's own buttons. Only
// while the filter is on for the channel: it's switched from Mor's hub.
"use strict";

const PlayerRow = (() => {
  const STYLE = `
    :host { all: initial; display: flex; align-items: center; min-width: 0; margin-right: 8px; }
    :host([hidden]) { display: none; }
    .capsule {
      display: flex; align-items: center; gap: 2px; min-width: 0; height: 26px; box-sizing: border-box;
      padding: 0 11px 0 1px; border: 1px solid rgba(255, 255, 255, 0.38); border-radius: 13px;
    }
    .retry {
      all: unset; display: flex; align-items: center; justify-content: center; flex: none;
      width: 22px; height: 22px; border-radius: 11px; color: #fff; cursor: pointer;
    }
    .retry:hover:not(:disabled) { background: rgba(255, 255, 255, 0.16); }
    .retry:focus-visible { outline: 1px solid rgba(255, 255, 255, 0.7); outline-offset: -1px; }
    .retry:disabled { opacity: 0.4; cursor: default; }
    .retry svg { width: 14px; height: 14px; display: block; }
    .text {
      max-width: 320px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font: 13px/24px Inter, "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #fff;
      -webkit-font-smoothing: antialiased; user-select: none;
    }
    .text.problem { color: #ff6b7a; }
  `;
  // a circular arrow: the song is looked for afresh
  const ICON = ["M13.2 8.6A5.25 5.25 0 1 1 11.6 4.1", "M12.2 1.9v2.6H9.6"];

  function icon() {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    const attributes = { viewBox: "0 0 16 16", fill: "none", stroke: "currentColor", "stroke-width": "1.6",
      "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" };
    for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
    for (const d of ICON) {
      const path = document.createElementNS(NS, "path");
      path.setAttribute("d", d);
      svg.append(path);
    }
    return svg;
  }

  // Whether an element takes room in the bar (Twitch keeps empty ones in its groups).
  function shows(element) {
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Whether a comes before b among the same parent's children.
  function precedes(a, b) {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  // How long until the retry can go again (Shazam's budget, a retry just sent), in whole seconds; 0 when it can.
  function retryWait(filter, now) {
    return Math.max(0, Math.ceil((((filter && filter.retryAt) || 0) - now) / 1000));
  }

  class Row {
    // onRetry: called when the retry button is pressed.
    constructor(onRetry = () => {}) {
      this.host = document.createElement("div");
      this.host.setAttribute("data-mor", "music-filter");
      const root = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      const capsule = document.createElement("div");
      capsule.className = "capsule";
      this.retry = document.createElement("button");
      this.retry.className = "retry";
      this.retry.type = "button";
      this.retry.append(icon());
      this.retry.setAttribute("aria-label", "Look for the song again");
      // Twitch's player takes clicks for itself (pause, controls): this one is Mor's alone
      for (const kind of ["click", "pointerdown", "mousedown", "dblclick"]) {
        this.retry.addEventListener(kind, (event) => {
          event.stopPropagation();
          if (kind === "click" && !this.retry.disabled) onRetry();
        });
      }
      this.text = document.createElement("span");
      this.text.className = "text";
      capsule.append(this.retry, this.text);
      root.append(style, capsule);
      this.drawn = undefined;
    }

    // Puts the row left of every button on the right of Twitch's controls: Twitch's own, and those other extensions
    // add there (7TV's, ...), whichever came first. Moved back there when Twitch renders its controls afresh or
    // something is added in front of it; Twitch's empty placeholders don't count.
    place(rightGroup) {
      const first = [...rightGroup.children].find((child) => child !== this.host && shows(child));
      if (first) {
        if (this.host.parentElement !== rightGroup || !precedes(this.host, first)) rightGroup.insertBefore(this.host, first);
      } else if (this.host.parentElement !== rightGroup) {
        rightGroup.prepend(this.host);
      }
    }

    remove() {
      this.host.remove();
    }

    // model: {on, filter, audio, running (the filter has started, so a retry can reach it)}; now: Date.now().
    update(model, now = Date.now()) {
      const { text, problem } = Mor.rowText(model.on, model.filter, model.audio);
      const wait = retryWait(model.filter, now);
      const canRetry = Boolean(model.running) && wait === 0;
      const key = model.on ? JSON.stringify([text, problem, canRetry, wait]) : null;
      if (key === this.drawn) return;
      this.drawn = key;
      this.host.hidden = !model.on;
      this.text.textContent = model.on ? text : "";
      this.text.title = model.on ? text : "";
      this.text.classList.toggle("problem", problem);
      this.retry.disabled = !canRetry;
      this.retry.title = wait > 0 ? `Look for the song again (in ${wait} s)` : "Look for the song again";
    }
  }

  return { Row, retryWait };
})();

if (typeof module !== "undefined") module.exports = PlayerRow;
