import subprocess
import sys
import unittest

# urllib3's percent pattern after the helper's modules load, in either order the rest of the helper might use them
CHECK = """
import {first}
import yt_dlp.networking._requests
import streamlink.session.http
import urllib3.util.url as url
assert url._PERCENT_RE.sub(lambda m: m.group(0).upper(), "a%2fb") == "a%2Fb"
assert url._PERCENT_RE.subn("x", "a%2fb")[1] == 1
print("ok")
"""


class NetCompatTests(unittest.TestCase):
    """yt-dlp's and streamlink's urllib3 wrappers together: streamlink's requests (the 1440p unlock) keep working."""

    def check(self, first):
        out = subprocess.run([sys.executable, "-c", CHECK.format(first=first)], capture_output=True, text=True)
        self.assertEqual(out.stdout.strip(), "ok", out.stderr[-600:])

    def test_the_unlock_loaded_first(self):
        self.check("mor_helper.unlock")

    def test_the_whole_helper(self):
        self.check("mor_helper.host")


if __name__ == "__main__":
    unittest.main()
