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
  const START_WAIT_MS = 3000; // how long the sound's start is waited for before it's said to be stuck
  const START_AGAIN_MS = 5000; // ...and how long until it's tried again by itself
  let context = null; // the AudioContext: one for the page, once it has run
  let ran = false; // the context has run (videos' sound is tied to it from then on)
  let couldnt = false; // a context couldn't start: the page's own never will, new ones are made in inner frames
  let frame = null; // the hidden inner frame the context was made in, if it wasn't the page's own
  let frameLost = false; // the page removed that frame after its context had run: only a reload helps
  let scope = null; // the window the context is of (the page's, or the frame's): its nodes are made there
  let tryAt = 0; // the sound couldn't start: not tried again before this time (a click tries at once)
  let moduleReady = null;
  const sources = new WeakMap(); // video -> its MediaElementAudioSourceNode (one per element, ever)
  let video = null; // the player's video element the sound is taken from
  let node = null; // the filter's AudioWorkletNode, while on
  let sid = null;
  let copy = null; // a song's copy on its way: {id, length, buffer, got, parts}
  let audioProblem = null;
  // as the background last said
  let filterState = { state: "listening", problem: null, step: null, retryAt: 0, stepUntil: 0, problemUntil: 0 };
  // the retry button: the song looked for afresh, or, with the sound not started, its start tried again at once
  const row = new PlayerRow.Row(() => {
    if (sid) tell({ type: "retry", sid });
    else startAgain();
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

  // Firefox leaves resume() unanswered, for good, while the sound can't start: no click on the page yet, or no
  // speaker or headphone connected (Bluetooth ones not yet on). So it's waited for only so long, said, and tried
  // again (tick, every START_AGAIN_MS, at a click and at the retry button), with a new AudioContext while none
  // has ever run (no video's sound is tied to it yet).
  //
  // A page's AudioContexts of one rate share what plays them, and once that couldn't start it never does, for
  // any of them, however many are made later and even with sound back (measured, Firefox 159): only another
  // window's start then. So after the first that couldn't, each new one is made in a hidden inner frame of its
  // own, which is a window of its own, as a page loaded again would be.
  function dropContext() {
    try { context.close().catch(() => {}); } catch (error) { /* it never started: nothing to close */ }
    context = null;
    if (frame) frame.remove();
    frame = null;
    scope = null;
  }

  function makeContext() {
    scope = window;
    if (couldnt) {
      frame = document.createElement("iframe");
      frame.setAttribute("data-mor", "sound");
      frame.style.display = "none";
      document.documentElement.append(frame);
      scope = frame.contentWindow;
    }
    context = new scope.AudioContext({ sampleRate: 48000 });
    moduleReady = context.audioWorklet.addModule(browser.runtime.getURL("audio/filter-worklet.js"));
  }

  async function ready() {
    if (context && !ran && context.state !== "running") dropContext();
    if (!context) makeContext();
    const mine = context;
    await moduleReady;
    if (mine.state !== "running") {
      let resumed;
      try { resumed = mine.resume().catch(() => {}); } catch (error) { /* told below */ }
      await Promise.race([resumed, new Promise((resolve) => setTimeout(resolve, START_WAIT_MS))]);
    }
    if (mine.state !== "running") {
      couldnt = true;
      const clicked = typeof navigator !== "undefined" && navigator.userActivation
        && navigator.userActivation.hasBeenActive;
      setAudioProblem(clicked
        ? "No sound output | Firefox couldn't start Mor's sound: is a speaker or headphone connected? Mor tries "
          + "again by itself"
        : "Click the stream | Firefox lets Mor hear the stream only after a click on the page");
      return false;
    }
    ran = true;
    setAudioProblem(null);
    return true;
  }

  function sourceOf(v) {
    if (!sources.has(v)) sources.set(v, context.createMediaElementSource(v));
    return sources.get(v);
  }

  async function startFilter(v) {
    if (!(await ready())) {
      tryAt = Date.now() + START_AGAIN_MS;
      return;
    }
    if (!wanted || channel === null || v !== playerVideo()) return; // changed while getting ready
    stopFilter();
    const source = sourceOf(v);
    source.disconnect();
    video = v;
    sid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    node = new scope.AudioWorkletNode(context, "mor-filter", { numberOfInputs: 1, numberOfOutputs: 1,
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
      tell({ type: "broken", sid, text: "Copy incomplete | The song's copy didn't arrive whole, the filter waits "
        + "for the next" });
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
    } else if (message.type === "start-again") { // the hub's retry button, with the sound not started
      startAgain();
    } else if (message.type === "state") {
      filterState = message.filter;
    } else if (message.type === "copy" && message.sid === sid) {
      onCopyPart(message);
    } else if (message.type === "playing" && message.sid === sid && node) {
      node.port.postMessage({ type: "playing", seq: message.seq, playing: message.playing });
    }
  });

  // The sound's start tried again now (a click on the page, the retry button), not at its next time.
  function startAgain() {
    // (asked for within the click itself, which is what Firefox wants: a start being waited for goes on from it)
    if (context && !ran) {
      try { context.resume().catch(() => {}); } catch (error) { /* said by the next try */ }
    }
    tryAt = 0;
    tick();
  }

  // Twitch is a single page: the channel and the player change without the page loading again
  let starting = false;
  async function tick() {
    checkPage();
    if (ran && frame && !frame.isConnected && !frameLost) {
      // (nothing can be done from here: the videos' sound is tied to the context of the frame that's gone)
      frameLost = true;
      stopFilter();
      setAudioProblem("Reload the page | The page removed what Mor plays the stream's sound through: load the "
        + "page again to hear the stream and filter it");
    }
    if (frameLost) return;
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
    if (starting || Date.now() < tryAt) return;
    starting = true;
    try {
      await startFilter(v);
    } catch (error) {
      setAudioProblem(`No stream sound | Mor couldn't reach the stream's sound: ${error.message}`);
      tryAt = Date.now() + START_AGAIN_MS;
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
    document.addEventListener(kind, () => { if (audioProblem) startAgain(); }, true);
  }

  // the music filter's row in Twitch's player controls, on a channel's live stream
  function showRow() {
    const v = channel ? playerVideo() : null;
    const container = v && v.closest(".video-player__container");
    const controls = container && container.querySelector(".player-controls");
    const group = controls && controls.querySelector(".player-controls__right-control-group");
    if (!group) {
      row.remove();
      return;
    }
    row.place(group);
    // (the retry button works with the filter started, and on a sound that couldn't start)
    row.update({ on: wanted, filter: filterState, audio: audioProblem, running: Boolean(sid || (audioProblem && !frameLost)) });
  }

  tell({ type: "page", channel: (channel = Mor.pageChannel(location.href)), hevc });
  setInterval(tick, 500);
  setInterval(showRow, 100);
})();
