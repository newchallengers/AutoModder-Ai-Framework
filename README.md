# AutoModder Ai Framework

A starter project for image-based character creation, with a browser preview and downloadable 3D assets.

Explore [Auto Modder](https://automodder.site).

## Workflow

1. Upload a character image.
2. Prepare the image using your configured image service.
3. Generate a 3D asset with Meshy.
4. Preview and download the model.
5. Continue asset review in Blender or your preferred 3D tools.

The template covers image generation, task polling, preview, and model downloads.
Game-specific processing and export are separate integrations.

## Setup

Use Node.js 22 or later and run `npm install`.

Set these environment variables before starting the server:

| Variable | Purpose |
| --- | --- |
| `MESHY_KEY_FILE` | Path to a file containing your Meshy API key. |
| `GEMINI_KEY_FILE` | Path to a file containing your image API key. |
| `IMAGE_PROMPT_FILE` | Path to your image preparation instructions. |
| `IMAGE_MODELS` | Comma-separated image model identifiers supported by your provider. |
| `PROMO_CODES_FILE` | Path to a JSON file defining generation allowances. |
| `PUBLIC_BASE_URL` | Public HTTPS origin that Meshy can use to fetch generated images. |
| `STORAGE_ROOT` | Working storage directory; defaults to `./storage`. |
| `MESHY_MODEL` | Optional Meshy model selection; otherwise uses the service default. |
| `PORT` | Local HTTP port; defaults to `3010`. |

An allowance file has this structure; choose your own access code:

```json
{"YOUR_ACCESS_CODE": {"remaining": 5}}
```

Keep keys, prompts, and deployment configuration outside the checkout.
Start with `npm start`, then open the server in your browser. For remote deployments,
put the local server behind an HTTPS reverse proxy. Generated images are served from
`/public/uploads` so the generation provider can retrieve them.

The frontend uses the same origin by default. For development with separate hosting,
set `?api=https://your-api.example.com` in the frontend URL.

## Project layout

- `frontend.html`: image upload, interactive preview, and model download.
- `server.js`: provider integration, task status, storage, and HTTP routes.
- `test/`: local configuration and route checks.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /modder/health` | Check service availability and generation configuration. |
| `POST /modder/promo/check` | Check a generation allowance. |
| `POST /modder/generate` | Submit a base64 image with an access code. |
| `GET /modder/status/:taskId` | Poll generation progress. |
| `GET /modder/model?url=…` | Retrieve a provider-hosted preview asset. |
| `GET /modder/fbx/:rigTaskId` | Download the generated model. |

## Development

Run `npm test` for local checks. Provider calls require your own account configuration
and may incur charges. Validate generated assets before using them in another project.

## License

MIT. See [LICENSE](LICENSE). Use images and assets you have permission to process.
