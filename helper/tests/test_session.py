import base64
import unittest

import numpy as np

from mor_helper.musicfilter import relay, status
from mor_helper.musicfilter.songs import Song
from mor_helper.session import CHUNK, FilterSession


class FakeTracker:
    def __init__(self, heard, library, on_state, on_problem, on_ready=None, on_step=None, clock=None):
        self.heard, self.on_state, self.on_problem, self.on_ready = heard, on_state, on_problem, on_ready
        self.playing = None
        self.retried = 0

    def _tell_ready(self):
        self.on_ready(0)

    def retry_soon(self):
        self.retried += 1


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.session = FilterSession("tab1", self.sent.append, relay.Budget(lambda: 0.0), library=object(),
                                     tracker_factory=FakeTracker)

    def test_the_streams_sound_is_heard_in_order(self):
        for part in (np.arange(3, dtype="<f4"), np.arange(3, 5, dtype="<f4")):
            self.session.hear(base64.b64encode(part.tobytes()).decode())
        sound, start = self.session.heard.latest(5)
        np.testing.assert_array_equal(sound, [0, 1, 2, 3, 4])
        self.assertEqual(start, 0)

    def test_the_shared_budget_is_the_trackers(self):
        budget = relay.Budget(lambda: 0.0)
        session = FilterSession("t", self.sent.append, budget, library=object(), tracker_factory=FakeTracker)
        self.assertIs(session.tracker.budget, budget)

    def test_a_new_song_sends_its_copy_first_then_its_place(self):
        sound = (np.arange(2 * 10, dtype=np.int16).reshape(2, 10))
        song = Song("k1", "Title", "Artist")
        self.session.tracker.playing = relay.Playing(song, sound, None, -4, "vid1", 2)
        self.session.tell_playing()
        copy, place = self.sent
        self.assertEqual(copy["type"], "copy")
        self.assertEqual((copy["copy"], copy["part"], copy["parts"], copy["length"]), ("vid1", 0, 1, 10))
        self.assertEqual(np.frombuffer(base64.b64decode(copy["data"]), "<i2").tolist(), sound.ravel().tolist())
        self.assertEqual(place["playing"], {"key": "k1", "title": "Title", "artist": "Artist", "copy": "vid1",
                                            "offset": -4, "round": 2})
        self.session.tell_playing()  # nothing changed: nothing sent
        self.assertEqual(len(self.sent), 2)

    def test_a_move_in_the_same_copy_sends_only_the_place(self):
        playing = relay.Playing(Song("k", "T", "A"), np.zeros((2, 4), np.int16), None, 0, "v", 0)
        self.session.tracker.playing = playing
        self.session.tell_playing()
        self.session.tracker.playing = playing.moved_to(100)
        self.session.tell_playing()
        self.session.tracker.playing = None
        self.session.tell_playing()
        kinds = [m["type"] for m in self.sent]
        self.assertEqual(kinds, ["copy", "playing", "playing", "playing"])
        self.assertEqual(self.sent[2]["playing"]["offset"], 100)
        self.assertIsNone(self.sent[3]["playing"])
        self.assertEqual([m["seq"] for m in self.sent[1:]], [1, 2, 3])

    def test_a_long_copy_goes_in_pieces_under_a_megabyte(self):
        samples = CHUNK  # 2 channels x 2 bytes: four pieces' worth
        self.session.send_copy("v", np.ones((2, samples), np.int16))
        self.assertEqual([m["part"] for m in self.sent], [0, 1, 2, 3])
        self.assertTrue(all(len(m["data"]) < 1_000_000 for m in self.sent))

    def test_what_it_tells_goes_to_the_tab(self):
        self.session.start()
        self.session.stop()
        self.session.tracker.on_problem("Shazam is down")
        self.session.broken("The music filter broke")
        lines = [m["line"] for m in self.sent if m["type"] == "status"]
        self.assertEqual(lines[:2], [status.LISTENING, "ready 0"])
        self.assertIn("problem Shazam is down", lines)
        self.assertEqual(lines[-1], "problem The music filter broke")
        self.assertTrue(all(m["sid"] == "tab1" for m in self.sent))

    def test_retry_reaches_the_tracker(self):
        self.session.retry()
        self.assertEqual(self.session.tracker.retried, 1)


if __name__ == "__main__":
    unittest.main()
