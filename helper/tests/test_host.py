import io
import json
import os
import struct
import tempfile
import time
import unittest
from unittest import mock

from mor_helper import host


def wire(*messages):
    out = b""
    for m in messages:
        data = json.dumps(m).encode()
        out += struct.pack("<I", len(data)) + data
    return io.BytesIO(out)


def unwire(data):
    messages, at = [], 0
    while at < len(data):
        size = struct.unpack("<I", data[at:at + 4])[0]
        messages.append(json.loads(data[at + 4:at + 4 + size]))
        at += 4 + size
    return messages


class FakeSession:
    made = []

    def __init__(self, sid, send, budget, library=None):
        self.sid, self.heard, self.stopped, self.retried = sid, [], False, 0
        FakeSession.made.append(self)

    def start(self):
        pass

    def stop(self):
        self.stopped = True

    def hear(self, data):
        self.heard.append(data)

    def retry(self):
        self.retried += 1


class HostTests(unittest.TestCase):
    def setUp(self):
        FakeSession.made = []
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patcher = mock.patch.dict(os.environ, {"APPDATA": self.tmp.name, "LOCALAPPDATA": self.tmp.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_host(self, *messages, prober=None):
        out = io.BytesIO()
        h = host.Host(wire(*messages), out, session_factory=FakeSession, prober=prober or (lambda *a: {}))
        with mock.patch("mor_helper.host.songs.Library"):
            h.run()
        return h, unwire(out.getvalue())

    def test_a_tabs_filter_hears_retries_and_ends_with_the_connection(self):
        h, _ = self.run_host({"type": "filter-start", "sid": "1"}, {"type": "heard", "sid": "1", "data": "AAAA"},
                             {"type": "retry", "sid": "1"}, {"type": "heard", "sid": "nobody", "data": "x"})
        session, = FakeSession.made
        self.assertEqual((session.heard, session.retried), (["AAAA"], 1))
        self.assertTrue(session.stopped)  # Firefox closed the connection: everything stops
        self.assertEqual(h.sessions, {})

    def test_starting_again_replaces_the_tabs_filter(self):
        self.run_host({"type": "filter-start", "sid": "1"}, {"type": "filter-start", "sid": "1"},
                      {"type": "filter-stop", "sid": "1"})
        first, second = FakeSession.made
        self.assertTrue(first.stopped and second.stopped)

    def test_hello_says_what_is_set_up(self):
        _, replies = self.run_host({"type": "hello"})
        self.assertEqual(replies[0]["type"], "hello")
        self.assertEqual(replies[0]["version"], host.VERSION)
        self.assertEqual(replies[0]["servers"], [])
        self.assertIn("tunnel", replies[0])

    def test_servers_added_and_removed(self):
        conf = "[Interface]\nPrivateKey = a\n[Peer]\n"
        _, replies = self.run_host({"type": "server-add", "name": "wg-NL-FREE-1.conf", "text": conf},
                                   {"type": "server-add", "name": "x.conf", "text": "nope"},
                                   {"type": "server-remove", "name": "wg-NL-FREE-1.conf"})
        self.assertEqual(replies[0]["servers"], ["wg-NL-FREE-1"])
        self.assertIn("isn't a WireGuard config", replies[1]["error"])
        self.assertEqual(replies[2]["servers"], [])

    def test_an_unlock_is_answered_with_its_id(self):
        def prober(channel, token, tunnel):
            return {"master": "#EXTM3U", "qualities": ["1440p60"], "error": None, "port": 1, "server": "a"}
        h = host.Host(wire(), io.BytesIO(), prober=prober)
        h.writer = io.BytesIO()
        h.handle({"type": "unlock", "id": 7, "channel": "x", "token": "t"})
        deadline = time.monotonic() + 2
        while not h.writer.getvalue() and time.monotonic() < deadline:
            time.sleep(0.01)
        reply, = unwire(h.writer.getvalue())
        self.assertEqual((reply["id"], reply["master"], reply["channel"]), (7, "#EXTM3U", "x"))

    def test_an_unlock_that_crashes_is_said(self):
        def prober(*a):
            raise RuntimeError("boom")
        h = host.Host(wire(), io.BytesIO(), prober=prober)
        h._unlock({"id": 1, "channel": "x", "token": "t"})
        reply, = unwire(h.writer.getvalue())
        self.assertIn("RuntimeError: boom", reply["error"])

    def test_anything_going_wrong_is_answered_not_dropped(self):
        _, replies = self.run_host({"type": "what"}, {"type": "retry"})
        self.assertIn("doesn't know 'what'", replies[0]["text"])

    def test_a_crash_in_handling_is_told(self):
        with mock.patch("mor_helper.vpn.add_config", side_effect=ValueError("bad")):
            _, replies = self.run_host({"type": "server-add", "name": "a", "text": "b"})
        self.assertEqual(replies[0]["type"], "error")
        self.assertIn("ValueError: bad", replies[0]["text"])


if __name__ == "__main__":
    unittest.main()
