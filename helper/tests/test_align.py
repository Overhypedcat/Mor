import unittest

import numpy as np

from mor_helper.musicfilter import align

RATE = 48000


def song(seconds, seed):
    """Something song-like: a beat of noisy hits that fade, a quarter second each, with a note under each."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(0.25 * RATE)) / RATE
    hits = [(rng.normal(0, 0.2, len(t)) + np.sin(2 * np.pi * f * t) * 0.1) * np.exp(-t * rng.uniform(4, 20))
            for f in rng.uniform(110, 880, seconds * 4)]
    return np.concatenate(hits).astype(np.float32)


class FindTests(unittest.TestCase):
    def setUp(self):
        self.song = song(60, seed=1)

    def test_finds_where_the_stream_is_in_the_song(self):
        start = 23 * RATE + 1234
        heard = self.song[start: start + 6 * RATE] * 0.5
        heard = heard + np.random.default_rng(2).normal(0, 0.05, len(heard)).astype(np.float32)  # talking over it
        at, score = align.find(heard, self.song)
        self.assertEqual(at, start)
        self.assertGreater(score, align.SURE)

    def test_kept_reduction_gives_the_same_answer(self):
        heard = self.song[10 * RATE: 16 * RATE]
        self.assertEqual(align.find(heard, self.song, align.reduce(self.song))[0], 10 * RATE)

    def test_another_song_is_not_taken_for_it(self):
        heard = song(6, seed=3)
        self.assertIsNone(align.find(heard, self.song)[0])

    def test_reduction_keeps_only_every_sixth_filtered_sample(self):
        sound = self.song[: 5 * RATE + 7]
        expected = np.convolve(sound, align._KERNEL, mode="same")[::align.STEP]
        np.testing.assert_allclose(align._decimate(sound), expected, atol=1e-5)

    def test_a_song_of_any_length(self):
        odd = self.song[: 20 * RATE + 11]  # an awkward length for the FFT: padded, never slow, still right
        self.assertEqual(len(align.reduce(odd)), len(align._decimate(odd)))
        self.assertEqual(align.find(odd[7 * RATE: 13 * RATE], odd)[0], 7 * RATE)

    def test_still_there(self):
        heard = self.song[30 * RATE: 34 * RATE]
        self.assertEqual(align.still(heard, self.song, None, 30 * RATE + 3)[0], 30 * RATE)
        self.assertIsNone(align.still(heard, self.song, None, 10 * RATE)[0])  # not where it was thought to be

    def test_a_repeated_part_is_still_where_it_was(self):
        bars = song(4, seed=7)
        repeating = np.concatenate([song(10, seed=8), bars, song(10, seed=9), bars, song(10, seed=10)])
        second = 24 * RATE  # the bars' second time
        heard = repeating[second: second + 4 * RATE]
        self.assertEqual(align.still(heard, repeating, None, second)[0], second)
        self.assertEqual(align.still(heard, repeating, None, 10 * RATE)[0], 10 * RATE)  # the first time sounds the same

    def test_repeated_bars_are_told_apart_by_where_the_song_is_expected(self):
        bars = song(6, seed=7)
        repeating = np.concatenate([song(10, seed=8), bars, song(10, seed=9), bars, song(10, seed=10)])
        first, second = 10 * RATE, 26 * RATE  # the same bars, sample for sample
        heard = repeating[second: second + 6 * RATE]
        self.assertEqual(align.find(heard, repeating, expected=second + 2 * RATE)[0], second)
        self.assertEqual(align.find(heard, repeating, expected=first - RATE)[0], first)

    def test_a_place_unlike_the_rest_isnt_moved_by_the_expectation(self):
        start = 23 * RATE
        heard = self.song[start: start + 6 * RATE]
        self.assertEqual(align.find(heard, self.song, expected=5 * RATE)[0], start)  # expected wrongly: skipped

    def test_still_asks_less_than_finding(self):
        self.assertLess(align.STILL_SURE, align.SURE)
        heard = song(4, seed=11)  # another song entirely: not where this one was
        self.assertIsNone(align.still(heard, self.song, None, 30 * RATE)[0])

    def test_a_song_heard_before_is_told_by_its_print(self):
        others = [song(60, seed=s) for s in (21, 22, 23)]
        prints = [align.thin(align.reduce(s)) for s in others + [self.song]]
        heard = self.song[37 * RATE: 45 * RATE] * 0.5
        heard = heard + np.random.default_rng(4).normal(0, 0.05, len(heard)).astype(np.float32)  # talking over it
        found, score = align.known(heard, prints)
        self.assertEqual(found, 3)
        self.assertGreaterEqual(score, align.KNOWN_SURE)

    def test_a_song_never_heard_isnt_told_as_one(self):
        prints = [align.thin(align.reduce(song(60, seed=s))) for s in (21, 22, 23)]
        self.assertIsNone(align.known(song(8, seed=30), prints)[0])
        self.assertIsNone(align.known(self.song[: 8 * RATE], [])[0])

    def test_a_print_is_small(self):
        self.assertEqual(len(align.thin(align.reduce(self.song))), len(self.song) // (align.STEP * align.THIN))

    def test_too_short_a_song(self):
        self.assertEqual(align.find(self.song[: 6 * RATE], self.song[: RATE]), (None, 0.0))


if __name__ == "__main__":
    unittest.main()
