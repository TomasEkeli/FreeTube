# Fjernsyn, a personal fork of FreeTube

Fjernsyn is my personal fork of [FreeTube](https://github.com/FreeTubeApp/FreeTube). It has the changes I want in my own build: fixes around SABR (server-side adaptive bitrate) playback, comments that load as you scroll, one subscriptions feed in place of four tabs, a page for sorting channels into profiles by drag and drop, and a download button that hands the video to yt-dlp. It is not the official FreeTube, and the FreeTube team does not support or endorse it.

Fjernsyn is Norwegian (and Danish) for television, literally "far-sight", tele-vision translated word for word. It has a name of its own so that nobody mistakes it for FreeTube.

If you want FreeTube, you almost certainly want the official project: [FreeTubeApp/FreeTube](https://github.com/FreeTubeApp/FreeTube), with downloads at [freetubeapp.io](https://freetubeapp.io/#download). All credit for the application belongs to its contributors.

If you want the fixes and modifications in this version, you are welcome to them. FreeTube is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE), which this fork honours, and which gives anyone the right to use, study, change and share it. Builds for Windows, macOS and Linux are produced on every push to `main`: pick the newest [build workflow run](https://github.com/TomasEkeli/FreeTube/actions/workflows/build.yml) and download the artifact for your platform (downloading artifacts needs a GitHub account).

Since this is my personal fork no effort is spent on translations. I merge the official project's, but the strings this fork adds exist only in English, so picking another language leaves those in English and the rest translated.

`main` is upstream plus my fixes, and upstream is merged into it as it moves. This repository takes no issues, and I am not looking for help with it; if you want FreeTube to change, [the official project](https://github.com/FreeTubeApp/FreeTube/issues) is where to go. The same goes for contributing: the official project and [its contributing guidelines](https://github.com/FreeTubeApp/FreeTube/blob/development/CONTRIBUTING.md) are where you do that.

## Differences from upstream

### Name and data

Fjernsyn keeps its data in a folder of its own, has its own `fjernsyn://` links, and installs beside an official FreeTube, so the two can run on one machine without touching each other's data.

On its first launch it copies what it finds in a FreeTube data folder: subscriptions, profiles, history, playlists, settings, and the yt-dlp, ffmpeg and Deno it installed. It copies and never moves, so the FreeTube folder is left as it was, and an official FreeTube keeps working with it. From then on the two keep their data apart. Exports are named `fjernsyn-*.db` and have the same format as FreeTube's, so each app imports the other's.

It also opens `freetube://` links, which the browser redirect extensions send, until you switch that off in the general settings.

Windows sees a build of this fork from before the rename as a different app. Fjernsyn installs beside it, and the old one has to be uninstalled by hand.

### Playback

YouTube's SABR streaming stops trusting a playback session now and then, and upstream's player answers that by reloading the page. Here a recovery ladder owns the decision: retry, re-mint credentials, rebuild the manifest, and reload only when nothing else is left. Nothing else in the app may reload the player without going through it, and "Reconnecting to YouTube" sits over the player while it works.

Around that: proof of origin (PO) token minting retries, and survives YouTube's captcha by taking the challenge from the homepage. Livestreams that come back without a web manifest are recovered. Metadata that cannot be read no longer stops the video from playing. The error screen says which failure you hit and offers Try Again.

The player runs shaka-player 5.2, a minor version ahead of upstream's. This is to get a fix the 5.1 line never got: request headers stay isolated across retry attempts, which every SABR request depends on. 5.2 turns the playback rate menu into a slider with presets beside it; the presets here are half steps, and the rate interval keeps stepping the keyboard shortcuts.

Another change is that the volume bar runs past 100%. Some videos are mastered so quietly that they are inaudible at FreeTube's maximum volume. In this version the volume can go up to a configurable ceiling of 1000% (+20 dB). Optional loudness normalisation corrects each video for how loud it was mastered (YouTube provides this information). This also lowers the volume on very loud videos automatically. The feature is off by default, but I have it enabled.

A small pin on the control bar keeps the player's controls on screen instead of letting them fade, and the choice sticks between videos.

### SponsorBlock

Some channels read their sponsors as part of the show. Skipping SponsorBlock's categories can now be set per-channel. This is for channels where ads are actually fun and cool. The switch for this is on the channel page and on the video you are watching, and there is a list in the SponsorBlock settings, where you can take any of them out again.

### Subscriptions

Videos, shorts, live streams and posts are consolidated to one stream instead of four tabs. A row of chips turns each kind on and off. All four are fetched every refresh whatever the chips say, so switching one on is instant.

The subscription list does not empty on refresh. Old entries are kept around and the new entries populate as they come in.

A channel is no longer declared terminated on one service's word. A gone verdict has to be corroborated by an independent endpoint, and an uncorroborated one counts as a failed fetch: retried later, with the cache left alone. Past a threshold of them in a single refresh the guard stops believing verdicts at all, and stops probing, which during an outage saves several hundred pointless requests.

Scheduled premieres and live streams are in a shelf over the other videos, collapsed by default. "Hide Upcoming Premieres" does what it says again: the rule never worked well in the official version. Now it does.

### Channels and profiles

With a few hundred subscriptions the checkbox lists in the profile settings were unusable, and my profiles went stale. The Channels page replaces the flat list of every channel with a place to sort them into profiles.

Every profile is a bubble along the top. Click one to open its column, open as many as you like, and the columns scroll sideways once they do not fit. Each window keeps its own open columns, so one window can work on two profiles while another works on three others. Channels in no profile sit in an Unassigned column on the left, which goes away once it is empty. The goal is every channel in a profile.

Drag a channel to another column to move it, or hold Ctrl to copy it. Dropping it on a bubble files it without opening that column. Click to select, Shift-click for a range, or use Select all on a column; dragging any selected channel moves the whole selection. The search box narrows every column at once, and each bubble shows how many of its channels match. Dropping on the trash unsubscribes, after asking. For the keyboard, the Move to and Copy to menus do what a drag does.

A channel in more than one profile sorts to the top of each column it is in. When two of those columns are open, both copies share a colour, so the pairs are easy to spot. Right-click one to take it out of that profile, or to make that profile its home and take it out of the others. Double-click a channel to go to it, and click a column's heading to make that profile the active one.

Make a profile with New profile at the end of the strip and type its name right there. Right-click a bubble to rename it, change its colour or remove it; removing a profile leaves its channels subscribed, and those in no other profile go back to Unassigned. Drag bubbles to put the profiles in your own order, which every list of profiles in the app follows, or move the focused one with Ctrl+Shift+Left and Right. A bar shows where a dragged bubble will land, and it lands there: Chromium quietly loses some drops, so the palette catches those itself. New profiles go at the end.

Suggest profiles swaps the profile columns for proposed ones, with dashed edges, for where channels might belong: Unassigned channels that fit one of your profiles, channels that fit another profile clearly better than their own (badged with where they are now), and groups for a new profile by YouTube category or by a shared tag. They come from what the app already sees, the tags on the channel pages a refresh fetches anyway and the category of every video you watch, so they cost no requests and get better as you go. Hover a channel to see why it is there. Nothing changes until you act: the tick on a channel files it, the cross leaves it where it is for good, the tick on a heading takes the whole suggestion, and dropping a channel on a suggestion adds it there to be filed with the rest.

Probe, on the Unassigned column and on every profile's, goes further for that column's channels the app knows too little about: it looks at three recent videos of each, one request at a time, never while subscriptions refresh, and it stops the moment YouTube pushes back. It carries on in the background as the suggestions fill in, a second column's Probe queues behind the first, and pressing it again after a stop takes up where it left off. What it finds is kept with the channel.

Profile settings still handle a profile's default. The channel lists there are gone.

### Explore

The Trending page is now called Explore, and shows every trending category at once. The categories come from what YouTube's own guide offers here, plus the categories it serves without mentioning them.

You can now easily change region on the page, and the last four you looked at stay a click away. Pinning a region keeps it there for good, and a pin does not spend one of the four, so you can pin the places you care about and still wander.

### Layout

Navigation has moved to the top bar, which gives the page back the width the sidebar was taking. Cards come in tight, standard, spacious and wall density. I use wall. Wall packs spacious-sized thumbnails edge to edge with the text over them. The control row stays on screen while you scroll. With wall and full window as the default viewing mode the app gets mostly out of the way and the content is king.

Hovering a video card shows a checkmark beside the playlist buttons, which marks the video as watched, or takes it back out of the history if it is already there. The external player button is gone from the cards, since I never used it.

### Comments

On the local API, comments load themselves as you scroll to them, keep paging, and open each thread to its first few replies with the rest behind a button. Loading follows what is visible, so a page of twenty threads does not fire twenty requests at once. Invidious keeps click-to-load. This is essentially a limited endless-scroll for comments. It remains impossible to comment, as there is no login functionality, but it is easier to read the comments now.

### Downloads

The download button is back. Upstream removed theirs in January 2026, since it had long been half broken and SABR broke it completely. This one hands the video to [yt-dlp](https://github.com/yt-dlp/yt-dlp). Switch it on in the yt-dlp section of the settings (desktop builds only).

If yt-dlp, or the ffmpeg and Deno it needs, is missing, the first press offers to install them and then downloads. The settings section can do the same, and can update yt-dlp when YouTube downloads start failing.

A click downloads the best quality available. Right-click or hold for a lower one, or the audio alone. A downloads indicator in the top bar shows progress, time left and where the file is going, and can cancel. A cancelled download picks up where it stopped. Once finished, the button becomes Show in folder.

### Build and tooling

Builds for Windows, macOS and Linux run on every push to `main`, and the artefacts are named after the build as well as the version. A devcontainer is included for working on the code.

Everything else about FreeTube, what it is, its features, screenshots, download links and community, lives in [the official README](https://github.com/FreeTubeApp/FreeTube#readme) and at [freetubeapp.io](https://freetubeapp.io/).

## Donate to the official project

Donations should go to the official FreeTube project. They are awesome. The address below is theirs, for keeping their website running and for eventual code signing costs. I have no connection to it.

* Bitcoin Address: `1Lih7Ho5gnxb1CwPD4o59ss78pwo2T91eS`

> [!TIP]
> If you are using the Invidious API, donate to the instance you use. You can also donate to the [Invidious team](https://invidious.io/donate/) or the [Local API developer](https://github.com/sponsors/LuanRT).

## License

[![GNU AGPLv3 Image](https://www.gnu.org/graphics/agplv3-155x51.png)](https://www.gnu.org/licenses/agpl-3.0.html)

FreeTube, including this fork, is Free Software: you can use, study, share and improve it at your
will. Specifically you can redistribute and/or modify it under the terms of the
[GNU Affero General Public License](https://www.gnu.org/licenses/agpl-3.0.html) as
published by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
