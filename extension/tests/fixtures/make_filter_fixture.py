"""Makes filter.bin: a stream with a song in it, run through the helper's Python Filter (the reference), for
filter.test.js to check the tab's port against. Run with the helper's Python after changing the filter:

    helper\\.venv\\Scripts\\python extension\\tests\\fixtures\\make_filter_fixture.py

The song goes through each case the Filter tells apart: none yet, a new song, a small move (followed without a
restart), a jump (restart, the shape kept), a retry (new round: from nothing), and none again.
Layout (little-endian): int32 count, then per piece of the timeline its header and samples; see filter.test.js.
"""
import struct
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "helper"))
from mor_helper.musicfilter import relay  # noqa: E402
from mor_helper.musicfilter.canceller import HOP  # noqa: E402
from mor_helper.musicfilter.songs import Song  # noqa: E402

RATE = 48000
SECONDS = 4
rng = np.random.default_rng(7)
n = SECONDS * RATE
song = (rng.standard_normal((2, n + RATE)) * 6000).clip(-32768, 32767).astype(np.int16)
voice = (rng.standard_normal((2, n)) * 0.05).astype(np.float32)
t = np.arange(n) / RATE
gain = (0.6 + 0.3 * np.sin(2 * np.pi * 0.5 * t)).astype(np.float32)
heard_song = np.zeros((2, n), np.float32)
heard_song[:, 3:] = song[:, :n - 3] / 32768.0  # a little delay, as the streamer's setup has
stream = (heard_song * gain + voice).astype(np.float32)

key = Song("k1", "Title", "Artist")
other = Song("k2", "Other", "Artist")
# (from stream sample, playing info or None)
timeline = [
    (0, None),
    (HOP * 20, (key, 0, 0)),
    (HOP * 120, (key, 100, 0)),  # moved a little: no restart
    (HOP * 180, (key, 4000, 0)),  # a jump: restart, shape kept
    (HOP * 250, (key, 4000, 1)),  # a retry: from nothing
    (HOP * 300, (other, 4000, 1)),  # another song
    (HOP * 340, None),
]


class Tracker:
    playing = None


tracker = Tracker()
filt = relay.Filter(relay.Heard(), tracker, lambda *a, **k: None)
outputs = []
CHUNK = 128
for start in range(0, n, CHUNK):
    for at, info in timeline:
        if at == start:
            if info is None:
                tracker.playing = None
            else:
                s, offset, round_ = info
                tracker.playing = relay.Playing(s, song, None, offset, "vid", round_)
    for index, result in filt.push(stream[:, start:start + CHUNK]):
        outputs.append(result)
out = np.concatenate(outputs, axis=1).astype(np.float32)

with open(Path(__file__).with_name("filter.bin"), "wb") as f:
    f.write(struct.pack("<iii", n, song.shape[1], len(timeline)))
    for at, info in timeline:
        if info is None:
            f.write(struct.pack("<iiii", at, -1, 0, 0))
        else:
            s, offset, round_ = info
            f.write(struct.pack("<iiii", at, int(s.key[1:]), offset, round_))
    f.write(stream.astype("<f4").tobytes())
    f.write(song.astype("<i2").tobytes())
    f.write(struct.pack("<i", out.shape[1]))
    f.write(out.astype("<f4").tobytes())
print("filter.bin:", out.shape, "max", float(np.abs(out).max()))
