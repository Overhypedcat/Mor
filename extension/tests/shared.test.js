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
  s = Mor.applyStatus(s, "step Removing A - B", 1000);
  assert.strictEqual(s.step, "Removing A - B");
  assert.strictEqual(Mor.applyStatus(s, "garbage", 0), s);
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

test("what the player's row says and shows", () => {
  const filter = { state: "listening", problem: null, step: null, retryAt: 0 };
  assert.deepStrictEqual(Mor.rowText(false, filter, null), { text: "Off", problem: false });
  assert.deepStrictEqual(Mor.rowText(true, filter, null), { text: "Listening for music", problem: false });
  assert.deepStrictEqual(Mor.rowText(true, { ...filter, state: "filtering" }, null), { text: "Removing the song", problem: false });
  assert.deepStrictEqual(Mor.rowText(true, { ...filter, step: "Getting A - B" }, null), { text: "Getting A - B", problem: false });
  assert.deepStrictEqual(Mor.rowText(true, { ...filter, step: "x", problem: "Shazam is down" }, null), { text: "Shazam is down", problem: true });
  assert.deepStrictEqual(Mor.rowText(true, filter, "Click the stream once"), { text: "Click the stream once", problem: true });
  assert.strictEqual(Mor.rowState(false, filter, null), null);
  assert.strictEqual(Mor.rowState(true, filter, null), "listening");
  assert.strictEqual(Mor.rowState(true, { ...filter, state: "filtering" }, null), "filtering");
  assert.strictEqual(Mor.rowState(true, { ...filter, state: "filtering", problem: "p" }, null), "problem");
});

test("the listening dots step, only while listening; the retry counts down", () => {
  assert.deepStrictEqual([0, 300, 600, 900].map((t) => Mor.musicPhase("listening", t)), [0, 1, 2, 0]);
  assert.strictEqual(Mor.musicPhase("filtering", 300), null);
  assert.strictEqual(Mor.musicPhase(null, 300), null);
  assert.strictEqual(Mor.retryWait({ retryAt: 10500 }, 1000), 10);
  assert.strictEqual(Mor.retryWait({ retryAt: 500 }, 1000), 0);
  assert.strictEqual(Mor.retryWait({}, 1000), 0);
});

test("an older helper than the extension is noticed", () => {
  assert.strictEqual(Mor.helperOutdated("0.1.2", "0.1.3"), true);
  assert.strictEqual(Mor.helperOutdated("0.1.2", "0.1.10"), true); // by number, not by text
  assert.strictEqual(Mor.helperOutdated("0.1.3", "0.1.3"), false);
  assert.strictEqual(Mor.helperOutdated("0.2.0", "0.1.9"), false);
  assert.strictEqual(Mor.helperOutdated(null, "0.1.3"), false); // not running yet: nothing to say
});
