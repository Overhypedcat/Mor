"""Where Mor's helper keeps its things: roaming AppData (the VPN servers) and local AppData (the songs' clean
copies, the tunnel program and its config). Standard library only (the installer uses it before setup)."""
import os
from pathlib import Path

NAME = "Mor"


def roaming():
    return folder("APPDATA")


def local():
    return folder("LOCALAPPDATA")


def folder(variable):
    return Path(os.environ.get(variable) or Path.home()) / NAME
