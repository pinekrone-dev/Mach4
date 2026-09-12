# Deploying to planning.realestateaistudio.com

Target: a Cloudflare Pages project called `siteplanner` on the Real Estate AI
Studio account, served at `planning.realestateaistudio.com`.

State at the time of writing: the zone `realestateaistudio.com` is already on
Cloudflare; `planning.realestateaistudio.com` does not resolve, so there is no
existing site to overwrite and no diffing step needed.

`.github/workflows/deploy.yml` does the publishing. It runs the test suite,
stages `index.html`, `styles.css`, `404.html` and `src/` into `dist/`, and
deploys that with wrangler. It needs two repository secrets and one one-time
setup step.

## 1. Mint a narrow token

Account-owned, Pages:Write on this account only. Note that
`POST /user/tokens` fails when authenticating with an account-owned token —
use the account endpoint:

```bash
CF_ACCOUNT=<32-hex account id>
CF_TOKEN=<an existing token that can create tokens>

# Confirm the permission group ids rather than trusting them blindly
curl -s "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/tokens/permission_groups" \
  -H "Authorization: Bearer $CF_TOKEN" | jq '.result[] | select(.name|test("Pages"))'

curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/tokens" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "siteplanner-pages-deploy",
    "policies": [{
      "effect": "allow",
      "resources": { "com.cloudflare.api.account.'"$CF_ACCOUNT"'": "*" },
      "permission_groups": [{ "id": "8d28297797f24fb8a0c332fe0866ec89" }]
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
an account id used as a credential answers error 6111.)

## 3. Create the project, once

```bash
npx wrangler pages project create siteplanner --production-branch=main
```

Then run the workflow — Actions → "Deploy to Cloudflare Pages" → Run workflow.
It is also triggered by any push to `main` or `claude/charming-mayer-iljhu7`.

## 4. Attach the custom domain, once

```bash
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/pages/projects/siteplanner/domains" \
  -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"planning.realestateaistudio.com"}'
```

Cloudflare adds the CNAME itself when the zone is on the same account. If it
does not, add `planning` as a proxied CNAME to `siteplanner.pages.dev`.

## 5. Verify like the deploy is lying

The pages.dev apex serves the *previous* deployment for 30–45 seconds after
wrangler reports success, so wait before concluding anything failed. Then check
by content type and status, not a bare 200:

```bash
curl -sI https://planning.realestateaistudio.com/            # 200, text/html
curl -sI https://planning.realestateaistudio.com/src/main.js # 200, javascript
curl -so /dev/null -w '%{http_code}\n' \
     https://planning.realestateaistudio.com/definitely-not-a-page   # 404
```

The 404 check matters: with no `404.html` Pages answers 200 with index.html for
every missing path, so a bare 200 proves nothing. `404.html` is in the repo for
exactly this reason.

## After this

The repo is then the only write path. `wrangler pages deploy` replaces the whole
site, so a manual wrangler push and a repo push race each other and the last one
wins. Commit to the repo; if you wrangler-deploy to test, it survives only until
the next push.

To see which is which:
`GET /accounts/$CF_ACCOUNT/pages/projects/siteplanner/deployments` — entries
with a commit message came from the Action, entries without came from someone
running wrangler by hand.
