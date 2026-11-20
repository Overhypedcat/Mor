"""What the music filter is doing, told to the extension a line at a time.

LISTENING while no song is being taken out, FILTERING while one is. Anything that goes wrong is told too, never kept
quiet: PROBLEM with what happened (the filter carries on) and FINE once what failed works again; STEP with what it's
doing just now (asking Shazam, getting a song, lining it up, taking it out); READY with the seconds until Shazam may
be asked again (its budget), each time that changes; UNTIL with a countdown for what's shown (the step, or the
problem): "until step 60" makes "Resting" count down from a minute. The extension can send a retry back: have the
filter forget the song it's on and ask Shazam afresh. Standard library only.

Steps and problems are a few words, for the player's pill and the hub: never a song's name. A problem can carry the
whole story after SEP ("Shazam unreachable | Shazam couldn't be asked what's playing: timeout"), shown where there's
room for it (the pill's tooltip, the hub), for the user to report.
"""
import math
import threading

LISTENING = "listening"
FILTERING = "filtering"
PROBLEM = "problem"
FINE = "fine"
READY = "ready"
STEP = "step"
UNTIL = "until"
STATES = (LISTENING, FILTERING)
SEP = " | "  # between a problem's few words and the whole story


def problem(short, detail=None):
    """A problem as told: its few words, then what happened in full (left out when it says no more)."""
    return f"{short}{SEP}{detail}" if detail and detail != short else short


def line(kind, detail=None):
    """One message as sent: the kind, then the detail on the same line."""
    detail = " ".join((detail or "").split())  # one line, however the reason was written
    return f"{kind} {detail}".strip()


def parse(text):
    """(kind, detail) from a line sent, or None when it isn't one."""
    kind, _, detail = text.strip().partition(" ")
    if kind in STATES or kind == FINE:
        return kind, None
    if kind in (PROBLEM, STEP) and detail:
        return kind, detail
    if kind == READY and detail.isdigit():
        return kind, detail
    which, _, seconds = detail.partition(" ")
    if kind == UNTIL and which in (STEP, PROBLEM) and seconds.isdigit():
        return kind, detail
    return None


class Server:
    """Tells each change once: the same problem again only after the filter has worked in between, and a lasting
    problem (the filter broke) stays told whatever works after it. tell(line) sends a line on."""

    def __init__(self, tell):
        self.tell = tell
        self.state = LISTENING
        self.problem = None
        self.lasting = False
        self.ready_in = None  # seconds until Shazam may be asked, as last told
        self.step_text = None  # what the filter is doing, as last told
        self.lock = threading.Lock()

    def step(self, text):
        """What the filter is doing just now, in a few words, told when it changes."""
        with self.lock:
            if text == self.step_text:
                return
            self.step_text = text
            self.tell(line(STEP, text))

    def until(self, which, seconds):
        """A countdown for the step or the problem just told (which: STEP or PROBLEM), shown counting down."""
        with self.lock:
            self.tell(line(UNTIL, f"{which} {max(0, math.ceil(seconds))}"))

    def ready(self, seconds):
        """Seconds until Shazam may be asked again (0: now), told whenever its budget changes."""
        with self.lock:
            self.ready_in = max(0, int(seconds))
            self.tell(line(READY, str(self.ready_in)))

    def set(self, state):
        with self.lock:
            if state == self.state:
                return
            self.state = state
            self.tell(line(state))
        if state == FILTERING:
            self.report(None)  # working

    def report(self, problem, lasting=False):
        """Something went wrong and the filter carries on; None once what failed works again (told as FINE). A
        lasting problem stays told whatever works after it."""
        with self.lock:
            if self.lasting or problem == self.problem:
                return
            self.problem, self.lasting = problem, lasting
            self.tell(line(PROBLEM, problem) if problem else line(FINE))
