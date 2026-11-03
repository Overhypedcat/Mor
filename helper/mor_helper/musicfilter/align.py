"""Where in a song a stretch of the stream is.

The stream is compared with the whole song at every possible position, at a sixth of the sample rate for speed, then
pinned to the exact sample at full rate. A match has to stand far above how alike the stream and the song look
everywhere else, so a different recording of the same song (a remaster, a live version, a cover) isn't taken for it.
"""
import numpy as np

STEP = 6  # 48 kHz to 8 kHz
LOWPASS = 63  # taps of the filter before dropping samples, so higher sounds don't fold down
WHITEN = 64  # bins the loudness of each pitch is averaged over
SURE = 14.0  # how far a match has to stand above the rest (robust z-score) to count: the song itself scored 21 or
# more on 6 s of a stream, a cover of it and unrelated sound 11 at most
# confirming the song is still where it was is a far smaller question than finding it: only a few places are looked
# at, so a song that isn't there scores 3 or so; one whose bars repeat (techno) can't stand out from its own copies
# elsewhere as much as SURE asks, though it is right where it was
STILL_SURE = 6.0
REACH = 256  # samples either side of where it should be that still count as there (lining up wavers that much)
# places that score at least this share of the best are taken for the same bars repeated (a loop, a chorus): of
# those, the one nearest where the song is expected to be is the one (Shazam's place in the song, or where it was)
ALIKE = 0.8
# a song's print, by which a song heard before is told again without Shazam: its reduction (above) with THIN times
# fewer samples, small enough to keep one for every stored song and to look through all of them in a moment
THIN = 8  # 1 kHz: told 43 stored songs apart, the right one 37 or more, the others 21 at most
KNOWN_SURE = 28.0  # how far the stream has to stand out in one stored song's print to be told as that song


def _lowpass(taps=LOWPASS, step=STEP):
    n = np.arange(taps) - (taps - 1) / 2
    kernel = np.sinc(n / step) * np.hamming(taps)
    return (kernel / kernel.sum()).astype(np.float32)


_KERNEL = _lowpass()


def _decimate(sound):
    """The low-passed sound at every STEP-th sample: only the samples kept are worked out (a sixth of the work of
    filtering everything first)."""
    half = LOWPASS // 2
    padded = np.concatenate([np.zeros(half, np.float32), np.asarray(sound, np.float32), np.zeros(half, np.float32)])
    count = (len(padded) - LOWPASS) // STEP + 1
    windows = np.lib.stride_tricks.as_strided(padded, (count, LOWPASS), (padded.strides[0] * STEP,
                                                                        padded.strides[0]))
    return windows @ _KERNEL[::-1]


def reduce(sound):
    """A mono sound at a sixth of its rate and with every pitch made equally loud, for comparing: its bass would
    otherwise outweigh the rest, and bass looks alike in many places of a song, and in other versions of it."""
    low = _decimate(sound)
    size = 1 << int(np.ceil(np.log2(max(len(low), 2))))  # a length the FFT is quick at (a song's own can be slow)
    spectrum = np.fft.rfft(low, size)
    level = np.convolve(np.abs(spectrum), np.ones(WHITEN) / WHITEN, mode="same")
    return np.fft.irfft(spectrum / (level + 1e-9), size)[: len(low)].astype(np.float32)


_kept = {}  # the latest song's spectrum and energy, for the checks that follow it every few seconds


def _song_parts(long, size):
    key = (id(long), len(long), size)
    if key not in _kept:
        _kept.clear()
        _kept[key] = (long, np.fft.rfft(long, size), np.concatenate([[0.0], np.cumsum(long.astype(np.float64) ** 2)]))
    return _kept[key][1:]


def thin(reduced):
    """A reduced sound's print: THIN times fewer samples (each the average of THIN, so higher sounds don't fold
    down)."""
    n = len(reduced) // THIN * THIN
    return np.asarray(reduced[:n], np.float32).reshape(-1, THIN).mean(1)


def known(stream, prints):
    """Which of these songs' prints (a list) the stream is in, by its index, and how sure; (None, best score) when
    none stands out enough."""
    heard = thin(reduce(stream))
    best, best_score = None, 0.0
    for i, song_print in enumerate(prints):
        if len(song_print) < len(heard) + 2:
            continue
        likeness = _correlate(np.asarray(song_print, np.float32), heard, keep=False)
        median = float(np.median(likeness))
        spread = 1.4826 * float(np.median(np.abs(likeness - median))) + 1e-12
        score = (float(likeness.max()) - median) / spread
        if score > best_score:
            best, best_score = i, score
    return (best, best_score) if best_score >= KNOWN_SURE else (None, best_score)


def _correlate(long, short, keep=True):
    """How alike short is with long at each position of long, from -1 to 1."""
    size = 1 << int(np.ceil(np.log2(len(long) + len(short))))
    if keep:  # the same song is checked against every few seconds: its spectrum is kept for the next time
        spectrum, energy = _song_parts(long, size)
    else:
        spectrum = np.fft.rfft(long, size)
        energy = np.concatenate([[0.0], np.cumsum(long.astype(np.float64) ** 2)])
    dots = np.fft.irfft(spectrum * np.conj(np.fft.rfft(short, size)), size)[: len(long) - len(short) + 1]
    windows = energy[len(short):] - energy[: len(long) - len(short) + 1]
    return dots / (np.sqrt(np.maximum(windows, 1e-12)) * (np.linalg.norm(short) + 1e-12))


def _scores(stream, song, reduced_song):
    """How far each place in the song stands out as the stream's (robust z-scores), or None when it can't be told."""
    reduced_song = reduce(song[:]) if reduced_song is None else reduced_song
    reduced = reduce(stream)
    if len(reduced) < 2 or len(reduced_song) < len(reduced):
        return None
    likeness = _correlate(reduced_song, reduced)
    median = float(np.median(likeness))
    spread = 1.4826 * float(np.median(np.abs(likeness - median))) + 1e-12
    return (likeness - median) / spread


def find(stream, song, reduced_song=None, expected=None):
    """Where in song (sample index) the stream's first sample is, and how sure that is; (None, score) when it isn't
    there. Both mono at the same rate (song can be anything that slices into samples, see relay.Mono);
    reduced_song is reduce(song), when it's kept from an earlier look. expected (a song sample index), when known,
    picks among places that sound alike: the bars of techno repeated sample for sample, a chorus come again."""
    scores = _scores(stream, song, reduced_song)
    if scores is None:
        return None, 0.0
    peak = int(np.argmax(scores))
    if scores[peak] < SURE:
        return None, float(scores[peak])
    if expected is not None:
        peak = _nearest_alike(scores, peak, expected)
    return _pin(stream, song, peak * STEP), float(scores[peak])


def _nearest_alike(scores, peak, expected):
    """Of the places scoring nearly as high as the peak, the top of the one nearest expected (song samples)."""
    alike = np.flatnonzero(scores >= max(SURE, scores[peak] * ALIKE))
    nearest = int(alike[np.argmin(np.abs(alike * STEP - expected))])
    steps = max(2, round(REACH / STEP))
    lo, hi = max(nearest - steps, 0), min(nearest + steps + 1, len(scores))
    return lo + int(np.argmax(scores[lo:hi]))


def still(stream, song, reduced_song, expected, reach=REACH):
    """Is the stream still at song sample expected (give or take reach samples)? Its exact place there, and how sure;
    (None, score) when it isn't. Asked of the place itself, so a song whose parts repeat (the same bars copied over,
    as dance music does) can't be taken for being somewhere else."""
    scores = _scores(stream, song, reduced_song)
    if scores is None:
        return None, 0.0
    rough = round(expected / STEP)
    steps = max(2, round(reach / STEP))
    lo, hi = max(rough - steps, 0), min(rough + steps + 1, len(scores))
    if lo >= hi:
        return None, 0.0
    near = lo + int(np.argmax(scores[lo:hi]))
    if scores[near] < STILL_SURE:
        return None, float(scores[near])
    return _pin(stream, song, near * STEP), float(scores[near])


def _pin(stream, song, rough):
    """The exact sample near rough where the stream lines up with the song best."""
    best, best_at = -np.inf, rough
    for at in range(max(rough - STEP, 0), min(rough + STEP, len(song) - len(stream)) + 1):
        dot = float(np.dot(stream, song[at: at + len(stream)]))
        if dot > best:
            best, best_at = dot, at
    return best_at
