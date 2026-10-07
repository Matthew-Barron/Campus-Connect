# Campus Connect

Marketplace, events, polls, societies and tutoring for verified students.
Express + MySQL backend, static frontend served from `public/`.

## Run locally
1. `npm install`
2. Copy `.env.example` to `.env` and fill in your values
3. Run `DATABASE_SCHEMA.sql` in MySQL
4. `npm start` then open http://localhost:5000

## Deploy for free (Render + hosted MySQL)
1. Create a free MySQL database (TiDB Cloud Serverless or Aiven) and run `DATABASE_SCHEMA_HOSTED.sql` in its SQL console.
2. On render.com: New > Web Service > connect this repo. Build: `npm install`. Start: `npm start`.
3. Add environment variables: `NODE_ENV=production`, `JWT_SECRET`, `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_SSL=true`.
4. Health check: `/health`
