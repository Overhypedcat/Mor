<p align="center"><img src="extension/icons/mor.svg" width="96" alt="Mor logo: a purple smiley"></p>

# Mor: Twitch music filter and 1440p unlock for Firefox

**Mor is a Firefox extension for Twitch.** It removes the music a streamer plays from a live stream's sound, so you
hear their voice and the game without the songs. It also unlocks Twitch's region-locked **1440p** (Enhanced
Broadcasting) streams through your own VPN, for the stream you're watching only.

Everything is controlled from Mor's button in the Firefox toolbar.

## Features

### Music filter: remove songs from Twitch streams

- Off until you switch it on for a channel from Mor's toolbar button while you watch it. Mor remembers the channels
  you've switched on, and keeps working while the Twitch tab is in the background.
- The song is taken out of the sound as it plays. The streamer's voice, the game and alerts stay.
- The first seconds of each song are heard until it's recognized. Songs heard before are recognized again at once.
- Twitch's player controls show what the filter is doing, next to Twitch's own buttons, in a few words as it happens:
  "Listening", "Asking Shazam", "Downloading", "Lining up", "Removing song", "Resting 52 s". What went wrong shows
  in red; hover over it for the whole story.
- A retry button beside that text looks for the song again when it isn't being removed.

### 1440p unlock: watch region-locked 1440p Twitch streams

- Twitch offers its 1440p (HEVC) copies only to logged-in viewers in some countries. With a WireGuard VPN server you
  add (a free Proton VPN server works), the stream plays in Twitch's own player with the 1440p quality available:
  choose 1440p in Twitch's quality menu.
- Only that tab's Twitch video goes through the VPN, and only while you watch it. Everything else on your PC, and in
  Firefox, uses your normal connection.
- When the VPN offers nothing more than your normal connection, the stream plays normally and nothing goes through
  the VPN.

### The hub

Mor's toolbar button opens its hub:

- **Music filter**: on or off for the channel you're watching, what the filter is doing, and the retry button.
- **1440p unlock**: on or off for all channels. When it's on, Mor checks each live stream as it starts and shows
  whether it's playing a locked quality through the VPN. Under **VPN servers** are the servers Mor tries, in order;
  **Add servers** opens a page to add `.conf` files.

### Alongside ad blockers

Mor works alongside Twitch ad blockers such as TwitchAdSolutions. When one swaps or reloads the player during an ad,
the music filter carries on with the song it was removing. While an ad blocker plays a backup stream, the 1440p
unlock steps aside and the stream plays at the backup's quality.

## How it works

Mor has two parts: the Firefox extension, and a small helper program on your PC that the extension starts through
Firefox's native messaging. The helper has no window, opens no network port, runs only while the extension needs it,
and ends when Firefox closes. Only the extension with Mor's id can start it.

### The music filter

1. The Twitch tab sends the stream's sound through an AudioWorklet (48 kHz) on its way to the speakers, and passes a
   copy of what it hears to the helper.
2. Every few seconds the helper sends about 5 seconds of that sound to Shazam, which names the song. Songs heard
   before are recognized on your PC from stored fingerprints, without asking Shazam.
3. The helper finds the song's clean copy on YouTube Music (or YouTube), downloads it, and works out exactly where
   in the song the stream is.
4. The tab receives the copy and its place and subtracts the song from the sound, matching the streamer's volume and
   EQ as they change. When the stream moves in the song or the song ends, the helper notices and follows.

### The 1440p unlock

1. When a live stream starts, the helper asks Twitch for the stream's playlist through a WireGuard tunnel to the VPN
   server you added. The tunnel is `wireproxy`, an open-source WireGuard client that offers a local SOCKS proxy and
   never changes your PC's network settings (no system VPN, no admin rights).
2. If that playlist offers more qualities than your normal connection gets, the extension swaps it into Twitch's
   player and sends only that tab's Twitch video requests through the tunnel.
3. The tunnel stops when you leave the stream or close Firefox.

### Components

- `extension/`: the Firefox extension (JavaScript, Manifest V2). `audio/filter-worklet.js` removes the song in the
  tab; `content/` runs in the Twitch page (the sound's path, the text in the player); `background/main.js` connects
  the tabs, the hub and the helper and does the 1440p unlock; `hub/` is the toolbar popup.
- `helper/`: the helper (Python). `mor_helper/musicfilter/` recognizes, fetches and lines up the songs (Shazam through
  `shazamio`, downloads through `yt-dlp`, decoding through PyAV, the signal work in NumPy); `mor_helper/unlock.py` and
  `vpn.py` ask Twitch through the tunnel (`streamlink`, `wireproxy`). `launcher/MorHelper.cs` is the small program
  Firefox starts, which runs the helper without a window.
- `tools/install.ps1` and `tools/uninstall.ps1`: what `Install Mor.cmd` and `Uninstall Mor.cmd` run.

The song removal in the tab is tested sample for sample against the helper's Python reference.

### What goes where

Everything Mor keeps stays on your PC. There's no Mor account, no Mor server, no analytics and no telemetry. The full
[privacy policy](PRIVACY.md) says what goes where.

- **What goes out to the internet**: short clips of the stream's sound (about 5 seconds) to Shazam to name the song;
  searches and song downloads from YouTube Music and YouTube; and Twitch's own requests. Nothing else.
- **Your Twitch login**: Mor never stores it. When a stream starts, the extension reads Firefox's own Twitch login
  cookie (`auth-token`) and hands it to the helper for that one request, which sends it only to Twitch (through the
  VPN), exactly as Twitch's site does. It's never written to disk or logged.
- **Your VPN profiles**: the `.conf` files you add are kept in `%APPDATA%\Mor\vpn` on your PC, readable only by your
  Windows account, and used only to start the tunnel. They're never uploaded anywhere. Remove them from the hub, or
  delete the folder.
- **What's kept on disk**: clean song copies for the music filter in `%LOCALAPPDATA%\Mor\music` (at most 1 GB, the
  oldest removed first), the tunnel program in `%LOCALAPPDATA%\Mor\bin`, a short helper log in
  `%LOCALAPPDATA%\Mor\helper.log`, and the last 20 clips of stream sound that Shazam couldn't name in
  `%LOCALAPPDATA%\Mor\unnamed` (about 10 MB at most).
- **Permissions the extension asks for**: Twitch's sites (to hear and filter the player's sound and swap its
  playlist), proxy (to send only that tab's Twitch video through the VPN), cookies (to read the Twitch login cookie),
  native messaging (to talk to the helper), and storage (your on/off choices).

## Requirements and installation

Mor needs Windows 10 or 11 and Firefox 140 or newer. The extension is on Firefox's add-on store
([Mor on addons.mozilla.org](https://addons.mozilla.org/firefox/addon/mor-twitch/)) and here; either way it needs its
helper on your PC, which the steps below set up (they add the extension too).

### Install

1. Download Mor from the [latest release](https://github.com/Overhypedcat/Mor/releases) (**Source code (zip)**)
   and unzip it, or clone this repository.
2. Double-click **`Install Mor.cmd`**. It sets up everything the helper needs and then opens Firefox to add the
   extension: press **Add**.
3. Open a Twitch channel and click Mor's purple smiley in the toolbar.

`Install Mor.cmd` installs what's missing by itself, without admin rights: Python 3.10 or newer and Node.js (through
winget), the helper's Python packages in a folder of its own (`helper\.venv`), and `wireproxy` (from its official
GitHub release, checked against its published checksum). It builds `MorHelper.exe` with the C# compiler that comes
with Windows. Running it again repairs or updates Mor.

### Add VPN servers for the 1440p unlock

The hub has these steps too, under "How to add Proton VPN servers".

1. Make a free account at [protonvpn.com](https://protonvpn.com/free-vpn), or sign in to yours.
2. Open [account.protonvpn.com/downloads](https://account.protonvpn.com/downloads) and scroll to **WireGuard
   configuration**.
3. Give the config any name, and pick **Windows** as the platform.
4. Under VPN options, set **NetShield blocker filtering** to **No filter**.
5. In the server list, pick a **free** server in the **Netherlands** or the **United States** and press **Create**.
6. Press **Download** to get a `.conf` file. Make two or three on different servers, in case one is busy.
7. In Mor's hub, press **Add servers** and choose the `.conf` files.

The free Proton plan allows one connection at a time: while Mor uses a server, keep the Proton app disconnected.

### Uninstall

1. Remove Mor in Firefox: **Add-ons and themes > Extensions > Mor > Remove**.
2. Double-click **`Uninstall Mor.cmd`**: it removes the helper's registration and Mor's data from your PC.
3. Delete Mor's folder.

### Run the tests

After `Install Mor.cmd` has run, from Mor's folder:

```
helper\.venv\Scripts\python -m unittest discover -s helper\tests     # the helper's tests
node --test "extension/tests/*.test.js"                                # the extension's tests
helper\.venv\Scripts\python extension\tests\fixtures\make_filter_fixture.py   # after changing the filter
```

## Notes

- **Your antivirus may flag Mor (a false positive).** Mor is new, and its helper is built on your PC when you install
  it, so your antivirus has never seen it before. Some antivirus programs flag new, unknown programs like this as
  suspicious, especially `MorHelper.exe` and `wireproxy.exe`. The full source is in this repository. If your antivirus
  blocks a part of Mor, Mor says which part failed, and you can allow it in your antivirus.
- **Some songs won't be removed.** Niche songs that Shazam doesn't know, or that aren't on YouTube Music or YouTube in
  the version the streamer plays (remixes, sped-up versions, live versions), stay audible. Mor says so on the player
  when it happens.
- **Loud music can leave artifacts.** Twitch re-encodes each stream's audio, which changes the song in ways that can't
  be fully known and reversed. When the music is loud, faint traces or a slightly watery sound can remain where the
  song was.
- **The 1440p unlock depends on Twitch and the VPN.** It follows Twitch's region rules and needs the VPN server to
  answer; free servers can be busy.
- **The music filter needs a sound output.** With no speaker or headphone connected, or before the first click on
  the page, Firefox can't start the filter's sound: Mor says so on the player and starts by itself once it can.
- Mor is open source under the [MIT License](LICENSE). It's an independent project, not affiliated with Twitch,
  Proton, Shazam or YouTube.
