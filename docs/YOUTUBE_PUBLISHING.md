# YouTube Shorts publishing

The publisher uploads reviewed MP4 exports with the official YouTube Data API and `google-api-python-client`. Uploads are resumable, channel-verified, and recorded in a local state file so a retry does not create duplicates.

## One-time Google setup

1. Create or select a Google Cloud project.
2. Enable **YouTube Data API v3**.
3. Configure the OAuth consent screen for your own account.
4. Create an OAuth client of type **Desktop app**.
5. Place the downloaded JSON at `var/youtube-publisher/client-secret.json`.

The `var/` directory is ignored by Git. Never commit the client JSON or `oauth-token.json`.

On macOS, a freshly created Desktop OAuth JSON can also be imported from the clipboard without printing its secret:

```bash
npm run youtube:publish:import-client
```

## Install and verify

```bash
python3 -m venv .venv-youtube
.venv-youtube/bin/python -m pip install -r requirements-youtube.txt
npm run youtube:publish:plan
npm run youtube:publish:auth
```

The authorization command opens Google OAuth in the browser and prints the channel title and channel id. Use that exact id for uploads.

## Upload

Upload all 20 as private drafts:

```bash
npm run youtube:publish:upload -- --expected-channel-id YOUR_CHANNEL_ID
npm run youtube:publish:verify -- --expected-channel-id YOUR_CHANNEL_ID --wait-seconds 120
```

Only six clips currently pass the no-edit human QA gate. Public upload of all 20 therefore requires two explicit acknowledgements:

```bash
npm run youtube:publish:upload -- --expected-channel-id YOUR_CHANNEL_ID --privacy public --allow-review-required --confirm-public
```

Successful uploads are stored in `var/youtube-publisher/upload-state.json`. Re-running the same command skips identical completed files. The publisher stops if an already uploaded file has changed.
