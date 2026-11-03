"""The helper as Firefox starts it: a native messaging host, talking to Mor's extension over its stdin and stdout
(each message a 4-byte length, then JSON). It has no window; it lives as long as the extension keeps it connected
and ends when Firefox closes the connection, taking the tunnel with it (winjob).

What it does for the extension: the music filter's thinking for each tab (session.py), the 1440p unlock's asks
through the VPN (unlock.py), and the VPN servers' list. Anything that goes wrong is answered, never dropped.
"""
import json
import logging
import logging.handlers
import struct
import sys
import threading
import time
import traceback

from mor_helper import paths, unlock, vpn
from mor_helper.musicfilter import relay, songs
from mor_helper.session import FilterSession
from mor_helper.youtube import js_runtimes

VERSION = "1.0.0"
log = logging.getLogger("mor")


class Host:
    def __init__(self, reader, writer, session_factory=FilterSession, prober=unlock.probe):
        self.reader, self.writer = reader, writer
        self.write_lock = threading.Lock()
        self.sessions = {}
        self.budget = relay.Budget(time.monotonic)  # Shazam's: one connection, however many tabs
        self.library = None
        self.tunnel = vpn.Tunnel()
        self.unlock_lock = threading.Lock()  # one ask at a time: there's a single tunnel
        self.session_factory, self.prober = session_factory, prober

    # the wire

    def send(self, message):
        data = json.dumps(message, separators=(",", ":")).encode("utf-8")
        with self.write_lock:
            self.writer.write(struct.pack("<I", len(data)) + data)
            self.writer.flush()

    def receive(self):
        """The next message, or None once Firefox has closed the connection."""
        head = self._read(4)
        if head is None:
            return None
        body = self._read(struct.unpack("<I", head)[0])
        return None if body is None else json.loads(body.decode("utf-8"))

    def _read(self, size):
        data = b""
        while len(data) < size:
            more = self.reader.read(size - len(data))
            if not more:
                return None
            data += more
        return data

    def run(self):
        try:
            while True:
                message = self.receive()
                if message is None:
                    return
                try:
                    self.handle(message)
                except Exception as error:  # told, and the helper carries on
                    log.error("handling %s: %s", message.get("type"), traceback.format_exc())
                    self.send({"type": "error", "about": message.get("type"),
                               "text": f"Mor's helper ran into an error: {type(error).__name__}: {songs.reason(error)}"})
        finally:
            self.close()

    def close(self):
        for session in self.sessions.values():
            session.stop()
        self.sessions.clear()
        self.tunnel.stop()

    # what the extension asks

    def handle(self, message):
        kind = message.get("type")
        sid = message.get("sid")
        if kind == "heard":
            session = self.sessions.get(sid)
            if session:
                session.hear(message["data"])
        elif kind == "hello":
            self.send({"type": "hello", "version": VERSION, **self.setup()})
        elif kind == "filter-start":
            self._stop_session(sid)
            if self.library is None:
                self.library = songs.Library()
            session = self.session_factory(sid, self.send, self.budget, library=self.library)
            self.sessions[sid] = session
            session.start()
        elif kind == "filter-stop":
            self._stop_session(sid)
        elif kind == "retry":
            if sid in self.sessions:
                self.sessions[sid].retry()
        elif kind == "broken":
            if sid in self.sessions:
                self.sessions[sid].broken(message.get("text") or "The music filter broke")
        elif kind == "unlock":
            threading.Thread(target=self._unlock, args=(message,), daemon=True).start()
        elif kind == "tunnel-stop":
            self.tunnel.stop()
            self.send({"type": "tunnel", "up": False})
        elif kind == "servers":
            self.send(self.servers())
        elif kind == "server-add":
            ok, why = vpn.add_config(message.get("name") or "", message.get("text") or "")
            self.send({**self.servers(), "error": why})
        elif kind == "server-remove":
            vpn.remove_config(message.get("name") or "")
            self.send(self.servers())
        else:
            self.send({"type": "error", "about": kind, "text": f"Mor's helper doesn't know '{kind}', update it"})

    def _stop_session(self, sid):
        session = self.sessions.pop(sid, None)
        if session:
            session.stop()

    def _unlock(self, message):
        with self.unlock_lock:
            try:
                result = self.prober(message["channel"], message["token"], self.tunnel)
            except Exception as error:
                log.error("unlock: %s", traceback.format_exc())
                result = {"master": None, "qualities": [], "port": None, "server": None,
                          "error": f"The 1440p unlock ran into an error: {type(error).__name__}: {songs.reason(error)}"}
        self.send({"type": "unlock", "id": message.get("id"), "channel": message["channel"], **result})

    def setup(self):
        """What the features need from this PC, for the extension to say what's missing."""
        return {"tunnel": vpn.wireproxy_path() is not None, "javascript": bool(js_runtimes()),
                "servers": [p.stem for p in vpn.configs()]}

    def servers(self):
        in_use = self.tunnel.conf.stem if self.tunnel.running() and self.tunnel.conf else None
        return {"type": "servers", "servers": [p.stem for p in vpn.configs()], "inUse": in_use, "error": None}


def main():
    folder = paths.local()
    folder.mkdir(parents=True, exist_ok=True)
    # what the helper did, step by step, for reports: kept to a few MB (the oldest part goes first)
    handler = logging.handlers.RotatingFileHandler(folder / "helper.log", maxBytes=1_000_000, backupCount=2,
                                                   encoding="utf-8")
    logging.basicConfig(handlers=[handler], level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    for name in ("shazamio", "shazamio_core"):  # (a line per request, saying nothing)
        logging.getLogger(name).setLevel(logging.WARNING)
    log.info("started %s", VERSION)
    try:
        Host(sys.stdin.buffer, sys.stdout.buffer).run()
    finally:
        log.info("ended")
    return 0
