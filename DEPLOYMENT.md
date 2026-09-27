# RentMaster V7: Supabase + Vercel

V7 preserves the RentMaster Node.js UI and workflows but uses PostgreSQL for Supabase and exports an Express app through `api/index.js` for Vercel.

## 1. Create the Supabase database

1. Create a project at https://supabase.com.
2. Open **SQL Editor**.
3. Paste and run [`supabase-schema.sql`](supabase-schema.sql).
4. Confirm that these tables exist: `users`, `equipment`, `customers`, `rentals`, `calendar_events`, and `payment_transactions`.
5. Run this once in SQL Editor to create the first admin login:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
INSERT INTO users (username, password, role)
VALUES ('admin', crypt('admin123', gen_salt('bf')), 'admin')
ON CONFLICT (username) DO NOTHING;
```

Change this password immediately after first login.

## 2. Get Supabase credentials

In Supabase, open **Project Settings > Database** and copy the connection string. Use the **Transaction pooler** connection when deploying to Vercel. It normally uses port `6543`.

In **Project Settings > API**, copy:

- Project URL
- `service_role` secret key

Never expose the service-role key in frontend JavaScript. It belongs only in Vercel server environment variables.

## 3. Configure Supabase Storage

1. Open **Storage** in Supabase.
2. Create a bucket named `rentmaster-uploads`.
3. Keep the bucket **private**. Customer NIC/passport scans must not be world-readable.
4. The V7 server uploads NIC/passport images into `id-documents/` and stores the **object path** (not a URL) in `customers.id_image`.
5. Documents are served through `GET /customers/:id/document`, which requires a logged-in session and issues a 60-second Supabase signed URL.

## 4. Deploy to Vercel

Push the repository to GitHub, then create a Vercel project from it. Leave the
Vercel project **Root Directory** at the repository root (the default), because
`package.json`, `vercel.json`, and `api/` are already at the top level.

Vercel detects [`vercel.json`](vercel.json), which sends requests to [`api/index.js`](api/index.js).

Add these Production environment variables in Vercel:

```env
NODE_ENV=production
SESSION_SECRET=replace-with-a-long-random-secret
DATABASE_URL=postgresql://postgres.<project-ref>:<password>@<pooler-host>:6543/postgres
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<server-only-service-role-key>
SUPABASE_STORAGE_BUCKET=rentmaster-uploads
```

Do not set `VERCEL` yourself; Vercel injects `VERCEL=1` at runtime and rejects the reserved name.

Redeploy after adding or changing environment variables. Open the deployed URL at `/login`.

## 4b. Receipt email (Resend)

Receipts are emailed at checkout (agreement + advance) and at return (final,
with any early-return recalculation).

1. Create an account at https://resend.com and verify your sending domain.
2. Create an API key.
3. Add to Vercel:

```env
RESEND_API_KEY=re_xxxxxxxxxxxx
RECEIPT_FROM=RentMaster <receipts@yourdomain.com>
```

Without `RESEND_API_KEY` the app still works: receipts are skipped, or written
as HTML to `RECEIPT_LOG_DIR` when that is set. A failing receipt never fails
the rental it describes.

## 4c. Database migrations

Run the files in `migrations/` in order against the Supabase database, after
`supabase-schema.sql`. They are additive and safe to re-run:

```bash
psql "$DATABASE_URL?sslmode=require" -f migrations/001-advance-payment-and-deposit.sql
psql "$DATABASE_URL?sslmode=require" -f migrations/002-email-receipts-and-early-return.sql
```

## 5. Migrate existing MySQL data

The original PHP/V6 database is not modified. To copy its records into Supabase, add both database configurations to a local V7 `.env`:

```env
DATABASE_URL=your-supabase-pooler-connection-string
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=rentsystem
MYSQL_USER=root
MYSQL_PASSWORD=
```

Run this from a machine that can reach both databases:

```bash
cd rentmaster_V7
npm install
npm run migrate:mysql
```

The migration copies users, equipment, customers, rentals, calendar events, and payment transactions. It preserves IDs and can be run again safely because rows are upserted by ID. Local uploaded files must be uploaded to the Supabase Storage bucket separately.

## 6. Local V7 setup

From the repository root:

```bash
cd rentmaster_V7
cp .env.example .env
npm install
npm start
```

For local Supabase, edit `.env` with the same values. The local app runs at http://localhost:3000.

## 7. Git commands

From the repository root:

```bash
git add rentmaster_V7
git commit -m "Add RentMaster V7 Supabase Vercel app"
git push origin main
```

## Important production notes

- V7 uses PostgreSQL placeholders and schema; do not use the old MySQL `database.sql` with this project.
- Vercel functions are stateless. V7 uses signed cookie sessions instead of in-memory Express sessions.
- `app.set('trust proxy', 1)` is required. Vercel terminates TLS at the edge, so without it `req.protocol` is `http`, the `secure` session cookie is silently dropped, and login redirects back to `/login` forever.
- `vercel.json` must keep `includeFiles: "views/**"`. The EJS templates are read at runtime, so the bundler cannot trace them and pages return 500 without it.
- Node 22 or newer is required; `@supabase/supabase-js` needs a native `WebSocket`, which Node 18 does not provide.
- Vercel local disk is temporary. V7 uses Supabase Storage for uploaded ID documents.
- The existing PHP app and MySQL-based Node app remain unchanged in their original folders.
- The uploads bucket is private and capped at 5 MB with an image/PDF MIME allowlist.
- Still outstanding before wider rollout: CSRF protection and rate limiting on `/login`.
