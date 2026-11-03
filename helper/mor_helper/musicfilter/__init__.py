"""The music filter: takes the song a streamer plays out of a live stream's sound, leaving their voice and the game.

Every few seconds it asks Shazam what's playing (songs.py), fetches that song's clean copy from YouTube Music, finds
where in the song the stream is (align.py, relay.Tracker), and the tab subtracts the song as the stream plays it: at
its volume and with the streamer's EQ (canceller.py, ported to the tab's AudioWorklet). The start of each song is
heard until it's recognized.
"""
