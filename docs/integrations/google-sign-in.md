# Google sign-in

## What it does

Adds a "Sign in with Google" button next to email sign-in.

## Requirements

An OAuth 2.0 **Web application** client ID from your Google Cloud project.

## Turn it on

1. In the OAuth client, add your `SITE_URL` (e.g. `https://design.example.com`) to **Authorised JavaScript
   origins**.
2. Set the client ID and restart the services:

   ```ini
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   ```

You only need the client ID; no client secret is needed.

## Settings

See [Google sign-in in configuration.md](../self-hosting/configuration.md#google-sign-in).

## Check it works

Open the sign-in page. The button appears, and signing in with it works.

## Troubleshooting

- **"origin_mismatch":** the address in the browser isn't in the client's authorised JavaScript origins.
- **No button:** `GOOGLE_CLIENT_ID` is empty in the API's environment. Check it as shown in
  [troubleshooting.md](../self-hosting/troubleshooting.md#checking-a-setting).
