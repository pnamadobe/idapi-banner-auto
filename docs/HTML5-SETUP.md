# HTML5 banner setup

One-time setup so **Generate Banners → HTML5** in AEM Assets View can publish animated HTML5 ads for you.

HTML5 banners are published to **your own** Edge Delivery Services (EDS) site, authored in Document Authoring
(DA). There is no shared or default site. Each campaign folder in AEM points at a site through an `html5.json`
file. If that file is missing, the Generate Banners dialog shows **"No EDS site for this folder"** and lists the
folders it looked in.

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

## Step 5: Add `html5.json` to the campaign folder in AEM

This file tells Generate Banners which site the campaign publishes to.

1. On your computer, create a file named exactly **`html5.json`**:

   ```json
   { "DA_ORG": "<owner>", "DA_SITE": "<repo>" }
   ```

2. In AEM Assets View, upload it into the **campaign folder** (the folder you run Generate Banners on), **or
   any folder above it**. The nearest `html5.json` wins, so one file in a brand or client folder covers every
   campaign under it, and a campaign folder can override it with its own. The search stops at the folder below
   `/content/dam`.

   Example: `/content/dam/26H2/hilton-hgv/html5.json` covers
   `/content/dam/26H2/hilton-hgv/automation` and every other campaign under `hilton-hgv`.

Optional keys:

| key | default | when to set it |
|---|---|---|
| `DA_ADS_ROOT` | `/ads` | campaign pages should go somewhere else in the site |
| `EDS_REF` | `main` | previews should use another branch: `https://<ref>--<repo>--<owner>.aem.page` |
| `GITHUB_REPO` | `<DA_ORG>/<DA_SITE>` | the GitHub repo name differs from the DA org and site |

Rules: the file must be a JSON object; `DA_ORG`, `DA_SITE` and `EDS_REF` may only contain letters, digits and `-`;
`GITHUB_REPO` is `owner/repo`. Put **no tokens or secrets** in it. It is an ordinary DAM asset that anyone with folder access can
read.

**Check:** reopen **Generate Banners** on the campaign folder. Under the HTML5 option, the dialog now shows your
site and DA path (for example "in **<owner>/<repo>** under **/ads/…**") instead of "No EDS site for this folder".

## Step 6: Packaging for CM360 (optional)

**Package for CM360** zips each published ad with a GIF preview and storyboard. It does so by starting the
`package.yml` workflow in your repo. The workflow needs no secrets of its own, but the deployment's dispatch
token must be allowed to start workflows in your repo.

Ask whoever runs the Generate Banners deployment to give its GitHub dispatch token (`GITHUB_DISPATCH_TOKEN`,
a fine-grained token) **Actions: read and write** and **Contents: read** on `<owner>/<repo>`. If you run
your own deployment, create that token yourself and set it in the deployment's environment. It is a deployment
secret, so never commit it.

**Check:** after an HTML5 run, click **Package for CM360**. A run appears under
`https://github.com/<owner>/<repo>/actions`, and the zips land in the campaign's `output/html5` folder in AEM.

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| **No EDS site for this folder**, "add html5.json to the campaign folder" | No `html5.json` in the campaign folder or any folder above it (the dialog lists the folders it checked) | Step 5 |
| "… is not valid JSON" / "must be a JSON object" | `html5.json` exists but is malformed | Fix the file and re-upload it. Use straight quotes `"`, and no trailing commas |
| Generate HTML5 is disabled | Same as the two rows above. The other Generate modes still work | Step 5 |
| `HTML5_DA_NO_ACCESS`, DA returned 401/403 | Your Adobe ID cannot write to the DA site | Step 4.1 |
| `HTML5_DA_NO_ACCESS`, "EDS could not read the page from DA" / preview 401 | The site needs sign-in for preview and you lack the author role, or Code Sync is not set up | Steps 4.2 and 2 |
| Preview page is blank or the ad doesn't animate | The repo is missing the `ad` block, or `EDS_REF` points at a branch without it | Step 1. Check `blocks/ad/` is on the branch in `EDS_REF` |
| Package for CM360: "GitHub dispatch <owner>/<repo> -> 403/404" or "GITHUB_DISPATCH_TOKEN is not configured" | The dispatch token cannot reach your repo, or `package.yml` is missing | Step 6 |
| Pages were written to someone else's site | `html5.json` names the wrong org or site, or a folder above yours has one | The dialog shows the resolved site before you run. Add your own `html5.json` in the campaign folder to override |

Still stuck? The design notes in [HTML5-DESIGN.md](HTML5-DESIGN.md) (§11) describe how the site is resolved and
who the writes run as.
