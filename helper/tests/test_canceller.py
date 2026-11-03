import unittest

import numpy as np

from mor_helper.musicfilter.canceller import DELAY, HOP, Canceller

RATE = 48000


def run(canceller, stream, song=None):
    """The whole stream through the canceller, lined up with the input again (DELAY taken off)."""
    n = len(stream) // HOP * HOP
    out = np.concatenate([canceller.process(stream[i:i + HOP], None if song is None else song[i:i + HOP])
                          for i in range(0, n, HOP)])
    return out[DELAY:], stream[: n - DELAY]


def db(signal):
    return 10 * np.log10(np.mean(signal.astype(np.float64) ** 2) + 1e-20)


class PassThroughTests(unittest.TestCase):
    def test_without_a_song_the_sound_comes_back_unchanged(self):
        sound = np.random.default_rng(0).normal(0, 0.1, RATE).astype(np.float32)
        out, original = run(Canceller(), sound)
        self.assertLess(np.max(np.abs(out - original)), 1e-4)


class CancelTests(unittest.TestCase):
    def setUp(self):
        rng = np.random.default_rng(1)
        seconds = 20
        self.song = rng.normal(0, 0.1, seconds * RATE).astype(np.float32)
        # the voice: bursts of a different sound, as talking comes and goes
        voice = rng.normal(0, 0.1, seconds * RATE) * (np.sin(np.arange(seconds * RATE) / RATE * 2 * np.pi) > 0)
        self.voice = voice.astype(np.float32)
        # the streamer's setup: an EQ (a short echo), a delay, and the volume pulled down halfway through
        heard = np.convolve(self.song, [0.5, 0.0, 0.2], mode="full")[: len(self.song)]
        heard = np.concatenate([np.zeros(30, np.float32), heard[:-30]])
        volume = np.where(np.arange(len(heard)) < len(heard) // 2, 0.8, 0.4)
        self.music = (heard * volume).astype(np.float32)

    def test_takes_the_song_out(self):
        out, _ = run(Canceller(), self.music, self.song)
        late = slice(8 * RATE, None)  # once it has learned the song's shape
        self.assertLess(db(out[late]) - db(self.music[: len(out)][late]), -30)

    def test_takes_the_song_out_under_a_voice(self):
        # the voice here is as loud as the song at every pitch, harder than a streamer talking over music
        out, _ = run(Canceller(), self.music + self.voice, self.song)
        late = slice(8 * RATE, None)
        leftover = out[late] - self.voice[: len(out)][late]  # what isn't the voice: the song, or damage to the voice
        self.assertLess(db(leftover) - db(self.music[: len(out)][late]), -9)

    def test_the_song_is_taken_out_again_after_a_mute(self):
        # the streamer mutes the music for 3 s while it keeps playing (same place in the song), then unmutes:
        # the volume sank to nothing meanwhile, and has to follow it back up
        voice = self.voice * 0.3
        muted = self.music.copy()
        muted[6 * RATE: 9 * RATE] = 0
        back = slice(10 * RATE, 16 * RATE)  # a second after the unmute

        def removed(music):
            out, _ = run(Canceller(), music + voice, self.song)
            return db(out[back] - voice[: len(out)][back]) - db(music[: len(out)][back])
        # as well as if it had never been muted (before, the song came back through all but untouched)
        self.assertLess(removed(muted), removed(self.music) + 1)
        self.assertLess(removed(muted), -9)

    def test_a_shout_doesnt_let_the_song_through(self):
        canceller = Canceller()
        quiet, _ = run(canceller, self.music, self.song)  # learned the song and the streamer's EQ
        t = np.arange(RATE) / RATE  # then a second of shouting, 25 dB over the song
        shout = sum(np.sin(2 * np.pi * k * 230 * t) / k for k in range(1, 25)).astype(np.float32)
        later = slice(12 * RATE, 13 * RATE)
        shout *= np.sqrt(np.mean(self.music[later] ** 2)) * 10 ** (25 / 20) / np.sqrt(np.mean(shout ** 2))
        stream = self.music.copy()
        stream[later] += shout
        canceller = Canceller()
        out, _ = run(canceller, stream, self.song)
        for part in (later, slice(13 * RATE, 15 * RATE)):  # during it, and the two seconds after
            music = self.music[: len(out)][part]
            left = out[part] - (stream[: len(out)][part] - music)  # what isn't the shout: the song's leftover
            share = abs(np.dot(left, music)) / np.dot(music, music)
            self.assertLess(20 * np.log10(share + 1e-12), -25)

    def test_restart_keeps_the_streamers_sound(self):
        canceller = Canceller()
        run(canceller, self.music, self.song)
        learned = canceller.shape.copy()
        canceller.restart()  # another song
        np.testing.assert_array_equal(canceller.shape, learned)
        self.assertEqual(canceller.volume, 1.0)
        self.assertFalse(np.any(canceller.history))

    def test_follows_the_volume_without_drifting_off(self):
        canceller = Canceller()
        run(canceller, self.music + self.voice, self.song)
        # the volume and the shape only matter together; neither may run away while the other makes up for it
        self.assertGreater(canceller.volume, 0.2)
        self.assertLess(canceller.volume, 5)

    def test_reset_forgets_the_song(self):
        canceller = Canceller()
        run(canceller, self.music, self.song)
        canceller.reset()
        self.assertFalse(np.any(canceller.shape))
        self.assertEqual(canceller.volume, 1.0)


if __name__ == "__main__":
    unittest.main()
