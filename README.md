# A personal fork of FreeTube

This is my personal fork of [FreeTube](https://github.com/FreeTubeApp/FreeTube). It has the changes I want in my own build: fixes around SABR (server-side adaptive bitrate) playback, comments that load as you scroll, and one consolidated subscriptions feed instead of four tabs. It is not the official FreeTube repository, and the FreeTube team does not support or endorse it.

If you want FreeTube, you almost certainly want the official project: [FreeTubeApp/FreeTube](https://github.com/FreeTubeApp/FreeTube), with downloads at [freetubeapp.io](https://freetubeapp.io/#download). All credit for the application belongs to its contributors.

If you want the fixes here, you are welcome to them. FreeTube is licensed under the [GNU Affero General Public License v3.0 (AGPL-3.0)](LICENSE), which this fork keeps, and which gives anyone the right to use, study, change and share it. Builds for Windows, macOS and Linux are produced on every push to `main`: pick the newest [build workflow run](https://github.com/TomasEkeli/FreeTube/actions/workflows/build.yml) and download the artifact for your platform (downloading artifacts needs a GitHub account).

`main` is upstream plus my fixes, upstream is merged into it as it moves. This repository takes no issues. It is a personal fork and I am not looking for help with it; if you want FreeTube to change, [the official project](https://github.com/FreeTubeApp/FreeTube/issues) is where to go. The same goes for contributing: if you want to contribute to FreeTube, the official project and [its contributing guidelines](https://github.com/FreeTubeApp/FreeTube/blob/development/CONTRIBUTING.md) are where you do that.

## Differences from upstream

### Playback

YouTube's SABR streaming stops trusting a playback session now and then, and upstream's player answers that by reloading the page. Here a recovery ladder owns the decision: retry, re-mint credentials, rebuild the manifest, and reload only when nothing else is left. Nothing else in the app may reload the player without going through it, and "Reconnecting to YouTube" sits over the player while it works.

Around that: PO token minting retries, and survives YouTube's captcha by taking its challenge from the homepage. Livestreams that come back without a web manifest are recovered. Metadata that cannot be read no longer stops the video from playing. The error screen says which failure you hit and offers Try Again.

The volume bar runs past 100%. Some videos are mastered so quietly that they are inaudible at FreeTube's maximum volume; above 100% a Web Audio gain stage with a limiter supplies the rest, up to a configurable ceiling of 1000% (+20 dB). Optional loudness normalization corrects each video for how loud it was mastered. That cuts both ways, so it is off by default.

### SponsorBlock

Some channels read their sponsors as part of the show, and the categories are one standing choice across every channel. A channel can go on a list that holds every skip back: its segments are still marked on the seek bar, and what goes is the jump. The switch is on the channel page and on the video you are watching, and the channels on the list sit in the SponsorBlock settings, where you can take any of them off again.

### Subscriptions

One stream instead of four tabs. Videos, shorts, live streams and posts arrive together, with a row of chips to say which kinds you want to see. All four are fetched every refresh whatever the chips say, so switching one on is instant.

When a refresh cannot reach some of your channels, it goes back for them in the background, first a profile at a time and then one channel at a time, asking for less with each attempt. The feed stays usable throughout and fills in as they arrive. RSS feeds have no video durations, so the missing details are fetched for the part of the feed you are looking at, and kept.

A channel is no longer declared terminated on one service's word. YouTube's RSS service answered 404 to every request for ninety minutes one day, and the feed concluded that 611 channels were gone and cached that conclusion. A gone verdict now needs corroboration from an independent endpoint, and past a threshold of them in a single refresh the guard stops believing verdicts at all.

Scheduled premieres and live streams sit in a shelf over the stream, folded away until you open it.

### Explore

The Trending page is now Explore, and shows every trending category at once. The chips come from what YouTube's own guide offers here, plus the categories it serves without mentioning them. You can change region on the page, and the regions you read stay a click away. The old `/trending` address still works.

### Layout

Navigation lives in the top bar, which gives the page back the width the sidebar was taking. Cards come in tight, standard, spacious and wall density, wall being spacious-sized thumbnails packed edge to edge with the text over them. The control row stays on screen while you scroll.

### Comments

On the local API, comments load themselves as you scroll to them, keep paging, and open each thread to its first few replies with the rest behind a button. Loading follows what is visible, so a page of twenty threads does not fire twenty requests at once. Invidious keeps click-to-load.

### Build and tooling

Builds for Windows, macOS and Linux run on every push to `main`, and the artefacts are named after the build as well as the version. The update check is off by default, since it polls upstream's releases and will eventually offer a build with none of this in it. A devcontainer is included for working on the code.

Everything else about FreeTube, what it is, its features, screenshots, download links and community, lives in [the official README](https://github.com/FreeTubeApp/FreeTube#readme) and at [freetubeapp.io](https://freetubeapp.io/).

## Donate

Donations go to the official FreeTube project, not to me. The address below is theirs, used for keeping their website up and running and eventual code signing costs. I have no connection to it.

* Bitcoin Address: `1Lih7Ho5gnxb1CwPD4o59ss78pwo2T91eS`

> [!TIP]
> If you are using the Invidious API then we recommend that you donate to the instance that you use. You can also donate to the [Invidious team](https://invidious.io/donate/) or the [Local API developer](https://github.com/sponsors/LuanRT).

## License

[![GNU AGPLv3 Image](https://www.gnu.org/graphics/agplv3-155x51.png)](https://www.gnu.org/licenses/agpl-3.0.html)

FreeTube, including this fork, is Free Software: You can use, study share and improve it at your
will. Specifically you can redistribute and/or modify it under the terms of the
[GNU Affero General Public License](https://www.gnu.org/licenses/agpl-3.0.html) as
published by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.
