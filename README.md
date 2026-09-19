# PES Timetable

Vanilla HTML/CSS/JavaScript timetable with manual scheduling, a countdown, and
Gemini-powered timetable screenshot import. The API key is used only by the
server-side API endpoint; it is never sent to the browser.

## Local development

Requires Node.js 22 or newer.

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a local environment file:

   ```sh
   cp .env.example .env
   ```

3. Add a newly created Gemini key to `.env`:

   ```env
   GEMINI_API_KEY=your_key_here
   GEMINI_MODEL=gemini-2.5-flash
   ```

4. Run the local server:

   ```sh
   npm start
   ```

5. Open `http://127.0.0.1:3000`.

`dev-server.cjs` provides local static files and `POST /api/analyze-timetable`.

## Vercel deployment

1. Push this repository to GitHub and import it into Vercel.
2. In **Project Settings → Environment Variables**, set:

   ```text
   GEMINI_API_KEY
   GEMINI_MODEL
   ```

3. Deploy. Vercel serves the static frontend and the serverless function at
   `/api/analyze-timetable` automatically.

Do not add the Gemini key to the website, source code, or repository. The
browser uses the same-origin relative API route, so no localhost URL or CORS
configuration is required in production.

## Data behavior

- A new browser starts with a blank timetable-information section, an empty
  timetable, and no countdown.
- Timetable, imported subject definitions, timetable information, and countdown
  are persisted separately in browser localStorage.
- **Reset Timetable** clears only the schedule; it does not overwrite the
  user's timetable information.
- Screenshot imports are reviewed before confirmation. The image is the source
  of truth: unknown subjects are created dynamically, and detected empty cells
  remain empty.

## Project structure

```text
index.html                 UI shell
script.js                  timetable UI, persistence, and import review
styles.css                 dark UI styling
dev-server.cjs             local-development static/API server (not deployed)
lib/timetable-analysis.js  shared Gemini, multipart, and validation logic
api/analyze-timetable.js   Vercel serverless API route
.env.example               local configuration template
```
