"""The 1440p unlock's ask: Twitch's playlist for a channel, asked for through the VPN tunnel, logged in, with HEVC
allowed, through streamlink's Twitch plugin: the extension hands it to the tab's
player in place of the one Twitch gave Firefox, and sends that tab's video through the same tunnel.

The servers are tried one after another, in case a free one is busy; a rejected login stops at the first, since no
other server would take it either.
"""
from mor_helper import netcompat  # noqa: F401  (before streamlink: see netcompat)
from streamlink import Streamlink
from streamlink.options import Options

from mor_helper import vpn

USHER = ("https://usher.ttvnw.net/api/v2/channel/hls/", "https://usher.ttvnw.net/api/channel/hls/")
NOT_QUALITIES = {"worst", "best", "audio_only"}


def is_quality(name):
    """Whether a stream name is a quality; Twitch's vertical copies (…_portrait) aren't."""
    return name not in NOT_QUALITIES and not name.endswith("_portrait")


def fetch(channel, proxy, token, session_factory=Streamlink):
    """(multivariant playlist text, qualities, error) for a live channel through the proxy; text None on failure."""
    session = session_factory({"http-proxy": proxy})
    seen = {}

    def keep_master(response, *args, **kwargs):
        if response.url.startswith(USHER) and response.ok:
            seen["master"] = response.text

    session.http.hooks["response"].append(keep_master)
    options = Options({"api-header": [("Authorization", f"OAuth {token}")],
                       "supported-codecs": vpn.CODECS.split(","), "low-latency": True})
    try:
        streams = session.streams(f"https://twitch.tv/{channel}", options=options)
    except Exception as error:  # streamlink's PluginError and the connection's own
        return None, [], str(error) or type(error).__name__
    qualities = [name for name in streams if is_quality(name)]
    if not qualities or "master" not in seen:
        return None, [], f"{channel} isn't live through the VPN"
    return seen["master"], qualities, None


def probe(channel, token, tunnel, servers=None, fetcher=fetch):
    """Ask through each server until one answers: {master, qualities, error, port, server}. The tunnel stays up on
    the server that answered (the tab's video goes through it); when none did it's stopped."""
    servers = vpn.configs() if servers is None else servers
    if not vpn.wireproxy_path():
        return _failed("The tunnel program is missing, run Mor's installer again")
    if not servers:
        return _failed("No VPN servers yet")
    error = None
    ordered = sorted(servers, key=lambda conf: conf != tunnel.conf)  # the one up already first: no restart
    for conf in ordered:
        if not (tunnel.running() and tunnel.conf == conf) and not tunnel.start(conf):
            error = error or f"Couldn't connect to {conf.stem}"
            continue
        master, qualities, problem = fetcher(channel, tunnel.proxy, token)
        if master:
            return {"master": master, "qualities": qualities, "error": None, "port": tunnel.port,
                    "server": conf.stem}
        error = problem
        if problem and "authorization" in problem.lower():
            break  # the token, not the server: no point trying the others
    tunnel.stop()
    if error and "authorization" in error.lower():
        error = "Twitch rejected the login, log in to Twitch in Firefox again"
    return _failed(error or "No VPN server answered")


def _failed(error):
    return {"master": None, "qualities": [], "error": error, "port": None, "server": None}
