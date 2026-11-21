# AutoModder Ai Framework 🌟 [open source]

Guys, the goal has always been to make modding easier for everyone. This is the dev side of that journey 😎

**TL;DR:** Want to build and experiment? You're in the right place. Want to jump into the hosted version? Check out **[automodder.site](https://automodder.site)** — that version runs on my servers and handles the AI credits for you.

## A little backstory / lore

I've been making mods for decades. OGs might remember Shitty Melee and USA Melee. Lawl. I got serious about NewChallengers in 2019, but sharing what I learn goes all the way back to my SmashBoards guides.

The idea hasn't changed: make this stuff easier to get into, then see what everyone makes with it. AI tools have opened up a whole new world for that. It's pretty wild tbh.

## So what's in here? 👀

An image-to-3D starting point you can run, mess with, and build on:

1. Pick a character image.
2. Let your configured image service prepare it.
3. Send it to Meshy to make a 3D model.
4. Spin it around in the browser and grab the download.
5. Open it in Blender or whatever 3D tools you like and keep going.

This repo handles image generation, progress updates, previews, and model downloads. Connecting those assets to a particular game is a separate integration. The hosted AutoModder has its own workflow — check it out if you want the ready-to-use experience.

## Let's get it running 🛠️

You'll want Node.js 22 or newer. Grab the dependencies:

```bash
npm install
```

Then set up these environment variables. Bring your own API accounts for this version:

| Variable | What goes here |
| --- | --- |
| `MESHY_KEY_FILE` | The path to a file with your Meshy API key. |
| `GEMINI_KEY_FILE` | The path to a file with your image API key. |
| `IMAGE_PROMPT_FILE` | A file with your image preparation instructions. Make it your own. |
| `IMAGE_MODELS` | Your provider's image model identifiers, separated by commas. |
| `PROMO_CODES_FILE` | A JSON file with your access codes and generation counts. |
| `PUBLIC_BASE_URL` | Your public HTTPS origin, so Meshy can fetch the generated images. |
| `STORAGE_ROOT` | Where your working files go. Defaults to `./storage`. |
| `MESHY_MODEL` | Optional. Pick a Meshy model, or leave it out to use their default. |
| `PORT` | Your local HTTP port. Defaults to `3010`. |

Here's what the access-code file looks like. Pick your own code:

```json
{"YOUR_ACCESS_CODE": {"remaining": 5}}
```

Keep your keys, prompts, and server configuration outside the repo. Those are yours.

Now start it up:

```bash
npm start
```

Open `http://localhost:3010` in your browser (or whatever port you picked). To make generation work on a hosted setup, put the server behind an HTTPS reverse proxy. Images live at `/public/uploads` so Meshy can reach them.

Hosting the frontend separately? Add `?api=https://your-api.example.com` to its URL. Otherwise it talks to the same server you're viewing it on.

## Where's everything?

- `frontend.html` — the upload screen, 3D preview, and download button.
- `server.js` — talks to the providers, tracks jobs, and handles files and requests.
- `test/` — a few checks to help catch broken stuff before you ship it.

## API stuff, if you're building on this

| Endpoint | What it does |
| --- | --- |
| `GET /modder/health` | Is the server up? Is generation configured? |
| `POST /modder/promo/check` | Check how many generations an access code has left. |
| `POST /modder/generate` | Send a base64 image and an access code to start a job. |
| `GET /modder/status/:taskId` | See how the job is doing. |
| `GET /modder/model?url=…` | Fetch a preview model from the provider. |
| `GET /modder/fbx/:rigTaskId` | Grab the generated model. |

## Mess with it, make something cool ✨

Run `npm test` when you change things. The tests use simulated provider responses, so they don't spend your credits. Actual generation uses your API accounts and can cost money. Give your models a look before using them elsewhere.

I want more people trying this stuff, sharing ideas, and making things nobody else would have thought of. Go see what people are making on [AutoModder](https://automodder.site), too!

## Open source, go have fun

MIT license — see [LICENSE](LICENSE). Use images and assets you have permission to work with.
