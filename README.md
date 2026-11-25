# Odd Word Out

A phone web app for 4 to 12 players. Everyone gets the same secret word except the odd one(s), who get a close cousin of it. Players give clues, then vote. Works face to face or online, installs to the home screen, and needs no sign-in.

Roles are decided on the server and each phone only receives its own word, so nobody can peek by inspecting the page.

## Run it on your computer

```
npm install
npm start
```

Open http://localhost:3000. To test with friends on the same Wi-Fi, open `http://<your-computer-ip>:3000` on their phones. (Mic, install and wake lock need HTTPS, so use a real deployment for those.)

## Put it on the internet (free, about 10 minutes)

Phones need an HTTPS link. Any host that runs Node works.

### Render (easiest)
1. Create a free GitHub account and upload this folder as a new repository (do not upload `node_modules`).
2. On render.com choose New, then Web Service, and connect the repository.
3. Build command: `npm install`. Start command: `npm start`. Plan: Free.
4. When it finishes you get a link like `https://odd-word-out.onrender.com`. Share that.

### Railway or Fly.io
Both detect Node automatically. Use `npm start` as the start command. The app reads the `PORT` variable they provide.

### Things to know about free hosting
- Free services sleep after some idle time. The first visit can take 30 to 60 seconds to wake up.
- Games live in memory. If the server restarts, running games are lost and players just create a new one.
- Games with nobody in them are removed after 30 minutes.

## Install on a phone
- Android (Chrome): open the link, tap "Install the app" on the home screen, or the browser menu then Install app.
- iPhone (Safari): tap Share, then Add to Home Screen.

## Words
Words are not fixed pairs. Every round the server picks two related words at random from the chosen pack, so the group word and odd word are a new combination each game, and no word repeats within a game.

To add words, edit `words.json` (add new entries to a pack's list; related words work best when listed near each other) and restart the server.

## Chat and voice
- Chat: the Chat button in the top bar works in every mode.
- Voice chat: in Online mode, tap Join voice. Phones talk to each other directly (WebRTC), so no separate call is needed. Use headphones, and mute if you are in the same room as another player. Works well for up to about 8 people.
- Some mobile networks block direct phone-to-phone audio. If a player cannot hear others, add a free TURN relay: create an account with a TURN provider, then in Render open Environment and add `TURN_URLS` (for example `turn:your.turn.host:443`), `TURN_USER` and `TURN_PASS`. The app picks them up automatically.
- Voice needs the https link and a browser mic permission. Keep the screen on while talking.

## Files
- `server.js` game rooms and rules (WebSocket at `/ws`)
- `public/` the app (`app.js`, `style.css`, `sw.js`, `manifest.webmanifest`, icons)
- `words.json` word packs
