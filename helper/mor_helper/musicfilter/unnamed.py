"""The stream's sound Shazam couldn't name, kept on disk: the few seconds it was asked about, as it heard them, so
a song the filter missed can be listened to and asked about again (longer, later, by hand). Only the latest KEEP
stay; nothing here changes what the filter does.
"""
import time

import numpy as np

from mor_helper import paths
from mor_helper.musicfilter import songs

KEEP = 20  # clips kept, the latest (about half a MB each at 5 s)


def folder():
    return paths.local() / "unnamed"


def level(sound):
    """How loud the sound is (its RMS, 1.0 being full scale): near nothing means Shazam was asked about silence."""
    return float(np.sqrt(np.mean(np.square(sound, dtype=np.float64)))) if len(sound) else 0.0


def keep(sound, rate=songs.RATE, where=None, now=None, limit=KEEP):
    """Saves these mono samples as a WAV named by the time (to the second; a second one in it gets a number), and
    removes all but the latest `limit`. Returns the file's path; OSError when it can't be kept."""
    where = where or folder()
    where.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
    path, n = where / f"{stamp}.wav", 1
    while path.exists():
        n += 1
        path = where / f"{stamp}-{n}.wav"
    path.write_bytes(songs.wav_bytes(sound, rate))
    for old in sorted(where.glob("*.wav"), key=lambda p: (p.stat().st_mtime, p.name))[:-limit]:
        old.unlink(missing_ok=True)
    return path
