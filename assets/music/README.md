# Viral music assets

This directory contains the local working copies referenced by
`catalog.v1.json`. Each source page stated that the track was free for use
under the [Pixabay Content License](https://pixabay.com/service/license-summary/)
when retrieved on 2026-08-08.

The license summary permits free use, optional attribution, and modification,
subject to its prohibited uses and the legally binding full license. In
particular, raw Pixabay content must not be distributed on a standalone basis.
Do not publish these unmodified MP3 files as downloadable repository assets;
use them only as inputs to rendered creative works or fetch them from their
recorded official `contentUrl` into private deployment storage.

Install and verify those private runtime copies after cloning:

```bash
python3 scripts/install_music_catalog_assets.py
python3 scripts/install_music_catalog_assets.py --check
```

The installer verifies the catalog seal, each byte length and each SHA-256
before atomically making an asset available. Rendering never downloads music
implicitly.

## Source replacement

The approved `Rain and Nostalgia - Sad Lofi Background Music For Videos`
(Pixabay content ID `5800`) returned a live 404 and was absent from the live
Pixabay search catalog on 2026-08-08. It was explicitly replaced by
`Sugar and Venom` (Pixabay content ID `422055`). The replacement is marked
`aiGenerated: true` and must never be reported as the original track.

## Integrity

Every local MP3 was validated with FFprobe as a single stereo MP3 audio stream.
The catalog records its exact SHA-256, byte length, duration, sample rate, and
source URL. `contentIdRegistered` remains `unknown` unless authoritative
evidence is added later.
