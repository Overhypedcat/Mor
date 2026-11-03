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

    // Puts the text first among Twitch's buttons on the right (again whenever Twitch renders its controls afresh).
    place(rightGroup) {
      if (this.host.parentElement !== rightGroup) rightGroup.prepend(this.host);
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
