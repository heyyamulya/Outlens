# Outlens
Hackathon project, HackLanta, 28h, SOLO beginner. See the project brief.
Browser app: tap (later pinch) an object -> outline -> estimated color -> callout label -> optional voice.

## Stack
Next.js on Vercel. MediaPipe in the browser. Server routes for Gemini and ElevenLabs.

## Rules
- Plain language. One small step at a time. Plan first, code after I approve.
- Never invent library APIs, model names, or versions. Check official docs and say what you checked.
- Always say 'estimated'. No food-safety, ripeness certainty, or medical claims.
- Traffic lights only as a labeled SIMULATION.
- Never store camera images. Send only a cropped selection to Gemini, only on selection.
- MediaPipe runs on the device and never sends images, but it sends usage/performance metrics to Google. Mention this in the privacy note (Stage 7).
- Tap must always work; pinch is an extra.
- Never rely on color alone in the UI. Avoid red/green. Use blue + amber + neutral.
- The label's color swatch shows sampled camera content, not UI color, so it is exempt from the red/green rule. The text must always carry the full meaning.
- Label anything sample or simulated.
- Commit and deploy after every working stage. API keys only in server environment variables.

## Stages
0 deploy; 1 camera+tap+color; 2 outline; 3 callout; 4 voice; 5 Gemini; 6 pinch; 7 landing+domain+polish; 8 submit
- Stage 7 todo: revisit the freeze on tap (e.g. auto-resume after a few seconds, or resume when the label is closed).

## Status
(update after each stage)
- Stage 0: done. Next.js 16.4.0 placeholder page deployed. Repo: https://github.com/heyyamulya/Outlens. Live: https://outlens-one.vercel.app
- Stage 1: done. /explore has the live camera, tap, and estimated color label with swatch. Tested on laptop and phone (rear camera works). Known: white can read as gray or light orange in some lighting (camera white balance); tuning skipped for now.
- Stage 2: done. Tap freezes the frame and a "magic wand" outline (lib/colorRegion.ts: grows from the tap over similar colors in CIELAB, about 50 ms, no model) is drawn, with the estimated color from inside it. Falls back to a simple rounded shape when there is no clear edge. Known: patterned/textured objects outline one color area, not the whole object. MediaPipe segmenter (lib/segmenter.ts) is switched off: in 1.0.1 its GPU mode returned empty masks and CPU took about 12 s per tap.
- Stage 3: done. Callout styled like the mockup: thin blue glowing outline, white ring dot at the tap point, thin blue line that bends into a white pill label (swatch, "Estimated: ...", Listen, close). lib/callout.ts places the label in free space, avoiding the object and the controls (tests: scripts/check-callout.mjs). The look can be fully restyled later: styles are in CameraExplorer.tsx and the top of lib/drawOutline.ts.
- Scope decision: the outline targets solid, single-color objects (mugs, cups, books, fruit, shoes). Not glass, water, reflections, or thin parts like chair legs. The bottom hint says so.
- Stage 4 (in progress): Listen button. app/api/speak/route.ts calls ElevenLabs (key only in env var ELEVENLABS_API_KEY; optional ELEVENLABS_VOICE_ID). Only phrases like "Estimated color: dark blue." are allowed, to protect credits. lib/speak.ts fetches the audio when a label appears and plays it on Listen; if it is not ready or fails, the browser voice speaks instead.
