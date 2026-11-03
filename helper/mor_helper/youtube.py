"""What songs.py uses of YouTube: yt-dlp's messages kept quiet, its errors in a line, and the JavaScript runtimes
it solves YouTube's puzzles with."""
import shutil

JS_RUNTIMES = ("deno", "node", "bun")


class _Quiet:
    """yt-dlp's messages, kept: the last error is what's told when something goes wrong."""

    def __init__(self):
        self.last = None  # not "error": that's the method yt-dlp calls

    def debug(self, msg):
        pass

    def info(self, msg):
        pass

    def warning(self, msg):
        pass

    def error(self, msg):
        self.last = msg


def short_reason(message):
    """A one-line reason from a yt-dlp error."""
    text = (message or "").replace("ERROR:", "").strip()
    lowered = text.lower()
    if "sign in" in lowered or "login" in lowered:
        return "YouTube wants a login for this one"
    return text.splitlines()[0][:120] if text else "YouTube couldn't be reached"


def js_runtimes():
    """The JavaScript runtimes on this computer, as yt-dlp wants them."""
    return {name: {} for name in JS_RUNTIMES if shutil.which(name)}
