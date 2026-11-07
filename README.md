# Ro Sight Cloudflare PWA

This branch contains the current React PWA and Cloudflare Worker source for the Ro Sight assistive-vision prototype, plus the optional Flask proxy, YOLO host, VieNeu gateway, and their setup notes. It does not contain the separate native iOS LiDAR test app, PCB files, datasets, model weights, tunnel credentials, or provider secrets.

## Build locally

```powershell
npm ci
npm run build
```

The build output is written to `dist/`, which is ignored by Git and is served by the Worker assets binding.

The app imports `assistant_profile.json` at build time. Keep this file in the repository root when building; it contains model defaults and prompts, not API keys.

## Run the Worker locally

1. Install Node.js and dependencies with `npm ci`.
2. Set local-only Worker bindings/secrets in `cloudflare/.dev.vars` or use Wrangler's local secrets workflow. That file is ignored by Git.
3. Start the local Worker after building:

```powershell
npm run cloud:dev
```

## Optional local service hosts

The Worker can proxy to configured model hosts. Source and setup notes are included for the laptop-side Flask bridge, YOLO service, and VieNeu gateway. Their model files and credentials are intentionally external. Follow `YOLO_HOST_SETUP.md` and `VIENEU_TTS_SETUP.md`, then enter only the public endpoint and server-side secret through the protected settings/configuration path.

The Flask bridge also needs Python dependencies from `requirements.txt`; copy `.env.example` to `.env` and set only the values needed for the service being run. Do not expose `.env` or host tokens through the PWA.

## Checks

```powershell
npm run test:app
npm run test:worker
npm run test:backend
```

These automated checks use fixtures/mocks for provider and device boundaries. They do not prove live camera inference, ESP32 pairing, production STT/TTS playback, or safe navigation.

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
