# Deploying SitePlanner

Target: the `missfits` Worker on the Real Estate AI Studio Cloudflare account,
currently reachable at `https://missfits.shiny-butterfly-2b90.workers.dev`, to
be fronted by `planning.realestateaistudio.com`.

SitePlanner is a static site, so `wrangler.toml` declares an **assets-only
Worker** — no `main`, no server code. Cloudflare serves `dist/` from the edge.
`not_found_handling = "404-page"` makes a missing path return the real 404 page
with a 404 status, rather than 200 with index.html.

`stage.sh` assembles `dist/` from `index.html`, `styles.css`, `404.html` and
`src/`, so `.git`, the docs screenshots and the test tooling never reach the
edge. `.github/workflows/deploy.yml` runs the tests, stages, deploys, then
verifies by status **and** content type per path.

## State

- [x] Worker `missfits` exists on the account
- [x] `wrangler.toml`, `stage.sh` and the workflow are in the repo
- [x] `wrangler deploy --dry-run` passes
- [ ] `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set as repo secrets
- [ ] custom domain `planning.realestateaistudio.com` attached
- [ ] first real deploy (the Worker still serves the stock "Hello world")

## 1. Mint a narrow token

Account-owned, **Workers Scripts: Edit** on this account only. Note that
`POST /user/tokens` fails when authenticating with an account-owned token —
use the account endpoint:

```bash
CF_ACCOUNT=<32-hex account id>
CF_TOKEN=<an existing token that can create tokens>

# Read the permission group id rather than trusting a hardcoded one
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/tokens/permission_groups" \
  -H "Authorization: Bearer $CF_TOKEN" | jq '.result[] | select(.name=="Workers Scripts Write")'

curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/tokens" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "siteplanner-worker-deploy",
    "policies": [{
      "effect": "allow",
      "resources": { "com.cloudflare.api.account.'"$CF_ACCOUNT"'": "*" },
      "permission_groups": [{ "id": "<Workers Scripts Write id>" }]
    }]
  }'
```

Verify the **value**, not the listing — a token can read as ACTIVE and still be
dead. Account tokens verify at the account endpoint, not `/user/tokens/verify`:

```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/tokens/verify" \
  -H "Authorization: Bearer $NEW_TOKEN"
```

## 2. Put it in the repo

GitHub → `pinekrone-dev/Mach4` → Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | the token from step 1 |
| `CLOUDFLARE_ACCOUNT_ID` | the 32-hex account id |

(A 32-hex string is an account id, never a token. Real API tokens are 40 chars;
an account id used as a credential answers error 6111, which reads like a broken
token and is not one.)

Then: Actions → **Deploy** → Run workflow. It also runs on any push to `main`
or `claude/charming-mayer-iljhu7`.

## 3. Attach the custom domain, once

Easiest in the dashboard: Workers & Pages → `missfits` → Settings → Domains &
Routes → Add → Custom domain → `planning.realestateaistudio.com`. Cloudflare
creates the DNS record itself because the zone is on the same account.

## 4. Verify like the deploy is lying

The workflow already does this, but by hand:

```bash
base=https://planning.realestateaistudio.com
curl -sI $base/                # 200, text/html
curl -sI $base/src/main.js     # 200, javascript
curl -so /dev/null -w '%{http_code}\n' $base/definitely-not-a-page   # 404
```

The 404 is the meaningful one. Without `not_found_handling` and a real
`404.html`, every missing path answers 200 with index.html and a bare 200 tells
you nothing.

## Deploying by hand

```bash
./stage.sh
npx wrangler deploy            # needs CLOUDFLARE_API_TOKEN in the environment
```

Once the Action is live, prefer pushing: `wrangler deploy` replaces the whole
Worker, so a manual deploy and a repo push race each other and the last one
wins. A hand deploy survives only until the next push.

## Notes

- The Worker name `missfits` is what shows in the `*.workers.dev` URL. Once the
  custom domain is attached that URL stops mattering, but renaming is cheap
  while nothing points at it: create a Worker with the new name, change `name`
  in `wrangler.toml`, redeploy, move the domain, delete the old one.
- The site is public with no auth. If it should not be, put Cloudflare Access
  in front of the custom domain — that needs no application change.
