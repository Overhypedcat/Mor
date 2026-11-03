"""The music filter's thinking, for Mor: what song a Twitch tab is playing and where in it the stream is (Tracker).

The sound never passes through here: the tab's AudioWorklet takes the song out (extension/audio/filter.js, a line-for-line port of Filter
and the Canceller below), sends the stream's sound here (Heard), and gets back the song's copy and its place
(Playing) as the Tracker finds them. Filter stays here as the reference that port is tested against.
"""
import math
import threading
import time

import numpy as np

from mor_helper.musicfilter import align, songs, status
from mor_helper.musicfilter.canceller import DELAY, HOP, Canceller

RATE = 48000
HEARD_S = 12  # seconds of the stream kept for recognizing and lining up
MATCH_S = 8  # seconds of the stream a song's copy is first lined up with: sure of the place before taking it out
FOLLOW_S = 4  # seconds checked against the song while it's taken out: short, so a song change shows quickly
ASK_S = 10  # seconds Shazam hears, sent in one request: many songs start quietly, and a short stretch of that
# silence is a request spent for nothing (it was 5 s until 2026-10-31)
CHECK_S = 4  # how often the song's place is checked while it's being taken out
LOST = 6  # checks in a row (about 24 s) without finding the song where it should be: it has stopped
SHAZAM_ON_MISSES = (2, 4)  # which of those checks ask Shazam what's playing, when the song can't be found anywhere
# in its copy either (so another song likely plays: its answer is switched to at once, no second request): the 2nd,
# some 8 s after it went missing, so most of what Shazam hears is the new song; the 4th once more, all of it new.
# Everything else is worked out from the copy, without a request
# until then it's still taken out: a moment of not hearing it well (a shout over it, a quiet part) is no reason to
# let it through, and taking out a song that has stopped costs nothing (its volume goes to nothing)
# while no song is being taken out, Shazam is asked again as soon as it would hear only new sound (listen_wait), its
# budget allowing (2 at once, then one each BUDGET_EVERY_S), so a song starting is named within seconds. No easing
# off while nothing plays: with no music the filter is switched off. (Before 2026-10-31 it eased off, 6, 10, 15,
# 20, 25 then 30 s.)
NOTHING_RUN = 2  # answers in a row without a song (some 20 s of sound): no music now, so Shazam rests a while...
NOTHING_REST_S = 60  # ...this long, instead of spending its budget on talking (songs heard before are still looked
# for meanwhile, without a request; the retry button wakes it)
NEXT_SONG_WAIT_S = 5  # once a song is over (or let go), this long before Shazam is asked what's next: a gap between
# songs, the next one's quiet start
LISTEN_S = 6  # a song named but not taken out yet (no copy lined up, a download failed): tried again this soon
KNOWN_S = 10  # how often the stream is looked for among the songs heard before, while none is taken out (no request)
KNOWN_MAX = 60  # the latest songs heard before that are looked through (about 3 s for all of them)
# how often Shazam is asked while a song with no usable copy plays: there's nothing to follow it with, so this is
# how soon a skip to another song is noticed (a wait for its length would miss a skip until then)
UNUSABLE_S = 20
# Shazam's own limit, measured from a home connection (2026-10-30, again 2026-10-31 over 300 requests; it's published
# nowhere, and it answers a plain 429 with no say of how long to wait): 2 requests at once, the 3rd refused; after
# that about 3.5 a minute however fast it's asked (one each 10 s, 5 s, 3 s or 1.5 s all got 3.5 to 4 a minute
# through). A short refusal is over in 40 to 90 s, but a hundred requests into it kept it refusing 8 to 14 minutes.
# So all of the filter's requests share one budget just under that (a refusal costs a minute and more)...
BUDGET = 2  # requests at once
BUDGET_EVERY_S = 20  # one more each this long: 3 a minute
# ...and when it refuses anyway, it's left alone this long, doubling each time it still does, up to LIMITED_MAX_S
LIMITED_S = 60
LIMITED_MAX_S = 240
JUMP = HOP  # the song's place moving by more than this: the cancellers start over there (keeping the shape)
# the song's place found a few samples off from where it was is no move: lining up wavers that much with the voice
# over it, and the shape already covers such a little delay; following each would cost the shape its fine tuning
WAVER = align.REACH
RETRIES = 2  # a song Shazam named that couldn't be taken out yet (no copy lined up, or none could be had) is tried
# again this many times without asking Shazam again: a first try can fail on talking over it, or a download


class Mono:
    """A 16-bit stereo sound read as mono floats, a slice at a time (the whole song as floats is a lot of memory)."""

    def __init__(self, sound):
        self.sound = sound

    def __len__(self):
        return self.sound.shape[1]

    def __getitem__(self, part):
        return self.sound[:, part].mean(0, dtype=np.float32) / 32768.0


def listen_wait(tries):
    """Seconds until Shazam is asked again, after this many answers in a row without a song: as soon as it would
    hear only new sound, however many came before (see LISTEN_S)."""
    return ASK_S


class Budget:
    """How many Shazam requests may go out now: BUDGET at once, one more every BUDGET_EVERY_S."""

    def __init__(self, clock, size=BUDGET, every=BUDGET_EVERY_S):
        self.clock, self.size, self.every = clock, size, every
        self.left = float(size)
        self.at = clock()

    def _refill(self):
        now = self.clock()
        self.left = min(self.size, self.left + (now - self.at) / self.every)
        self.at = now

    def wait(self):
        """Seconds until a request may go out (0: now)."""
        self._refill()
        return 0.0 if self.left >= 1 - 1e-6 else (1 - self.left) * self.every  # (a hair short is rounding)

    def take(self):
        self._refill()
        self.left -= 1


class Playing:
    """A song being taken out: its sound (16-bit stereo), and the song sample at stream sample 0 (offset); which
    YouTube copy that is (video_id), and which retry it came from (round: the cancellers start afresh for a new one)."""

    def __init__(self, song, sound, reduced, offset, video_id=None, round=0):
        self.song, self.sound, self.reduced, self.offset = song, sound, reduced, offset
        self.video_id, self.round = video_id, round

    def moved_to(self, offset):
        """The same song from the same copy, at another place."""
        return Playing(self.song, self.sound, self.reduced, offset, self.video_id, self.round)

    def slice(self, start, length):
        """The song's sound under these stream samples, shape (2, length) floats; None once it's over or before it
        starts."""
        at = start + self.offset
        if at + length <= 0 or at >= self.sound.shape[1]:
            return None
        out = np.zeros((2, length), np.float32)
        lo, hi = max(at, 0), min(at + length, self.sound.shape[1])
        out[:, lo - at: hi - at] = self.sound[:, lo:hi] / 32768.0
        return out


class Heard:
    """The latest HEARD_S seconds of the stream, mono, and how many samples came before them."""

    def __init__(self, seconds=HEARD_S, rate=RATE):
        self.buffer = np.zeros(seconds * rate, np.float32)  # a ring: sample i sits at i % its length
        self.total = 0
        self.lock = threading.Lock()

    def add(self, mono):
        with self.lock:
            size = len(self.buffer)
            self.total += len(mono)
            mono = mono[-size:]  # only the newest fit
            at = (self.total - len(mono)) % size
            first = min(len(mono), size - at)
            self.buffer[at: at + first] = mono[:first]
            self.buffer[: len(mono) - first] = mono[first:]

    def latest(self, length):
        """(the latest length samples, the stream index of the first), or (None, 0) when not that many came yet."""
        with self.lock:
            if self.total < length or length > len(self.buffer):
                return None, 0
            start = self.total - length
            return np.roll(self.buffer, -(self.total % len(self.buffer)))[-length:].copy(), start


class Tracker:
    """Works out what's playing and where, from what was heard; the main loop reads .playing as it goes. on_state
    hears LISTENING or FILTERING, on_problem what went wrong."""

    def __init__(self, heard, library, on_state, on_problem, recognize=songs.recognize, load=songs.load,
                 clock=time.monotonic, on_ready=None, on_step=None):
        self.heard, self.library, self.on_state, self.on_problem = heard, library, on_state, on_problem
        self.on_ready = on_ready or (lambda seconds: None)  # hears the seconds until Shazam may be asked again
        self.on_step = on_step or (lambda text: None)  # hears what it's doing just now, for the app's box
        self.retry_wanted = False  # the app's retry button: handled at the next look (set from another thread)
        self.round = 0  # retries so far: each has the cancellers start afresh
        self.avoid = None  # (song key, video id) of a copy a retry gave up on: tried last, if no other lines up
        self.recognize, self.load, self.clock = recognize, load, clock
        self.playing = None
        self.misses = 0
        self.tries = 0
        self.next_at = 0.0
        self.unusable = {}  # song key -> why it can't be taken out: not looked for again, told again
        self.limited = 0  # times in a row Shazam said there are too many requests
        self.shazam_after = 0.0  # Shazam refused: it's left alone until then (the rest goes on)
        self.refused = False  # its refusal is being told: taken back once Shazam may be asked again
        self.budget = Budget(clock)
        self.retry = None  # (song, tries left): a song named, to be tried again without asking Shazam
        self.ask_at = 0.0  # when Shazam is next asked while no song is taken out (the looks in between are local)
        self.mismatched = set()  # songs whose copies didn't line up once: a second time, they're given up on
        self.loaded = {}  # video id -> (sound, reduced), for a song that comes back
        self.asked_from = 0  # the stream sample the sound Shazam was last asked about began at
        # video id -> how far its copy runs from Shazam's (samples): a copy with a longer intro is ahead all along
        self.shifts = {}

    def step(self):
        """One look, when it's due; called over and over by run(). A retry asked for comes first."""
        if self.refused and self.clock() >= self.shazam_after:
            self.refused = False
            self.on_problem(None)  # its wait is over: the refusal isn't told any more, whatever comes next
        if self.retry_wanted:
            self.retry_wanted = False
            self._retry()
            return
        if self.clock() < self.next_at:
            return
        if self.playing:
            self._check()
        else:
            self._listen()

    def run(self):
        _warm_up()
        while True:
            self.look()
            time.sleep(0.2)

    def look(self):
        """A step, with whatever goes wrong in it told rather than ending the filter."""
        try:
            self.step()
        except songs.RateLimited as problem:  # asking sooner would only keep it going
            wait = min(LIMITED_S * 2 ** self.limited, LIMITED_MAX_S)
            self.limited += 1
            self.shazam_after = self.clock() + wait  # only Shazam waits: following the song goes on
            self.refused = True
            self.on_problem(f"{problem}, asking again in {wait} s")
            self._tell_ready()
        except songs.Problem as problem:  # Shazam or YouTube couldn't be reached: the next look tries again
            self.on_problem(str(problem))
        except Exception as error:  # never the stream's end, but always said
            self.on_problem(f"The music filter ran into an error: {type(error).__name__}: {songs.reason(error)}")
            self.next_at = self.clock() + LISTEN_S

    def _check(self):
        """Is the song still where it's thought to be? Follows it when it moved; lets go when it's gone."""
        self.next_at = self.clock() + CHECK_S
        sound, start = self.heard.latest(FOLLOW_S * RATE)
        playing = self.playing
        if sound is not None and start + playing.offset >= playing.sound.shape[1]:
            self._set(None)  # the song is over: listen for the next one right away
            self._listen()
            return
        at = None
        if sound is not None:
            at, _ = align.still(sound, Mono(playing.sound), playing.reduced, start + playing.offset)
        if at is None:
            self.misses += 1
            self.on_step(f"Lost {playing.song}, looking for it")
            if self.misses >= LOST:
                self._set(None)
                return
            if sound is not None:  # the same song somewhere else (skipped, arranged differently)? Or another?
                self._ask_again(playing)
            return
        if self.misses:
            self.on_step(f"Removing {playing.song}")  # found again
        self.misses = 0
        if self.clock() >= self.shazam_after:
            self.on_problem(None)  # the song is where it should be: all is well (but Shazam's refusal still holds)
        if abs(at - start - playing.offset) > WAVER:
            self.playing = playing.moved_to(at - start)

    def retry_soon(self):
        """The app's retry button (from the status server's thread): at the next look, forget the song and ask
        Shazam afresh."""
        self.retry_wanted = True

    def _retry(self):
        """Start it all over (the filter didn't take the song out): ask Shazam afresh (never the songs heard before,
        which may be what went wrong), try the song's other copies before the one that was in use (it lined up but
        didn't take the song out: another version, or mastered differently), read the copy again, and have the
        cancellers start from nothing, what they learned of the stream's EQ and delay too. Within Shazam's budget,
        shared with everything else the filter asks: out of it, says how long until it's back and leaves the song
        be."""
        wait = self._shazam_wait()
        if wait > 0:
            self.on_problem(f"Shazam can be asked again in {math.ceil(wait)} s")
            self._tell_ready()
            return
        playing = self.playing
        self.avoid = (playing.song.key, playing.video_id) if playing and playing.video_id else None
        self.round += 1
        self.loaded = {}
        self.unusable.clear()
        self.mismatched.clear()
        self.shifts.clear()
        self.on_step("Retrying from the start")
        self._set(None, wait=0)
        self._listen(fresh=True)

    def _copies(self, song):
        """The song's YouTube copies to try, the one a retry gave up on last."""
        avoided = self.avoid[1] if self.avoid and self.avoid[0] == song.key else None
        later = []
        try:
            for video_id in self.library.candidates(song):
                if video_id == avoided:
                    later.append(video_id)
                else:
                    yield video_id
        except songs.Problem:
            if not later:
                raise
        yield from later

    def _take(self):
        """A request to Shazam is going out: taken from the budget, and the app told when the next may."""
        self.budget.take()
        self._tell_ready()

    def _tell_ready(self):
        self.on_ready(math.ceil(self._shazam_wait()))

    def _shazam_wait(self):
        """Seconds until Shazam may be asked: its own refusal, or the budget."""
        return max(self.budget.wait(), self.shazam_after - self.clock(), 0.0)

    def _ask_again(self, playing):
        """While the song can't be found where it should be: look for it all over its copy first (the streamer
        skipped ahead, or plays a version arranged differently), and follow it there; only when it isn't anywhere in
        it, ask Shazam (a couple of times at most) and switch at once if it hears another song."""
        # only what was heard since it went missing: a longer stretch would still hold the song where it was
        heard, start = self.heard.latest(min(MATCH_S, FOLLOW_S * self.misses) * RATE)
        # (of places that sound alike, the one nearest where it was: a shout over a loop isn't a jump to its copy)
        at, _ = (align.find(heard, Mono(playing.sound), playing.reduced, expected=start + playing.offset)
                 if heard is not None else (None, 0))
        if at is not None:
            self.misses = 0
            self.playing = playing.moved_to(at - start)
            self.on_step(f"Removing {playing.song}")
            return
        if self.misses not in SHAZAM_ON_MISSES or self._shazam_wait():
            return  # (out of budget: the song is held on to meanwhile, and Shazam asked at a later miss)
        sound, self.asked_from = self.heard.latest(ASK_S * RATE)
        self._take()
        self.on_step("The song changed, asking Shazam what's on")
        song = self.recognize(sound)
        self.limited = 0
        if song and song != playing.song:
            self._set(None, wait=0)  # (Shazam just named the next one)
            self._listen(song)

    def _listen(self, song=None, fresh=False):
        """Ask Shazam (unless it just named the song); for a song it knows, find a copy that lines up with the
        stream. fresh: straight to Shazam, never a song tried before or heard before (a retry)."""
        sound, sound_from = self.heard.latest(ASK_S * RATE)
        if sound is None:  # not enough heard yet
            self.next_at = self.clock() + 1
            return
        now = self.clock()
        self.next_at = now + KNOWN_S
        if not song and self.retry and not fresh:  # named before and not done with: tried again, no request
            song, left = self.retry
            self.retry = (song, left - 1) if left > 1 else None
        if not song and not fresh:
            song = self._known()  # a song heard before: told without asking Shazam
        if not song:
            wait = max(self._shazam_wait(), self.ask_at - now)
            if wait > 0:
                self.next_at = now + min(wait, KNOWN_S)  # meanwhile still looked for among the songs heard before
                return
            self._take()
            self.ask_at = now + listen_wait(self.tries)
            self.next_at = min(self.next_at, self.ask_at)  # the next look: a local one, or Shazam's if sooner
            self.asked_from = sound_from
            self.on_step("Asking Shazam what's playing")
            song = self.recognize(sound)
            self.limited = 0  # Shazam answered
        if not song:
            self.tries += 1  # only an answer counts as a try: Shazam out of reach says nothing about the music
            if self.tries % NOTHING_RUN == 0:
                self.ask_at = self.clock() + NOTHING_REST_S
                self.on_step("No music found, resting a minute")
            else:
                self.on_step("Listening for music")
            self.on_problem(None)  # Shazam answered: whatever failed before works again
            return  # nothing Shazam knows playing: talking, or a song it hasn't got
        if song.key in self.unusable:
            self.on_problem(self.unusable[song.key])
            self.ask_at = self.clock() + UNUSABLE_S  # still that song: Shazam needn't be asked again so soon
            return
        compared, failed = False, None
        self.on_step(f"Finding {song} on YouTube")
        for video_id in self._copies(song):
            try:
                if video_id not in self.loaded:
                    self.on_step(f"Getting {song}")
                sound, reduced = self._copy(video_id)
            except songs.Problem as problem:
                failed = str(problem)  # this copy can't be had; another might
                continue
            compared = True
            self.on_step(f"Lining up {song}")
            heard, start = self.heard.latest(MATCH_S * RATE)
            if heard is None:
                heard, start = self.heard.latest(ASK_S * RATE)
            said = None  # where Shazam's place in the song puts this stretch (by Shazam's copy)
            if song.offset is not None:
                said = round(song.offset * RATE) + start - self.asked_from
            expected = None if said is None else said + self.shifts.get(video_id, 0)
            at, _ = align.find(heard, Mono(sound), reduced, expected=expected)
            if at is not None:
                if said is not None:
                    self.shifts[video_id] = at - said
                self.library.remember(song, video_id)
                self.avoid = None
                self._set(Playing(song, sound, reduced, at - start, video_id, self.round))
                return
        if compared and song.key not in self.mismatched:  # once could be talking over it: tried again
            self.mismatched.add(song.key)
            self._try_again(song)
            self.on_problem(f"YouTube's copy of {song} doesn't line up with the stream yet, trying again")
            return
        if compared:
            self.unusable[song.key] = f"YouTube has only other versions of {song} than the one playing"
        elif failed:  # not held against the song: it may download next time
            self._try_again(song)
            self.on_problem(f"Couldn't get {song} from YouTube: {failed}")
            return
        else:
            self.unusable[song.key] = f"{song} isn't on YouTube Music or YouTube"
        self.on_problem(self.unusable[song.key])
        self.ask_at = self.clock() + UNUSABLE_S

    def _known(self):
        """The song playing, if it's one heard before (by the prints of the copies kept), else None."""
        heard, _ = self.heard.latest(MATCH_S * RATE)
        before = self.library.heard_before()[:KNOWN_MAX]
        if heard is None or not before:
            return None
        prints = []
        for _, _, path in before:
            try:
                prints.append(np.load(path, mmap_mode="r"))
            except (OSError, ValueError):
                prints.append(np.zeros(0, np.float16))  # a broken print: passed over, made again with its copy
        found, _ = align.known(heard, prints)
        return before[found][0] if found is not None else None

    def _try_again(self, song):
        """Have the next look (soon) try this song again, without asking Shazam (unless it's been tried enough)."""
        if not (self.retry and self.retry[0] == song):
            self.retry = (song, RETRIES)
        self.next_at = self.clock() + LISTEN_S

    def _copy(self, video_id):
        """(16-bit stereo sound, its reduction for lining up) of a YouTube song; Problem when it can't be had."""
        if video_id not in self.loaded:
            path = self.library.fetch(video_id)
            try:
                sound = self.load(path)
            except songs.Problem:
                try:
                    path.unlink()  # a broken download: fetched afresh next time
                except OSError:
                    pass  # still told (the Problem goes on); it's tried again as it is
                raise
            reduced = align.reduce(Mono(sound)[:])
            self.loaded = {video_id: (sound, reduced)}  # one kept: memory
            self.library.keep_print(video_id, align.thin(reduced))
        return self.loaded[video_id]

    def _set(self, playing, wait=NEXT_SONG_WAIT_S):
        """The song being taken out now, or None; with None, Shazam is asked what's next after wait s."""
        had = self.playing is not None
        self.playing, self.misses, self.tries, self.retry = playing, 0, 0, None
        # a song just over: the next one is asked about after a moment (none before: at once)
        self.ask_at = self.clock() + wait if had and not playing else 0.0
        self.next_at = self.clock() + (CHECK_S if playing else 0)
        self.on_state(status.FILTERING if playing else status.LISTENING)
        self.on_step(f"Removing {playing.song}" if playing else "Listening for music")


def _warm_up():
    """Load what recognizing and fetching use before the first song comes, not while it plays (seconds of it)."""
    try:
        import shazamio  # noqa: F401
        import yt_dlp  # noqa: F401
    except ImportError as error:
        raise songs.Problem(f"The music filter is missing a part, set it up again: {songs.reason(error)}") from error


class Filter:
    """The stream's sound in, the same with the song taken out; DELAY samples behind (push() says which samples)."""

    def __init__(self, heard, tracker, on_problem):  # on_problem(text, lasting=...)
        self.heard, self.tracker, self.on_problem = heard, tracker, on_problem
        self.cancellers = [Canceller(RATE), Canceller(RATE)]
        self.pending = np.zeros((2, 0), np.float32)
        self.fed = 0  # stream samples handed to the cancellers so far
        self.playing = None  # the Playing the cancellers follow, to start over when it changes
        self.broken = False
        self.held = np.zeros((2, DELAY), np.float32)  # once broken: the sound held back as long as the filter did

    def push(self, sound):
        """Stereo float samples (2, n) in; [(stream index of the first sample, samples (2, HOP))] out."""
        self.heard.add(sound.mean(0))
        self.pending = np.concatenate([self.pending, sound], axis=1)
        out = []
        while self.pending.shape[1] >= HOP:
            block, self.pending = self.pending[:, :HOP], self.pending[:, HOP:]
            if not self.broken:
                song = self._song(self.fed)
                try:
                    result = np.stack([c.process(block[ch], None if song is None else song[ch])
                                       for ch, c in enumerate(self.cancellers)])
                except Exception as error:  # the filter must never stop the sound: from now on it goes through
                    self.broken = True
                    self.on_problem(f"The music filter broke, the sound plays unfiltered: {type(error).__name__}: "
                                    f"{songs.reason(error)}", lasting=True)
            if self.broken:  # still DELAY behind, so it stays in step with the picture
                joined = np.concatenate([self.held, block], axis=1)
                result, self.held = joined[:, :HOP], joined[:, HOP:]
            out.append((self.fed - DELAY, result))
            self.fed += HOP
        return out

    def _song(self, start):
        playing = self.tracker.playing
        if playing is not self.playing:
            if playing and self.playing and playing.round != self.playing.round:
                # a retry: from nothing, what they learned of the stream's EQ and delay too (it may be what failed)
                self.cancellers = [Canceller(RATE), Canceller(RATE)]
            elif (playing is None or self.playing is None or playing.song != self.playing.song
                  or abs(playing.offset - self.playing.offset) > JUMP):
                for c in self.cancellers:
                    c.restart()  # the streamer's EQ and delay they learned stay
            self.playing = playing
        return playing.slice(start, HOP) if playing else None
