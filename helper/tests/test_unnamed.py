import io
import logging
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

import numpy as np

from mor_helper.musicfilter import relay, songs, unnamed
from mor_helper.musicfilter.songs import Song
from mor_helper.session import FilterSession


class KeepTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.where = Path(temp.name) / "unnamed"

    def test_the_sound_is_kept_as_a_wav_named_by_the_time(self):
        sound = np.sin(np.arange(4800) / 10).astype(np.float32) / 2
        now = 1_800_000_000
        path = unnamed.keep(sound, rate=48000, where=self.where, now=now)
        self.assertEqual(path.parent, self.where)
        self.assertRegex(path.name, r"^\d{8}-\d{6}\.wav$")
        with wave.open(io.BytesIO(path.read_bytes())) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()), (1, 2, 48000, 4800))
            back = np.frombuffer(w.readframes(4800), "<i2") / 32767
        np.testing.assert_allclose(back, sound, atol=1e-4)

    def test_two_in_the_same_second_are_both_kept(self):
        first = unnamed.keep(np.zeros(10, np.float32), where=self.where, now=1_800_000_000)
        second = unnamed.keep(np.ones(10, np.float32), where=self.where, now=1_800_000_000)
        self.assertNotEqual(first, second)
        self.assertEqual(len(list(self.where.glob("*.wav"))), 2)

    def test_only_the_latest_stay(self):
        paths = [unnamed.keep(np.zeros(10, np.float32), where=self.where, now=1_800_000_000 + i, limit=3)
                 for i in range(5)]
        self.assertEqual(sorted(p.name for p in self.where.glob("*.wav")), sorted(p.name for p in paths[-3:]))

    def test_how_loud(self):
        self.assertEqual(unnamed.level(np.zeros(100, np.float32)), 0.0)
        self.assertAlmostEqual(unnamed.level(np.full(100, 0.5, np.float32)), 0.5)
        self.assertEqual(unnamed.level(np.zeros(0, np.float32)), 0.0)

    def test_a_folder_that_cant_be_made_is_an_error_to_tell(self):
        blocked = self.where.parent / "file"
        blocked.write_text("in the way")
        with self.assertRaises(OSError):
            unnamed.keep(np.zeros(10, np.float32), where=blocked / "unnamed")


class Asked:
    """A Tracker stand-in with Shazam's answer set by the test."""

    def __init__(self, heard, library, on_state, on_problem, on_ready=None, on_step=None, on_until=None, clock=None):
        self.playing = None
        self.answer = None
        self.recognize = self.ask

    def ask(self, sound):
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class AnswerLogTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.where = Path(temp.name) / "unnamed"
        patch = mock.patch.object(unnamed, "folder", lambda: self.where)
        patch.start()
        self.addCleanup(patch.stop)
        self.session = FilterSession("tab1", lambda message: None, relay.Budget(lambda: 0.0), library=object(),
                                     tracker_factory=Asked)
        self.sound = np.full(5 * relay.RATE, 0.25, np.float32)

    def ask(self):
        with self.assertLogs("mor.filter", logging.INFO) as logs:
            try:
                return self.session.tracker.recognize(self.sound), logs.output
            except Exception as error:
                return error, logs.output

    def test_no_song_is_logged_with_its_length_and_level_and_the_sound_kept(self):
        answer, lines = self.ask()
        self.assertIsNone(answer)
        (kept,) = self.where.glob("*.wav")
        self.assertIn("tab1 Shazam: no song in 5.0 s (level 0.2500), kept as " + str(kept), lines[-1])
        with wave.open(str(kept)) as w:
            self.assertEqual(w.getnframes(), 5 * relay.RATE)

    def test_a_song_is_logged_and_nothing_kept(self):
        self.session.tracker.answer = Song("k", "Title", "Artist")
        answer, lines = self.ask()
        self.assertEqual(answer, Song("k", "Title", "Artist"))
        self.assertIn("tab1 Shazam: Artist - Title, on 5.0 s", lines[-1])
        self.assertFalse(self.where.exists())

    def test_shazam_out_of_reach_is_logged_and_still_raised(self):
        self.session.tracker.answer = songs.RateLimited("Shazam is getting too many requests")
        answer, lines = self.ask()
        self.assertIsInstance(answer, songs.RateLimited)
        self.assertIn("tab1 Shazam: no answer on 5.0 s (", lines[-1])
        self.assertFalse(self.where.exists())

    def test_sound_that_cant_be_kept_is_said_and_the_answer_still_given(self):
        with mock.patch.object(unnamed, "keep", side_effect=OSError("disk full")):
            answer, lines = self.ask()
        self.assertIsNone(answer)
        self.assertIn("which couldn't be kept: ", lines[-1])
        self.assertIn("disk full", lines[-1])


if __name__ == "__main__":
    unittest.main()
