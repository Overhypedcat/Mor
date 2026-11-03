import io
import json
import os
import tempfile
import time
import unittest
import wave
from pathlib import Path
from unittest import mock

import numpy as np

from mor_helper.musicfilter import songs
from mor_helper.musicfilter.songs import Song


class ShazamAnswerTests(unittest.TestCase):
    def test_the_song_it_knew(self):
        answer = {"matches": [{}], "track": {"key": "40787562", "title": "Feel Good Inc", "subtitle": "Gorillaz"}}
        self.assertEqual(songs.song_of(answer), Song("40787562", "Feel Good Inc", "Gorillaz"))

    def test_where_in_the_song_shazam_heard(self):
        answer = {"matches": [{"offset": 81.25}], "track": {"key": "1", "title": "T", "subtitle": "A"}}
        song = songs.song_of(answer)
        self.assertEqual(song.offset, 81.25)
        self.assertEqual(song, Song("1", "T", "A"))  # the place isn't part of which song it is
        for odd in ([{}], [{"offset": "81"}], [{"offset": -1}], [], None, ["x"]):
            self.assertIsNone(songs.song_of({"matches": odd, "track": {"key": "1", "title": "T"}}).offset)

    def test_nothing_known(self):
        self.assertIsNone(songs.song_of({"matches": []}))
        self.assertIsNone(songs.song_of({"track": {"title": "no key"}}))
        self.assertIsNone(songs.song_of(None))
        self.assertIsNone(songs.song_of("garbage"))

    def test_wav_for_shazam(self):
        data = songs.wav_bytes(np.array([0.0, 0.5, -2.0], np.float32))
        with wave.open(io.BytesIO(data)) as w:
            self.assertEqual((w.getnchannels(), w.getsampwidth(), w.getframerate()), (1, 2, songs.RATE))
            samples = np.frombuffer(w.readframes(3), "<i2")
        self.assertEqual(samples.tolist(), [0, 16383, -32767])  # clipped, never wrapped around

    def test_shazam_unreachable_is_a_problem(self):
        with mock.patch("shazamio.Shazam.recognize", side_effect=OSError("offline")):
            with self.assertRaises(songs.Problem) as caught:
                songs.recognize(np.zeros(songs.RATE, np.float32))
        self.assertEqual(str(caught.exception), "Shazam couldn't be asked what's playing: offline")

    def test_shazam_limiting_is_its_own_problem(self):
        from shazamio.exceptions import RateLimited
        with mock.patch("shazamio.Shazam.recognize", side_effect=RateLimited("rate limited the request")):
            with self.assertRaises(songs.RateLimited):
                songs.recognize(np.zeros(songs.RATE, np.float32))

    def test_a_reason_without_words_is_its_kind(self):
        self.assertEqual(songs.reason(TimeoutError()), "TimeoutError")
        self.assertEqual(songs.reason(OSError("two\nlines")), "two lines")

    def test_a_reason_never_hides_behind_a_web_address(self):
        long = "https://amp.shazam.com/discovery/v5/en-US/GB/iphone/-/tag/" + "A" * 200 + "?sync=true"
        self.assertEqual(songs.reason(OSError(f"{long} answered 429")),
                         "too many requests right now (429), it eases off in a while")
        self.assertEqual(songs.reason(OSError(f"{long} answered 418")), "answered 418")
        self.assertEqual(songs.reason(OSError(long)), "OSError")

    def test_song_names(self):
        self.assertEqual(str(Song("1", "Feel Good Inc", "Gorillaz")), "Gorillaz - Feel Good Inc")
        self.assertEqual(str(Song("1", "Untitled", "")), "Untitled")


class SearchTests(unittest.TestCase):
    def test_search_url(self):
        song = Song("1", "Feel Good Inc", "Gorillaz")
        self.assertEqual(songs.search_url(song), "https://music.youtube.com/search?q=Gorillaz+Feel+Good+Inc#songs")
        self.assertEqual(songs.search_url(song, "YouTube"), "ytsearch3:Gorillaz Feel Good Inc")

    def test_candidates_from_flat_results(self):
        entries = [{"id": "a"}, {"title": "no id"}, None, {"id": "b"}, {"id": "c"}, {"id": "d"}]
        self.assertEqual(songs.candidate_ids(entries), ["a", "b", "c"])
        self.assertEqual(songs.candidate_ids(None), [])


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.song = Song("k", "Song", "Artist")

    def tearDown(self):
        self.folder.cleanup()

    def test_remembers_which_copy_matched(self):
        songs.Library(self.root).remember(self.song, "abc")
        self.assertEqual(songs.Library(self.root).known(self.song), "abc")
        self.assertEqual(json.loads((self.root / "songs.json").read_text()),
                         {"k": {"id": "abc", "title": "Song", "artist": "Artist"}})

    def test_an_index_from_before_still_reads(self):
        (self.root / "songs.json").write_text(json.dumps({"k": "abc"}))
        self.assertEqual(songs.Library(self.root).known(self.song), "abc")
        self.assertEqual(songs.Library(self.root).heard_before(), [])  # no name: told by Shazam again first

    def test_only_the_latest_songs_are_remembered(self):
        library = songs.Library(self.root)
        with mock.patch.object(songs, "INDEX_MAX", 3):
            for i in range(5):
                library.remember(Song(str(i), f"Song {i}", "Artist"), f"id{i}")
            library.remember(Song("2", "Song 2", "Artist"), "id2")  # heard again: the latest now
        self.assertEqual(list(songs.Library(self.root).index), ["3", "4", "2"])

    def test_songs_heard_before_with_their_prints(self):
        library = songs.Library(self.root)
        library.remember(self.song, "abc")
        library.remember(Song("other", "Other", "Artist"), "gone")  # its copy isn't here any more
        (self.root / "abc.webm").write_bytes(b"x")
        library.keep_print("abc", np.ones(10, np.float32))
        (self.root / ("gone" + songs.PRINT)).write_bytes(b"x")
        found = library.heard_before()
        self.assertEqual([(s.key, s.title, vid) for s, vid, _ in found], [("k", "Song", "abc")])
        self.assertEqual(np.load(found[0][2]).dtype, np.float16)
        self.assertEqual(library.path("abc"), self.root / "abc.webm")  # a print is never taken for the copy

    def test_a_broken_index_is_an_empty_one(self):
        (self.root / "songs.json").write_text("not json")
        self.assertIsNone(songs.Library(self.root).known(self.song))

    def test_searches_only_when_the_known_copy_doesnt_do(self):
        library = songs.Library(self.root)
        library.remember(self.song, "known")
        results = {"YouTube Music": ["x", "known", "y"], "YouTube": ["y", "z"]}
        with mock.patch.object(songs.Library, "_search", side_effect=lambda song, source: results[source]) as search:
            found = library.candidates(self.song)
            self.assertEqual(next(found), "known")
            search.assert_not_called()
            self.assertEqual(next(found), "x")
            self.assertEqual(search.call_count, 1)  # YouTube only when YouTube Music's don't do
            self.assertEqual(list(found), ["y", "z"])  # each tried once

    def test_a_failed_search_doesnt_stop_the_other(self):
        def search(song, source):
            if source == "YouTube Music":
                raise songs.Problem("Searching YouTube Music for Artist - Song failed: 503")
            return ["z"]
        with mock.patch.object(songs.Library, "_search", side_effect=search):
            found = songs.Library(self.root).candidates(self.song)
            self.assertEqual(next(found), "z")
            with self.assertRaises(songs.Problem):  # still told, once the rest were tried
                next(found)

    def test_a_failed_search_says_why(self):
        with mock.patch("yt_dlp.YoutubeDL") as ydl:
            ydl.return_value.__enter__.return_value.extract_info.side_effect = OSError("Connection refused")
            with self.assertRaises(songs.Problem) as caught:
                songs.Library(self.root)._search(self.song)
        self.assertEqual(str(caught.exception), "Searching YouTube Music for Artist - Song failed: Connection refused")

    def test_a_failed_download_says_why(self):
        with mock.patch("mor_helper.youtube.js_runtimes", return_value={"node": {}}), \
                mock.patch("yt_dlp.YoutubeDL") as ydl:
            ydl.return_value.__enter__.return_value.download.side_effect = OSError("HTTP Error 403: Forbidden")
            with self.assertRaises(songs.Problem) as caught:
                songs.Library(self.root).fetch("abc")
        self.assertEqual(str(caught.exception), "HTTP Error 403: Forbidden")

    def test_a_download_that_left_nothing(self):
        with mock.patch("mor_helper.youtube.js_runtimes", return_value={"node": {}}), mock.patch("yt_dlp.YoutubeDL"):
            with self.assertRaises(songs.Problem):
                songs.Library(self.root).fetch("abc")

    def test_downloading_needs_a_javascript_runtime(self):
        with mock.patch("mor_helper.youtube.js_runtimes", return_value={}):
            with self.assertRaises(songs.Problem) as caught:
                songs.Library(self.root).fetch("abc")
        self.assertIn("Node.js or Deno", str(caught.exception))

    def test_a_downloaded_copy_is_used_again(self):
        (self.root / "abc.webm").write_bytes(b"x")
        (self.root / "def.webm.part").write_bytes(b"x")  # a download that didn't finish
        library = songs.Library(self.root)
        self.assertEqual(library.fetch("abc"), self.root / "abc.webm")
        self.assertIsNone(library.path("def"))

    def test_makes_room_by_dropping_the_oldest(self):
        library = songs.Library(self.root)
        library.remember(self.song, "new")
        for i, name in enumerate(("old.webm", "old.print.npy", "mid.webm", "new.webm")):
            path = self.root / name
            path.write_bytes(b"x" * 100)
            os.utime(path, (time.time() - 100 + (i // 2) * 10 + i,) * 2)
        library.make_room(keep=250)  # the oldest goes with its print
        self.assertEqual(sorted(p.name for p in self.root.iterdir()), ["mid.webm", "new.webm", "songs.json"])


class LoadTests(unittest.TestCase):
    def test_reads_a_song_file_as_16_bit_stereo(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "tone.wav"
            tone = (np.sin(np.arange(22050) / 22050 * 2 * np.pi * 440) * 10000).astype("<i2")
            with wave.open(str(path), "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(22050)
                w.writeframes(tone.tobytes())
            sound = songs.load(path)
        self.assertEqual(sound.dtype, np.int16)
        self.assertEqual(sound.shape[0], 2)
        self.assertAlmostEqual(sound.shape[1], songs.RATE, delta=songs.RATE * 0.01)  # one second, at 48 kHz

    def test_unreadable(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "broken.webm"
            path.write_bytes(b"not a song")
            with self.assertRaises(songs.Problem) as caught:
                songs.load(path)
        self.assertTrue(str(caught.exception).startswith("the download couldn't be read: "))


if __name__ == "__main__":
    unittest.main()


class KeepTests(unittest.TestCase):
    def test_up_to_a_gigabyte_of_copies_is_kept(self):
        self.assertEqual(songs.KEEP_BYTES, 1024 ** 3)
