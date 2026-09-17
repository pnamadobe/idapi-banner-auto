# 374TanBadger

Welcome to my Adobe I/O Application!

## Setup

- Copy `.env.example` to `.env` and fill it with credentials for your own
  App Builder workspace, Firefly Services project, and AEM environment. The
  extension does not use a shared AEM environment.
- Keep `.env` local. It is ignored by Git.

## Local Dev

- `aio app run` to start your local Dev server
- App will run on `localhost:9080` by default

By default the UI will be served locally but actions will be deployed and served from Adobe I/O Runtime. To run your actions locally use the `aio app dev` option.

For more information on the difference between `aio app run` and `aio app dev`, see [here](https://developer.adobe.com/app-builder/docs/guides/development/#aio-app-dev-vs-aio-app-run)

## Test & Coverage

- Run `aio app test` to run unit tests for ui and actions
- Run `aio app test --e2e` to run e2e tests

### Long renders

The Generate Banners action is a durable job launcher, not a blocking render request. It stores a seven-day job record in App Builder State and queues `generate-idapi-banners-worker`. Each worker invocation renders at most two CSV rows (configurable with `batchSize`, capped at ten), then queues the next worker before returning. This keeps every activation below Runtime's 600-second limit and means closing the AEM modal does not cancel the job.

`generate-idapi-banners-status` returns durable status by `jobId`. Output names are tracked in state and skipped on retries, so a worker retry does not upload the same output again. Configure `AEM_SC_JSON` (recommended) or `AEM_DEV_TOKEN`; caller browser tokens are not persisted in job state.

Each job also writes `_idapi-job.json` into the AEM `output/` folder after
starting and after every batch. It contains the job ID, status, row progress,
output count, timestamps, and any failure message, so diagnostics do not depend
on recovering an App Builder State key. The status action can resolve a job from
the folder manifest when called with `folder` instead of `jobId`.

Before starting, the modal preflights the variations CSV and pagemap CSV and
shows the row count, page count, estimated JPG count, and estimated editable
INDD count. The page count comes from the pagemap, which is the page contract
used by the registered InDesign capability.

### Template and pagemap contract

The InDesign template must have one page per output artboard. Put Script Labels
on the actual swappable page items (not only on a group or layer). Label names
are intentionally flexible:

- image frame: any label matching an image column header
- text frame: any label matching a text column header

Use **Window > Utilities > Script Label** in InDesign and match the CSV header
exactly, including spaces and capitalization. Every variations CSV column except
the reserved `outputFileName` column is applied to the frame with the matching
label. `outputFileName` controls output naming and does not need a frame.

The pagemap CSV maps 1-based InDesign page order to output artboard names:

```csv
pagenumber,pagename
1,WEB_LEADERBOARD_1000x320
2,WEB_HP_SLIDER_1440x500
```

`pagenumber` must match the page's position in the `.indd`; `pagename` is the
artboard/output name used in rendered filenames and optional paragraph-style
groups. Include one row per template page and keep the rows in page order.

## Deploy & Cleanup

- `aio app deploy` to build and deploy all actions on Runtime and static files to CDN
- `aio app undeploy` to undeploy the app

## Config

### `.env`

You can generate the App Builder workspace values using `aio app use`.
Start from `aem-extension/.env.example` for the full Runtime, Firefly, and AEM
configuration.

```bash
# This file must **not** be committed to source control

## please provide your Adobe I/O Runtime credentials
# AIO_RUNTIME_AUTH=
# AIO_RUNTIME_NAMESPACE=
```

The Runtime action reads `AEM_SC_JSON` (preferred durable Service Credential)
and `AEM_AUTHOR_URL` plus the Firefly values at deploy time. Set
`AEM_AUTHOR_URL` to the author URL for the AEM environment where the extension
is enabled. Replace every
environment-specific value with one from your own org; do not copy another
team member's `.env`.

When Assets View supplies the current author URL in its resource or host
metadata, the extension passes that URL with the job and uses it for the
request. Keep `AEM_AUTHOR_URL` configured regardless: it is required for
deployment and is the fallback when host metadata is unavailable.

### `app.config.yaml`

- Main configuration file that defines an application's implementation. 
- More information on this file, application configuration, and extension configuration 
  can be found [here](https://developer.adobe.com/app-builder/docs/guides/configuration/#appconfigyaml)

#### Action Dependencies

- You have two options to resolve your actions' dependencies:

  1. **Packaged action file**: Add your action's dependencies to the root
   `package.json` and install them using `npm install`. Then set the `function`
   field in `app.config.yaml` to point to the **entry file** of your action
   folder. We will use `webpack` to package your code and dependencies into a
   single minified js file. The action will then be deployed as a single file.
   Use this method if you want to reduce the size of your actions.

  2. **Zipped action folder**: In the folder containing the action code add a
     `package.json` with the action's dependencies. Then set the `function`
     field in `app.config.yaml` to point to the **folder** of that action. We will
     install the required dependencies within that directory and zip the folder
     before deploying it as a zipped action. Use this method if you want to keep
     your action's dependencies separated.

## Debugging in VS Code

While running your local server (`aio app dev`), both UI and actions can be debugged. To do so follow the instructions [here](https://developer.adobe.com/app-builder/docs/guides/development/#debugging)

## Typescript support for UI

To use typescript use `.tsx` extension for react components and add a `tsconfig.json` 
and make sure you have the below config added
```
 {
  "compilerOptions": {
      "jsx": "react"
    }
  } 
```
