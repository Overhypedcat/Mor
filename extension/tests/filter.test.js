// The tab's music filter against the helper's Python one (fixtures/filter.bin, made by make_filter_fixture.py):
// the same stream and song through every case the Filter tells apart must come out the same.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { Canceller, Filter, Playing, FFT, HOP, DELAY, SIZE } = require("../audio/filter-worklet.js");

const SONGS = { 1: ["k1", "Title", "Artist"], 2: ["k2", "Other", "Artist"] };

function readFixture() {
  const buf = fs.readFileSync(path.join(__dirname, "fixtures", "filter.bin"));
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let at = 0;
  const int = () => { const v = view.getInt32(at, true); at += 4; return v; };
  const n = int(), songLength = int(), pieces = int();
  const timeline = [];
  for (let i = 0; i < pieces; i++) timeline.push({ at: int(), song: int(), offset: int(), round: int() });
  const floats = (count) => {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) { out[i] = view.getFloat32(at, true); at += 4; }
    return out;
  };
  const stream = [floats(n), floats(n)];
  const shorts = (count) => {
    const out = new Int16Array(count);
    for (let i = 0; i < count; i++) { out[i] = view.getInt16(at, true); at += 2; }
    return out;
  };
  const song = { left: shorts(songLength), right: shorts(songLength) };
  const outLength = int();
  const expected = [floats(outLength), floats(outLength)];
  return { n, timeline, stream, song, expected };
}

test("the port takes the song out exactly as the Python filter does", () => {
  const { n, timeline, stream, song, expected } = readFixture();
  const heard = [];
  const filter = new Filter((mono) => heard.push(mono.length), () => assert.fail("broke"));
  const got = [[], []];
  let seq = 0;
  for (let start = 0; start < n; start += 128) {
    for (const piece of timeline) {
      if (piece.at !== start) continue;
      if (piece.song < 0) filter.wanted = null;
      else {
        const [key, title, artist] = SONGS[piece.song];
        filter.wanted = new Playing(++seq, { key, title, artist, offset: piece.offset, round: piece.round }, song);
      }
    }
    for (const [, result] of filter.push([stream[0].subarray(start, start + 128), stream[1].subarray(start, start + 128)])) {
      got[0].push(...result[0]); got[1].push(...result[1]);
    }
  }
  assert.strictEqual(got[0].length, expected[0].length);
  let worst = 0, energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    for (let i = 0; i < got[ch].length; i++) {
      worst = Math.max(worst, Math.abs(got[ch][i] - expected[ch][i]));
      energy = Math.max(energy, Math.abs(expected[ch][i]));
    }
  }
  assert.ok(worst < 1e-4 * Math.max(energy, 1), `largest difference ${worst} (peak ${energy})`);
  assert.strictEqual(heard.reduce((a, b) => a + b, 0), n); // every sample went to the helper
});

test("the song is mostly gone once the cancellers have learned it", () => {
  const { n, stream, expected } = readFixture();
  // the fixture's song plays from HOP*20 on: after learning, what's left is far quieter than the stream
  const from = HOP * 100, to = HOP * 115;
  let inPower = 0, outPower = 0;
  for (let i = from; i < to; i++) {
    inPower += stream[0][i] ** 2;
    outPower += expected[0][i + DELAY] ** 2;
  }
  assert.ok(outPower < inPower * 0.1, `left ${outPower / inPower} of the stream's power`);
  assert.ok(n > to);
});

test("without a song the sound goes through, DELAY behind", () => {
  const c = new Canceller();
  const input = Float32Array.from({ length: HOP * 8 }, (_, i) => Math.sin(i / 7) * 0.5);
  const out = [];
  for (let i = 0; i < 8; i++) out.push(...c.process(input.subarray(i * HOP, (i + 1) * HOP)));
  for (let i = SIZE; i < out.length; i++) assert.ok(Math.abs(out[i] - input[i - DELAY]) < 1e-5);
});

test("the FFT and its inverse give back the samples", () => {
  const x = Float64Array.from({ length: SIZE }, (_, i) => Math.cos(i * 0.37) + (i % 5) * 0.1);
  const re = new Float64Array(SIZE / 2 + 1), im = new Float64Array(SIZE / 2 + 1), back = new Float64Array(SIZE);
  FFT.rfft(x, re, im);
  let dc = 0;
  for (const v of x) dc += v;
  assert.ok(Math.abs(re[0] - dc) < 1e-9);
  FFT.irfft(re, im, back);
  for (let i = 0; i < SIZE; i++) assert.ok(Math.abs(back[i] - x[i]) < 1e-9);
});

test("a song's slice: its sound under the stream, nothing before or after", () => {
  const copy = { left: Int16Array.from([16384, -16384, 0, 8192]), right: Int16Array.from([1, 2, 3, 4]) };
  const p = new Playing(1, { key: "k", title: "t", artist: "a", offset: 1, round: 0 }, copy);
  assert.deepStrictEqual(Array.from(p.slice(0, 2)[0]), [-0.5, 0]);
  assert.deepStrictEqual(Array.from(p.slice(2, 3)[0]), [0.25, 0, 0]);
  assert.strictEqual(p.slice(3, 2), null);
  assert.strictEqual(p.slice(-5, 2), null);
});

test("a filter that breaks lets the sound through, still in step", () => {
  const problems = [];
  const filter = new Filter(() => {}, (text) => problems.push(text));
  filter.cancellers[0].process = () => { throw new Error("boom"); };
  const block = Float32Array.from({ length: HOP }, (_, i) => i / HOP);
  const outs = [];
  for (let i = 0; i < 6; i++) outs.push(...filter.push([block, block]).map(([, r]) => r[0]));
  assert.strictEqual(problems.length, 1);
  assert.match(problems[0], /broke, the sound plays unfiltered: Error: boom/);
  const flat = outs.flatMap((o) => Array.from(o));
  for (let i = DELAY; i < flat.length; i++) assert.ok(Math.abs(flat[i] - block[(i - DELAY) % HOP]) < 1e-7);
});
