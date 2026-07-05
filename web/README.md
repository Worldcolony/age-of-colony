# Age of Colony Web

Next.js frontend for the Age of Colony match-room experience.

## Development

Start the FastAPI engine from the repository root:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Then start the web app from this directory:

```bash
npm run dev
```

Open http://localhost:3000. API requests are proxied to the backend through
`next.config.ts`, so `NEXT_PUBLIC_API_URL` can stay empty for local development.

## Checks

```bash
npm run lint
npm run build
```

The production build uses `next/font/google`, so it needs network access to
download the configured fonts unless they are already cached by the build
environment.
