# Conversational Blender studio

A local practical-effects prototype inspired by this repo's interruptible visual director: **GPT-6 Astra chooses the scene edit, Blender animates gray geometry, and H3 Max generates a shot from three key images**. The last decoded video stays visible while the next one loads.

Requires Python 3.11+, Blender 5.1, a signed-in `codex` CLI with `gpt-6-astra` access, and a fal key. No OpenAI API key is needed; the planner uses the local Codex login. Voice input uses browser speech recognition where available; typed instructions are always supported. This prototype does not yet reuse the full Grok voice conversation transport.

```powershell
python apps/blender-studio/server.py --env .env --blender "C:/Program Files/Blender Foundation/Blender 5.1/blender.exe"
```

Open **http://127.0.0.1:4318**. Try “Fold the floor upward and lift the ceiling,” then “Make the windows float inward.” The companion Blender window shows real animated geometry beside the resulting video.

The first prototype supports hallway dimensions, floor folding, ceiling lift, window displacement, and visual style. Astra returns validated settings; arbitrary generated Python is never executed. Each completed edit submits one paid five-second H3 reference-to-video request, using images only. It is an experimental interpretation of the geometry, not guaranteed motion reconstruction.

Use a fresh `--runtime PATH` for each new server session. Outputs, plans and history remain local. The server binds to loopback and is not intended for public deployment. New instructions supersede stale results; accepted provider requests cannot be unbilled.

```sh
python -m unittest discover -s apps/blender-studio -p "test_*.py"
```
