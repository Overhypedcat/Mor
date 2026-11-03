// What the background, the hub and the tests share: reading Twitch's playlists and addresses, the unlock's
// decision, and the music filter's status lines. No browser APIs here.
"use strict";

const Mor = (() => {
  const NOT_QUALITIES = new Set(["worst", "best", "audio_only"]);
  // twitch.tv pages that aren't a channel
  const NOT_CHANNELS = new Set(["directory", "downloads", "jobs", "p", "search", "settings", "subscriptions",
    "turbo", "wallet", "drops", "inventory", "friends", "messages", "videos", "following", "store", "prime",
    "u", "user", "login", "signup", "logout", "bits", "broadcast", "annual-recap", "privacy", "legal"]);
  const LOGIN = /^[a-z0-9_]{1,25}$/;

  // Whether a stream name is a quality; Twitch's vertical copies (…_portrait) aren't.
  function isQuality(name) {
    return !NOT_QUALITIES.has(name) && !name.endsWith("_portrait");
  }

  function attributes(line) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(line))) out[m[1]] = m[2].replace(/^"|"$/g, "");
    return out;
  }

  // A variant's name from its size and frame rate, as streamlink names it: 1920x1080 at 60 -> '1080p60'.
  function sizeName(a) {
    const m = /^(\d+)x(\d+)$/.exec(a.RESOLUTION || "");
    if (!m) return null;
    const fps = Math.round(Number(a["FRAME-RATE"]) || 0);
    return `${m[2]}p${fps > 0 ? fps : ""}`;
  }

  // The qualities a multivariant playlist offers ('1440p60', '1080p60', ...): each variant's own name (Twitch's
  // IVS-NAME, or its STABLE-VARIANT-ID), else its rendition's NAME without the '(source)' note (Twitch's older
  // playlists), else its size and frame rate.
  function qualities(master) {
    const names = [];
    const renditions = {}; // VIDEO group -> NAME
    const lines = (master || "").split(/\r?\n/);
    for (const line of lines) {
      if (!line.startsWith("#EXT-X-MEDIA:")) continue;
      const a = attributes(line.slice(13));
      if (a.TYPE === "VIDEO" && a["GROUP-ID"] && a.NAME) renditions[a["GROUP-ID"]] = a.NAME;
    }
    for (const line of lines) {
      if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
      const a = attributes(line.slice(18));
      let name = a["IVS-NAME"] || a["STABLE-VARIANT-ID"] || (a.VIDEO && renditions[a.VIDEO]) || sizeName(a);
      if (name === "chunked") name = sizeName(a) || name; // the source copy's group, in older playlists
      name = (name || "").replace(/\s*\([^)]*\)/g, "").trim();
      if (name && isQuality(name) && !names.includes(name)) names.push(name);
    }
    return names;
  }

  // Qualities the tunnel offers that the normal connection doesn't.
  function unlockedOnly(direct, unlocked) {
    return unlocked.filter((q) => !direct.includes(q));
  }

  // Whether to play through the tunnel: the wanted quality only exists there, or 'best' is better there.
  function needsVpn(quality, direct, unlocked) {
    const extra = unlockedOnly(direct, unlocked);
    return extra.length > 0 && (quality == null || quality === "best" || extra.includes(quality));
  }

  // The channel a live-stream usher request is for, or null.
  function usherChannel(url) {
    const m = /^https:\/\/usher\.ttvnw\.net\/api\/(?:v2\/)?channel\/hls\/([a-z0-9_]{1,25})\.m3u8/i.exec(url);
    return m ? m[1].toLowerCase() : null;
  }

  // The channel whose live stream a twitch.tv address shows, or null (the front page, a past broadcast, ...).
  function pageChannel(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const host = u.hostname.toLowerCase();
    if (host === "player.twitch.tv") {
      const c = (u.searchParams.get("channel") || "").toLowerCase();
      return LOGIN.test(c) ? c : null;
    }
    if (!/(^|\.)twitch\.tv$/.test(host)) return null;
    const parts = u.pathname.split("/").filter(Boolean).map((p) => p.toLowerCase());
    if (parts[0] === "popout" || parts[0] === "moderator" || parts[0] === "embed") parts.shift();
    const name = parts[0];
    if (!name || !LOGIN.test(name) || NOT_CHANNELS.has(name)) return null;
    if (parts[1] === "videos" || parts[1] === "clip" || parts[1] === "clips" || parts[1] === "schedule"
        || parts[1] === "about") return null;
    return name;
  }

  // The music filter's lines ('problem Shazam is down'): [kind, detail] or null (helper/.../status.py).
  function parseStatus(text) {
    const trimmed = (text || "").trim();
    const space = trimmed.indexOf(" ");
    const kind = space < 0 ? trimmed : trimmed.slice(0, space);
    const detail = space < 0 ? "" : trimmed.slice(space + 1);
    if (kind === "listening" || kind === "filtering" || kind === "fine") return [kind, null];
    if ((kind === "problem" || kind === "step") && detail) return [kind, detail];
    if (kind === "ready" && /^\d+$/.test(detail)) return [kind, detail];
    return null;
  }

  // A tab's music filter as the hub shows it, after one more status line.
  function applyStatus(state, line, now) {
    const parsed = parseStatus(line);
    if (!parsed) return state;
    const [kind, detail] = parsed;
    const next = { ...state };
    if (kind === "problem") next.problem = detail;
    else if (kind === "fine") next.problem = null;
    else if (kind === "step") next.step = detail;
    else if (kind === "ready") next.retryAt = now + Number(detail) * 1000;
    else {
      next.state = kind;
      if (kind === "filtering") next.problem = null;
    }
    return next;
  }

  // Bytes <-> base64, in pieces so a large buffer never overflows the call stack.
  function toBase64(bytes) {
    let text = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  function fromBase64(text) {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // A Proton server's readable name: 'wg-NL-FREE-102' -> ['NL', 'Netherlands · Free 102'].
  const COUNTRIES = { NL: "Netherlands", US: "United States", JP: "Japan", CA: "Canada", DE: "Germany",
    GB: "United Kingdom", UK: "United Kingdom", FR: "France", PL: "Poland", RO: "Romania", NO: "Norway",
    CH: "Switzerland", SG: "Singapore", MX: "Mexico", SE: "Sweden" };

  function serverLabel(stem) {
    const m = /(?:^|-)([A-Z]{2})-(FREE)-(\d+)$/i.exec(stem);
    if (!m) return ["", stem];
    const code = m[1].toUpperCase();
    return [code, `${COUNTRIES[code] || code} · Free ${m[3]}`];
  }

  // What the music filter's text on the player says: what went wrong, else what it's doing, else that it's off.
  function rowText(on, filter, audioProblem) {
    if (!on) return { text: "Off", problem: false };
    const problem = audioProblem || filter.problem;
    if (problem) return { text: problem, problem: true };
    if (filter.step) return { text: filter.step, problem: false };
    return { text: filter.state === "filtering" ? "Removing the song" : "Listening for music", problem: false };
  }

  // Whether the helper on this PC is older than the extension (Firefox updates the extension by itself; the helper
  // comes with Mor's folder): '0.1.2' < '0.1.10'.
  function helperOutdated(helperVersion, extensionVersion) {
    if (!helperVersion || !extensionVersion) return false;
    const a = helperVersion.split(".").map(Number), b = extensionVersion.split(".").map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0);
    }
    return false;
  }

  return { helperOutdated, isQuality, qualities, unlockedOnly, needsVpn, usherChannel, pageChannel, parseStatus, applyStatus,
    toBase64, fromBase64, serverLabel, rowText };
})();

if (typeof module !== "undefined") module.exports = Mor;
