"""Subtracts a known song from a stream's sound, a slice at a time.

The stream holds the song as the streamer's setup changed it: an EQ and a delay that hardly ever change, and a
volume that does (their fader, ducking under their voice). So per frequency a short filter learns the song's shape
slowly, and one volume across all frequencies follows quickly. Both learn only from where the song is what's heard:
in the frequencies the streamer's voice fills, they hold still. A filter that kept learning there would take on a
bit of every word and subtract it again a moment later (an echo), and a shout would throw it off so far that the
song came through for seconds. What's left of the song after subtracting is turned down where it still outweighs
everything else.

The shape belongs to the streamer's setup, not to the song, so it's kept across songs and jumps within one
(restart()); only a new stream starts it from nothing.
"""
import numpy as np

SIZE = 2048  # samples per analysis frame
HOP = 512  # samples between frames: the slice the stream moves on by
DELAY = SIZE - HOP  # how far the result runs behind the stream
TAPS = 2  # frames of the song each frequency's filter looks back over (the song's echo in the stream)
SHAPE_RATE = 0.01  # how fast the per-frequency shape learns
VOLUME_SECONDS = 0.2  # how quickly the volume follows the streamer's
WARMUP_FRAMES = 50  # with a fresh shape: it learns on its own this long before the volume starts following
LEFTOVER_FLOOR = 0.15  # what's left of the song is turned down at most to this
QUIET_VOLUME = 0.05  # the song this far down (faded out, paused) teaches the shape nothing
MAX_VOLUME = 4.0  # the volume never follows past this: a voice can't make it run off
LEARN_FLOOR = 0.05  # a frequency the voice fills still learns this share, so nothing ever stops learning for good
# a frequency learns at full speed until what isn't the song there outweighs it SHARE_GAIN - 1 to 1: learning only
# slows where a voice clearly drowns the song, and keeps the speed of plain learning everywhere else
SHARE_GAIN = 4.0
LEARN_VOLUME = 0.3  # the stream is scaled back to the song's own volume for learning, but never by more than 1/this
# the volume and the shape only matter multiplied together, so either could drift off while the other makes up for
# it (the volume sinking towards nothing, the shape growing without end); this slowly hands the volume's lasting
# part over to the shape, keeping the volume about 1 without changing what's subtracted
SETTLE = 0.002


class Canceller:
    """One channel of sound. Feed it a slice of the stream and the matching slice of the song (None while there's
    no song to take out); it gives back a slice of the result, DELAY samples behind what went in."""

    def __init__(self, rate=48000):
        self.window = np.hanning(SIZE + 1)[:SIZE].astype(np.float32)  # periodic: overlapping frames sum evenly
        self.norm = float((self.window ** 2).sum() / HOP)
        self.volume_keep = float(np.exp(-HOP / (rate * VOLUME_SECONDS)))
        self.shape_keep = float(np.exp(-HOP / (rate * 2.0)))
        self.stream = np.zeros(SIZE, np.float32)
        self.song = np.zeros(SIZE, np.float32)
        self.overlap = np.zeros(SIZE, np.float32)
        self.share_gain = SHARE_GAIN
        self.reset()

    def reset(self):
        """Forget everything learned, the streamer's setup too."""
        bins = SIZE // 2 + 1
        self.shape = np.zeros((bins, TAPS), complex)
        self.power = np.zeros(bins)
        self.song_power = 0.0
        self.frames = 0
        self.fresh = True  # the shape knows nothing yet: it learns from everything at first
        self.restart()

    def restart(self):
        """Another song, or the same one somewhere else: its frames and the volume start over; the shape (the
        streamer's EQ and delay) is kept, so it takes out the new place from the start."""
        bins = SIZE // 2 + 1
        self.history = np.zeros((bins, TAPS), complex)  # the song's latest frames, newest first
        self.num = self.den = 0.0
        self.volume = 1.0
        if not self.fresh:
            self.frames = WARMUP_FRAMES  # the volume follows at once

    def process(self, stream, song=None):
        """HOP samples of the stream (and the song lined up with them) in, HOP samples of the result out."""
        self.stream = np.concatenate([self.stream[HOP:], stream])
        self.song = np.concatenate([self.song[HOP:], song if song is not None else np.zeros(HOP, np.float32)])
        Y = np.fft.rfft(self.stream * self.window)
        if song is None:
            E = Y
        else:
            E = self._cancel(Y, np.fft.rfft(self.song * self.window))
        self.overlap += np.fft.irfft(E, SIZE).astype(np.float32) * self.window / self.norm
        out, self.overlap = self.overlap[:HOP].copy(), np.concatenate([self.overlap[HOP:], np.zeros(HOP, np.float32)])
        return out

    def _cancel(self, Y, X):
        self.history = np.concatenate([X[:, None], self.history[:, :-1]], axis=1)
        x = self.history
        s = (self.shape * x).sum(1)  # the song as the shape predicts it, before the volume
        self.frames += 1
        if self.fresh and self.frames > WARMUP_FRAMES:
            self.fresh = False
        # how much each frequency is the song right now: what's learned from it. Judged at no less than LEARN_VOLUME:
        # with the song muted a while (the streamer's mute, a fade, ducking to nothing) the volume sinks to nothing,
        # and judged by it nothing would look like the song any more, so the volume could never come back
        heard_at = max(self.volume, LEARN_VOLUME) if self.frames > WARMUP_FRAMES else 1.0
        guess = np.abs(heard_at * s) ** 2
        share = np.ones(len(Y)) if self.fresh else guess / (guess + np.abs(Y - heard_at * s) ** 2 + 1e-12)
        share = np.minimum(share * self.share_gain, 1.0)
        self.num = self.volume_keep * self.num + (1 - self.volume_keep) * float(np.sum(share * np.real(np.conj(s) * Y)))
        self.den = self.volume_keep * self.den + (1 - self.volume_keep) * float(np.sum(share * np.abs(s) ** 2))
        if self.frames > WARMUP_FRAMES and self.den > 1e-12:
            self.volume = min(max(self.num / self.den, 0.0), MAX_VOLUME)
        music = self.volume * s
        E = Y - music
        heard = (np.abs(x) ** 2).sum(1)
        if self.frames == 1:  # the averages start from the song's first frame, not from silence
            self.power, self.song_power = heard.copy(), float(heard.mean())
        self.power = self.shape_keep * self.power + (1 - self.shape_keep) * heard
        self.song_power = self.shape_keep * self.song_power + (1 - self.shape_keep) * float(heard.mean())
        volume = self.volume if self.frames > WARMUP_FRAMES else 1.0
        if volume >= QUIET_VOLUME:
            floor = 1e-3 * self.song_power + 1e-12
            # the shape learns from the stream scaled back to the song's own volume, where the song is what's heard
            # (by the song's average power: by each frame's own, it learned at a third of the speed, measured live)
            step = SHAPE_RATE * np.maximum(share, LEARN_FLOOR) / (self.power + floor)
            self.shape += step[:, None] * np.conj(x) * (Y / max(volume, LEARN_VOLUME) - s)[:, None]
        # (not while the song is muted: a volume near nothing would hand the shape a shrink every frame, wiping out
        # the streamer's EQ in a few seconds)
        if self.frames > WARMUP_FRAMES and self.volume >= QUIET_VOLUME:
            f = self.volume ** SETTLE
            self.shape *= f
            self.num, self.den, self.volume = self.num * f, self.den * f * f, self.volume / f
        # what's left of the song, turned down where it still outweighs the rest
        ratio = np.abs(music) ** 2 / (np.abs(E) ** 2 + np.abs(music) ** 2 + 1e-12)
        return E * np.clip(1 - ratio, LEFTOVER_FLOOR, 1)
