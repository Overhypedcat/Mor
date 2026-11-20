const test = require("node:test");
const assert = require("node:assert");
global.btoa = (s) => Buffer.from(s, "binary").toString("base64");
global.atob = (s) => Buffer.from(s, "base64").toString("binary");
const Mor = require("../lib/shared.js");

// Twitch's playlists as they come (2026): each variant named on its own line
const MASTER = `#EXTM3U
#EXT-X-SESSION-DATA:DATA-ID="NODE",VALUE="x"
#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=2560x1440,CODECS="hvc1.1.6.L153.B0,mp4a.40.2",FRAME-RATE=60.000,STABLE-VARIANT-ID="1440p60",IVS-NAME="1440p60",IVS-VARIANT-SOURCE="source"
https://a/1440
#EXT-X-STREAM-INF:BANDWIDTH=8042999,RESOLUTION=1920x1080,CODECS="avc1.4D401F,mp4a.40.2",FRAME-RATE=60.000,STABLE-VARIANT-ID="1080p60",IVS-NAME="1080p60",IVS-VARIANT-SOURCE="transcode"
https://a/1080
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1080x1920,CODECS="avc1.4D401F,mp4a.40.2",FRAME-RATE=30.000,IVS-NAME="1080p30_portrait"
https://a/portrait
#EXT-X-STREAM-INF:BANDWIDTH=160000,CODECS="mp4a.40.2",STABLE-VARIANT-ID="audio_only",IVS-NAME="audio_only"
https://a/audio
`;

// the older kind: renditions named by EXT-X-MEDIA
const OLD = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60 (source)",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,VIDEO="chunked",FRAME-RATE=60.000
https://a/src
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,VIDEO="720p60",FRAME-RATE=60.000
https://a/720
#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360,FRAME-RATE=30.000
https://a/360
`;

test("qualities are read from Twitch's playlists, old and new", () => {
  assert.deepStrictEqual(Mor.qualities(MASTER), ["1440p60", "1080p60"]);
  assert.deepStrictEqual(Mor.qualities(OLD), ["1080p60", "720p60", "360p30"]);
  assert.deepStrictEqual(Mor.qualities(""), []);
  assert.deepStrictEqual(Mor.qualities(null), []);
});

test("the tunnel's playlist is used only when it offers more", () => {
  const direct = ["160p30", "720p60", "1080p60"];
  const unlocked = [...direct, "1440p60"];
  assert.deepStrictEqual(Mor.unlockedOnly(direct, unlocked), ["1440p60"]);
  assert.ok(Mor.needsVpn("best", direct, unlocked));
  assert.ok(!Mor.needsVpn("best", direct, direct));
  assert.ok(!Mor.needsVpn("best", direct, []));
  assert.ok(!Mor.needsVpn("1080p60", direct, unlocked));
  assert.ok(Mor.needsVpn("1440p60", direct, unlocked));
});

test("the channel of a usher request", () => {
  assert.strictEqual(Mor.usherChannel("https://usher.ttvnw.net/api/v2/channel/hls/OhnePixel.m3u8?acmb=1"), "ohnepixel");
  assert.strictEqual(Mor.usherChannel("https://usher.ttvnw.net/api/channel/hls/x_y.m3u8"), "x_y");
  assert.strictEqual(Mor.usherChannel("https://usher.ttvnw.net/vod/v2/123.m3u8"), null);
  assert.strictEqual(Mor.usherChannel("https://example.com/api/v2/channel/hls/x.m3u8"), null);
});

test("the channel a page shows live", () => {
  assert.strictEqual(Mor.pageChannel("https://www.twitch.tv/TheBausffs"), "thebausffs");
  assert.strictEqual(Mor.pageChannel("https://www.twitch.tv/thebausffs?sr=a"), "thebausffs");
  assert.strictEqual(Mor.pageChannel("https://www.twitch.tv/popout/thebausffs/chat"), "thebausffs");
  assert.strictEqual(Mor.pageChannel("https://www.twitch.tv/moderator/thebausffs"), "thebausffs");
  assert.strictEqual(Mor.pageChannel("https://player.twitch.tv/?channel=abc&parent=x"), "abc");
  for (const not of ["https://www.twitch.tv/", "https://www.twitch.tv/directory/category/music",
    "https://www.twitch.tv/videos/123", "https://www.twitch.tv/x/clip/abc", "https://www.twitch.tv/settings",
    "https://www.twitch.tv/x/videos", "https://example.com/thebausffs", "not a url"]) {
    assert.strictEqual(Mor.pageChannel(not), null, not);
  }
});

test("the music filter's status lines", () => {
  assert.deepStrictEqual(Mor.parseStatus("problem Shazam is down"), ["problem", "Shazam is down"]);
  assert.deepStrictEqual(Mor.parseStatus("filtering"), ["filtering", null]);
  assert.deepStrictEqual(Mor.parseStatus("ready 12"), ["ready", "12"]);
  assert.strictEqual(Mor.parseStatus("ready soon"), null);
  assert.deepStrictEqual(Mor.parseStatus("until step 60"), ["until", "step 60"]);
  assert.strictEqual(Mor.parseStatus("until later 60"), null);
  assert.strictEqual(Mor.parseStatus("problem"), null);
  assert.strictEqual(Mor.parseStatus("what"), null);
  let s = { state: "listening", problem: null, step: null, retryAt: 0 };
  s = Mor.applyStatus(s, "problem Shazam is down", 1000);
  assert.strictEqual(s.problem, "Shazam is down");
  s = Mor.applyStatus(s, "filtering", 1000);
  assert.strictEqual(s.state, "filtering");
  assert.strictEqual(s.problem, null); // working again
  s = Mor.applyStatus(s, "ready 5", 1000);
  assert.strictEqual(s.retryAt, 6000);
  s = Mor.applyStatus(s, "step Removing song", 1000);
  assert.strictEqual(s.step, "Removing song");
  assert.strictEqual(Mor.applyStatus(s, "garbage", 0), s);
  // countdowns: for the step or the problem just told, gone with the next one
  s = Mor.applyStatus(s, "step Resting", 1000);
  s = Mor.applyStatus(s, "until step 60", 1000);
  assert.strictEqual(s.stepUntil, 61000);
  s = Mor.applyStatus(s, "problem Shazam rate limit | too many requests", 2000);
  s = Mor.applyStatus(s, "until problem 30", 2000);
  assert.strictEqual(s.problemUntil, 32000);
  assert.strictEqual(s.stepUntil, 61000); // the step's still counts down underneath
  s = Mor.applyStatus(s, "step Asking Shazam", 3000);
  assert.strictEqual(s.stepUntil, 0);
  s = Mor.applyStatus(s, "fine", 3000);
  assert.strictEqual(s.problemUntil, 0);
});

test("base64 both ways, large buffers too", () => {
  const bytes = Uint8Array.from({ length: 200000 }, (_, i) => (i * 7) & 255);
  const back = Mor.fromBase64(Mor.toBase64(bytes));
  assert.deepStrictEqual(Buffer.from(back), Buffer.from(bytes));
});

test("server names", () => {
  assert.deepStrictEqual(Mor.serverLabel("wg-NL-FREE-102"), ["NL", "Netherlands · Free 102"]);
  assert.deepStrictEqual(Mor.serverLabel("my server"), ["", "my server"]);
});

test("what the music filter's text on the player says: a few words, in real time", () => {
  const filter = { state: "listening", problem: null, step: null, retryAt: 0, stepUntil: 0, problemUntil: 0 };
  const said = (f, audio = null, now = 1000) => Mor.rowText(true, { ...filter, ...f }, audio, now);
  assert.deepStrictEqual(Mor.rowText(false, filter, null), { text: "Off", problem: false, detail: null });
  assert.deepStrictEqual(said({}), { text: "Listening", problem: false, detail: null });
  assert.deepStrictEqual(said({ state: "filtering" }), { text: "Removing song", problem: false, detail: null });
  assert.deepStrictEqual(said({ step: "Downloading" }), { text: "Downloading", problem: false, detail: null });
  // a countdown: whole seconds left, then just the words once it's over
  assert.strictEqual(said({ step: "Resting", stepUntil: 53500 }).text, "Resting 53 s");
  assert.strictEqual(said({ step: "Resting", stepUntil: 53500 }, null, 60000).text, "Resting");
  // a problem: its few words in front, the whole story kept for the tooltip and the hub
  assert.deepStrictEqual(said({ step: "x", problem: "Shazam unreachable | Shazam couldn't be asked: timeout" }),
    { text: "Shazam unreachable", problem: true, detail: "Shazam couldn't be asked: timeout" });
  assert.strictEqual(said({ problem: "Shazam rate limit | too many", problemUntil: 31000 }).text, "Shazam rate limit 30 s");
  assert.deepStrictEqual(said({}, "Click the stream | Firefox lets Mor hear it after a click"),
    { text: "Click the stream", problem: true, detail: "Firefox lets Mor hear it after a click" });
  // an older helper's sentence, with no few words of its own, is shown as it is
  assert.deepStrictEqual(said({ problem: "Shazam is down" }), { text: "Shazam is down", problem: true, detail: null });
});

test("a problem's few words and its whole story", () => {
  assert.deepStrictEqual(Mor.splitProblem("Not on YouTube | A - B isn't on YouTube"), ["Not on YouTube", "A - B isn't on YouTube"]);
  assert.deepStrictEqual(Mor.splitProblem("Just this"), ["Just this", null]);
  assert.deepStrictEqual(Mor.splitProblem("A | b | c"), ["A", "b | c"]);
  assert.deepStrictEqual(Mor.splitProblem(null), ["", null]);
  assert.strictEqual(Mor.secondsLeft(0, 1000), 0);
  assert.strictEqual(Mor.secondsLeft(2001, 1000), 2);
  assert.strictEqual(Mor.secondsLeft(500, 1000), 0);
});


test("an older helper than the extension is noticed", () => {
  assert.strictEqual(Mor.helperOutdated("0.1.2", "0.1.3"), true);
  assert.strictEqual(Mor.helperOutdated("0.1.2", "0.1.10"), true); // by number, not by text
  assert.strictEqual(Mor.helperOutdated("0.1.3", "0.1.3"), false);
  assert.strictEqual(Mor.helperOutdated("0.2.0", "0.1.9"), false);
  assert.strictEqual(Mor.helperOutdated(null, "0.1.3"), false); // not running yet: nothing to say
});
