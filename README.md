# Ro Sight Cloudflare PWA

This branch contains the current React PWA and Cloudflare Worker source for the Ro Sight assistive-vision prototype. It does not contain the separate native iOS LiDAR test app, PCB files, datasets, model weights, or provider credentials.

## Build locally

```powershell
npm ci
npm run build
```

The build output is written to `dist/`, which is ignored by Git and is served by the Worker assets binding.

## Run the Worker locally

1. Install Node.js and dependencies with `npm ci`.
2. Set local-only Worker bindings/secrets in `cloudflare/.dev.vars` or use Wrangler's local secrets workflow. That file is ignored by Git.
3. Start the local Worker after building:

```powershell
npm run cloud:dev
```

## Deploy to a Cloudflare account

`cloudflare/wrangler.jsonc` defines the Worker, static assets, Workers AI binding, and D1 binding. The D1 database ID belongs to the existing project account; replace it and apply the migrations if deploying under a different account. Authenticate Wrangler with the account owner before deployment.

Secrets are configured in the Cloudflare dashboard or with `wrangler secret put`; never add secret values to the frontend, this repository, or `.env.example`. The Worker may use these server-side secrets when the corresponding feature is enabled:

- `SESSION_SECRET`
- `REGISTRATION_CODE`
- `MODEL_SETTINGS_ENCRYPTION_KEY`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `VIENEU_TTS_ENDPOINT`
- `VIENEU_TTS_SHARED_TOKEN`
- `VIENEU_TTS_VOICE`
- `MODEL_HOST_ALLOWED_HOSTS`

## Runtime boundaries

The PWA bundles the current camera, path-assessment, device-event, and voice interfaces. The Cloudflare Worker owns the API boundary and serves the built PWA. Some inference and Vietnamese TTS paths depend on externally hosted services and their model files; those weights, datasets, tunnels, and credentials are not included in this contest branch. Read the Worker configuration and the project’s deployment settings before using a production account.

The PWA’s camera path sends still-image requests; the voice path sends phone microphone audio to server-side transcription and assistant/TTS routes. A successful build does not establish live camera accuracy, device connectivity, or audible multi-turn voice performance.
