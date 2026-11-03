# Mor privacy policy

Mor is a Firefox extension for Twitch, with a helper program that runs on your own PC. This policy says what Mor
handles, where it goes, and what stays on your PC. Mor has no account, no server of its own, no analytics and no
telemetry. Its developer receives nothing from you.

## What is sent out, and to whom

- **Shazam (Apple):** to name the song a streamer is playing, Mor sends short clips of the Twitch stream's sound,
  about 10 seconds each, at most a few a minute while the music filter is on, and none while a song it already knows
  is being removed. Only the stream's sound is sent: nothing about you, your PC or your browsing. Shazam's own privacy
  policy applies to what it receives.
- **YouTube Music and YouTube (Google):** to remove a song, Mor searches for it by its name and artist and downloads
  its audio. Google's privacy policy applies to these searches and downloads.
- **Twitch:** for the 1440p unlock, Mor asks Twitch for the stream you're watching through the VPN server you added,
  sending your Twitch login (the same one Firefox already sends Twitch) to Twitch only. Twitch's privacy policy applies.
- **Your VPN provider:** while a stream plays through the 1440p unlock, that tab's Twitch video goes through the VPN
  server you added. Your VPN provider's privacy policy applies.

Nothing else is sent anywhere.

## What stays on your PC

- **Your Twitch login:** read from Firefox's own Twitch cookie when a stream starts, handed to the helper for that
  one request, and never stored or logged by Mor.
- **Your VPN server files** (WireGuard `.conf`): kept in `%APPDATA%\Mor\vpn`, used only to start the tunnel, never
  uploaded.
- **Song copies:** the songs' audio, kept in `%LOCALAPPDATA%\Mor\music` so a song heard before needn't be fetched
  again (at most 1 GB; the oldest are removed first).
- **The helper's log:** what the music filter did, step by step (`%LOCALAPPDATA%\Mor\helper.log`, a few MB at most),
  for you to read or to send along with a problem report if you choose to.
- **Your choices:** which channels you switched the music filter off for, and whether the 1440p unlock is on, kept
  in Firefox's storage for the extension.

## Removing it

Remove the extension in Firefox (Add-ons and themes > Extensions > Mor > Remove) and run `Uninstall Mor.cmd` from
Mor's folder: it removes the helper's registration and everything listed above under "What stays on your PC".

## Contact

Questions or problems: https://github.com/Overhypedcat/Mor/issues
