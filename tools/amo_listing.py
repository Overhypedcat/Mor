"""Fills Mor's page on the add-on store (addons.mozilla.org) from store/: the texts in store/listing.md, the icon and
the screenshots, through AMO's API with the API keys in .amo-keys (git-ignored). Run with the helper's Python, which
has `requests`:

    helper\\.venv\\Scripts\\python tools\\amo_listing.py            the texts, the icon and the screenshots
    helper\\.venv\\Scripts\\python tools\\amo_listing.py --texts    only the texts
    helper\\.venv\\Scripts\\python tools\\amo_listing.py --images   only the icon and the screenshots

Each part that AMO refuses is said, with AMO's own reason; the rest still goes through.
"""
import base64
import hashlib
import hmac
import json
import re
import sys
import time
import uuid
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
STORE = ROOT / "store"
API = "https://addons.mozilla.org/api/v5/addons/addon/mor@overhypedcat"
LOCALE = "en-US"


def token():
    """A JWT for AMO's API, good for a minute."""
    key, secret = [line.strip() for line in (ROOT / ".amo-keys").read_text().splitlines() if line.strip()][:2]
    enc = lambda data: base64.urlsafe_b64encode(data).rstrip(b"=")
    now = int(time.time())
    head = enc(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
    body = enc(json.dumps({"iss": key, "jti": str(uuid.uuid4()), "iat": now, "exp": now + 60}).encode())
    sig = enc(hmac.new(secret.encode(), head + b"." + body, hashlib.sha256).digest())
    return {"Authorization": "JWT " + (head + b"." + body + b"." + sig).decode()}


def sections(text):
    """listing.md's sections: heading -> its text."""
    found = {}
    for part in re.split(r"^## ", text, flags=re.M)[1:]:
        title, _, rest = part.partition("\n")
        found[title.strip()] = rest.strip()
    return found


def texts():
    s = sections((STORE / "listing.md").read_text(encoding="utf-8"))
    summary = " ".join(s["Summary (250 characters at most)"].split())
    assert len(summary) <= 250, f"the summary is {len(summary)} characters, 250 at most"
    return {
        "name": {LOCALE: s["Name"].strip()},
        "slug": s["Add-on URL (slug)"].split()[0],
        "summary": {LOCALE: summary},
        "description": {LOCALE: s["Description"]},
        "categories": ["photos-music-videos"],
        "tags": [t.strip() for t in s["Tags"].split(",") if t.strip()],
        "homepage": {LOCALE: "https://github.com/Overhypedcat/Mor"},
        "support_url": {LOCALE: "https://github.com/Overhypedcat/Mor/issues"},
    }


def throttled(send):
    """Runs send() (a request), waiting out a short rate limit and trying again; a long one (AMO's hourly cap on
    listing edits) is reported instead, with how long to wait."""
    for _ in range(3):
        response = send()
        if response.status_code != 429:
            return response
        wait = re.search(r"(\d+) seconds", response.text)
        seconds = int(wait.group(1)) if wait else 60
        if seconds > 120:
            return response
        time.sleep(seconds + 2)
    return response


def report(what, response):
    if response.ok:
        print(f"{what}: done")
        return True
    print(f"{what}: refused ({response.status_code}) {response.text[:400]}")
    return False


def patch_fields(fields):
    """Sends the fields together; when AMO refuses one, the others are sent again without it."""
    r = requests.patch(API + "/", json=fields, headers=token(), timeout=60)
    if r.ok:
        return report("texts (" + ", ".join(fields) + ")", r)
    try:
        bad = set(r.json())
    except ValueError:
        bad = set()
    if not bad or not bad - set(fields) == set():
        return report("texts", r)
    print("refused:", r.text[:600])
    rest = {k: v for k, v in fields.items() if k not in bad}
    if rest:
        patch_fields(rest)
    return False


def icon():
    with open(STORE / "icon-128.png", "rb") as f:
        data = f.read()
    return report("icon", throttled(lambda: requests.patch(
        API + "/", files={"icon": ("icon-128.png", data, "image/png")}, headers=token(), timeout=60)))


def screenshots():
    s = sections((STORE / "listing.md").read_text(encoding="utf-8"))["Screenshots (with captions)"]
    captions = dict(re.findall(r"`([^`]+\.png)`:\s*(.+)", s))
    existing = requests.get(API + "/", headers=token(), timeout=60).json().get("previews", [])
    for preview in existing:  # replaced, so running this again doesn't pile them up
        throttled(lambda: requests.delete(f"{API}/previews/{preview['id']}/", headers=token(), timeout=60))
    for i, (name, caption) in enumerate(sorted(captions.items())):
        data = (STORE / name).read_bytes()
        if not report(f"screenshot {name}", throttled(lambda: requests.post(
                API + "/previews/", files={"image": (name, data, "image/png")},
                data={"caption": json.dumps({LOCALE: caption.strip()}), "position": str(i)},
                headers=token(), timeout=120))):
            return  # (the rest would be refused the same way)


if __name__ == "__main__":
    if "--images" not in sys.argv:
        patch_fields(texts())
    if "--texts" not in sys.argv:
        icon()
        screenshots()
