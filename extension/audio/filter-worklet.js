// The music filter's subtraction, in the tab: the stream's sound in, the same with the song taken out.
//
// Canceller and Filter are line-for-line ports of helper/mor_helper/musicfilter/canceller.py and relay.Filter (the
// Python ones are the reference: tests/filter.test.js checks this port against them sample for sample). The helper
// works out which song plays and where (relay.Tracker) from the sound this sends it, and sends back the song's
// clean copy and each new place; until it knows, the sound goes through as it is.
//
// Runs in an AudioWorklet (registerProcessor below); under Node it only exports the classes, for the tests.

const RATE = 48000;
const SIZE = 2048; // samples per analysis frame
const HOP = 512; // samples between frames: the slice the stream moves on by
const DELAY = SIZE - HOP; // how far the result runs behind the stream
const TAPS = 2;
const SHAPE_RATE = 0.01;
const VOLUME_SECONDS = 0.2;
const WARMUP_FRAMES = 50;
const LEFTOVER_FLOOR = 0.15;
const QUIET_VOLUME = 0.05;
const MAX_VOLUME = 4.0;
const LEARN_FLOOR = 0.05;
const SHARE_GAIN = 4.0;
const LEARN_VOLUME = 0.3;
const SETTLE = 0.002;
const BINS = SIZE / 2 + 1;
const JUMP = HOP; // the song's place moving by more than this: the cancellers start over there (keeping the shape)
const HEARD_BATCH = 4096; // mono samples per message to the helper
const QUEUE = 8192; // room for filtered sound waiting to play: a few HOPs is all it ever holds

// A real FFT of SIZE samples through a complex one (iterative radix 2), and its inverse as numpy.fft.irfft does it
// (the imaginary parts of the first and last bins are left out).
const FFT = (() => {
  const n = SIZE;
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);

  function transform(sign) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step];
          const wi = sign * sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  return {
    // samples (length SIZE) -> spectrum (BINS) as outRe, outIm
    rfft(samples, outRe, outIm) {
      for (let i = 0; i < n; i++) { re[i] = samples[i]; im[i] = 0; }
      transform(-1);
      for (let k = 0; k < BINS; k++) { outRe[k] = re[k]; outIm[k] = im[k]; }
    },
    // spectrum (BINS) -> samples (SIZE)
    irfft(inRe, inIm, out) {
      re[0] = inRe[0]; im[0] = 0;
      re[n / 2] = inRe[n / 2]; im[n / 2] = 0;
      for (let k = 1; k < n / 2; k++) {
        re[k] = inRe[k]; im[k] = inIm[k];
        re[n - k] = inRe[k]; im[n - k] = -inIm[k];
      }
      transform(1);
      for (let i = 0; i < n; i++) out[i] = re[i] / n;
    },
  };
})();

// numpy.hanning(SIZE + 1)[:SIZE] as float32: periodic, so overlapping frames sum evenly
const WINDOW = (() => {
  const w = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SIZE);
  return w;
})();
const NORM = (() => {
  let total = 0;
  for (let i = 0; i < SIZE; i++) total += Math.fround(WINDOW[i] * WINDOW[i]);
  return total / HOP;
})();

// One channel of sound. Feed it a slice of the stream and the matching slice of the song (null while there's no
// song to take out); it gives back a slice of the result, DELAY samples behind what went in.
class Canceller {
  constructor(rate = RATE) {
    this.volumeKeep = Math.exp(-HOP / (rate * VOLUME_SECONDS));
    this.shapeKeep = Math.exp(-HOP / (rate * 2.0));
    this.stream = new Float32Array(SIZE);
    this.song = new Float32Array(SIZE);
    this.overlap = new Float32Array(SIZE);
    this.shareGain = SHARE_GAIN;
    this.frame = new Float64Array(SIZE);
    this.Yr = new Float64Array(BINS); this.Yi = new Float64Array(BINS);
    this.Xr = new Float64Array(BINS); this.Xi = new Float64Array(BINS);
    this.Er = new Float64Array(BINS); this.Ei = new Float64Array(BINS);
    this.back = new Float64Array(SIZE);
    this.share = new Float64Array(BINS);
    this.sr = new Float64Array(BINS); this.si = new Float64Array(BINS);
    this.heard = new Float64Array(BINS);
    this.reset();
  }

  // Forget everything learned, the streamer's setup too.
  reset() {
    this.shapeRe = new Float64Array(BINS * TAPS);
    this.shapeIm = new Float64Array(BINS * TAPS);
    this.power = new Float64Array(BINS);
    this.songPower = 0.0;
    this.frames = 0;
    this.fresh = true;
    this.restart();
  }

  // Another song, or the same one somewhere else: its frames and the volume start over; the shape is kept.
  restart() {
    this.histRe = new Float64Array(BINS * TAPS); // the song's latest frames, newest first: [bin * TAPS + tap]
    this.histIm = new Float64Array(BINS * TAPS);
    this.num = 0.0;
    this.den = 0.0;
    this.volume = 1.0;
    if (!this.fresh) this.frames = WARMUP_FRAMES;
  }

  // HOP samples of the stream (and the song lined up with them) in, HOP samples of the result out.
  process(stream, song = null) {
    this.stream.copyWithin(0, HOP); this.stream.set(stream, SIZE - HOP);
    this.song.copyWithin(0, HOP);
    if (song) this.song.set(song, SIZE - HOP); else this.song.fill(0, SIZE - HOP);
    for (let i = 0; i < SIZE; i++) this.frame[i] = Math.fround(this.stream[i] * WINDOW[i]);
    FFT.rfft(this.frame, this.Yr, this.Yi);
    if (song === null) {
      this.Er.set(this.Yr); this.Ei.set(this.Yi);
    } else {
      for (let i = 0; i < SIZE; i++) this.frame[i] = Math.fround(this.song[i] * WINDOW[i]);
      FFT.rfft(this.frame, this.Xr, this.Xi);
      this._cancel();
    }
    FFT.irfft(this.Er, this.Ei, this.back);
    for (let i = 0; i < SIZE; i++) this.overlap[i] += Math.fround(this.back[i]) * WINDOW[i] / NORM;
    const out = this.overlap.slice(0, HOP);
    this.overlap.copyWithin(0, HOP); this.overlap.fill(0, SIZE - HOP);
    return out;
  }

  _cancel() {
    const { Yr, Yi, Xr, Xi, Er, Ei, histRe, histIm, shapeRe, shapeIm, share, sr, si, heard } = this;
    for (let k = 0; k < BINS; k++) {
      for (let t = TAPS - 1; t > 0; t--) {
        histRe[k * TAPS + t] = histRe[k * TAPS + t - 1];
        histIm[k * TAPS + t] = histIm[k * TAPS + t - 1];
      }
      histRe[k * TAPS] = Xr[k]; histIm[k * TAPS] = Xi[k];
      let a = 0, b = 0;
      for (let t = 0; t < TAPS; t++) { // the song as the shape predicts it, before the volume
        const i = k * TAPS + t;
        a += shapeRe[i] * histRe[i] - shapeIm[i] * histIm[i];
        b += shapeRe[i] * histIm[i] + shapeIm[i] * histRe[i];
      }
      sr[k] = a; si[k] = b;
    }
    this.frames += 1;
    if (this.fresh && this.frames > WARMUP_FRAMES) this.fresh = false;
    const heardAt = this.frames > WARMUP_FRAMES ? Math.max(this.volume, LEARN_VOLUME) : 1.0;
    let numSum = 0, denSum = 0;
    for (let k = 0; k < BINS; k++) {
      let value = 1;
      if (!this.fresh) {
        const gr = heardAt * sr[k], gi = heardAt * si[k];
        const guess = gr * gr + gi * gi;
        const dr = Yr[k] - gr, di = Yi[k] - gi;
        value = guess / (guess + dr * dr + di * di + 1e-12);
      }
      value = Math.min(value * this.shareGain, 1.0);
      share[k] = value;
      numSum += value * (sr[k] * Yr[k] + si[k] * Yi[k]);
      denSum += value * (sr[k] * sr[k] + si[k] * si[k]);
    }
    const vk = this.volumeKeep;
    this.num = vk * this.num + (1 - vk) * numSum;
    this.den = vk * this.den + (1 - vk) * denSum;
    if (this.frames > WARMUP_FRAMES && this.den > 1e-12) {
      this.volume = Math.min(Math.max(this.num / this.den, 0.0), MAX_VOLUME);
    }
    const vol = this.volume;
    let heardMean = 0;
    for (let k = 0; k < BINS; k++) {
      Er[k] = Yr[k] - vol * sr[k]; Ei[k] = Yi[k] - vol * si[k];
      let h = 0;
      for (let t = 0; t < TAPS; t++) {
        const i = k * TAPS + t;
        h += histRe[i] * histRe[i] + histIm[i] * histIm[i];
      }
      heard[k] = h;
      heardMean += h;
    }
    heardMean /= BINS;
    if (this.frames === 1) { // the averages start from the song's first frame, not from silence
      this.power.set(heard);
      this.songPower = heardMean;
    }
    const sk = this.shapeKeep;
    for (let k = 0; k < BINS; k++) this.power[k] = sk * this.power[k] + (1 - sk) * heard[k];
    this.songPower = sk * this.songPower + (1 - sk) * heardMean;
    const volume = this.frames > WARMUP_FRAMES ? this.volume : 1.0;
    if (volume >= QUIET_VOLUME) {
      const floor = 1e-3 * this.songPower + 1e-12;
      const scale = Math.max(volume, LEARN_VOLUME);
      for (let k = 0; k < BINS; k++) {
        const step = SHAPE_RATE * Math.max(share[k], LEARN_FLOOR) / (this.power[k] + floor);
        const wr = Yr[k] / scale - sr[k], wi = Yi[k] / scale - si[k];
        for (let t = 0; t < TAPS; t++) {
          const i = k * TAPS + t;
          const xr = histRe[i], xi = -histIm[i]; // conj(x)
          shapeRe[i] += step * (xr * wr - xi * wi);
          shapeIm[i] += step * (xr * wi + xi * wr);
        }
      }
    }
    if (this.frames > WARMUP_FRAMES && this.volume >= QUIET_VOLUME) {
      const f = Math.pow(this.volume, SETTLE);
      for (let i = 0; i < shapeRe.length; i++) { shapeRe[i] *= f; shapeIm[i] *= f; }
      this.num *= f; this.den *= f * f; this.volume /= f;
    }
    // what's left of the song, turned down where it still outweighs the rest
    for (let k = 0; k < BINS; k++) {
      const mr = vol * sr[k], mi = vol * si[k];
      const music = mr * mr + mi * mi;
      const left = Er[k] * Er[k] + Ei[k] * Ei[k];
      const ratio = music / (left + music + 1e-12);
      const keep = Math.min(Math.max(1 - ratio, LEFTOVER_FLOOR), 1);
      Er[k] *= keep; Ei[k] *= keep;
    }
  }
}

// A song being taken out: its copy (16-bit, left and right), the song sample at stream sample 0 (offset).
class Playing {
  constructor(seq, info, copy) {
    this.seq = seq;
    this.key = info.key; this.title = info.title; this.artist = info.artist;
    this.offset = info.offset; this.round = info.round;
    this.left = copy.left; this.right = copy.right;
  }

  sameSong(other) {
    return this.key === other.key && this.title === other.title && this.artist === other.artist;
  }

  // The song's sound under these stream samples, [left, right]; null once it's over or before it starts.
  slice(start, length) {
    const at = start + this.offset;
    const n = this.left.length;
    if (at + length <= 0 || at >= n) return null;
    const out = [new Float32Array(length), new Float32Array(length)];
    const lo = Math.max(at, 0), hi = Math.min(at + length, n);
    for (let i = lo; i < hi; i++) {
      out[0][i - at] = this.left[i] / 32768.0;
      out[1][i - at] = this.right[i] / 32768.0;
    }
    return out;
  }
}

// The stream's sound in, the same with the song taken out; DELAY samples behind. playing is what the helper said
// last (a Playing, or null); onHeard gets the mono sound for the helper, onProblem what went wrong.
class Filter {
  constructor(onHeard, onProblem) {
    this.onHeard = onHeard; this.onProblem = onProblem;
    this.cancellers = [new Canceller(RATE), new Canceller(RATE)];
    this.pending = [new Float32Array(HOP), new Float32Array(HOP)]; // sound not yet a whole HOP
    this.pendingLength = 0;
    this.fed = 0;
    this.current = null; // the Playing the cancellers follow
    this.wanted = null; // the latest Playing from the helper
    this.broken = false;
    this.held = [new Float32Array(DELAY), new Float32Array(DELAY)];
  }

  // Stereo samples [left, right] in; [[stream index of the first sample, [left, right] of HOP]] out.
  push(sound) {
    const n = sound[0].length;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = (sound[0][i] + sound[1][i]) / 2;
    this.onHeard(mono);
    const out = [];
    let at = 0;
    while (at < n) {
      const take = Math.min(n - at, HOP - this.pendingLength);
      this.pending[0].set(sound[0].subarray(at, at + take), this.pendingLength);
      this.pending[1].set(sound[1].subarray(at, at + take), this.pendingLength);
      this.pendingLength += take;
      at += take;
      if (this.pendingLength < HOP) break;
      this.pendingLength = 0;
      const block = this.pending;
      let result = null;
      if (!this.broken) {
        const song = this._song(this.fed);
        try {
          result = [0, 1].map((ch) => this.cancellers[ch].process(block[ch], song === null ? null : song[ch]));
        } catch (error) { // the filter must never stop the sound: from now on it goes through
          this.broken = true;
          this.onProblem(`The music filter broke, the sound plays unfiltered: ${error.name}: ${error.message}`);
        }
      }
      if (this.broken) { // still DELAY behind, so it stays in step
        result = [0, 1].map((ch) => {
          const joined = concat(this.held[ch], block[ch]);
          this.held[ch] = joined.slice(HOP);
          return joined.slice(0, HOP);
        });
      }
      out.push([this.fed - DELAY, result]);
      this.fed += HOP;
    }
    return out;
  }

  _song(start) {
    const playing = this.wanted;
    const before = this.current;
    if (playing !== before) {
      if (playing && before && playing.round !== before.round) {
        // a retry: from nothing, what they learned of the stream's EQ and delay too (it may be what failed)
        this.cancellers = [new Canceller(RATE), new Canceller(RATE)];
      } else if (playing === null || before === null || !playing.sameSong(before)
                 || Math.abs(playing.offset - before.offset) > JUMP) {
        for (const c of this.cancellers) c.restart(); // the streamer's EQ and delay they learned stay
      }
      this.current = playing;
    }
    return playing ? playing.slice(start, HOP) : null;
  }
}

function concat(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

if (typeof registerProcessor === "function") {
  // The node in the tab: 128 samples at a time in, the filtered sound out a constant DELAY (and a HOP's gathering)
  // behind. Its port takes the helper's news ({type: "copy"}, {type: "playing"}) and sends the stream's sound
  // ({type: "heard"}) and problems ({type: "broken"}) back.
  class MorFilter extends AudioWorkletProcessor {
    constructor() {
      super();
      this.copy = null; // {id, left, right}: the song copy the helper sent last
      this.heard = new Float32Array(HEARD_BATCH);
      this.heardCount = 0;
      this.queue = [new Float32Array(QUEUE), new Float32Array(QUEUE)]; // filtered sound waiting to play (a ring)
      this.queueStart = 0;
      this.queueLength = 0;
      this.paused = false;
      this.filter = new Filter((mono) => this._heard(mono),
                               (text) => this.port.postMessage({ type: "broken", text }));
      this.port.onmessage = (event) => this._message(event.data);
    }

    _message(message) {
      if (message.type === "copy") {
        this.copy = { id: message.copy, left: message.left, right: message.right };
      } else if (message.type === "playing") {
        const info = message.playing;
        if (info && this.copy && this.copy.id === info.copy) {
          this.filter.wanted = new Playing(message.seq, info, this.copy);
        } else {
          this.filter.wanted = null;
          if (info) this.port.postMessage({ type: "broken-copy", copy: info.copy });
        }
      } else if (message.type === "paused") {
        this.paused = message.paused;
      }
    }

    _heard(mono) {
      let at = 0;
      while (at < mono.length) {
        const take = Math.min(mono.length - at, HEARD_BATCH - this.heardCount);
        this.heard.set(mono.subarray(at, at + take), this.heardCount);
        this.heardCount += take;
        at += take;
        if (this.heardCount === HEARD_BATCH) {
          const full = this.heard;
          this.port.postMessage({ type: "heard", samples: full }, [full.buffer]);
          this.heard = new Float32Array(HEARD_BATCH);
          this.heardCount = 0;
        }
      }
    }

    process(inputs, outputs) {
      const input = inputs[0];
      const output = outputs[0];
      const frames = output[0].length;
      if (input && input.length && !this.paused) {
        const left = input[0];
        const right = input.length > 1 ? input[1] : input[0];
        for (const [, result] of this.filter.push([left, right])) {
          for (let i = 0; i < result[0].length && this.queueLength < QUEUE; i++) {
            const slot = (this.queueStart + this.queueLength) % QUEUE;
            this.queue[0][slot] = result[0][i];
            this.queue[1][slot] = result[1][i];
            this.queueLength++;
          }
        }
      }
      const ready = Math.min(frames, this.queueLength);
      for (let ch = 0; ch < output.length; ch++) {
        const from = this.queue[Math.min(ch, 1)];
        const out = output[ch];
        out.fill(0);
        for (let i = 0; i < ready; i++) out[i] = from[(this.queueStart + i) % QUEUE];
      }
      this.queueStart = (this.queueStart + ready) % QUEUE;
      this.queueLength -= ready;
      return true;
    }
  }
  registerProcessor("mor-filter", MorFilter);
}

if (typeof module !== "undefined") {
  module.exports = { Canceller, Filter, Playing, FFT, WINDOW, NORM, RATE, SIZE, HOP, DELAY, JUMP, HEARD_BATCH };
}
