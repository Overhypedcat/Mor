import unittest
from unittest import mock

import numpy as np

from mor_helper.musicfilter import relay, songs, status
from mor_helper.musicfilter.canceller import DELAY, HOP
from mor_helper.musicfilter.songs import Song

RATE = relay.RATE


class HeardTests(unittest.TestCase):
    def test_latest_across_the_ring(self):
        heard = relay.Heard(seconds=1, rate=10)  # room for 10 samples
        heard.add(np.arange(7, dtype=np.float32))
        heard.add(np.arange(7, 13, dtype=np.float32))
        sound, start = heard.latest(5)
        self.assertEqual(sound.tolist(), [8, 9, 10, 11, 12])
        self.assertEqual(start, 8)

    def test_more_than_fits_at_once(self):
        heard = relay.Heard(seconds=1, rate=4)
        heard.add(np.arange(10, dtype=np.float32))
        self.assertEqual(heard.latest(4)[0].tolist(), [6, 7, 8, 9])
        self.assertEqual(heard.total, 10)

    def test_not_enough_yet(self):
        heard = relay.Heard(seconds=1, rate=10)
        heard.add(np.zeros(3, np.float32))
        self.assertEqual(heard.latest(5), (None, 0))


class PlayingTests(unittest.TestCase):
    def setUp(self):
        sound = np.tile(np.arange(10, dtype=np.int16) * 3276, (2, 1))  # 10 samples
        self.playing = relay.Playing(Song("k", "t", "a"), sound, None, offset=5)

    def test_the_song_under_the_stream(self):
        part = self.playing.slice(0, 3)  # stream 0..2 is song 5..7
        np.testing.assert_allclose(part[0], np.array([5, 6, 7]) * 3276 / 32768, rtol=1e-6)

    def test_silence_where_the_song_isnt(self):
        part = self.playing.slice(-7, 4)  # song -2..1: two samples before it starts
        np.testing.assert_allclose(part[0], np.array([0, 0, 0, 1]) * 3276 / 32768, rtol=1e-6)

    def test_none_once_its_over(self):
        self.assertIsNone(self.playing.slice(5, 3))
        self.assertIsNone(self.playing.slice(-20, 3))

    def test_mono_slices(self):
        mono = relay.Mono(np.array([[0, 32767], [32767, 32767]], np.int16))
        self.assertEqual(len(mono), 2)
        np.testing.assert_allclose(mono[:], [0.5, 1.0], atol=1e-4)


class BudgetTests(unittest.TestCase):
    def test_a_few_at_once_then_one_each_while(self):
        now = [0.0]
        budget = relay.Budget(lambda: now[0], size=3, every=20)
        for _ in range(3):
            self.assertEqual(budget.wait(), 0)
            budget.take()
        self.assertEqual(budget.wait(), 20)
        now[0] = 10
        self.assertEqual(budget.wait(), 10)
        now[0] = 20
        self.assertEqual(budget.wait(), 0)
        budget.take()
        now[0] = 40.0 - 1e-12  # due now, but for rounding
        self.assertEqual(budget.wait(), 0)
        now[0] = 1000  # a long while: back to 3 at once, never more
        for _ in range(3):
            budget.take()
        self.assertGreater(budget.wait(), 0)

    def test_stays_under_what_shazam_was_seen_to_refuse(self):
        # measured: 2 at once (the 3rd refused), then about 3.5 a minute however fast it's asked
        now = [0.0]
        budget = relay.Budget(lambda: now[0])
        sent = []
        while now[0] < 120:
            if not budget.wait():
                budget.take()
                sent.append(now[0])
            now[0] += 1
        self.assertEqual(len([t for t in sent if t < 3]), 2)  # never a 3rd at once (asked once a second here)
        for start in range(0, 61):
            self.assertLessEqual(len([t for t in sent if start <= t < start + 60]), 4)  # under 3.5 a minute after
        self.assertLessEqual(len(sent) - 2, 120 / 17.5)  # its sustained rate, over two minutes


class FakeTracker:
    playing = None


class FilterTests(unittest.TestCase):
    def setUp(self):
        self.problems = []

    def setUp(self):
        self.problems = []

    def test_without_a_song_the_sound_goes_through(self):
        tracker = FakeTracker()
        filt = relay.Filter(relay.Heard(), tracker, self.problems.append)
        sound = np.random.default_rng(0).normal(0, 0.1, (2, 10 * HOP)).astype(np.float32)
        out = filt.push(sound)
        self.assertEqual([index for index, _ in out], [i * HOP - DELAY for i in range(10)])
        joined = np.concatenate([part for _, part in out], axis=1)[:, DELAY:]
        np.testing.assert_allclose(joined, sound[:, : joined.shape[1]], atol=1e-4)
        self.assertEqual(filt.heard.total, 10 * HOP)

    def test_a_retry_starts_the_cancellers_from_nothing(self):
        tracker = FakeTracker()
        filt = relay.Filter(relay.Heard(), tracker, self.problems.append)
        song = np.zeros((2, RATE), np.int16)
        tracker.playing = relay.Playing(Song("a", "A", "x"), song, None, 0, "v1", round=0)
        filt.push(np.zeros((2, HOP), np.float32))
        learned = list(filt.cancellers)
        tracker.playing = tracker.playing.moved_to(5)  # the same song a few samples on: they keep going
        filt.push(np.zeros((2, HOP), np.float32))
        self.assertEqual(filt.cancellers, learned)
        tracker.playing = relay.Playing(Song("a", "A", "x"), song, None, 5, "v1", round=1)  # a retry
        filt.push(np.zeros((2, HOP), np.float32))
        self.assertTrue(all(new is not old for new, old in zip(filt.cancellers, learned)))  # new ones

    def test_a_new_song_starts_over_but_keeps_the_streamers_sound(self):
        tracker = FakeTracker()
        filt = relay.Filter(relay.Heard(), tracker, self.problems.append)
        song = np.zeros((2, RATE), np.int16)
        tracker.playing = relay.Playing(Song("a", "A", "x"), song, None, 0)
        filt.push(np.zeros((2, HOP), np.float32))
        filt.cancellers[0].volume = 3.0
        filt.cancellers[0].shape[5, 0] = 0.7  # what it learned of the streamer's EQ
        tracker.playing = relay.Playing(Song("a", "A", "x"), song, None, 10)  # same song, nudged: kept
        filt.push(np.zeros((2, HOP), np.float32))
        self.assertEqual(filt.cancellers[0].volume, 3.0)
        tracker.playing = relay.Playing(Song("b", "B", "x"), song, None, 10)
        filt.push(np.zeros((2, HOP), np.float32))
        self.assertEqual(filt.cancellers[0].volume, 1.0)  # the volume starts over...
        self.assertEqual(filt.cancellers[0].shape[5, 0], 0.7)  # ...the EQ stays

    def test_a_broken_filter_lets_the_sound_through_in_step(self):
        tracker = FakeTracker()
        filt = relay.Filter(relay.Heard(), tracker, lambda text, lasting=False: self.problems.append((text, lasting)))
        filt.cancellers[0].process = lambda *a: 1 / 0
        sound = np.random.default_rng(3).normal(0, 0.1, (2, 8 * HOP)).astype(np.float32)
        out = filt.push(sound)
        self.assertTrue(filt.broken)
        self.assertEqual(self.problems, [("The music filter broke, the sound plays unfiltered: ZeroDivisionError: "
                                          "division by zero", True)])  # said once, and it stays
        joined = np.concatenate([part for _, part in out], axis=1)
        self.assertEqual(out[0][0], -DELAY)
        np.testing.assert_array_equal(joined[:, DELAY:], sound[:, : joined.shape[1] - DELAY])


class FakeLibrary:
    def __init__(self, ids):
        self.ids = ids
        self.remembered = {}
        self.asked = 0
        self.before = []  # (Song, id, print path) of songs heard before
        self.prints = {}

    def candidates(self, song):
        self.asked += 1
        return iter(self.ids)

    def fetch(self, video_id):
        return video_id

    def remember(self, song, video_id):
        self.remembered[song.key] = video_id

    def heard_before(self):
        return self.before

    def keep_print(self, video_id, sound_print):
        self.prints[video_id] = sound_print


class TrackerTests(unittest.TestCase):
    def setUp(self):
        # these follow the pipeline with 5 s asked about (the sound fed below is cut to that); how much Shazam
        # hears, and the wait before the next song, have tests of their own (TimingTests)
        patch = mock.patch.object(relay, "ASK_S", 5)
        patch.start()
        self.addCleanup(patch.stop)
        rng = np.random.default_rng(5)
        self.song = (rng.normal(0, 0.2, (2, 40 * RATE)) * 32767 / 4).astype(np.int16)
        self.now = 0.0
        self.states = []
        self.problems = []
        self.problems = []
        self.recognized = Song("k", "Song", "Artist")
        self.heard = relay.Heard()
        self.library = FakeLibrary(["wrong", "right"])
        copies = {"right": self.song, "wrong": (rng.normal(0, 0.2, (2, 40 * RATE)) * 8000).astype(np.int16)}
        self.tracker = relay.Tracker(self.heard, self.library, self.states.append, self.problems.append,
                                     recognize=self.recognize, load=copies.get, clock=lambda: self.now)

    def recognize(self, sound):
        if isinstance(self.recognized, Exception):
            raise self.recognized
        return self.recognized

    def hear(self, start_s, seconds):
        part = self.song[:, start_s * RATE:(start_s + seconds) * RATE].mean(0) / 32768
        self.heard.add(part.astype(np.float32))

    def step(self, after_s):
        self.now += after_s
        self.tracker.look()

    def test_each_step_told(self):
        steps = []
        self.tracker.on_step = steps.append
        self.hear(10, 9)
        self.step(0)
        self.assertEqual(steps[0], "Asking Shazam what's playing")
        self.assertIn(f"Finding {self.recognized} on YouTube", steps)
        self.assertIn(f"Lining up {self.recognized}", steps)
        self.assertEqual(steps[-1], f"Removing {self.recognized}")

    def test_a_retry_forgets_the_song_and_asks_shazam_afresh(self):
        ready = []
        self.tracker.on_ready = ready.append
        self.hear(10, 9)
        self.step(0)  # taken out: one request
        self.assertIsNotNone(self.tracker.playing)
        asked = []
        self.recognize = lambda sound: asked.append(1) or self.recognized
        self.tracker.recognize = self.recognize
        self.library.before = [(self.recognized, "right", "nowhere")]  # heard before: never the answer to a retry
        self.tracker.retry_soon()
        self.step(1)
        self.assertEqual(asked, [1])  # Shazam itself, at once (its budget had room)
        self.assertEqual(self.states, [status.FILTERING, status.LISTENING, status.FILTERING])
        self.assertEqual(len(ready), 2)  # each request tells the app how long until the next may go

    def test_a_retry_tries_the_songs_other_copy_first(self):
        self.library.ids = ["right", "again"]  # two copies of the song, both lining up
        self.tracker.load = {"right": self.song, "again": self.song.copy()}.get
        self.hear(10, 9)
        self.step(0)
        self.assertEqual(self.tracker.playing.video_id, "right")
        self.tracker.retry_soon()
        self.step(1)
        playing = self.tracker.playing
        self.assertEqual((playing.video_id, playing.round), ("again", 1))  # the one that didn't do: tried last
        self.assertEqual(self.library.remembered, {"k": "again"})

    def test_a_retry_with_only_that_copy_takes_it_again_afresh(self):
        self.library.ids = ["right"]
        self.hear(10, 9)
        self.step(0)
        self.tracker.retry_soon()
        self.step(1)
        playing = self.tracker.playing
        self.assertEqual((playing.video_id, playing.round), ("right", 1))  # the cancellers start from nothing

    def test_a_retry_out_of_budget_waits_and_says_how_long(self):
        ready = []
        self.tracker.on_ready = ready.append
        self.tracker.budget.left = 0  # the budget spent by the filter's own requests
        asked = []
        self.tracker.recognize = lambda sound: asked.append(1)
        self.hear(10, 9)
        self.tracker.retry_soon()
        self.step(0)
        self.assertEqual(asked, [])  # never past the budget: Shazam would refuse for minutes
        self.assertEqual(ready, [relay.BUDGET_EVERY_S])
        self.assertIn(f"Shazam can be asked again in {relay.BUDGET_EVERY_S} s", self.problems)

    def test_a_refusal_tells_the_app_how_long(self):
        ready = []
        self.tracker.on_ready = ready.append
        self.recognized = songs.RateLimited("Shazam says too many requests")
        self.hear(10, 9)
        self.step(0)
        self.assertGreaterEqual(ready[-1], relay.LIMITED_S)

    def test_finds_the_copy_that_lines_up(self):
        self.hear(10, 9)  # the stream heard song 10 s..19 s
        self.step(0)
        playing = self.tracker.playing
        self.assertIsNotNone(playing)
        self.assertEqual(self.library.remembered, {"k": "right"})
        self.assertEqual(playing.offset, 10 * RATE)  # stream sample 0 is song sample 10 s
        self.assertEqual(self.states, [status.FILTERING])

    def test_shazams_place_in_the_song_picks_among_repeated_bars(self):
        self.song[:, 22 * RATE: 34 * RATE] = self.song[:, 4 * RATE: 16 * RATE]  # a loop: 4..16 s again at 22..34 s
        self.library.ids = ["right"]
        for said_s, expected_offset_s in ((27.0, 23), (9.0, 5)):  # Shazam heard the last 5 s: song 27 s (or 9 s) on
            with self.subTest(said_s=said_s):
                self.tracker.playing, self.tracker.next_at, self.tracker.shifts = None, 0.0, {}
                self.heard.total = 0
                self.recognized = Song("k", "Song", "Artist", offset=said_s)
                self.hear(23, 9)
                self.step(relay.BUDGET_EVERY_S)  # (Shazam may be asked again by then)
                self.assertEqual(self.tracker.playing.offset, expected_offset_s * RATE)

    def other_sound(self, seconds, seed=9):
        self.heard.add(np.random.default_rng(seed).normal(0, 0.1, seconds * RATE).astype(np.float32))

    def test_lets_go_when_the_song_stops(self):
        self.hear(10, 9)
        self.step(0)
        self.recognized = None
        for i in range(relay.LOST):
            self.other_sound(relay.MATCH_S, seed=i)
            self.step(relay.CHECK_S)
        self.assertIsNone(self.tracker.playing)
        self.assertEqual(self.states, [status.FILTERING, status.LISTENING])

    def test_holds_on_through_a_moment_of_not_hearing_it(self):
        self.hear(10, 9)
        self.step(0)
        self.recognized = None  # a shout over it: Shazam hears nothing it knows
        for i in range(relay.LOST - 1):
            self.other_sound(relay.FOLLOW_S, seed=i)
            self.step(relay.CHECK_S)
        self.assertIsNotNone(self.tracker.playing)  # still taken out all along
        self.assertEqual(self.states, [status.FILTERING])

    def test_a_different_song_switches_at_once(self):
        self.hear(10, 9)
        self.step(0)
        self.recognized = Song("other", "Other", "Artist")
        self.library.ids = []
        self.other_sound(relay.FOLLOW_S)
        self.step(relay.CHECK_S)  # gone from where it was: Shazam not asked yet, the sound is mostly the old song's
        self.assertIsNotNone(self.tracker.playing)
        self.other_sound(relay.FOLLOW_S, seed=3)
        self.step(relay.CHECK_S)  # the 2nd miss: asked, and switched to its answer at once
        self.assertIsNone(self.tracker.playing)
        self.assertEqual(self.problems, ["Artist - Other isn't on YouTube Music or YouTube"])

    def test_follows_the_song_as_it_plays(self):
        self.hear(10, 9)
        self.step(0)
        self.hear(19, 4)
        self.step(relay.CHECK_S)
        self.assertEqual(self.tracker.playing.offset, 10 * RATE)
        self.assertEqual(self.tracker.misses, 0)

    def test_asks_shazam_only_when_the_song_isnt_anywhere_in_its_copy(self):
        asked = []
        recognize = self.tracker.recognize
        self.tracker.recognize = lambda sound: (asked.append(1), recognize(sound))[1]
        self.hear(10, 9)
        self.step(0)
        self.hear(12, relay.FOLLOW_S + 1)  # started again a bit back: found in the copy, no request
        self.step(relay.CHECK_S)
        self.assertEqual(len(asked), 1)  # only the first, which named the song
        self.assertIsNotNone(self.tracker.playing)
        self.recognized = None
        for i in range(relay.LOST - 1):  # gone from the copy altogether: Shazam a couple of times at most
            self.other_sound(relay.FOLLOW_S, seed=i)
            self.step(relay.CHECK_S)
        # a couple of requests at most (fewer when the budget holds one back), never one per check
        self.assertIn(len(asked), range(2, 2 + len(relay.SHAZAM_ON_MISSES)))

    def test_follows_the_song_when_it_jumps(self):
        # the streamer skipped ahead, or their version of the song is arranged differently from the copy
        self.hear(10, 9)
        self.step(0)
        self.hear(30, relay.MATCH_S + 1)  # stream from 9 s on is the song from 30 s on
        self.step(relay.CHECK_S)
        self.assertEqual(self.tracker.playing.offset, 21 * RATE)
        self.assertEqual(self.tracker.misses, 0)

    def test_asks_whats_next_a_moment_after_the_song_is_over(self):
        self.hear(30, 9)  # the last 10 s of the 40 s song
        self.step(0)
        self.recognized = Song("next", "Next", "Artist")
        self.library.ids = []
        self.hear(39, 1)
        self.heard.add(np.zeros(10 * RATE, np.float32))  # well past its end
        self.step(relay.CHECK_S)
        self.assertIsNone(self.tracker.playing)
        self.assertEqual(self.states, [status.FILTERING, status.LISTENING])
        self.assertEqual(self.problems, [])  # not straight away: a gap between songs, the next one's quiet start
        self.step(relay.NEXT_SONG_WAIT_S)
        self.assertEqual(self.problems, ["Artist - Next isn't on YouTube Music or YouTube"])  # then looked up

    def test_a_song_without_a_matching_copy_is_given_up_on_the_second_time(self):
        asked = []
        recognize = self.tracker.recognize
        self.tracker.recognize = lambda sound: (asked.append(1), recognize(sound))[1]
        self.library.ids = ["wrong"]
        self.hear(10, 9)
        self.step(0)  # once could be talking over it: tried again, without asking Shazam
        self.assertEqual(self.problems, ["YouTube's copy of Artist - Song doesn't line up with the stream yet, "
                                         "trying again"])
        self.step(relay.LISTEN_S)
        self.assertEqual((len(asked), self.library.asked), (1, 2))
        said = "YouTube has only other versions of Artist - Song than the one playing"
        self.assertEqual(self.problems[-1], said)
        self.step(relay.UNUSABLE_S)  # still that song: not looked for again
        self.assertIsNone(self.tracker.playing)
        self.assertEqual(self.library.asked, 2)
        self.assertEqual(self.problems[-1], said)

    def test_a_failed_download_is_tried_again_without_asking_shazam(self):
        asked = []
        recognize = self.tracker.recognize
        self.tracker.recognize = lambda sound: (asked.append(1), recognize(sound))[1]
        fetch = self.library.fetch

        def offline(video_id):
            raise songs.Problem("no connection")
        self.library.fetch = offline
        self.hear(10, 9)
        self.step(0)
        self.library.fetch = fetch
        self.step(relay.LISTEN_S)
        self.assertIsNotNone(self.tracker.playing)
        self.assertEqual(len(asked), 1)

    def test_a_song_youtube_music_hasnt_got_is_said(self):
        self.library.ids = []
        self.hear(10, 9)
        self.step(0)
        self.assertEqual(self.problems, ["Artist - Song isn't on YouTube Music or YouTube"])

    def test_shazam_unreachable_is_said(self):
        self.recognized = songs.Problem("Shazam couldn't be asked what's playing: offline")
        self.hear(10, 9)
        self.step(0)
        self.assertEqual(self.problems, ["Shazam couldn't be asked what's playing: offline"])

    def test_a_problem_clears_once_it_works_again(self):
        self.recognized = songs.Problem("Shazam couldn't be asked what's playing: offline")
        self.hear(10, 9)
        self.step(0)
        self.recognized = None  # Shazam answers again (nothing it knows playing)
        self.step(relay.LISTEN_S)
        self.assertEqual(self.problems, ["Shazam couldn't be asked what's playing: offline", None])

    def test_following_the_song_is_all_well(self):
        self.hear(10, 9)
        self.step(0)
        self.hear(19, 4)
        self.step(relay.CHECK_S)
        self.assertEqual(self.problems, [None])

    def test_waits_longer_each_time_shazam_is_limiting(self):
        self.recognized = songs.RateLimited("Shazam is getting too many requests from this connection")
        self.hear(10, 9)
        waits = []
        for _ in range(5):
            self.now = max(self.tracker.next_at, self.tracker.shazam_after)
            self.tracker.look()
            waits.append(self.tracker.shazam_after - self.now)
        self.assertEqual(waits, [60, 120, 240, 240, 240])
        self.assertEqual(self.problems[0], "Shazam is getting too many requests from this connection, asking again "
                                           "in 60 s")
        self.recognized = None  # it answers again: back to the usual pace
        self.now = max(self.tracker.next_at, self.tracker.shazam_after)
        self.tracker.look()
        self.assertEqual(self.tracker.limited, 0)

    def test_a_refusal_holds_back_only_shazam(self):
        self.hear(10, 9)
        self.step(0)  # taken out
        self.tracker.shazam_after = self.now + 200  # Shazam refused a moment ago
        self.problems.clear()
        self.hear(19, 4)
        self.step(relay.CHECK_S)  # the song is still followed meanwhile
        self.assertEqual(self.tracker.misses, 0)
        self.assertEqual(self.problems, [])  # and the refusal isn't cleared by it

    def test_a_little_waver_isnt_followed(self):
        self.hear(10, 9)
        self.step(0)
        offset = self.tracker.playing.offset
        self.tracker.playing.offset += 100  # thought a hair off: found where it really is, within the waver
        self.hear(19, 4)
        self.step(relay.CHECK_S)
        self.assertEqual(self.tracker.playing.offset, offset + 100)

    def test_a_song_without_a_copy_isnt_asked_about_so_often(self):
        self.library.ids = []
        self.hear(10, 9)
        self.step(0)
        self.assertEqual(self.tracker.ask_at - self.now, relay.UNUSABLE_S)
        self.assertLessEqual(self.tracker.next_at - self.now, relay.KNOWN_S)  # songs heard before still looked for
        self.now = self.tracker.ask_at
        self.tracker.look()  # the same song still playing
        self.assertEqual(self.tracker.ask_at - self.now, relay.UNUSABLE_S)

    def test_never_more_requests_than_the_budget(self):
        asked = []
        recognize = self.tracker.recognize
        self.tracker.recognize = lambda sound: (asked.append(self.now), recognize(sound))[1]
        self.recognized = None
        self.hear(0, 9)
        for _ in range(60):  # ten minutes of nothing Shazam knows, looked at every 10 s
            self.step(10)
        for i in range(len(asked)):
            later = [t for t in asked[i:] if t < asked[i] + 60]
            self.assertLessEqual(len(later), relay.BUDGET + 60 / relay.BUDGET_EVERY_S)  # within any minute

    def test_an_unexpected_error_is_said(self):
        self.recognized = KeyError("track")
        self.hear(10, 9)
        self.step(0)
        self.assertEqual(self.problems, ["The music filter ran into an error: KeyError: 'track'"])
        self.assertIsNone(self.tracker.playing)

    def test_a_copy_that_cant_be_had_is_tried_again_later(self):
        def offline(video_id):
            raise songs.Problem("no connection")
        self.library.fetch = offline
        self.hear(10, 9)
        self.step(0)
        self.assertNotIn("k", self.tracker.unusable)
        self.assertEqual(self.problems, ["Couldn't get Artist - Song from YouTube: no connection"])
        self.library.fetch = lambda video_id: video_id
        self.step(relay.LISTEN_S)
        self.assertIsNotNone(self.tracker.playing)

    def test_a_song_heard_before_is_taken_out_without_asking_shazam(self):
        import tempfile
        from mor_helper.musicfilter import align
        asked = []
        recognize = self.tracker.recognize
        self.tracker.recognize = lambda sound: (asked.append(1), recognize(sound))[1]
        self.hear(10, 9)
        self.step(0)  # the first time: Shazam names it, its copy is kept with a print
        self.assertIn("right", self.library.prints)
        self.tracker._set(None)
        with tempfile.TemporaryDirectory() as folder:
            path = f"{folder}/right.print.npy"
            np.save(path, self.library.prints["right"].astype(np.float16))
            self.library.before = [(self.recognized, "right", path)]
            self.library.ids = ["right"]
            self.hear(20, 9)
            self.step(relay.KNOWN_S)  # the next time: told by its print
        self.assertIsNotNone(self.tracker.playing)
        self.assertEqual(self.tracker.playing.song, self.recognized)
        self.assertEqual(len(asked), 1)

    def test_waiting_to_hear_enough_isnt_a_try(self):
        self.hear(0, 2)
        for _ in range(9):
            self.step(1)
        self.assertEqual(self.tracker.tries, 0)

    def test_rests_a_minute_after_two_answers_without_music(self):
        asked = []
        recognize = self.tracker.recognize
        self.tracker.recognize = lambda sound: (asked.append(self.now), recognize(sound))[1]
        self.recognized = None
        self.hear(0, 9)
        for _ in range(150):  # with the local looks in between
            self.now = self.tracker.next_at
            self.tracker.look()
        gaps = [round(b - a, 6) for a, b in zip(asked, asked[1:])]
        # two asks on new sound each (the budget's two at once), then a minute's rest, over and over
        self.assertEqual(gaps[:4], [relay.ASK_S, relay.NOTHING_REST_S, relay.ASK_S, relay.NOTHING_REST_S])
        self.assertTrue(all(gap >= relay.ASK_S for gap in gaps))

    def test_a_retry_wakes_it_from_its_rest(self):
        steps = []
        self.tracker.on_step = steps.append
        self.recognized = None
        self.hear(0, 9)
        self.step(0)
        self.step(relay.ASK_S)
        self.assertEqual(steps[-1], "No music found, resting a minute")
        asked = []
        self.tracker.recognize = lambda sound: asked.append(1)
        self.tracker.budget.left = relay.BUDGET  # (its budget has room again)
        self.tracker.retry_soon()
        self.step(1)
        self.assertEqual(asked, [1])  # asked at once, rest or not

    def test_asks_quickly_again_after_a_song(self):
        self.hear(10, 9)
        self.step(0)  # found and taken out: the tries start over
        self.assertEqual(self.tracker.tries, 0)
        self.assertEqual(relay.listen_wait(0), relay.ASK_S)
        self.assertEqual(relay.listen_wait(99), relay.ASK_S)  # no easing off


class TimingTests(unittest.TestCase):
    """How much Shazam hears, and when it's asked, with the real numbers."""

    def setUp(self):
        self.now = 0.0
        self.problems, self.sent = [], []
        self.heard = relay.Heard()
        self.tracker = relay.Tracker(self.heard, FakeLibrary([]), lambda state: None, self.problems.append,
                                     recognize=lambda sound: self.sent.append(len(sound)), clock=lambda: self.now)

    def test_ten_seconds_sent_and_not_before_there_are_ten(self):
        self.heard.add(np.zeros(9 * RATE, np.float32))
        self.tracker.look()
        self.assertEqual(self.sent, [])  # a quiet start: no request on too little
        self.heard.add(np.zeros(1 * RATE, np.float32))
        self.now += 1
        self.tracker.look()
        self.assertEqual(self.sent, [10 * RATE])

    def test_a_refusal_stops_being_said_once_its_wait_is_over(self):
        self.tracker.recognize = mock.Mock(side_effect=songs.RateLimited("Shazam is getting too many requests"))
        self.heard.add(np.zeros(10 * RATE, np.float32))
        self.tracker.look()
        self.assertEqual(self.problems, ["Shazam is getting too many requests, asking again in 60 s"])
        self.now += 59
        self.tracker.look()
        self.assertEqual(self.problems[-1], "Shazam is getting too many requests, asking again in 60 s")
        self.now += 2  # its 60 s are over, whether or not a song is found after
        self.tracker.recognize = mock.Mock(side_effect=songs.Problem("offline"))
        self.tracker.look()
        self.assertIsNone(self.problems[1])



if __name__ == "__main__":
    unittest.main()
