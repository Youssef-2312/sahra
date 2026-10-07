# Sahra setup (owner's steps)

Everything here is done by you, on your accounts. Nothing in this repository
creates Cloudflare or Google resources by itself. Secrets are typed or piped by you
directly into Cloudflare, never into chat and never into the repository.

You need Node.js 20+ and git on your computer.

```sh
git clone https://github.com/Youssef-2312/sahra && cd sahra
npm ci
npx wrangler login          # opens a browser; this login is the credential only you hold
```

## 1. Cloudflare resources (production)

```sh
npx wrangler d1 create sahra-prod      # prints a database_id: send it to Claude (it is not a secret)
npx wrangler r2 bucket create sahra-prod
```

R2 asks for an "R2 subscription" (a checkout with a payment method) before the first
bucket. Usage inside the free allowance (10 GB-month storage, 1M Class A and 10M
Class B operations per month) is not charged, but usage above it is billed; there is
no hard cap. Decide before doing this step.

## 2. Workers Builds (deploy from GitHub)

Dashboard: **Workers & Pages > Create > Import a repository > Youssef-2312/sahra**.

- Project / Worker name: `sahra` (must match `wrangler.jsonc`).
- Production branch: `main`.
- Build command: leave empty.
- Deploy command: `npx wrangler d1 migrations apply DB --remote && npx wrangler deploy`
- **Settings > Build > Branch control: untick "Enable Preview Builds".** Previews
  are not used for this Worker; only `main` deploys, and `main` changes only through
  pull requests you merge.
- API token: the token Workers Builds creates has Workers Scripts, KV and R2
  permissions but **not D1**. In **My Profile > API Tokens**, edit that token and add
  **Account > D1 > Edit**, otherwise the migrations step fails.

Note: whoever can merge to `main` can run any `wrangler` command with that token
(including D1 restores). Keep write access to the repository to yourself.

## 3. Secrets (after the first deploy exists)

```sh
node scripts/gen-secret.mjs | npx wrangler secret put QR_MASTER_K1
node scripts/gen-secret.mjs | npx wrangler secret put LINK_MASTER_K1
```

## 4. Google OAuth client (after the first deploy)

Google Cloud Console > APIs & Services:

1. OAuth consent screen: User type **External**. App name "Sahra". Scopes: only
   `openid`, `email`, `profile`. **Do not upload a logo** or add other branding
   (that triggers brand verification). Publish the app (In production).
2. Credentials > Create credentials > OAuth client ID > **Web application**.
   Authorized redirect URI, exactly:
   `https://sahra.<your-subdomain>.workers.dev/api/auth/google/callback`
3. Send Claude the **client ID** (not secret). Set the client secret yourself:

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET     # paste when prompted; input is hidden
```

## 5. First party and owner

```sh
node scripts/create-party.mjs --id <slug> --name "<Party name>" --capacity 300 \
  --max-per-ticket 4 --owner-name "<Owner>" --owner-email <owner>@gmail.com
```

The owner then opens `https://sahra.<your-subdomain>.workers.dev/` and signs in with
Google. The invitation is valid for 14 days.

## Optional: staging Worker

A separate Worker `sahra-staging` with its own D1 and R2 (`env.staging` in
`wrangler.jsonc`), so test code never touches live data:

```sh
npx wrangler d1 create sahra-staging
npx wrangler r2 bucket create sahra-staging
```

Connect it as a second Workers Builds project with deploy command
`npx wrangler d1 migrations apply DB --remote --env staging && npx wrangler deploy --env staging`.
