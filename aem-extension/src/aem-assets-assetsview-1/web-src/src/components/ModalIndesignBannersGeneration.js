/*
 * Modal for the "Generate Banners" ActionBar action.
 * Confirms the job folder derived from the selected template, calls the
 * generate-idapi-banners Runtime action, and shows progress + results.
 */
import React, { useState, useEffect, useRef } from 'react';
import { attach } from '@adobe/uix-guest';
import {
  Flex, Provider, defaultTheme, Text, Heading, ButtonGroup, Button, View, ProgressCircle, Checkbox,
  TextField, Picker, Item, ActionButton
} from '@adobe/react-spectrum';

import { extensionId } from './Constants';
import Confetti from './Confetti';
import actionWebInvoke from '../utils';
import actionsConfig from '../config.json';

function readJob() {
  // primary: localStorage (shared across the extension's same-origin iframes)
  try {
    const j = JSON.parse(localStorage.getItem('idapi_job') || '{}');
    if (j && (j.folder || j.assetPath !== undefined)) {
      return { folder: j.folder || '', template: j.templateName || '', assetPath: j.assetPath || '', aemAuthorUrl: j.aemAuthorUrl || '', tenant: j.tenant || '' };
    }
  } catch (e) { /* ignore */ }
  // fallback: hash query
  const h = window.location.hash || '';
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
  const sp = new URLSearchParams(q);
  return { folder: sp.get('folder') || '', template: sp.get('template') || '', aemAuthorUrl: sp.get('aemAuthorUrl') || '', tenant: sp.get('tenant') || '' };
}
function resolveActionUrl(action = 'generate-idapi-banners') {
  // config.json is populated at build/deploy with { "<pkg>/<action>": "https://…" }
  const hit = Object.entries(actionsConfig || {}).find(([k]) => k.endsWith(`/${action}`) || k === action);
  return hit ? hit[1] : null;
}

function normalizeScope(scope) {
  if (!scope) return '';
  const s = String(scope).trim().replace(/\/+$/, '').toLowerCase();
  if (!s) return '';
  try {
    return /^https?:\/\//i.test(s) ? new URL(s).host : s;
  } catch (e) {
    return s;
  }
}

async function deterministicJobId(folder, mode, template, aemAuthorUrl) {
  // must match keyFor() in actions/job-utils.js
  const editable = mode === 'both' || mode === 'editable';
  const sc = normalizeScope(aemAuthorUrl);
  const input = new TextEncoder().encode(`${folder}|${editable ? '1' : '0'}${template ? `|${template}` : ''}${mode === 'editable' ? '|editable-only' : ''}${mode === 'html5' ? '|html5' : ''}${sc ? `|@${sc}` : ''}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

const MAX_SHOWN_FINDINGS = 10;

const ANIMATION_STYLES = [
  { id: 'editorial', label: 'Subtle / Editorial (Airlines, financial services, healthcare, B2B)' },
  { id: 'luxury', label: 'Luxury / Cinematic (Hospitality, fashion, luxury retail, automotive)' },
  { id: 'kinetic', label: 'Bold / Kinetic (Sports, entertainment, tech launches, events)' },
  { id: 'retail', label: 'Retail / Promo (Sales, QSR, e-commerce, loyalty offers)' },
  { id: 'wipe', label: 'Clean Wipe / Split (Modern SaaS, telecom, travel destinations)' },
  { id: 'minimal', label: 'Minimal / Compliance-Safe (Pharma, regulated finance, strict brand guidelines)' },
];
const DEFAULT_ANIMATION_STYLE = 'editorial';

// The signed-in user's IMS token and org ID, asked of the Assets View host each time (never stored on disk).
// Assets View exposes it as host.auth.getIMSInfo(); sharedContext 'auth' is the AEM editors' way.
async function userAuth(gc) {
  if (!gc) return { token: '', imsOrg: '' };
  try {
    const info = await gc.host.auth.getIMSInfo();
    if (info && info.accessToken) {
      return { token: info.accessToken, imsOrg: info.imsOrg || info.imsOrgId || info.org || '' };
    }
  } catch (e) { /* older host */ }
  try {
    const auth = gc.sharedContext.get('auth');
    if (auth && auth.imsToken) {
      return { token: auth.imsToken, imsOrg: auth.imsOrg || auth.imsOrgId || auth.org || '' };
    }
  } catch (e) { /* not shared */ }
  return { token: '', imsOrg: '' };
}

function buildAuthHeaders(token, imsOrg) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (imsOrg) headers['x-gw-ims-org-id'] = imsOrg;
  return headers;
}

// DA folder of an HTML5 job: the job's own record, else where preflight says the pages would go.
const html5PathWithStyle = (base, style) => (base ? (style ? `${base}/${style}` : base) : '');
const html5FolderUrl = (r, estimate, style) => (r && r.html5Folder && r.html5Folder.daUrl)
  || (estimate && estimate.html5Site && estimate.html5Path ? `https://da.live/#/${estimate.html5Site}${html5PathWithStyle(estimate.html5Path, style)}` : '');

// HTML5 results: EDS preview links per size, then the CM360 packaging control.
function Html5Panel({ html5, jobId, token, imsOrg, tenant, folderUrl }) {
  const [pkg, setPkg] = useState(null);
  const [pkgError, setPkgError] = useState('');
  const url = resolveActionUrl('generate-idapi-banners-package');
  const headers = buildAuthHeaders(token, imsOrg);
  const call = async (extra) => {
    const res = await actionWebInvoke(url, headers, {
      jobId,
      ...(token ? { userToken: token } : {}),
      ...(imsOrg ? { imsOrg } : {}),
      ...(tenant ? { tenant } : {}),
      ...extra
    });
    if (res && (res.error || (res.statusCode && res.statusCode >= 400))) throw new Error(res.error || `package action returned ${res.statusCode}`);
    return res && res.body ? res.body : res;
  };
  useEffect(() => {
    if (!url || !jobId || !token) return undefined;
    let cancelled = false;
    const poll = () => call({ status: '1' }).then((b) => { if (!cancelled) { setPkg(b); setPkgError(''); } }).catch((e) => { if (!cancelled) setPkgError(String(e.message || e)); });
    poll();
    const timer = setInterval(() => { if (!pkg || pkg.status === 'running') poll(); }, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [jobId, token, pkg && pkg.status]);
  const start = () => {
    setPkgError('');
    call({}).then((b) => setPkg({ ...b, done: b.done || 0 })).catch((e) => setPkgError(String(e.message || e)));
  };
  const pages = (html5 && html5.pages) || [];
  const warnings = (html5 && html5.warnings) || [];
  const running = pkg && pkg.status === 'running';
  return (
    <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
      <Flex direction="column" gap="size-75">
        <Text><b>HTML5 banners</b> ({pages.length} size{pages.length === 1 ? '' : 's'}) — preview on EDS:</Text>
        {folderUrl && <Text><a href={folderUrl} target="_blank" rel="noopener noreferrer">Open the HTML5 folder in Document Authoring ↗</a></Text>}
        {pages.map((p) => (
          <Text key={p.page}>
            {p.previewUrl ? <a href={p.previewUrl} target="_blank" rel="noopener noreferrer">{p.page} ↗</a> : p.page}
            {p.rows ? ` · ${p.rows} variation${p.rows === 1 ? '' : 's'}` : ''}
          </Text>
        ))}
        {warnings.slice(0, 5).map((w, i) => <Text key={`w-${i}`}>⚠ {typeof w === 'string' ? w : (w.message || JSON.stringify(w))}</Text>)}
        {!url && <Text>The package action URL is not configured.</Text>}
        {pkg && pkg.status !== 'none' && (
          <Text>
            <b>CM360 package:</b> {pkg.status}{typeof pkg.ads === 'number' ? ` — ${pkg.done || 0}/${pkg.ads} ads` : ''}
            {pkg.failed ? `, ${pkg.failed} failed` : ''}{pkg.output ? ` → ${pkg.output}` : ''}
          </Text>
        )}
        {pkg && pkg.outputUrl && (pkg.done > 0 || pkg.status === 'done') && <Text><a href={pkg.outputUrl} target="_blank" rel="noopener noreferrer">Open the CM360 zips in Assets View ↗</a></Text>}
        {pkg && pkg.status === 'stalled' && <Text>⚠ The packaging job stopped without finishing (no progress for 15 minutes). Re-package to run it again.</Text>}
        {pkg && pkg.error && <Text>✖ {pkg.error}</Text>}
        {pkgError && <Text>✖ {pkgError}</Text>}
        {url && (
          <ButtonGroup>
            <Button variant="primary" isDisabled={running || !pages.length} onPress={start}>
              {running ? 'Packaging…' : (pkg && (pkg.status === 'done' || pkg.status === 'stalled') ? 'Re-package for CM360' : 'Package for CM360')}
            </Button>
          </ButtonGroup>
        )}
      </Flex>
    </View>
  );
}

// The setup guide in this app's repo: one-time steps for a user's own EDS site and html5.json.
const HTML5_SETUP_URL = 'https://github.com/pnamadobe/idapi-banner-auto/blob/main/docs/HTML5-SETUP.md';

// Errors first, then warnings; the start action's 422 and the preflight estimate share this shape.
function FindingsPanel({ findings }) {
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity !== 'error');
  const shown = [...errors, ...warnings].slice(0, MAX_SHOWN_FINDINGS);
  const more = errors.length + warnings.length - shown.length;
  const heading = errors.length
    ? `Preflight found ${errors.length} problem${errors.length === 1 ? '' : 's'} that will make the generation fail`
    : `Preflight found ${warnings.length} warning${warnings.length === 1 ? '' : 's'} — generation can still be started`;
  return (
    <View backgroundColor="gray-100" padding="size-150" borderRadius="regular" maxHeight="size-3000" overflow="auto">
      <Flex direction="column" gap="size-75">
        <Text><b>{heading}</b></Text>
        {shown.map((f, i) => (
          <Text key={`${f.code}-${i}`}>{f.severity === 'error' ? '✖' : '⚠'} {f.message}</Text>
        ))}
        {more > 0 && <Text>…and {more} more</Text>}
      </Flex>
    </View>
  );
}

// Pick the existing DA / EDS site this folder publishes HTML5 banners to. The action checks the signed-in
// user can write to it and that it serves the ad block, then saves html5.json in the chosen folder as them.
// Creating a site (repo, Code Sync, DA) stays in the setup guide.
function SitePicker({ estimate, folder, aemAuthorUrl, getAuth, onSaved, onCancel }) {
  const [org0, site0] = String((estimate && estimate.html5Site) || '/').split('/');
  const folders = (estimate && Array.isArray(estimate.html5Folders) ? estimate.html5Folders : []);
  const defaultTarget = (estimate && estimate.html5FoundAt) || folders[1] || folders[0] || folder;
  const [org, setOrg] = useState(org0 || '');
  const [site, setSite] = useState(site0 || '');
  const [target, setTarget] = useState(defaultTarget);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const save = async () => {
    setSaving(true);
    setSaveError('');
    try {
      const url = resolveActionUrl();
      const { token, imsOrg } = await getAuth();
      if (!token) throw new Error('Assets View did not share your sign-in with this dialog. Reload Assets View and try again.');
      const res = await actionWebInvoke(url, buildAuthHeaders(token, imsOrg), {
        folder,
        aemAuthorUrl,
        saveSite: '1',
        org,
        site,
        target,
        userToken: token,
        ...(imsOrg ? { imsOrg } : {})
      });
      if (res && (res.error || (res.statusCode && res.statusCode >= 400))) throw new Error(res.error || `saving the site returned ${res.statusCode}`);
      await onSaved();
    } catch (e) {
      setSaveError(String(e.message || e));
    } finally {
      setSaving(false);
    }
  };
  const short = (f) => (f === folder ? `${f} (this folder)` : f);
  return (
    <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
      <Flex direction="column" gap="size-100">
        <Text>Enter the DA org and site your HTML5 banners publish to (the names in <code>da.live/#/org/site</code>). It's checked as you and saved for the folder you pick; folders below it use it too.</Text>
        <Flex gap="size-150" wrap>
          <TextField label="DA org" value={org} onChange={setOrg} isDisabled={saving} autoFocus />
          <TextField label="DA site" value={site} onChange={setSite} isDisabled={saving} />
        </Flex>
        {folders.length > 1 && (
          <Picker label="Use it for" selectedKey={target} onSelectionChange={setTarget} isDisabled={saving} width="100%">
            {folders.map((f) => <Item key={f}>{short(f)}</Item>)}
          </Picker>
        )}
        {saveError && <Text><b>{saveError}</b></Text>}
        <ButtonGroup>
          <Button variant="accent" onPress={save} isDisabled={saving || !org.trim() || !site.trim()}>{saving ? 'Checking…' : 'Save site'}</Button>
          {onCancel && <Button variant="secondary" onPress={onCancel} isDisabled={saving}>Cancel</Button>}
        </ButtonGroup>
        <Text>No site yet? Follow the <a href={HTML5_SETUP_URL} target="_blank" rel="noopener noreferrer">HTML5 banner setup guide ↗</a> (you can point Claude at it).</Text>
      </Flex>
    </View>
  );
}

export default function ModalIndesignBannersGeneration() {
  const [guestConnection, setGuestConnection] = useState();
  const [colorScheme, setColorScheme] = useState('light');
  const [job] = useState(readJob);
  const { folder, template, aemAuthorUrl, tenant } = job;
  const editableKind = /\.psd$/i.test(template) ? 'PSD' : 'INDD';
  const [status, setStatus] = useState('idle'); // idle | html5-confirm | running | started | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState('');
  const [findings, setFindings] = useState([]);
  const [override, setOverride] = useState(false);
  const notFoundPolls = useRef(0);
  const [confetti, setConfetti] = useState(false);
  const [html5Run, setHtml5Run] = useState(false);
  const [lastHtml5, setLastHtml5] = useState(null); // last finished HTML5 run with published pages, if any
  const [editSite, setEditSite] = useState(false);
  const [animationStyle, setAnimationStyle] = useState(DEFAULT_ANIMATION_STYLE);
  const [imsToken, setImsToken] = useState(''); // the user's own token (memory only): authenticates all action calls
  const [imsOrg, setImsOrg] = useState('');
  const authRef = useRef(null);

  const getAuth = async () => {
    if (guestConnection) {
      const fresh = await userAuth(guestConnection);
      if (fresh.token) {
        if (fresh.token !== imsToken) setImsToken(fresh.token);
        if (fresh.imsOrg && fresh.imsOrg !== imsOrg) setImsOrg(fresh.imsOrg);
        return fresh;
      }
    }
    if (imsToken) return { token: imsToken, imsOrg };
    if (!authRef.current) {
      authRef.current = (async () => {
        const gc = await attach({ id: extensionId });
        setGuestConnection(gc);
        try { const t = await gc.host.theme.getThemeInfo(); if (t && t.colorScheme) setColorScheme(t.colorScheme); } catch (e) {}
        const auth = await userAuth(gc);
        if (auth.token) setImsToken(auth.token);
        if (auth.imsOrg) setImsOrg(auth.imsOrg);
        return auth;
      })();
    }
    return authRef.current;
  };

  const invokeAuth = async (url, params) => {
    const { token, imsOrg: org } = await getAuth();
    const headers = buildAuthHeaders(token, org);
    const body = {
      ...params,
      ...(tenant ? { tenant } : {}),
      ...(token ? { userToken: token } : {}),
      ...(org ? { imsOrg: org } : {})
    };
    return actionWebInvoke(url, headers, body);
  };

  useEffect(() => { getAuth(); }, []);

  const hasErrors = findings.some((f) => f.severity === 'error');

  const inspect = () => {
    const url = resolveActionUrl();
    if (!folder || !url) return Promise.resolve();
    return invokeAuth(url, { folder, template, aemAuthorUrl, preflight: '1' })
      .then((res) => {
        const body = res && res.body ? res.body : res;
        if (res && (res.error || (res.statusCode && res.statusCode >= 400))) throw new Error(res.error || 'Unable to inspect inputs');
        setEstimate(body);
        setFindings(Array.isArray(body && body.findings) ? body.findings : []);
        setEstimateError('');
      })
      .catch((e) => setEstimateError(String(e.message || e)));
  };

  useEffect(() => { inspect(); }, [folder, template, aemAuthorUrl]);

  // On open, look up this template's HTML5 job (same id the start action uses). A finished run that
  // published pages is remembered, and the start screen's HTML5 button becomes "Manage HTML5 banners"
  // (the start screen stays, so INDD/PSD renders are still one click away). A run still in progress
  // resumes polling. Anything else (none yet, failed, no pages) leaves the start screen as is.
  useEffect(() => {
    const url = resolveActionUrl('generate-idapi-banners-status');
    if (!folder || !template || !url || /\.psd$/i.test(template)) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const jobId = await deterministicJobId(folder, 'html5', template, aemAuthorUrl);
        const res = await invokeAuth(url, { jobId });
        const body = res && res.body ? res.body : res;
        if (cancelled || !body || !body.writeHtml5 || typeof body.status !== 'string') return;
        const published = body.status === 'completed' && body.html5 && (body.html5.pages || []).length > 0;
        const inProgress = body.status === 'queued' || body.status === 'running';
        if (published) { setLastHtml5({ ...body, found: true }); return; }
        if (!inProgress) return;
        // only take over the start screen: never replace a run the user just started
        setStatus((s) => {
          if (s !== 'idle') return s;
          setHtml5Run(true);
          setResult(body);
          return 'started';
        });
      } catch (e) { /* no earlier run: stay on the start screen */ }
    })();
    return () => { cancelled = true; };
  }, [folder, template]);

  // An HTML5 run that finishes in this session becomes the one "Manage HTML5 banners" opens.
  useEffect(() => {
    if (status === 'done' && result && !result.found && result.writeHtml5 && result.html5 && (result.html5.pages || []).length > 0) {
      setLastHtml5({ ...result, found: true });
    }
  }, [status, result]);

  // Key on the job id, not the result object: each poll replaces `result`, which would
  // otherwise re-run this effect and fire the next poll immediately instead of every 15s.
  const jobId = result && result.jobId;
  useEffect(() => {
    if (status !== 'started' || !jobId) return undefined;
    const url = resolveActionUrl('generate-idapi-banners-status');
    if (!url) {
      setError(`Job ${jobId} started, but the status action URL is not configured. Check the output folder or query the status action manually.`);
      return undefined;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await invokeAuth(url, { jobId });
        const body = res && res.body ? res.body : res;
        // A failed job is a normal status reply that carries its own `error`: only a reply with
        // no job status is the status check itself failing.
        const isJob = body && typeof body.status === 'string';
        if (!isJob && res && (res.error || (res.statusCode && res.statusCode >= 400))) {
          throw new Error(res.error || `status action returned ${res.statusCode}`);
        }
        if (cancelled) return;
        notFoundPolls.current = 0;
        setResult(body);
        if (body.status === 'completed') {
          setConfetti(true);
          setStatus('done');
        } else if (body.status === 'failed') {
          setError(String(body.error || 'The worker reported a failure.').replace(/^generation failed:\s*/i, ''));
          setStatus('error');
        }
      } catch (e) {
        if (cancelled) return;
        const msg = String(e.message || e);
        // The start action rejects a job that fails preflight before creating it, so a job that
        // is still unknown after a couple of polls means it was never started (the 422 arrived
        // after the modal's 6s wait). Re-run the inspection so the findings are shown.
        notFoundPolls.current += 1;
        if (/job not found/i.test(msg)) {
          if (notFoundPolls.current >= 2) {
            cancelled = true;
            setResult(null);
            setError('Generation was not started — preflight found problems. Review them below, fix the inputs, or choose to generate anyway.');
            inspect().then(() => setStatus(html5Run ? 'html5-confirm' : 'idle'));
          }
          return;
        }
        setError(`Job ${jobId} started, but status could not be checked: ${msg}`);
      }
    };
    check();
    const timer = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [status, jobId]);

  const close = () => guestConnection && guestConnection.host.modal.closeDialog();

  // mode: 'images' (flattened images only) | 'both' (images + editable file) | 'editable' (editable file only)
  async function generate(mode = 'images') {
    setStatus('running');
    setError('');
    notFoundPolls.current = 0;
    const url = resolveActionUrl();
    if (!url) { setError('Action URL not found — deploy the app so config.json is populated.'); setStatus('error'); return; }
    // The render runs for minutes server-side. Fire it and DON'T chain the user to
    // a spinner: race a short window to surface fast failures (auth/missing inputs);
    // if it's still running after that, tell them it's underway and let them close.
    // The Runtime action keeps running to completion even after the UI stops waiting.
    const params = { folder, template, aemAuthorUrl, ...(tenant ? { tenant } : {}), mode, writeIndd: mode === 'both' || mode === 'editable' ? '1' : '' };
    if (mode === 'html5') {
      params.writeHtml5 = '1';
      params.animationStyle = animationStyle;
    }
    setHtml5Run(mode === 'html5');
    if (override && hasErrors) params.preflightOverride = '1';
    const { token, imsOrg: org } = await getAuth();
    if (!token) {
      setError('Assets View did not share your sign-in with this dialog. Reload Assets View and try again.');
      setStatus(mode === 'html5' ? 'html5-confirm' : 'idle');
      return;
    }
    const headers = buildAuthHeaders(token, org);
    params.userToken = token;
    if (org) params.imsOrg = org;
    const call = actionWebInvoke(url, headers, params)
      .then((r) => ({ done: true, r }))
      .catch((e) => ({ done: true, err: e }));
    const outcome = await Promise.race([
      call,
      new Promise((res) => setTimeout(() => res({ started: true }), 6000)),
    ]);
    if (outcome.started) {
      setResult({ jobId: await deterministicJobId(folder, mode, template, aemAuthorUrl) });
      setStatus('started');
      return;
    }
    if (outcome.err) { setError(String((outcome.err && outcome.err.message) || outcome.err)); setStatus('error'); return; }
    const res = outcome.r;
    // 422: the start action refused the job because preflight found errors; show them in place.
    if (res && res.error && Array.isArray(res.findings)) {
      setFindings(res.findings);
      setOverride(false);
      setStatus(mode === 'html5' ? 'html5-confirm' : 'idle');
      return;
    }
    if (res && (res.error || (res.statusCode && res.statusCode >= 400))) { setError(res.error || ('action returned ' + res.statusCode)); setStatus('error'); return; }
    const body = res && res.body ? res.body : res;
    setResult(body);
    setStatus(body && (body.status === 'queued' || body.status === 'running') ? 'started' : 'done');
  }

  return (
    <Provider theme={defaultTheme} colorScheme={colorScheme}>
      <View padding="size-250">
        {!folder && (
          <Flex direction="column" gap="size-150">
            <Text>Couldn't determine the job folder from your selection. Select a template (<code>.indd</code> or <code>.psd</code>) inside a job folder and try again.</Text>
            {job.assetPath && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Text><b>Selected path:</b> {String(job.assetPath)}</Text>
              </View>
            )}
            <ButtonGroup><Button variant="primary" onPress={close}>Close</Button></ButtonGroup>
          </Flex>
        )}

        {folder && status === 'idle' && (
          <Flex direction="column" gap="size-200">
            <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
              <Flex direction="column" gap="size-50">
                <Text><b>Template:</b> {template || '(auto-detect in folder)'}</Text>
                <Text><b>Folder:</b> {folder}</Text>
              </Flex>
            </View>
            <Text>
              The folder's variations CSV, pagemap CSV, and images will be rendered by Adobe Creative Cloud services.
              Results land in <b>{folder}/output</b> (in a datetime-stamped subfolder if it already has assets) — unpublished, for your review.
            </Text>
            <Text>
              Choose <b>Generate banners</b> for the flattened images only, <b>+ editable file</b> to also
              write a reopenable {editableKind} per variation (larger output), or <b>Editable files only</b> to
              skip the flattened images{/\.psd$/i.test(template) ? '' : ' (each INDD still gets its preview and a multi-page PDF)'}.
            </Text>
            {estimate && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Flex direction="column" gap="size-50">
                  <Text><b>Rows to execute:</b> {estimate.variationRows}</Text>
                  <Text><b>Template pages:</b> {estimate.pageCount} (from pagemap)</Text>
                  <Text><b>Estimated images:</b> {estimate.variationRows * estimate.pageCount} JPGs</Text>
                  <Text><b>Estimated editable files:</b> {estimate.variationRows} {/\.psd$/i.test(template) ? 'PSDs' : 'INDDs'} when selected</Text>
                </Flex>
              </View>
            )}
            {!estimate && !estimateError && <Text>Inspecting the CSV and page map…</Text>}
            {estimateError && <Text>Could not calculate output estimates; generation can still be started.</Text>}
            {error && <Text><b>{error}</b></Text>}
            {findings.length > 0 && <FindingsPanel findings={findings} />}
            {hasErrors && (
              <Checkbox isSelected={override} onChange={setOverride}>
                Generate anyway (the problems above will probably make some or all banners fail)
              </Checkbox>
            )}
            <ButtonGroup orientation="vertical" width="100%">
              <Button variant="accent" width="100%" isDisabled={hasErrors && !override} onPress={() => generate('images')}>Generate banners</Button>
              <Button
                variant="primary"
                width="100%"
                isDisabled={editableKind === 'PSD'}
                onPress={() => {
                  setError('');
                  if (lastHtml5) { setHtml5Run(true); setResult(lastHtml5); setStatus('done'); } else setStatus('html5-confirm');
                }}
              >
                {editableKind === 'PSD' ? 'HTML5 banners (InDesign templates only for now)' : lastHtml5 ? 'Manage HTML5 banners' : 'Generate HTML5 banners'}
              </Button>
              <Button variant="primary" width="100%" isDisabled={hasErrors && !override} onPress={() => generate('both')}>Generate banners + editable file</Button>
              <Button variant="primary" width="100%" isDisabled={hasErrors && !override} onPress={() => generate('editable')}>Editable {editableKind}s only (no flattened images)</Button>
              <Button variant="secondary" width="100%" onPress={close}>Cancel</Button>
            </ButtonGroup>
          </Flex>
        )}

        {folder && status === 'html5-confirm' && (
          <Flex direction="column" gap="size-200">
            <Heading level={3}>HTML5 banners</Heading>
            <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
              <Flex direction="column" gap="size-50">
                <Text><b>Template:</b> {template || '(auto-detect in folder)'}</Text>
                <Text><b>Folder:</b> {folder}</Text>
                {estimate && Array.isArray(estimate.html5Pages) && (
                  <Text><b>HTML5 sizes:</b> {estimate.html5Pages.length ? estimate.html5Pages.join(', ') : 'none (no pagemap row has html5 = yes)'}</Text>
                )}
              </Flex>
            </View>
            <Text>
              <b>Generate HTML5 banners</b> publishes only the pagemap's HTML5 sizes as Document Authoring pages
              in {estimate && estimate.html5Site ? <><b>{estimate.html5Site}</b>{estimate.html5Path ? <> under <b>{html5PathWithStyle(estimate.html5Path, animationStyle)}</b></> : ''}</> : 'your EDS site'}, previewed
              on EDS (no flattened images; run <b>Generate banners</b> for those). Package them for CM360 afterwards.
            </Text>
            {estimate && !estimate.html5SiteError && estimate.html5Site && !editSite && (
              <Text>
                Publishing to <b>{estimate.html5Site}</b>{estimate.html5FoundAt ? <> (set on {estimate.html5FoundAt})</> : ''} ·{' '}
                <ActionButton isQuiet onPress={() => setEditSite(true)}>change</ActionButton>
              </Text>
            )}
            {estimate && estimate.html5SiteError && !editSite && estimate.html5FoundAt && (
              <Text><b>The html5.json in {estimate.html5FoundAt} can't be used:</b> {estimate.html5SiteError}</Text>
            )}
            {estimate && (estimate.html5SiteError || editSite) && (
              <>{!estimate.html5FoundAt && !editSite && <Text><b>No EDS site is set for this folder yet.</b></Text>}<SitePicker
                estimate={estimate}
                folder={folder}
                aemAuthorUrl={aemAuthorUrl}
                getAuth={getAuth}
                onSaved={async () => { await inspect(); setEditSite(false); }}
                onCancel={editSite ? () => setEditSite(false) : null}
              /></>
            )}
            {(!estimate || (!estimate.html5SiteError && !editSite)) && (
              <Picker
                label="Animation style"
                selectedKey={animationStyle}
                onSelectionChange={(k) => k && setAnimationStyle(String(k))}
                width="100%"
              >
                {ANIMATION_STYLES.map((s) => (
                  <Item key={s.id}>{s.label}</Item>
                ))}
              </Picker>
            )}
            {!estimate && !estimateError && <Text>Inspecting the CSV and page map…</Text>}
            {error && <Text><b>{error}</b></Text>}
            {findings.length > 0 && <FindingsPanel findings={findings} />}
            {hasErrors && (
              <Checkbox isSelected={override} onChange={setOverride}>
                Generate anyway (the problems above will probably make some or all banners fail)
              </Checkbox>
            )}
            <ButtonGroup orientation="vertical" width="100%">
              <Button variant="accent" width="100%" isDisabled={(hasErrors && !override) || (estimate && Array.isArray(estimate.html5Pages) && !estimate.html5Pages.length) || !!(estimate && estimate.html5SiteError) || editSite} onPress={() => generate('html5')}>Generate HTML5 banners</Button>
              <Button variant="secondary" width="100%" onPress={() => { setError(''); setStatus('idle'); }}>Back</Button>
            </ButtonGroup>
          </Flex>
        )}


        {status === 'running' && (
          <Flex direction="column" alignItems="center" gap="size-200" margin="size-300">
            <ProgressCircle aria-label="Starting generation" isIndeterminate />
            <Text>Starting the generation…</Text>
          </Flex>
        )}

        {status === 'started' && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>✓ Generation started</Heading>
            {html5Run ? (
              <Text>
                Your HTML5 banners are being published as Document Authoring pages
                in <b>{(result && result.html5Folder && result.html5Folder.site) || (estimate && estimate.html5Site) || 'your EDS site'}</b>
                {((result && result.html5Folder && result.html5Folder.path) || (estimate && estimate.html5Path)) ? <> under <b>{(result && result.html5Folder && result.html5Folder.path) || html5PathWithStyle(estimate.html5Path, animationStyle)}</b></> : ''}, previewed on EDS, in a few minutes.
                Keep this dialog open to get the preview links and the <b>Package for CM360</b> button, or close it and reopen <b>Generate Banners</b> on this template later: it opens on the finished run, ready to package.
              </Text>
            ) : (
              <Text>
                Your banners are rendering on the {/\.psd$/i.test(template) ? 'Adobe Photoshop API' : 'Adobe InDesign API'} and will appear in
                <b> {(result && result.outputFolder) || `${folder}/output`}</b> in a few minutes — unpublished, ready for your review.
                You can close this dialog; the job keeps running in the background.
              </Text>
            )}
            {result && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Flex direction="column" gap="size-100">
                  <Text><b>Status:</b> {result.status || 'queued'}</Text>
                  {result.phase && <Text><b>Step:</b> {result.phase}</Text>}
                  {!html5Run && <Text><b>Verified outputs:</b> {result.count || 0}</Text>}
                </Flex>
              </View>
            )}
            {html5Run && html5FolderUrl(result, estimate, animationStyle) && (
              <Text><a href={html5FolderUrl(result, estimate, animationStyle)} target="_blank" rel="noopener noreferrer">Open the HTML5 folder in Document Authoring ↗</a></Text>
            )}
            {!html5Run && result && result.outputUrl && (
              <Text><a href={result.outputUrl} target="_blank" rel="noopener noreferrer">Open the output folder in Assets View ↗</a></Text>
            )}
            {result && result.jobId && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Flex direction="column" gap="size-100">
                  <Text><b>Job ID:</b> <code>{result.jobId}</code></Text>
                  <Text>Status is checked automatically. If the job fails, this ID and the error can be used to diagnose or retry it.</Text>
                </Flex>
                {error && <Text><b>Diagnostic warning:</b> {error}</Text>}
              </View>
            )}
            <ButtonGroup><Button variant="accent" onPress={close}>Close</Button></ButtonGroup>
          </Flex>
        )}

        {status === 'error' && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>Generation failed</Heading>
            <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
              <Flex direction="column" gap="size-75">
                <Text>{error}</Text>
                {/not_started|poll timeout|InDesign API did not start/i.test(error) && (
                  <Text>⚠ <b>Upstream Adobe InDesign API issue:</b> Your template and inputs passed validation, but the external Adobe InDesign API cloud service did not start or finish the render job in time. Please wait a couple of minutes and try again.</Text>
                )}
              </Flex>
            </View>
            {result && result.jobId && <Text><b>Job ID:</b> <code>{result.jobId}</code></Text>}
            {/* Only a job that ran has a manifest; HTML5 runs report on the job itself. */}
            {!html5Run && result && result.jobId && (
              <Text>Check the job manifest in <b>{(result && result.outputFolder) || `${folder}/output`}/_idapi-job.json</b>, then retry after correcting the reported issue.</Text>
            )}
            <ButtonGroup>
              <Button variant="primary" onPress={() => { setError(''); setStatus(html5Run ? 'html5-confirm' : 'idle'); }}>Back</Button>
              <Button variant="secondary" onPress={close}>Close</Button>
            </ButtonGroup>
          </Flex>
        )}

        {confetti && <Confetti onDone={() => setConfetti(false)} />}

        {status === 'done' && result && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>{result.found ? '✓ Last HTML5 run for this template' : result.reused ? '✓ Existing generation found' : result.writeHtml5 ? '✓ HTML5 banners generated' : `✓ ${result.count} banner(s) generated`}</Heading>
            <Text>
              {result.found
                ? 'These pages are from the last HTML5 generation of this template. Package them below, or generate again to render fresh pages.'
                : result.reused
                  ? `This folder already has a completed job with ${result.count} recorded output(s). No new render was started.`
                  : 'The generation completed successfully.'}
              {result.writeHtml5
                ? <>{' '}Pages are in Document Authoring under <b>{(result.html5Folder && result.html5Folder.path) || html5PathWithStyle(estimate && estimate.html5Path, result.animationStyle || animationStyle) || 'your EDS site'}</b> (image slices in <b>{result.outputFolder}/html5</b>).</>
                : <>{' '}Written to <b>{result.outputFolder}</b> — unpublished; review before publishing.</>}
            </Text>
            {!result.writeHtml5 && result.outputUrl && (
              <Text><a href={result.outputUrl} target="_blank" rel="noopener noreferrer">Open the output folder in Assets View ↗</a></Text>
            )}
            {result.jobId && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Flex direction="column" gap="size-100">
                  <Text><b>Job ID:</b> <code>{result.jobId}</code></Text>
                  <Text>Keep this ID if you need to check the manifest or troubleshoot the generation.</Text>
                </Flex>
              </View>
            )}
            {/* The HTML5 panel (sizes, DA link, Package for CM360) only after an HTML5 run that published pages. */}
            {result.writeHtml5 && result.html5 && (result.html5.pages || []).length > 0
              ? <Html5Panel html5={result.html5} jobId={result.jobId} token={imsToken} imsOrg={imsOrg} tenant={tenant} folderUrl={html5FolderUrl(result, estimate, result.animationStyle || animationStyle)} />
              : result.writeHtml5 && (
                <Text>
                  No HTML5 pages were published for this job.
                  {((result.html5 && result.html5.warnings) || []).slice(0, 5).map((w, i) => <span key={`w-${i}`}><br />⚠ {typeof w === 'string' ? w : (w.message || JSON.stringify(w))}</span>)}
                </Text>
              )}
            {Array.isArray(result.outputs) && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular" maxHeight="size-2000" overflow="auto">
                <Text>{result.outputs.slice(0, 20).join(', ')}{result.outputs.length > 20 ? ' …' : ''}</Text>
              </View>
            )}
            <ButtonGroup>
              {result.found && <Button variant="secondary" onPress={() => { setResult(null); setHtml5Run(false); setError(''); setStatus('idle'); }}>Back</Button>}
              {(result.found || result.writeHtml5) && <Button variant="secondary" onPress={() => { setResult(null); setError(''); setStatus('html5-confirm'); }}>Generate again</Button>}
              <Button variant="accent" onPress={close}>Close</Button>
            </ButtonGroup>
          </Flex>
        )}

      </View>
    </Provider>
  );
}
