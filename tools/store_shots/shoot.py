"""Makes the add-on store's screenshots (1280 x 800) in store/: the hub with a demo state (hub-demo.html, the real
hub with a stand-in for Firefox's extension API), on Mor's dark background. Needs Selenium, Pillow and geckodriver:

    python tools/store_shots/shoot.py path\\to\\geckodriver.exe
"""
import io
import sys
import time
from pathlib import Path

from PIL import Image
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

ROOT = Path(__file__).resolve().parents[2]
PAGE = (Path(__file__).parent / "hub-demo.html").as_uri()
W, H = 1280, 800
BG = (14, 14, 16)


def shoot(driver, kind):
    driver.get(f"{PAGE}?{kind}")
    time.sleep(1.2)
    height = driver.execute_script("return document.body.scrollHeight")
    driver.set_window_size(900, max(600, height + 200))
    time.sleep(0.4)
    png = Image.open(io.BytesIO(driver.find_element("css selector", "body").screenshot_as_png)).convert("RGB")
    # the hub is 360 px wide at 2x: crop to it, then place it in the middle of the frame
    hub = png.crop((0, 0, min(png.width, 2 * 360), min(png.height, 2 * (height + 4))))
    scale = min(1.0, (H - 80) / hub.height)
    if scale < 1:
        hub = hub.resize((round(hub.width * scale), round(hub.height * scale)), Image.LANCZOS)
    frame = Image.new("RGB", (W, H), BG)
    frame.paste(hub, ((W - hub.width) // 2, (H - hub.height) // 2))
    return frame


def main(gecko):
    o = Options()
    o.add_argument("-headless")
    o.set_preference("layout.css.devPixelsPerPx", "2.0")
    o.set_preference("security.fileuri.strict_origin_policy", False)  # the page reads hub.html beside it
    d = webdriver.Firefox(options=o, service=Service(gecko))
    out = ROOT / "store"
    out.mkdir(exist_ok=True)
    try:
        for i, kind in enumerate(["filtering", "servers", "setup"], 1):
            shoot(d, kind).save(out / f"screenshot-{i}-{kind}.png")
            print(out / f"screenshot-{i}-{kind}.png")
    finally:
        d.quit()


if __name__ == "__main__":
    main(sys.argv[1])
