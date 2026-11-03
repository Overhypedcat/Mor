"""What song is playing (Shazam), and its clean copy (YouTube Music, else YouTube).

Copies are kept in local AppData, up to KEEP_BYTES all told (the oldest used go first), and so is which copy
matched which song (the latest INDEX_MAX songs), so a song heard before needs neither a search nor a download. Each
matched copy also keeps a small print of itself (align.thin), by which a song heard before is told again without
asking Shazam: streamers play the same songs again and again. What goes wrong is raised as
a Problem saying what happened, for the extension to show.
"""
import asyncio
import io
import json
import os
import re
import wave
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote_plus

import numpy as np

from mor_helper import paths

RATE = 48000
CANDIDATES = 3  # each search's top results tried for a match, in order
# where a song's copy is looked for, in order: YouTube Music's songs are the album recordings streamers play; YouTube
# has what it hasn't (music videos, lyric uploads, sped-up and remixed versions, game soundtracks, smaller artists)
SOURCES = ("YouTube Music", "YouTube")
KEEP_BYTES = 300 * 1024 * 1024  # the copies and their prints, all told
INDEX_MAX = 2000  # songs remembered in the index (a few dozen bytes each), the latest kept
PRINT = ".print.npy"  # a copy's print, beside it
ASK_S = 10  # one try at asking Shazam, at most this long: the filter asks again on its own a few seconds later


class Problem(Exception):
    """Something the user is told about: the message says what went wrong and why."""


class RateLimited(Problem):
    """Shazam is getting too many requests from this connection: it's asked again only after a while."""


@dataclass(frozen=True)
class Song:
    key: str  # Shazam's id for it
    title: str
    artist: str
    # where in the song (seconds) the sound Shazam heard began, by its own copy: a song whose bars repeat looks the
    # same in many places of its copy, and this says which. Not part of which song it is.
    offset: float | None = field(default=None, compare=False)

    def __str__(self):
        return f"{self.artist} - {self.title}" if self.artist else self.title


_ADDRESS = re.compile(r"https?://\S+")
_BARE_STATUS = re.compile(r"(?:answered\s+)?([45]\d\d)")  # a server's bare answer, nothing said with it
STATUSES = {403: "refused (403)", 404: "not found (404)", 429: "too many requests right now (429), it eases off "
            "in a while", 500: "had an error (500)", 502: "is having trouble (502)", 503: "is down for a moment (503)"}


def reason(error):
    """An exception as a short reason: its message without the web addresses in it (they say nothing and push the
    rest out of sight), a server's answer like 429 put into words, or its kind when it has none (a timeout)."""
    text = " ".join(_ADDRESS.sub("", str(error)).split())
    status = _BARE_STATUS.fullmatch(text)
    if status and int(status.group(1)) in STATUSES:
        return STATUSES[int(status.group(1))]
    return text[:160] if text else type(error).__name__


def folder():
    return paths.local() / "music"


def song_of(result):
    """The Song in Shazam's answer, or None when it didn't know."""
    track = (result or {}).get("track") if isinstance(result, dict) else None
    if not isinstance(track, dict) or not track.get("key") or not track.get("title"):
        return None
    return Song(str(track["key"]), str(track["title"]), str(track.get("subtitle") or ""), _offset(result))


def _offset(result):
    """Where in the song Shazam's best match says the sound began (seconds), or None when it doesn't say."""
    matches = result.get("matches")
    first = matches[0] if isinstance(matches, list) and matches else None
    offset = first.get("offset") if isinstance(first, dict) else None
    return float(offset) if isinstance(offset, (int, float)) and not isinstance(offset, bool) and offset >= 0 else None


def wav_bytes(sound, rate=RATE):
    """Mono float samples as a 16-bit WAV file, the way Shazam takes them."""
    pcm = (np.clip(sound, -1, 1) * 32767).astype("<i2").tobytes()
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return out.getvalue()


def recognize(sound, rate=RATE):
    """The song in these few seconds of mono sound, or None when Shazam doesn't know it (talking, or a song it
    hasn't got); Problem when Shazam couldn't be asked."""
    from aiohttp_retry import ExponentialRetry
    from shazamio import HTTPClient, Shazam

    async def ask():
        # ShazamIO would otherwise try up to 20 times, waiting longer each time: a minute and more
        client = HTTPClient(retry_options=ExponentialRetry(attempts=1))
        try:
            return await asyncio.wait_for(Shazam(http_client=client).recognize(wav_bytes(sound, rate)), ASK_S)
        finally:
            await client.close()
    try:
        answer = asyncio.run(ask())
    except Exception as error:  # no connection, Shazam busy or changed
        if type(error).__name__ == "RateLimited":  # shazamio.exceptions.RateLimited
            raise RateLimited("Shazam is getting too many requests from this connection") from error
        raise Problem(f"Shazam couldn't be asked what's playing: {reason(error)}") from error
    return song_of(answer)


def search_url(song, source="YouTube Music"):
    words = f"{song.artist} {song.title}".strip()
    if source == "YouTube":
        return f"ytsearch{CANDIDATES}:{words}"
    return f"https://music.youtube.com/search?q={quote_plus(words)}#songs"


def candidate_ids(entries, limit=CANDIDATES):
    """The YouTube ids of the first songs in a YouTube Music search's flat results."""
    ids = [e.get("id") for e in entries or () if isinstance(e, dict)]
    return [i for i in ids if isinstance(i, str) and i][:limit]


class Library:
    """The clean copies: where each song's matched copy is, and the downloads themselves."""

    def __init__(self, root=None):
        self.root = Path(root) if root else folder()
        self.index_path = self.root / "songs.json"
        try:
            self.index = json.loads(self.index_path.read_text(encoding="utf-8"))
            if not isinstance(self.index, dict):
                self.index = {}
        except (OSError, ValueError):
            self.index = {}

    def known(self, song):
        """The YouTube id that matched this song before, or None."""
        found = self.index.get(song.key)
        if isinstance(found, dict):
            found = found.get("id")
        return found if isinstance(found, str) else None

    def remember(self, song, video_id):
        """This copy matched this song; it's kept among the latest INDEX_MAX."""
        self.index.pop(song.key, None)  # to the end: the latest
        self.index[song.key] = {"id": video_id, "title": song.title, "artist": song.artist}
        for old in list(self.index)[: max(0, len(self.index) - INDEX_MAX)]:
            del self.index[old]
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.index), encoding="utf-8")
        os.replace(tmp, self.index_path)

    def heard_before(self):
        """[(Song, YouTube id, its print's path)] of the songs whose copy and print are here, the latest first."""
        found = []
        for key, entry in reversed(list(self.index.items())):
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                continue  # from before songs were remembered by name: told again by Shazam, and kept by name then
            printed = self.root / (entry["id"] + PRINT)
            if printed.is_file() and self.path(entry["id"]):
                found.append((Song(key, str(entry.get("title") or ""), str(entry.get("artist") or "")),
                              entry["id"], printed))
        return found

    def keep_print(self, video_id, sound_print):
        """Keep a copy's print beside it (float16: half the room)."""
        self.root.mkdir(parents=True, exist_ok=True)
        tmp = self.root / f"{video_id}.tmp.npy"
        np.save(tmp, sound_print.astype(np.float16))
        os.replace(tmp, self.root / (video_id + PRINT))

    def candidates(self, song):
        """YouTube ids to try for this song: the one that matched before, then YouTube Music's top songs, then
        YouTube's (each searched for only when what came before doesn't do). A search that failed doesn't stop the
        next; it's raised (Problem) once the rest are tried."""
        first = self.known(song)
        tried = {first} if first else set()
        if first:
            yield first
        failed = None
        for source in SOURCES:
            try:
                found = self._search(song, source)
            except Problem as problem:
                failed = failed or problem
                continue
            for video_id in found:
                if video_id not in tried:
                    tried.add(video_id)
                    yield video_id
        if failed:
            raise failed

    def _search(self, song, source="YouTube Music"):
        """A source's top results for it (none when it hasn't got it); Problem when the search failed."""
        import yt_dlp
        from mor_helper.youtube import _Quiet, short_reason
        log = _Quiet()
        options = {"extract_flat": True, "quiet": True, "logger": log, "playlistend": CANDIDATES}
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                return candidate_ids(ydl.extract_info(search_url(song, source), download=False).get("entries"))
        except Exception as error:
            why = short_reason(log.last or reason(error))
            raise Problem(f"Searching {source} for {song} failed: {why}") from error

    def path(self, video_id):
        """The downloaded copy of this YouTube song, if it's here."""
        found = sorted(self.root.glob(f"{video_id}.*"))
        found = [p for p in found if p.suffix not in (".json", ".part", ".tmp", ".ytdl", ".npy")]
        return found[0] if found else None

    def fetch(self, video_id):
        """The copy's file, downloaded when it isn't here yet; Problem saying why when it can't be had."""
        have = self.path(video_id)
        if have:
            os.utime(have)  # used: the last to go when making room
            return have
        import yt_dlp
        from mor_helper.youtube import _Quiet, js_runtimes, short_reason
        runtimes = js_runtimes()
        if not runtimes:
            raise Problem("Downloading from YouTube needs Node.js or Deno installed")
        self.root.mkdir(parents=True, exist_ok=True)
        log = _Quiet()
        options = {"quiet": True, "logger": log, "format": "bestaudio", "noprogress": True,
                   "outtmpl": str(self.root / "%(id)s.%(ext)s"), "js_runtimes": runtimes}
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])  # YouTube Music's songs too
        except Exception as error:
            raise Problem(short_reason(log.last or reason(error))) from error
        self.make_room()
        have = self.path(video_id)
        if not have:
            raise Problem(short_reason(log.last) if log.last else "the download left no file")
        return have

    def make_room(self, keep=KEEP_BYTES):
        """Drop the copies used longest ago (each with its print) until what's kept fits in keep bytes."""
        groups = {}  # YouTube id -> its files (the copy, its print)
        for p in self.root.glob("*"):
            if p.is_file() and p.name != self.index_path.name:
                groups.setdefault(p.name.split(".")[0], []).append(p)
        used = sorted(groups.values(), key=lambda files: max(f.stat().st_mtime for f in files), reverse=True)
        total = 0
        for files in used:
            total += sum(f.stat().st_size for f in files)
            if total > keep:
                for f in files:
                    try:
                        f.unlink()
                    except OSError:
                        pass  # in use right now: it goes after a later download, nothing is lost meanwhile


def load(path, rate=RATE):
    """A song file as 16-bit stereo at rate, shape (2, samples); Problem when it can't be read."""
    import av
    try:
        with av.open(str(path)) as container:
            if not container.streams.audio:
                raise Problem("the download has no sound in it")
            resampler = av.AudioResampler(format="s16p", layout="stereo", rate=rate)
            parts = [f.to_ndarray() for frame in container.decode(container.streams.audio[0])
                     for f in resampler.resample(frame)]
            parts += [f.to_ndarray() for f in resampler.resample(None)]
    except (av.FFmpegError, OSError) as error:
        raise Problem(f"the download couldn't be read: {reason(error)}") from error
    if not parts:
        raise Problem("the download has no sound in it")
    return np.concatenate(parts, axis=1)
