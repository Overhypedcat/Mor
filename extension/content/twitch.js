// Mor in a Twitch tab: tells the background which channel's live stream the page shows, and, with the music filter
// on for that channel, sends the player's sound through the filter (audio/filter-worklet.js) on its way to the
// speakers. Each stream (a new channel, a new player) is a fresh filter, as each stream starts with nothing
// learned. Off, the sound goes straight through as Twitch plays it.
"use strict";

(() => {
  const CHUNK = 512 * 1024; // bytes per piece of a song's copy (helper/mor_helper/session.py)
  const port = browser.runtime.connect({ name: "mor-tab" });
  const hevc = typeof MediaSource !== "undefined"
    && MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"');

  let channel = null;
  let wanted = false; // the music filter is on for this channel
  let context = null; // the AudioContext, made once
  let moduleReady = null;
  const sources = new WeakMap(); // video -> its MediaElementAudioSourceNode (one per element, ever)
  let video = null; // the player's video element the sound is taken from
  let node = null; // the filter's AudioWorkletNode, while on
  let sid = null;
  let copy = null; // a song's copy on its way: {id, length, buffer, got, parts}
  let audioProblem = null;
  let filterState = { state: "listening", problem: null, step: null, retryAt: 0 }; // as the background last said
  const row = new PlayerRow.Row({
    onToggle: () => tell({ type: "toggle-filter" }),
    onRetry: () => tell({ type: "retry" }),
  });

  function tell(message) {
    try { port.postMessage(message); } catch (error) { /* the background is reloading: it asks again */ }
  }

  function setAudioProblem(text) {
    if (text === audioProblem) return;
    audioProblem = text;
    tell({ type: "audio", problem: text });
  }

  // the page

  function checkPage() {
    const now = Mor.pageChannel(location.href);
    if (now !== channel) {
      channel = now;
      stopFilter();
      tell({ type: "page", channel, hevc });
    }
  }

  // The stream's video: the biggest one showing (Twitch also has small previews that play on hover).
  function playerVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // the sound's way

  async function ready() {
    if (!context) {
      context = new AudioContext({ sampleRate: 48000 });
      moduleReady = context.audioWorklet.addModule(browser.runtime.getURL("audio/filter-worklet.js"));
    }
    await moduleReady;
    if (context.state !== "running") {
      try { await context.resume(); } catch (error) { /* told below */ }
    }
    if (context.state !== "running") {
      setAudioProblem("Click the stream once so Mor can hear it");
      return false;
    }
    setAudioProblem(null);
    return true;
  }

  function sourceOf(v) {
    if (!sources.has(v)) sources.set(v, context.createMediaElementSource(v));
    return sources.get(v);
  }

  async function startFilter(v) {
    if (!(await ready())) return;
    if (!wanted || channel === null || v !== playerVideo()) return; // changed while getting ready
    stopFilter();
    const source = sourceOf(v);
    source.disconnect();
    video = v;
    sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    node = new AudioWorkletNode(context, "mor-filter", { numberOfInputs: 1, numberOfOutputs: 1,
      outputChannelCount: [2] });
    const mine = sid;
    node.port.onmessage = (event) => fromWorklet(mine, event.data);
    node.port.postMessage({ type: "paused", paused: v.paused });
    source.connect(node).connect(context.destination);
    tell({ type: "filter-start", sid });
  }

  // The same channel's stream in another video element (an ad blocker swapping or reloading the player): the
  // filter carries on with it, the song it's taking out and what it learned of the streamer's sound included. It
  // finds the song's new place in the copy it has; Shazam is only asked when the song isn't anywhere in it.
  function moveFilter(v) {
    const before = sources.get(video);
    if (before) {
      before.disconnect();
      before.connect(context.destination);
    }
    const source = sourceOf(v);
    source.disconnect();
    source.connect(node);
    video = v;
    node.port.postMessage({ type: "paused", paused: v.paused });
  }

  function stopFilter() {
    if (sid) tell({ type: "filter-stop", sid });
    sid = null;
    copy = null;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
      node = null;
    }
    if (video && context) {
      const source = sources.get(video);
      if (source) {
        source.disconnect();
        source.connect(context.destination); // straight through, as Twitch plays it
      }
    }
    video = null;
  }

  function fromWorklet(mine, message) {
    if (mine !== sid) return;
    if (message.type === "heard") tell({ type: "heard", sid, samples: message.samples });
    else if (message.type === "broken") tell({ type: "broken", sid, text: message.text });
    else if (message.type === "broken-copy") {
      tell({ type: "broken", sid, text: "The song's copy didn't arrive whole, the filter waits for the next" });
    }
  }

  // the helper's news, through the background

  function onCopyPart(message) {
    if (!copy || copy.id !== message.copy || message.part === 0) {
      copy = { id: message.copy, length: message.length, buffer: new ArrayBuffer(message.length * 4), got: 0,
        parts: message.parts };
    }
    const bytes = Mor.fromBase64(message.data);
    new Uint8Array(copy.buffer).set(bytes, message.part * CHUNK);
    copy.got += 1;
    if (copy.got === copy.parts && node) {
      const { buffer, length } = copy;
      node.port.postMessage({ type: "copy", copy: copy.id, left: new Int16Array(buffer, 0, length),
        right: new Int16Array(buffer, length * 2, length) }, [buffer]);
      copy = { ...copy, buffer: null };
    }
  }

  port.onMessage.addListener((message) => {
    if (message.type === "filter") {
      wanted = message.on;
      if (!wanted) stopFilter();
      else if (message.restart) stopFilter();
      tick();
    } else if (message.type === "state") {
      filterState = message.filter;
    } else if (message.type === "copy" && message.sid === sid) {
      onCopyPart(message);
    } else if (message.type === "playing" && message.sid === sid && node) {
      node.port.postMessage({ type: "playing", seq: message.seq, playing: message.playing });
    }
  });

  // Twitch is a single page: the channel and the player change without the page loading again
  let starting = false;
  async function tick() {
    checkPage();
    if (!wanted || channel === null) {
      if (sid) stopFilter();
      return;
    }
    const v = playerVideo();
    if (!v) return;
    if (v === video && sid) return;
    if (sid && node) {
      moveFilter(v);
      return;
    }
    if (starting) return;
    starting = true;
    try {
      await startFilter(v);
    } catch (error) {
      setAudioProblem(`Mor couldn't reach the stream's sound: ${error.message}`);
    } finally {
      starting = false;
    }
  }

  for (const kind of ["pause", "play", "playing"]) {
    document.addEventListener(kind, (event) => {
      if (event.target === video && node) node.port.postMessage({ type: "paused", paused: video.paused });
    }, true);
  }
  // a click is what lets the page play sound: the filter can start then, if it was waiting for one
  for (const kind of ["pointerdown", "keydown"]) {
    document.addEventListener(kind, () => { if (audioProblem && context) tick(); }, true);
  }

  // the music filter's row on the player: on a channel's live stream, with Twitch's controls
  function showRow() {
    const v = channel ? playerVideo() : null;
    const container = v && v.closest(".video-player__container");
    const controls = container && container.querySelector(".player-controls");
    const group = controls && controls.querySelector(".player-controls__right-control-group");
    if (!group) {
      row.remove();
      return;
    }
    const fading = controls.closest(".tw-transition") || controls;
    const up = Number(getComputedStyle(fading).opacity) > 0.5 && getComputedStyle(controls).visibility !== "hidden";
    // measured against Twitch's buttons only while they show, and never under the mouse: it stays where it was
    row.place(container, controls, group, up && !row.hovered);
    row.update({ on: wanted, filter: filterState, audio: audioProblem }, up, Date.now());
  }

  tell({ type: "page", channel: (channel = Mor.pageChannel(location.href)), hevc });
  setInterval(tick, 500);
  setInterval(showRow, 100);
})();
