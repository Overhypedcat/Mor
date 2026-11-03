import unittest
from pathlib import Path
from unittest import mock

from mor_helper import unlock

MASTER = "#EXTM3U\n#EXT-X-MEDIA:TYPE=VIDEO,NAME=\"1440p60\"\nhttps://x/1440.m3u8\n"


class FakeTunnel:
    def __init__(self, works=lambda conf: True):
        self.works, self.conf, self.up, self.started, self.stopped = works, None, False, [], 0
        self.proxy, self.port = "socks5h://127.0.0.1:5555", 5555

    def running(self):
        return self.up

    def start(self, conf):
        self.started.append(conf.stem)
        self.up = self.works(conf)
        self.conf = conf if self.up else None
        return self.up

    def stop(self):
        self.stopped += 1
        self.up, self.conf = False, None


SERVERS = [Path("a.conf"), Path("b.conf"), Path("c.conf")]


class ProbeTests(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch("mor_helper.vpn.wireproxy_path", return_value=Path("wireproxy.exe"))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_first_server_that_answers_is_kept_up(self):
        tunnel = FakeTunnel(lambda conf: conf.stem != "a")
        fetched = []

        def fetcher(channel, proxy, token):
            fetched.append((channel, proxy, token))
            return MASTER, ["1080p60", "1440p60"], None
        result = unlock.probe("someone", "tok", tunnel, SERVERS, fetcher)
        self.assertEqual(result["master"], MASTER)
        self.assertEqual(result["server"], "b")
        self.assertEqual(result["port"], 5555)
        self.assertEqual(tunnel.started, ["a", "b"])
        self.assertEqual(fetched, [("someone", "socks5h://127.0.0.1:5555", "tok")])
        self.assertTrue(tunnel.running())

    def test_a_tunnel_already_up_is_asked_first_without_a_restart(self):
        tunnel = FakeTunnel()
        tunnel.start(SERVERS[2])
        result = unlock.probe("x", "t", tunnel, SERVERS, lambda *a: (MASTER, ["1440p60"], None))
        self.assertEqual(result["server"], "c")
        self.assertEqual(tunnel.started, ["c"])

    def test_a_rejected_login_stops_at_the_first_and_says_so(self):
        tunnel = FakeTunnel()
        result = unlock.probe("x", "t", tunnel, SERVERS, lambda *a: (None, [], "Unauthorized: authorization failed"))
        self.assertEqual(tunnel.started, ["a"])
        self.assertIn("rejected the login", result["error"])
        self.assertFalse(tunnel.running())

    def test_nothing_answering_is_said(self):
        tunnel = FakeTunnel(lambda conf: False)
        result = unlock.probe("x", "t", tunnel, SERVERS, lambda *a: (MASTER, [], None))
        self.assertIsNone(result["master"])
        self.assertIn("Couldn't connect to a", result["error"])

    def test_what_is_missing_is_said(self):
        self.assertEqual(unlock.probe("x", "t", FakeTunnel(), [], lambda *a: None)["error"], "No VPN servers yet")
        with mock.patch("mor_helper.vpn.wireproxy_path", return_value=None):
            self.assertIn("tunnel program is missing", unlock.probe("x", "t", FakeTunnel(), SERVERS)["error"])


class FetchTests(unittest.TestCase):
    """fetch asks streamlink the way the unlock always has: through the proxy, logged in, HEVC allowed."""

    def session(self, streams=None, error=None, master=MASTER):
        test = self

        class Http:
            hooks = {"response": []}

        class Session:
            def __init__(self, options):
                test.options = options
                self.http = Http()
                self.http.hooks = {"response": []}

            def streams(self, url, options=None):
                test.url, test.plugin_options = url, options
                if error:
                    raise error
                response = mock.Mock(url="https://usher.ttvnw.net/api/v2/channel/hls/x.m3u8?a=1", ok=True, text=master)
                for hook in self.http.hooks["response"]:
                    hook(response)
                return streams
        return Session

    def test_asked_through_the_proxy_logged_in_with_hevc(self):
        streams = {"audio_only": 1, "720p60": 1, "1440p60": 1, "best": 1, "worst": 1, "1080p60_portrait": 1}
        master, qualities, error = unlock.fetch("x", "socks5h://p", "tok", self.session(streams))
        self.assertEqual((master, qualities, error), (MASTER, ["720p60", "1440p60"], None))
        self.assertEqual(self.options, {"http-proxy": "socks5h://p"})
        self.assertEqual(self.plugin_options.get("api-header"), [("Authorization", "OAuth tok")])
        self.assertEqual(self.plugin_options.get("supported-codecs"), ["h264", "h265"])
        self.assertEqual(self.url, "https://twitch.tv/x")

    def test_offline_and_errors_are_said(self):
        self.assertEqual(unlock.fetch("x", "p", "t", self.session({}))[2], "x isn't live through the VPN")
        self.assertEqual(unlock.fetch("x", "p", "t", self.session(error=OSError("refused")))[2], "refused")


if __name__ == "__main__":
    unittest.main()
