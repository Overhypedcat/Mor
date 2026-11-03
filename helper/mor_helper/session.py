"""One tab's music filter on the helper's side: the stream's sound comes in (heard), the Tracker works out the song
and its place, and the tab gets back the song's copy and each new place (Playing), plus everything the filter tells
(status lines, see musicfilter/status.py).

The tab subtracts; this side never holds up the sound.
"""
import base64
import logging
import threading
import time

import numpy as np

from mor_helper.musicfilter import relay, songs, status

CHUNK = 512 * 1024  # bytes of a song's copy per message: native messages to Firefox stay under 1 MB
WATCH_S = 0.01  # how often the Tracker's .playing is looked at, to tell the tab as soon as it changes
log = logging.getLogger("mor.filter")


def _log_alignment():
    """Each try at lining a copy up with the stream, with how sure it was against what counts (align.SURE, or
    STILL_SURE when following a song), in the log: the reason a copy didn't line up. The results are untouched."""
    align = relay.align
    if getattr(align.find, "logged", False):
        return
    find, still = align.find, align.still

    def logged_find(stream, song, reduced_song=None, expected=None):
        at, score = find(stream, song, reduced_song, expected)
        log.info("lining up: %s (sure %.1f, %.1f counts)", "found" if at is not None else "not found", score,
                 align.SURE)
        return at, score

    def logged_still(stream, song, reduced_song, expected, reach=align.REACH):
        at, score = still(stream, song, reduced_song, expected, reach)
        if at is None:
            log.info("following: not where it was (sure %.1f, %.1f counts)", score, align.STILL_SURE)
        return at, score

    logged_find.logged = True
    align.find, align.still = logged_find, logged_still


_log_alignment()


class FilterSession:
    def __init__(self, sid, send, budget, library=None, tracker_factory=relay.Tracker, clock=time.monotonic):
        """send(message dict) goes to the extension; budget is Shazam's, shared by every tab (one connection)."""
        self.sid, self.send = sid, send
        self.heard = relay.Heard()
        self.teller = status.Server(self._tell)
        self.tracker = tracker_factory(self.heard, library or songs.Library(), self.teller.set, self.teller.report,
                                       on_ready=self.teller.ready, on_step=self.teller.step, clock=clock)
        self.tracker.budget = budget
        self._log_copies()
        self.stopped = threading.Event()
        self.sent_copy = None  # the YouTube id of the copy the tab holds
        self.told = None  # the Playing the tab was last told
        self.seq = 0

    def _tell(self, text):
        """A status line to the tab, and (but Shazam's countdown) to the log: what the filter did, step by step."""
        if not text.startswith(status.READY):
            log.info("%s %s", self.sid, text)
        self.send({"type": "status", "sid": self.sid, "line": text})

    def _log_copies(self):
        """Which YouTube copy each try fetched and lined up, in the log (the Tracker's own steps name only the song)."""
        copy = getattr(self.tracker, "_copy", None)
        if copy is None:
            return

        def logged(video_id):
            log.info("%s trying YouTube copy %s", self.sid, video_id)
            return copy(video_id)
        self.tracker._copy = logged

    def start(self):
        log.info("%s filter started", self.sid)
        self.teller.tell(status.line(status.LISTENING))
        self.tracker._tell_ready()  # the tab knows from the start whether a retry can go
        threading.Thread(target=self._think, daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()

    def stop(self):
        log.info("%s filter stopped", self.sid)
        self.stopped.set()

    def hear(self, data):
        """Mono float32 samples from the tab, base64: every sample the tab's filter took in, in order."""
        self.heard.add(np.frombuffer(base64.b64decode(data), "<f4"))

    def retry(self):
        self.tracker.retry_soon()

    def broken(self, text):
        """The tab's filter broke (the sound goes through unfiltered from now on): said, and it stays said."""
        self.teller.report(text, lasting=True)

    def _think(self):
        """relay.Tracker.run, until the tab is gone."""
        try:
            relay._warm_up()
        except songs.Problem as problem:
            self.teller.report(str(problem), lasting=True)
            return
        while not self.stopped.is_set():
            self.tracker.look()
            time.sleep(0.2)

    def _watch(self):
        while not self.stopped.is_set():
            self.tell_playing()
            time.sleep(WATCH_S)

    def tell_playing(self):
        """Tell the tab when the Tracker's Playing changed: the copy first when the tab hasn't got it."""
        playing = self.tracker.playing
        if playing is self.told:
            return
        self.told = playing
        if playing is not None and playing.video_id != self.sent_copy:
            self.send_copy(playing.video_id or "", playing.sound)
            self.sent_copy = playing.video_id
        self.seq += 1
        if playing is None:
            log.info("%s nothing to take out", self.sid)
        else:
            log.info("%s taking out %s (copy %s, song sample %d at stream sample 0, round %d)", self.sid,
                     playing.song, playing.video_id, playing.offset, playing.round)
        message = {"type": "playing", "sid": self.sid, "seq": self.seq, "playing": None}
        if playing is not None:
            message["playing"] = {"key": playing.song.key, "title": playing.song.title, "artist": playing.song.artist,
                                  "copy": playing.video_id or "", "offset": int(playing.offset),
                                  "round": playing.round}
        self.send(message)

    def send_copy(self, video_id, sound):
        """A song's 16-bit stereo copy (2, n), left channel then right, in pieces."""
        data = np.ascontiguousarray(sound, "<i2").tobytes()
        parts = max(1, -(-len(data) // CHUNK))
        for i in range(parts):
            self.send({"type": "copy", "sid": self.sid, "copy": video_id, "part": i, "parts": parts,
                       "length": int(sound.shape[1]),
                       "data": base64.b64encode(data[i * CHUNK:(i + 1) * CHUNK]).decode("ascii")})
