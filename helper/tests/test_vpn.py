import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from mor_helper import vpn


class UnlockDecisionTests(unittest.TestCase):
    DIRECT = ["160p30", "720p60", "1080p60"]
    UNLOCKED = ["160p30", "720p60", "1080p60", "1440p60"]

    def test_unlocked_only(self):
        self.assertEqual(vpn.unlocked_only(self.DIRECT, self.UNLOCKED), ["1440p60"])
        self.assertEqual(vpn.unlocked_only(self.DIRECT, self.DIRECT), [])

    def test_best_goes_through_the_vpn_only_when_it_is_better_there(self):
        self.assertTrue(vpn.needs_vpn("best", self.DIRECT, self.UNLOCKED))
        self.assertTrue(vpn.needs_vpn(None, self.DIRECT, self.UNLOCKED))
        self.assertFalse(vpn.needs_vpn("best", self.DIRECT, self.DIRECT))
        self.assertFalse(vpn.needs_vpn("best", self.DIRECT, []))  # not checked yet

    def test_a_quality_the_normal_connection_has_stays_off_the_vpn(self):
        self.assertFalse(vpn.needs_vpn("1080p60", self.DIRECT, self.UNLOCKED))
        self.assertTrue(vpn.needs_vpn("1440p60", self.DIRECT, self.UNLOCKED))


class WireproxyTests(unittest.TestCase):
    def test_wireproxy_config(self):
        text = vpn.wireproxy_config(Path(r"C:\x\nl.conf"), 4321)
        self.assertIn(r"WGConfig = C:\x\nl.conf", text)
        self.assertIn("[Socks5]\nBindAddress = 127.0.0.1:4321", text)


CONF = "[Interface]\nPrivateKey = abc\nAddress = 10.2.0.2/32\n\n[Peer]\nPublicKey = def\nEndpoint = 1.2.3.4:51820\n"


class ServerListTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"APPDATA": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_added_listed_in_order_and_removed(self):
        self.assertEqual(vpn.add_config("wg-NL-FREE-2.conf", CONF), (True, None))
        self.assertEqual(vpn.add_config("wg-JP-FREE-1.conf", CONF), (True, None))
        self.assertEqual([p.stem for p in vpn.configs()], ["wg-JP-FREE-1", "wg-NL-FREE-2"])
        vpn.remove_config("wg-JP-FREE-1.conf")
        self.assertEqual([p.stem for p in vpn.configs()], ["wg-NL-FREE-2"])

    def test_anything_else_is_refused_and_said(self):
        ok, why = vpn.add_config("notes.txt", "hello")
        self.assertFalse(ok)
        self.assertIn("isn't a WireGuard config", why)
        self.assertEqual(vpn.configs(), [])

    def test_a_name_cant_leave_the_folder(self):
        vpn.add_config("../../evil.conf", CONF)
        self.assertEqual([p.parent for p in vpn.configs()], [vpn.configs_dir()])
        vpn.remove_config("../x.txt")  # not a config: nothing happens


if __name__ == "__main__":
    unittest.main()
