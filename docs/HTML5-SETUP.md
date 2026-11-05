# HTML5 banner setup

One-time setup so **Generate Banners → HTML5** in AEM Assets View can publish animated HTML5 ads for you.

For how it works (how the INDD is read, how the EDS pages and variations are built, and how CM360 packaging
works) and the template authoring rules, see [HTML5-HOW-IT-WORKS.md](HTML5-HOW-IT-WORKS.md).

HTML5 banners are published to **your own** Edge Delivery Services (EDS) site, authored in Document Authoring
(DA). There is no shared or default site. Steps 1–4 create the site once. Step 5 is done in the Generate Banners dialog: when a
campaign folder has no site yet, it asks for the DA org and site, checks you can write to it, and saves the choice
on the folder (as an `html5.json` file).

> **Using Claude or another coding agent?** Point it at this file and ask it to walk you through the setup. Every
> step below says what to do, how to check it worked, and what common errors mean. Nothing here needs a token or
> secret from you. Never paste tokens into `html5.json`, the dialog or a repo.

You will need:

* a GitHub account (or org) that can create repositories;
* an Adobe ID that can sign in to [da.live](https://da.live);
* access to the AEM Assets folder that holds your campaign (template, variations CSV, page map).

Throughout this guide, `<owner>` is your GitHub user or org and `<repo>` is the repository name you pick. The DA
org and site are the same two names.

---

## Step 1: Create your site repo from `banner-ads`

The ad block, motion presets and CM360 packaging workflow live in the
[`pnamadobe/banner-ads`](https://github.com/pnamadobe/banner-ads) starter repo.

1. Open <https://github.com/pnamadobe/banner-ads>. Click **Use this template → Create a new repository**, or
   **Fork** it.
2. Pick an owner (`<owner>`) and a name (`<repo>`), for example `acme/banner-ads`. Lower-case letters, digits and
   `-` only.

**Check:** `https://github.com/<owner>/<repo>` exists and contains `blocks/ad/` and
`.github/workflows/package.yml`.

## Step 2: Install AEM Code Sync on the repo

EDS serves your code straight from GitHub through the AEM Code Sync app.

1. Open <https://github.com/apps/aem-code-sync> and click **Install** (or **Configure** if it is already
   installed for `<owner>`).
2. Choose **Only select repositories**, add `<repo>`, and save.

**Check:** after a minute, `https://main--<repo>--<owner>.aem.page/` loads. A 404 page from EDS is fine at this
point. An error saying the repo or code is not found means Code Sync is not installed on the repo yet.

## Step 3: Create the DA site

1. Open <https://da.live/start>.
2. Enter the repo URL `https://github.com/<owner>/<repo>` and follow the steps. The DA org becomes `<owner>` and
   the site becomes `<repo>`.

**Check:** `https://da.live/#/<owner>/<repo>` opens and shows the site's content (it may be empty).

## Step 4: Make sure you can write to the site

Generate Banners writes the DA pages and starts the EDS preview **as you** (your signed-in Adobe identity). So
your Adobe ID needs write access.

1. **DA permissions.** If the DA org has permissions set up, open `https://da.live/#/<owner>/.da/config`
   (org admins only). Make sure your Adobe ID, or a group you are in, has `write` on `/<repo>/+**`. A brand-new
   org with no permissions sheet lets the creator write everywhere.
2. **Sign-in-protected sites only.** If the site requires sign-in for preview (an `admin` access config), add
   your Adobe ID with the `author` (or higher) role in the
   [EDS user admin tool](https://tools.aem.live/tools/user-admin/index.html). Skip this if the site is open.

**Check:** in DA, create a test document under `/ads`, click **Preview**, and confirm
`https://main--<repo>--<owner>.aem.page/ads/<doc>` opens. Delete the test document afterwards.

## Step 5: Pick the site in the Generate Banners dialog

1. In AEM Assets View, select the campaign folder and open **Generate Banners → HTML5**.
2. The dialog says **"No EDS site is set for this folder yet."** Enter:
   * **DA org**: `<owner>`
   * **DA site**: `<repo>`
   * **Use it for**: the campaign folder, or a folder above it. Pick a brand or client folder to cover every
     campaign under it. A campaign folder can still get its own site later.
3. Click **Save site**. The dialog checks, as you:
   * that your Adobe ID can write to `<owner>/<repo>` in DA (step 4);
   * that `https://main--<repo>--<owner>.aem.page/blocks/ad/ad.js` exists (steps 1 and 2);
   * that you can add files to the chosen AEM folder.

   If all pass, it saves `html5.json` in that folder.

**Check:** the dialog now shows "Publishing to **<owner>/<repo>** (set on …) · change". Use **change** to point
the folder at another site.

### Advanced: write `html5.json` by hand

The dialog saves a file named `html5.json` in the folder. You can also upload one yourself, for example to set
optional keys:

```json
{ "DA_ORG": "<owner>", "DA_SITE": "<repo>", "DA_ADS_ROOT": "/ads" }
```

The nearest `html5.json` wins: the campaign folder's own, else the closest folder above it, stopping at the
folder below `/content/dam`. Saving from the dialog keeps any optional keys already in the file.

| key | default | when to set it |
|---|---|---|
| `DA_ADS_ROOT` | `/ads` | campaign pages should go somewhere else in the site |
| `EDS_REF` | `main` | previews should use another branch: `https://<ref>--<repo>--<owner>.aem.page` |
| `GITHUB_REPO` | `<DA_ORG>/<DA_SITE>` | the GitHub repo name differs from the DA org and site |
| `EYEBROW_RATIO` | `0.35` | a small line set right above the largest text (a kicker like "GET" over "50,000") should be raised to a different share of that text's size; `0` keeps the template's size. HTML5 only: the JPGs keep the template's sizes |
| `TEXT_SCALE` | none | size named text layers in the HTML5 ads only, e.g. `{"kicker": 1.5, "legal": 1.2}` (factor 0.25 to 4; `1` leaves a layer as designed and skips the eyebrow rule for it) |

Rules: the file must be a JSON object; `DA_ORG`, `DA_SITE` and `EDS_REF` may only contain letters, digits and `-`;
`GITHUB_REPO` is `owner/repo`. Put **no tokens or secrets** in it. It is an ordinary DAM asset that anyone with
folder access can read.

## Step 6: Packaging for CM360 (optional)

**Package for CM360** zips each published ad with a GIF preview and storyboard. It does so by starting the
`package.yml` workflow in your repo. The workflow needs no secrets of its own, but the deployment's dispatch
token must be allowed to start workflows in your repo.

Ask whoever runs the Generate Banners deployment to give its GitHub dispatch token (`GITHUB_DISPATCH_TOKEN`,
a fine-grained token) **Actions: read and write** and **Contents: read** on `<owner>/<repo>`. If you run
your own deployment, create that token yourself and set it in the deployment's environment. It is a deployment
secret, so never commit it.

**Check:** after an HTML5 run, click **Package for CM360**. A run appears under
`https://github.com/<owner>/<repo>/actions`, and the zips, GIF previews and storyboards land in the job's `output/html5/cm360` folder in AEM. The modal
links to that folder in Assets View.

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| **No EDS site is set for this folder yet** | No `html5.json` in the campaign folder or any folder above it | Step 5 |
| "The html5.json in … can't be used", "… is not valid JSON" / "must be a JSON object" | A hand-made `html5.json` is malformed | Save the site again from the dialog, or fix the file. Use straight quotes `"`, and no trailing commas |
| Generate HTML5 is disabled | No usable site yet. The other Generate modes still work | Step 5 |
| Save site: "your Adobe ID can't open … in Document Authoring" / "can read … but not write" | You lack write access to the DA site | Step 4 |
| Save site: "… was not found in Document Authoring" | The DA org or site name is wrong, or the DA site doesn't exist | Step 3 |
| Save site: "… has no ad block (blocks/ad/ad.js)" | The repo isn't from `banner-ads`, or Code Sync isn't installed | Steps 1 and 2 |
| Save site: "you can't add files to … in AEM" | You can't edit that AEM folder | Pick another folder under **Use it for**, or ask an AEM admin |
| `HTML5_DA_NO_ACCESS`, DA returned 401/403 | Your Adobe ID cannot write to the DA site | Step 4.1 |
| `HTML5_DA_NO_ACCESS`, "EDS could not read the page from DA" / preview 401 | The site needs sign-in for preview and you lack the author role, or Code Sync is not set up | Steps 4.2 and 2 |
| Preview page is blank or the ad doesn't animate | The repo is missing the `ad` block, or `EDS_REF` points at a branch without it | Step 1. Check `blocks/ad/` is on the branch in `EDS_REF` |
| Package for CM360: "GitHub dispatch <owner>/<repo> -> 403/404" or "GITHUB_DISPATCH_TOKEN is not configured" | The dispatch token cannot reach your repo, or `package.yml` is missing | Step 6 |
| Pages were written to someone else's site | A folder above yours set another site | The dialog shows the site before you run. Click **change** and save your site on the campaign folder |

Still stuck? [HTML5-HOW-IT-WORKS.md](HTML5-HOW-IT-WORKS.md) lists every HTML5 and CM360 issue code. The design
notes in [HTML5-DESIGN.md](HTML5-DESIGN.md) (§11) describe how the site is resolved and who the writes run as.
