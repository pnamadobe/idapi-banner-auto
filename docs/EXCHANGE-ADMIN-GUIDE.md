# Adobe Exchange Installation & Administrator Guide
## InDesign & Photoshop Banner Automation for AEM Assets View

This guide walks System Administrators and AEM Practitioners through acquiring, configuring, and enabling the **InDesign & Photoshop Banner Automation** extension from **Adobe Exchange** (`exchange.adobe.com`).

---

## 1. Prerequisites

Before installing the application on Adobe Exchange, verify that your Adobe Enterprise Organization has the following entitlements:

1. **Adobe Experience Manager as a Cloud Service — AEM Assets (Assets View)**
   - Your organization must have an active AEM Assets as a Cloud Service environment with **Assets View** UI Extensibility enabled.
   - *Note:* If the `aem/assets/assetsview/1` extension point is not yet visible in your **AEM Extension Manager** (`https://experience.adobe.com/aem/extension-manager`), open an Adobe Support ticket requesting UI Extensibility enablement for your IMS Organization ID and AEM environment (reference Adobe KB `KA-43394`).
2. **Adobe Developer App Builder**
   - Your IMS Organization must be entitled to **Adobe Developer App Builder** so Adobe Exchange can provision an isolated runtime environment in your organization.
3. **Adobe Firefly Services (InDesign API & Photoshop API)**
   - An OAuth Server-to-Server credential in your organization with **InDesign API** and **Photoshop API** entitlements.
4. **System Administrator Role**
   - You must hold the **System Administrator** role in the Adobe Admin Console (`adminconsole.adobe.com`) for your IMS Organization to approve and deploy Exchange applications.

---

## 2. Acquiring & Deploying the App on Adobe Exchange

1. **Acquire the Application**
   - Sign in to **Adobe Exchange** (`https://exchange.adobe.com/experiencecloud`) using an account with System Administrator privileges in your target IMS Organization.
   - Locate **InDesign & Photoshop Banner Automation** and click **Acquire**.
2. **Open App Builder Application Management**
   - Navigate to **Manage → App Builder applications** (`https://exchange.adobe.com/manage`).
   - Select **InDesign & Photoshop Banner Automation** from your organization's acquired applications list.
3. **Create an Environment**
   - Click **Add Environment** (you can create up to 10 environments per organization, such as `Stage` and `Production`).
   - Enter an environment name and proceed to the **Configuration** tab.

---

## 3. Environment Configuration Parameters

Fill in the fields in the Adobe Exchange **Configuration** tab as described below:

| Field Title | Key | Required | Description |
| :--- | :--- | :---: | :--- |
| **Firefly Services Client ID** | `FFS_CLIENT_ID` | **Yes** | OAuth Server-to-Server Client ID with **InDesign API** and **Photoshop API** entitlements. |
| **Firefly Services Client Secret** | `FFS_CLIENT_SECRET` | **Yes** | Client Secret corresponding to `FFS_CLIENT_ID` (stored encrypted as a secret). |
| **IMS Organization ID** | `FFS_ORG_ID` | **Yes** | Your Adobe IMS Organization ID in the format `XXXXX@AdobeOrg`. |
| **Default AEM Author URL** | `AEM_AUTHOR_URL` | **Yes** | Default AEM as a Cloud Service Author URL (e.g., `https://author-p12345-e67890.adobeaemcloud.com`). Any environment in the same Cloud Manager program (`p12345`) is automatically permitted. |
| **AEM OAuth Server-to-Server Client ID** | `AEM_OAUTH_CLIENT_ID` | **Yes*** | OAuth S2S Client ID with read/write access to your target AEM DAM folders for durable background rendering. |
| **AEM OAuth Server-to-Server Client Secret** | `AEM_OAUTH_CLIENT_SECRET` | **Yes*** | Client Secret for `AEM_OAUTH_CLIENT_ID` (stored encrypted as a secret). |
| **AEM Service Credential JSON (Base64 Fallback)** | `AEM_SC_JSON` | Optional | Base64-encoded AEM Cloud Manager Technical Account JSON (only needed if not using `AEM_OAUTH_CLIENT_ID`). |
| **Allowed AEM Author URLs / Programs** | `ALLOWED_AEM_AUTHORS` | Optional | Comma-separated list of additional allowed AEM Author URLs, hostnames, or program IDs (e.g., `p12345,p67890`). |
| **Shared DAM Fonts Path** | `AEM_FONTS_PATH` | Optional | Shared DAM folder path containing brand fonts automatically bundled into renders. Defaults to `/content/dam/fonts`. |
| **Assets View Tenant Handle** | `ASSETS_VIEW_TENANT` | Optional | Your `@tenant` handle in Assets View URLs (`https://experience.adobe.com/#/@tenant/assets/...`). Auto-detected when omitted. |
| **State Storage Region** | `AIO_STATE_REGION` | Optional | Data residency region for job state storage: `amer` (US, default), `emea` (EU), `apac` (Japan), or `aus` (Australia). |
| **InDesign Capability Execute URL** | `INDESIGN_EXECUTE_URL` | Optional | Leave blank for automatic capability registration on first run, or supply a pre-registered `/v3/capability` execution URL. |
| **GitHub Dispatch Token** | `GITHUB_DISPATCH_TOKEN` | Optional | Fine-grained GitHub token with **Actions: Read and write** and **Contents: Read** on your EDS site repository (forked from `banner-ads`; see [HTML5-SETUP.md](HTML5-SETUP.md) Step 6). Only required if using the **Package for CM360** button. |
| **CM360 Writeback HMAC Secret** | `HTML5_WRITEBACK_SECRET` | Optional | Random secret string (32+ characters) used to sign short-lived HMAC writeback tokens for the GitHub Actions Playwright packaging runner (only required if using **Package for CM360**). |

4. **Select Product Profiles & Deploy**
   - Select the appropriate Adobe Product Profiles for your organization when prompted.
   - Click **Deploy**. Adobe Exchange will automatically provision the application into an isolated workspace in your organization.

---

## 4. Enabling & Configuring Per AEM Environment (AEM Extension Manager)

Once deployed in Adobe Exchange, you can enable, disable, or customize the extension for specific AEM as a Cloud Service environments (Dev, Stage, Production):

1. Open **AEM Extension Manager** at `https://experience.adobe.com/aem/extension-manager`.
2. In the top bar, select your **AEM Program** and **Environment** (e.g., `author-p12345-e67890`).
3. Locate **InDesign & Photoshop Banner Automation** (`idapi-banners`) in the extensions list and toggle it **On**.
4. *(Optional)* Click the **Configure (Gear) icon** next to the extension to set per-environment overrides without redeploying:
   - `aemAuthorUrl`: Override the target AEM Author URL for this environment.
   - `assetsViewTenant`: Override the `@tenant` handle for output folder deep links.

---

## 5. Using the Extension in AEM Assets View

1. Prepare a campaign folder in AEM Assets View (`/content/dam/<your-campaign>`) containing:
   - An InDesign (`.indd`) or Photoshop (`.psd`) banner template
   - A page map CSV (`*pagemap*.csv`) listing the pages/artboards to export
   - A variations CSV (`*.csv`) with one row per creative variation (`outputFileName` plus columns matching your template's InDesign Script Labels or PSD layer names)
   - Campaign images (`.jpg`, `.png`) in the folder or subfolders
   - *(Optional)* A `fonts/` subfolder (or shared `/content/dam/fonts` folder) with `.otf`/`.ttf` font files
2. In **AEM Assets View**, select the `.indd` or `.psd` template file.
3. Click **Generate Banners** in the top ActionBar.
4. Review the automatic **Preflight Inspection** (row count, page count, and any missing image or column warnings) and choose your output mode:
   - **Generate banners:** Flattened JPG banners for every size × variation row.
   - **Generate HTML5 banners:** Animated Edge Delivery Services / Document Authoring HTML5 banners with selectable industry animation choreography (`Subtle / Editorial`, `Luxury / Cinematic`, `Bold / Kinetic`, `Retail / Promo`, `Clean Wipe / Split`, `Minimal / Compliance-Safe`).
   - **Generate banners + editable file:** Flattened JPGs plus an editable `.indd` (with remapped AEM Asset Links, thumbnail rendition, and multi-page `.pdf` proof) or `.psd` per variation row.
   - **Editable INDDs/PSDs only:** Editable files without flattened JPGs.
5. Generated assets are written unpublished into `<campaign-folder>/output` for review and approval.
