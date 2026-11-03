"""Per-stream VPN for Twitch's region-locked qualities (Enhanced Broadcasting's 1440p).

Twitch only offers those to logged-in viewers in some countries who can play HEVC. A WireGuard tunnel (wireproxy,
using the user's Proton configs) gives the stream alone an address in such a country: the helper asks Twitch for the
stream through it (unlock.py), and Firefox sends only that tab's video requests through it; nothing else on the PC
goes through it. The Twitch login is the auth-token cookie Firefox already has, handed over by the extension with
each ask and never kept.
"""
import re
import socket
import subprocess
import threading
import time
from pathlib import Path

from mor_helper import paths, winjob

TUNNEL_START_TIMEOUT = 10.0
CODECS = "h264,h265"  # the 1440p copies are HEVC
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_SAFE_NAME = re.compile(r"[^A-Za-z0-9._ -]")


def configs_dir():
    return paths.roaming() / "vpn"


def configs():
    """The user's WireGuard configs, in name order (tried one after another)."""
    return sorted(configs_dir().glob("*.conf"))


def wireproxy_path():
    path = paths.local() / "bin" / "wireproxy.exe"
    return path if path.is_file() else None


def looks_like_wireguard(text):
    return "[Interface]" in text and "[Peer]" in text and "PrivateKey" in text


def add_config(name, text):
    """Keep a WireGuard config the extension read from a file; (True, None), or (False, why not)."""
    if not looks_like_wireguard(text or ""):
        return False, f"{name} isn't a WireGuard config"
    stem = _SAFE_NAME.sub("", Path(name).stem).strip() or "server"
    configs_dir().mkdir(parents=True, exist_ok=True)
    (configs_dir() / f"{stem}.conf").write_text(text, encoding="utf-8")
    return True, None


def remove_config(name):
    target = configs_dir() / Path(name).name
    if target.suffix == ".conf":
        target.unlink(missing_ok=True)


def free_port():
    """A port nothing listens on right now."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def unlocked_only(direct, unlocked):
    """Qualities the tunnel offers that the normal connection doesn't."""
    return [q for q in unlocked if q not in direct]


def needs_vpn(quality, direct, unlocked):
    """Whether to play through the tunnel: the wanted quality only exists there, or 'best' is better there."""
    extra = unlocked_only(direct, unlocked)
    return bool(extra) and (quality in (None, "best") or quality in extra)


def wireproxy_config(conf, port):
    return f"WGConfig = {conf}\n\n[Socks5]\nBindAddress = 127.0.0.1:{port}\n"


class Tunnel:
    """One wireproxy tunnel; the free Proton plan allows a single connection, so never more than one. It lives in
    the helper's job: when the helper goes (Firefox closed, the extension off), so does the tunnel."""

    def __init__(self):
        self.proc = None
        self.proxy = None
        self.port = None
        self.conf = None
        self.lock = threading.RLock()

    def running(self):
        return self.proc is not None and self.proc.poll() is None

    def start(self, conf):
        with self.lock:
            return self._start(conf)

    def _start(self, conf):
        self._stop()
        wireproxy = wireproxy_path()
        if not wireproxy:
            return False
        port = free_port()
        run = paths.local() / "run"
        run.mkdir(parents=True, exist_ok=True)
        cfg = run / "wireproxy.conf"
        cfg.write_text(wireproxy_config(conf, port), encoding="utf-8")
        self.proc = subprocess.Popen([str(wireproxy), "-c", str(cfg)], stdin=subprocess.DEVNULL,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=NO_WINDOW)
        winjob.adopt(self.proc)
        deadline = time.monotonic() + TUNNEL_START_TIMEOUT
        while time.monotonic() < deadline and self.running():
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
                self.proxy, self.port, self.conf = f"socks5h://127.0.0.1:{port}", port, conf
                return True
            except OSError:
                time.sleep(0.2)
        self._stop()
        return False

    def stop(self):
        with self.lock:
            self._stop()

    def _stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()
        self.proc = self.proxy = self.port = self.conf = None
