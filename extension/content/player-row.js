// What the music filter is doing, as a line of text in Twitch's player controls, first among the buttons on the
// right ("Listening for music", "Removing Artist - Song"; what went wrong, in red). It's part of Twitch's control bar,
// so it shows, hides and lays out with Twitch's own buttons. Only while the filter is on for the channel: it's
// switched, and retried, from Mor's hub.
"use strict";

const PlayerRow = (() => {
  const STYLE = `
    :host { all: initial; display: flex; align-items: center; min-width: 0; margin-right: 8px; }
    :host([hidden]) { display: none; }
    .text {
      max-width: 320px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      font: 13px/32px Inter, "Roobert", "Helvetica Neue", Helvetica, Arial, sans-serif; color: #fff;
      -webkit-font-smoothing: antialiased; user-select: none;
    }
    .text.problem { color: #ff6b7a; }
  `;

  // Whether an element takes room in the bar (Twitch keeps empty ones in its groups).
  function shows(element) {
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Whether a comes before b among the same parent's children.
  function precedes(a, b) {
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  class Row {
    constructor() {
      this.host = document.createElement("div");
      this.host.setAttribute("data-mor", "music-filter");
      const root = this.host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = STYLE;
      this.text = document.createElement("span");
      this.text.className = "text";
      root.append(style, this.text);
      this.drawn = undefined;
    }

    // Puts the text left of every button on the right of Twitch's controls: Twitch's own, and those other extensions
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

    // model: {on, filter, audio}.
    update(model) {
      const { text, problem } = Mor.rowText(model.on, model.filter, model.audio);
      const key = model.on ? JSON.stringify([text, problem]) : null;
      if (key === this.drawn) return;
      this.drawn = key;
      this.host.hidden = !model.on;
      this.text.textContent = model.on ? text : "";
      this.text.title = model.on ? text : "";
      this.text.classList.toggle("problem", problem);
    }
  }

  return { Row };
})();

if (typeof module !== "undefined") module.exports = PlayerRow;
