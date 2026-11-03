# Mor: what to paste into the add-on store's forms

## Name

Mor

## Add-on URL (slug)

mor-twitch (or "mor" if it's free)

## Summary (250 characters at most)

Removes the music streamers play from Twitch streams, keeping their voice and the game, and unlocks region-locked
1440p streams through your own VPN. Needs Mor's small helper on your Windows PC (free, from GitHub).

## Description

Mor is a Firefox extension for Twitch with two features:

**Music filter: remove songs from Twitch streams**
Mor recognizes the song a streamer is playing (Shazam), fetches its clean copy from YouTube Music or YouTube, finds
exactly where in the song the stream is, and subtracts the song from the stream's sound as it plays, matching the
streamer's volume and EQ. The streamer's voice, the game and alerts stay. It's on for every channel from the start;
switch it off per channel from Mor's toolbar button. What it's doing shows in Twitch's player controls.

**1440p unlock: watch region-locked 1440p Twitch streams**
Twitch offers its 1440p (Enhanced Broadcasting) copies only in some countries. Mor asks Twitch for the stream through
a WireGuard VPN server you add (a free Proton VPN server works) and plays it in Twitch's own player, with 1440p
available in its quality menu. Only that tab's Twitch video goes through the VPN, and only while you watch.

**Mor needs its helper.** The work is done by a small helper program on your PC (Windows 10 and 11), which Firefox
starts only while Mor needs it. It has no window and stops when you leave Twitch or close Firefox. Install it once:
download Mor from https://github.com/Overhypedcat/Mor/releases/latest (Source code zip), unzip it, and double-click
Install Mor.cmd. Mor's toolbar button shows these steps when the helper is missing.

**Heads-up**
- Some songs won't be removed: niche songs Shazam doesn't know, or versions YouTube doesn't have (remixes, sped-up or
  live versions). Mor says so when it happens.
- Loud music can leave faint traces, since Twitch re-encodes each stream's sound.
- Your antivirus may flag the helper as unknown the first time (a false positive): it's built on your PC when you
  install it. The full source is on GitHub.

**Privacy:** nothing about you is collected. Short clips of the stream's sound go to Shazam to name songs; songs are
searched and downloaded from YouTube; everything else (your VPN files, your Twitch login, song copies) stays on your
PC. No account, no analytics, no telemetry.

Works alongside Twitch ad blockers and 7TV. Open source (MIT): https://github.com/Overhypedcat/Mor

## Categories

Photos, Music & Videos (also: Other, if a second is allowed)

## Tags

twitch, music, streaming, video quality, vpn

## Support

- Support site: https://github.com/Overhypedcat/Mor/issues
- Homepage: https://github.com/Overhypedcat/Mor

## License

MIT License

## Privacy policy

Paste the text of PRIVACY.md (https://github.com/Overhypedcat/Mor/blob/main/PRIVACY.md).

## Screenshots (with captions)

1. `screenshot-1-filtering.png`: Removing a song and playing 1440p through a VPN server, from Mor's toolbar button.
2. `screenshot-2-servers.png`: Your VPN servers, tried in order, with a step-by-step guide to adding Proton VPN ones.
3. `screenshot-3-setup.png`: Without its helper, Mor shows how to install it.

## Icon

`icon-128.png`

## Notes to reviewer

Mor is open source: https://github.com/Overhypedcat/Mor (extension in `extension/`, helper in `helper/`). None of
the extension's code is minified, bundled or generated; the uploaded files are the repository's `extension/` folder
as is (tests excluded). No remote code is loaded or run by the extension.

The extension talks over native messaging (`mor_helper`) to a helper the user installs from the GitHub repository
(`Install Mor.cmd`: a Python environment, a small C# launcher built on the user's PC with Windows' own compiler, and
the open-source wireproxy, checked against its published SHA-256). Without the helper, the extension shows the user
how to install it (hub setup card) and does nothing else.

What each permission is for:
- `nativeMessaging`: the helper (song recognition and lining up; the VPN tunnel).
- `webRequest`, `webRequestBlocking` on usher.ttvnw.net: the 1440p unlock reads Twitch's stream playlist and, when
  the user's VPN offers more qualities, replaces it with the one fetched through the VPN (`filterResponseData`).
- `proxy`: only the tab playing an unlocked stream has its `*.ttvnw.net` / `*.live-video.net` requests sent to the
  helper's local SOCKS tunnel (127.0.0.1); everything else goes direct.
- `cookies` (twitch.tv): reads Twitch's own `auth-token` cookie for the one request the unlock makes to Twitch through
  the VPN; never stored.
- `storage`: the user's per-channel filter choices and the unlock switch.
- `tabs`: which Twitch tab the hub is about; reloading a stream when the unlock is switched.
- Host permissions twitch.tv, ttvnw.net, live-video.net: the content script on Twitch (it routes the player's sound
  through the AudioWorklet that removes the song) and the requests above.

Data collection (`websiteContent`): short clips of the Twitch stream's sound are sent to Shazam to recognize songs
(by the helper). Nothing else leaves the user's PC except to the services listed in the privacy policy.

To test without Windows or the helper: install the extension, open Mor's toolbar button: the setup card appears. With
the helper (Windows): run Install Mor.cmd from the repository, open any Twitch channel playing music, and Mor's text
in the player controls shows it listening, then removing the song.
