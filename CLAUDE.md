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
- Tap must always work; pinch is an extra.
- Never rely on color alone in the UI. Avoid red/green. Use blue + amber + neutral.
- Label anything sample or simulated.
- Commit and deploy after every working stage. API keys only in server environment variables.

## Stages
0 deploy; 1 camera+tap+color; 2 outline; 3 callout; 4 voice; 5 Gemini; 6 pinch; 7 landing+domain+polish; 8 submit

## Status
(update after each stage)
- Stage 0: done. Next.js 16.4.0 placeholder page deployed. Repo: https://github.com/heyyamulya/Outlens. Live: https://outlens-one.vercel.app