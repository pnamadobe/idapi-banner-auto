/*
 * Modal for the "Generate Banners" ActionBar action.
 * Confirms the job folder derived from the selected template, calls the
 * generate-idapi-banners Runtime action, and shows progress + results.
 */
import React, { useState, useEffect, useRef } from 'react';
import { attach } from '@adobe/uix-guest';
import {
  Flex, Provider, defaultTheme, Text, Heading, ButtonGroup, Button, View, ProgressCircle, Checkbox
} from '@adobe/react-spectrum';

import { extensionId } from './Constants';
import Confetti from './Confetti';
import actionWebInvoke from '../utils';
import actionsConfig from '../config.json';

function readJob() {
  // primary: localStorage (shared across the extension's same-origin iframes)
  try {
    const j = JSON.parse(localStorage.getItem('idapi_job') || '{}');
    if (j && (j.folder || j.assetPath !== undefined || j.token)) {
      return { folder: j.folder || '', template: j.templateName || '', assetPath: j.assetPath || '', token: j.token || '', aemAuthorUrl: j.aemAuthorUrl || '' };
    }
  } catch (e) { /* ignore */ }
  // fallback: hash query
  const h = window.location.hash || '';
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
  const sp = new URLSearchParams(q);
  return { folder: sp.get('folder') || '', template: sp.get('template') || '', aemAuthorUrl: sp.get('aemAuthorUrl') || '' };
}
function resolveActionUrl(action = 'generate-idapi-banners') {
  // config.json is populated at build/deploy with { "<pkg>/<action>": "https://…" }
  const hit = Object.entries(actionsConfig || {}).find(([k]) => k.endsWith(`/${action}`) || k === action);
  return hit ? hit[1] : null;
}

async function deterministicJobId(folder, mode, template) {
  // must match keyFor() in actions/job-utils.js
  const input = new TextEncoder().encode(`${folder}|${mode === 'images' ? '0' : '1'}${template ? `|${template}` : ''}${mode === 'editable' ? '|editable-only' : ''}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

const MAX_SHOWN_FINDINGS = 10;

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

export default function ModalIndesignBannersGeneration() {
  const [guestConnection, setGuestConnection] = useState();
  const [colorScheme, setColorScheme] = useState('light');
  const [job] = useState(readJob);
  const { folder, template, aemAuthorUrl } = job;
  const editableKind = /\.psd$/i.test(template) ? 'PSD' : 'INDD';
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState('');
  const [findings, setFindings] = useState([]);
  const [override, setOverride] = useState(false);
  const notFoundPolls = useRef(0);
  const [confetti, setConfetti] = useState(false);

  useEffect(() => {
    (async () => {
      const gc = await attach({ id: extensionId });
      setGuestConnection(gc);
      try { const t = await gc.host.theme.getThemeInfo(); if (t && t.colorScheme) setColorScheme(t.colorScheme); } catch (e) {}
    })();
  }, []);

  const hasErrors = findings.some((f) => f.severity === 'error');

  const inspect = () => {
    const url = resolveActionUrl();
    if (!folder || !url) return Promise.resolve();
    return actionWebInvoke(url, {}, { folder, template, aemAuthorUrl, preflight: '1' })
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
        const res = await actionWebInvoke(url, {}, { jobId });
        const body = res && res.body ? res.body : res;
        if (res && (res.error || (res.statusCode && res.statusCode >= 400))) {
          throw new Error(res.error || `status action returned ${res.statusCode}`);
        }
        if (cancelled) return;
        notFoundPolls.current = 0;
        setResult(body);
        if (body.status === 'completed') {
          setConfetti(true);
          setStatus('done');
        } else if (body.status === 'failed') {
          setError(`Job ${body.jobId} failed: ${body.error || 'The worker reported a failure.'}`);
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
            inspect().then(() => setStatus('idle'));
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
    const params = { folder, template, aemAuthorUrl, mode, writeIndd: mode === 'images' ? '' : '1' };
    if (override && hasErrors) params.preflightOverride = '1';
    const call = actionWebInvoke(url, {}, params)
      .then((r) => ({ done: true, r }))
      .catch((e) => ({ done: true, err: e }));
    const outcome = await Promise.race([
      call,
      new Promise((res) => setTimeout(() => res({ started: true }), 6000)),
    ]);
    if (outcome.started) {
      setResult({ jobId: await deterministicJobId(folder, mode, template) });
      setStatus('started');
      return;
    }
    if (outcome.err) { setError(String((outcome.err && outcome.err.message) || outcome.err)); setStatus('error'); return; }
    const res = outcome.r;
    // 422: the start action refused the job because preflight found errors; show them in place.
    if (res && res.error && Array.isArray(res.findings)) {
      setFindings(res.findings);
      setOverride(false);
      setStatus('idle');
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
            <Text>Debug (what the extension received):</Text>
            <View backgroundColor="gray-100" padding="size-150" borderRadius="regular" maxHeight="size-3000" overflow="auto">
              <Text><b>assetPath:</b> {String(job.assetPath)}</Text><br/>
              <Text><b>count:</b> {String(job.count)}</Text><br/>
              <Text><b>resourceSelection:</b> {String(job.rawSelection).slice(0, 1500)}</Text><br/>
              <Text><b>context:</b> {String(job.rawContext).slice(0, 600)}</Text>
            </View>
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
              <Button variant="primary" width="100%" isDisabled={hasErrors && !override} onPress={() => generate('both')}>Generate banners + editable file</Button>
              <Button variant="primary" width="100%" isDisabled={hasErrors && !override} onPress={() => generate('editable')}>Editable {editableKind}s only (no flattened images)</Button>
              <Button variant="secondary" width="100%" onPress={close}>Cancel</Button>
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
            <Text>
              Your banners are rendering on the {/\.psd$/i.test(template) ? 'Adobe Photoshop API' : 'Adobe InDesign API'} and will appear in
              <b> {(result && result.outputFolder) || `${folder}/output`}</b> in a few minutes — unpublished, ready for your review.
              You can close this dialog; the job keeps running in the background.
            </Text>
            {result && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Flex direction="column" gap="size-100">
                  <Text><b>Status:</b> {result.status || 'queued'}</Text>
                  <Text><b>Verified outputs:</b> {result.count || 0}</Text>
                </Flex>
              </View>
            )}
            {result && result.outputUrl && (
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
            <Text>{error}</Text>
            {result && result.jobId && <Text><b>Job ID:</b> <code>{result.jobId}</code></Text>}
            <Text>Check the job manifest in <b>{(result && result.outputFolder) || `${folder}/output`}/_idapi-job.json</b>, then retry after correcting the reported issue.</Text>
            <ButtonGroup><Button variant="accent" onPress={close}>Close</Button></ButtonGroup>
          </Flex>
        )}

        {confetti && <Confetti onDone={() => setConfetti(false)} />}

        {status === 'done' && result && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>{result.reused ? '✓ Existing generation found' : `✓ ${result.count} banner(s) generated`}</Heading>
            <Text>
              {result.reused
                ? `This folder already has a completed job with ${result.count} recorded output(s). No new render was started.`
                : 'The generation completed successfully.'}
              {' '}Written to <b>{result.outputFolder}</b> — unpublished; review before publishing.
            </Text>
            {result.outputUrl && (
              <Text><a href={result.outputUrl} target="_blank" rel="noopener noreferrer">Open the output folder in Assets View ↗</a></Text>
            )}
            {result.jobId && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Text><b>Job ID:</b> <code>{result.jobId}</code></Text>
                <Text>Keep this ID if you need to check the manifest or troubleshoot the generation.</Text>
              </View>
            )}
            {Array.isArray(result.outputs) && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular" maxHeight="size-2000" overflow="auto">
                <Text>{result.outputs.slice(0, 20).join(', ')}{result.outputs.length > 20 ? ' …' : ''}</Text>
              </View>
            )}
            <ButtonGroup><Button variant="accent" onPress={close}>Close</Button></ButtonGroup>
          </Flex>
        )}

        {status === 'error' && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>Generation failed</Heading>
            <View backgroundColor="gray-100" padding="size-150" borderRadius="regular"><Text>{error}</Text></View>
            <ButtonGroup>
              <Button variant="primary" onPress={() => setStatus('idle')}>Back</Button>
              <Button variant="secondary" onPress={close}>Close</Button>
            </ButtonGroup>
          </Flex>
        )}
      </View>
    </Provider>
  );
}
