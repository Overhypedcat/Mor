<p align="center"><img src="extension/icons/mor.svg" width="96" alt="Mor logo: a purple smiley"></p>

# Mor: Twitch music filter and 1440p unlock for Firefox

**Mor is a Firefox extension for Twitch.** It removes the music a streamer plays from a live stream's sound, so you
hear their voice and the game without the songs. It also unlocks Twitch's region-locked **1440p** (Enhanced
Broadcasting) streams through your own VPN, for the stream you're watching only.

Everything is controlled from Mor's button in the Firefox toolbar. A small helper program runs on your PC alongside
the extension: it has no window, starts only while the extension needs it, and stops when Firefox closes.

## What it does

### Music filter: remove songs from Twitch streams

- Switch it on per channel, from Mor's toolbar button, while you watch that channel.
- Every few seconds it asks Shazam what song is playing in the stream, fetches the song's clean copy from YouTube
  Music (or YouTube), finds exactly where in the song the stream is, and subtracts the song from the sound as it plays,
  matching the streamer's volume and EQ. The streamer's voice, the game and alerts stay.
- The first seconds of each song are heard until it's recognized. Songs heard before are recognized again without
  asking Shazam.
- A retry button asks Shazam again if a song isn't being removed. Mor shows what the filter is doing and anything that
  went wrong.

### 1440p unlock: watch region-locked 1440p Twitch streams

- Twitch offers its 1440p (HEVC) copies only to logged-in viewers in some countries. Mor asks Twitch for the stream
  through a WireGuard VPN server you add (a free Proton VPN server works), and plays it in Twitch's own player with
  the 1440p quality available.
- Only that tab's Twitch video goes through the VPN, and only while you watch it. Everything else on your PC, and in
  Firefox, uses your normal connection.
- When the VPN offers nothing more than your normal connection, the stream plays normally and nothing goes through
  the VPN.

## Heads-up

- **Your antivirus may flag Mor (a false positive).** Mor is new, and its helper is built on your PC when you install
  it, so your antivirus has never seen it before. Some antivirus programs flag new, unknown programs like this as
  suspicious, especially `MorHelper.exe` and `wireproxy.exe` (the open-source WireGuard tunnel Mor uses for the 1440p
  unlock, downloaded from its official GitHub release and checked against its published checksum). The full source is
  in this repository. If your antivirus blocks a part of Mor, Mor says which part failed, and you can allow it in your
  antivirus.
- **Some songs won't be removed.** Niche songs that Shazam doesn't know, or that aren't on YouTube Music or YouTube in
  the version the streamer plays (remixes, sped-up versions, live versions), stay audible. Mor says so on the player
  when it happens.
- **Loud music can leave artifacts.** Twitch re-encodes each stream's audio, which changes the song in ways that can't
  be fully known and reversed. When the music is loud, faint traces or a slightly watery sound can remain where the
  song was.
- The 1440p unlock depends on Twitch's region rules and on the VPN server answering; free servers can be busy.

## Install

Needs Windows 10 or 11 and Firefox.

1. Download Mor from the [latest release](https://github.com/Overhypedcat/Mor/releases) (**Source code (zip)**)
   and unzip it.
2. Double-click **`Install Mor.cmd`**.
   It sets up everything the helper needs (Python and Node.js are installed with winget if they're missing) and
   then opens Firefox to add the extension: press **Add**.
3. Open a Twitch channel and click Mor's purple smiley in the toolbar.

Running `Install Mor.cmd` again repairs or updates Mor. Nothing needs admin rights.

## Using Mor

On a Twitch channel's live stream, the music filter has its own row on the player, next to Twitch's buttons. It
shows up with Twitch's controls: a music note, what the filter is doing ("Listening for music", "Removing Artist -
Song") or what went wrong, a retry button and the filter's switch for that channel.

Mor's toolbar button opens its hub:

- **Music filter**: the same switch and status as on the player.
- **1440p unlock**: on or off for all channels. When it's on, Mor checks each live stream as it starts and shows
  whether it's playing a locked quality through the VPN. Choose 1440p in Twitch's own quality menu. Under **VPN
  servers** are the servers Mor tries, in order; **Add servers** opens a page to add `.conf` files.

Mor works alongside Twitch ad blockers such as TwitchAdSolutions: when one swaps or reloads the player during an ad,
the music filter carries on with the song it was removing. While an ad blocker plays a backup stream, the 1440p
unlock steps aside and the stream plays at the backup's quality.

### Adding Proton VPN servers

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

## Security and privacy

Everything Mor keeps stays on your PC. There's no Mor account, no Mor server, no analytics and no telemetry.

- **Your Twitch login**: Mor never stores it. When a stream starts, the extension reads Firefox's own Twitch login
  cookie (`auth-token`) and hands it to the helper for that one request, which sends it only to Twitch (through the
  VPN), exactly as Twitch's site does. It's never written to disk or logged.
- **Your VPN profiles**: the `.conf` files you add are kept in `%APPDATA%\Mor\vpn` on your PC, readable only by your
  Windows account, and used only to start the tunnel. They're never uploaded anywhere. Remove them from the hub, or
  delete the folder.
- **The VPN tunnel** runs only while a stream needs it, carries only that tab's Twitch video, and stops when you
  leave the stream or close Firefox. It never changes your PC's network settings (no system VPN, no admin rights).
- **What goes out to the internet**: short clips of the stream's sound (about 10 seconds) to Shazam to name the song;
  searches and song downloads from YouTube Music and YouTube; and Twitch's own requests. Nothing else.
- **What's kept on disk**: clean song copies for the music filter in `%LOCALAPPDATA%\Mor\music` (at most 300 MB, the
  oldest removed first), the tunnel program in `%LOCALAPPDATA%\Mor\bin`, and a short helper log in
  `%LOCALAPPDATA%\Mor\helper.log`.
- **The helper** is registered with Firefox for Mor's extension only (Firefox's native messaging: only the extension
  with Mor's id can start it). It has no window, opens no network port, and ends when Firefox closes.
- **Permissions the extension asks for**: Twitch's sites (to hear and filter the player's sound and swap its
  playlist), proxy (to send only that tab's Twitch video through the VPN), cookies (to read the Twitch login cookie),
  native messaging (to talk to the helper), and storage (your on/off choices).

## Uninstall

1. Remove Mor in Firefox: **Add-ons and themes > Extensions > Mor > Remove**.
2. Double-click **`Uninstall Mor.cmd`**: it removes the helper's registration and Mor's data from your PC.
3. Delete Mor's folder.

## Development

```
helper\.venv\Scripts\python -m unittest discover -s helper\tests     # the helper's tests
node --test "extension/tests/*.test.js"                                # the extension's tests
helper\.venv\Scripts\python extension\tests\fixtures\make_filter_fixture.py   # after changing the filter
```

- `extension/`: the Firefox extension. `audio/filter-worklet.js` removes the song in the tab; `background/main.js`
  connects the tabs, the hub and the helper and does the 1440p unlock; `hub/` is the toolbar popup.
- `helper/`: the helper (Python). `mor_helper/musicfilter/` recognizes, fetches and lines up the songs;
  `mor_helper/unlock.py` and `vpn.py` ask Twitch through the VPN tunnel.
- `tools/install.ps1`: what `Install Mor.cmd` runs.
The song removal in the tab is tested sample for sample against the helper's Python reference.

---

Mor is an independent project, not affiliated with Twitch, Proton, Shazam or YouTube.
