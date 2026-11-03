"""yt-dlp (songs) and streamlink (the 1440p unlock) both replace urllib3's percent-encoding pattern with a wrapper
of their own, and both run in the helper. yt-dlp's wrapper only reaches the real pattern's attributes, so laid over
streamlink's it loses urllib3's .sub and every streamlink request fails ("'Urllib3UtilUrlPercentReOverride' object
has no attribute 'sub'"). Laid the other way round (yt-dlp's first, streamlink's over it) both work: so yt-dlp's
networking is loaded first, here, before anything imports streamlink. Import this module before streamlink.
"""
import yt_dlp.networking._requests  # noqa: F401  (yt-dlp's wrapper first)
import streamlink.session.http  # noqa: F401,E402  (streamlink's over it)
