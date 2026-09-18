/*
 * Modal for the "Generate Banners" ActionBar action.
 * Confirms the job folder derived from the selected template, calls the
 * generate-idapi-banners Runtime action, and shows progress + results.
 */
import React, { useState, useEffect } from 'react';
import { attach } from '@adobe/uix-guest';
import {
  Flex, Provider, defaultTheme, Text, Heading, ButtonGroup, Button, View, ProgressCircle
} from '@adobe/react-spectrum';

import { extensionId } from './Constants';
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

async function deterministicJobId(folder, writeIndd) {
  const input = new TextEncoder().encode(`${folder}|${writeIndd ? '1' : '0'}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 48);
}

export default function ModalIndesignBannersGeneration() {
  const [guestConnection, setGuestConnection] = useState();
  const [colorScheme, setColorScheme] = useState('light');
  const [job] = useState(readJob);
  const { folder, template, aemAuthorUrl } = job;
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [estimate, setEstimate] = useState(null);
  const [estimateError, setEstimateError] = useState('');

  useEffect(() => {
    (async () => {
      const gc = await attach({ id: extensionId });
      setGuestConnection(gc);
      try { const t = await gc.host.theme.getThemeInfo(); if (t && t.colorScheme) setColorScheme(t.colorScheme); } catch (e) {}
    })();
  }, []);

  useEffect(() => {
    if (!folder) return;
    const url = resolveActionUrl();
    if (!url) return;
    actionWebInvoke(url, {}, { folder, aemAuthorUrl, preflight: '1' })
      .then((res) => {
        const body = res && res.body ? res.body : res;
        if (res && (res.error || (res.statusCode && res.statusCode >= 400))) throw new Error(res.error || 'Unable to inspect inputs');
        setEstimate(body);
      })
      .catch((e) => setEstimateError(String(e.message || e)));
  }, [folder, aemAuthorUrl]);

  useEffect(() => {
    if (status !== 'started' || !result || !result.jobId) return undefined;
    const url = resolveActionUrl('generate-idapi-banners-status');
    if (!url) {
      setError(`Job ${result.jobId} started, but the status action URL is not configured. Check the output folder or query the status action manually.`);
      return undefined;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const res = await actionWebInvoke(url, {}, { jobId: result.jobId });
        const body = res && res.body ? res.body : res;
        if (res && (res.error || (res.statusCode && res.statusCode >= 400))) {
          throw new Error(res.error || `status action returned ${res.statusCode}`);
        }
        if (cancelled) return;
        if (body.status === 'completed') {
          setResult(body);
          setStatus('done');
        } else if (body.status === 'failed') {
          setError(`Job ${body.jobId} failed: ${body.error || 'The worker reported a failure.'}`);
          setResult(body);
          setStatus('error');
        }
      } catch (e) {
        if (!cancelled) setError(`Job ${result.jobId} started, but status could not be checked: ${String(e.message || e)}`);
      }
    };
    check();
    const timer = setInterval(check, 15000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [status, result]);

  const close = () => guestConnection && guestConnection.host.modal.closeDialog();

  async function generate(writeIndd = false) {
    setStatus('running');
    setError('');
    const url = resolveActionUrl();
    if (!url) { setError('Action URL not found — deploy the app so config.json is populated.'); setStatus('error'); return; }
    // The render runs for minutes server-side. Fire it and DON'T chain the user to
    // a spinner: race a short window to surface fast failures (auth/missing inputs);
    // if it's still running after that, tell them it's underway and let them close.
    // The Runtime action keeps running to completion even after the UI stops waiting.
    const call = actionWebInvoke(url, {}, { folder, aemAuthorUrl, writeIndd: writeIndd ? '1' : '' })
      .then((r) => ({ done: true, r }))
      .catch((e) => ({ done: true, err: e }));
    const outcome = await Promise.race([
      call,
      new Promise((res) => setTimeout(() => res({ started: true }), 6000)),
    ]);
    if (outcome.started) {
      setResult({ jobId: await deterministicJobId(folder, writeIndd) });
      setStatus('started');
      return;
    }
    if (outcome.err) { setError(String((outcome.err && outcome.err.message) || outcome.err)); setStatus('error'); return; }
    const res = outcome.r;
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
            <Text>Couldn't determine the job folder from your selection. Select an InDesign template (<code>.indd</code>) inside a job folder and try again.</Text>
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
              The folder's variations CSV, pagemap CSV, and images will be rendered by the
              Adobe InDesign API. Results land in <b>{folder}/output</b> — unpublished, for your review.
            </Text>
            <Text>
              Choose <b>Generate banners</b> for images only, or <b>+ editable InDesign</b> to also
              write a reopenable <code>.indd</code> per variation (larger output).
            </Text>
            {estimate && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Flex direction="column" gap="size-50">
                  <Text><b>Rows to execute:</b> {estimate.variationRows}</Text>
                  <Text><b>Template pages:</b> {estimate.pageCount} (from pagemap)</Text>
                  <Text><b>Estimated images:</b> {estimate.variationRows * estimate.pageCount} JPGs</Text>
                  <Text><b>Estimated editable files:</b> {estimate.variationRows} INDDs when selected</Text>
                </Flex>
              </View>
            )}
            {!estimate && !estimateError && <Text>Inspecting the CSV and page map…</Text>}
            {estimateError && <Text>Could not calculate output estimates; generation can still be started.</Text>}
            <ButtonGroup orientation="vertical" width="100%">
              <Button variant="accent" width="100%" onPress={() => generate(false)}>Generate banners</Button>
              <Button variant="primary" width="100%" onPress={() => generate(true)}>Generate banners + editable InDesign</Button>
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
              Your banners are rendering on the Adobe InDesign API and will appear in
              <b> {folder}/output</b> in a few minutes — unpublished, ready for your review.
              You can close this dialog; the job keeps running in the background.
            </Text>
            {result && result.jobId && (
              <View backgroundColor="gray-100" padding="size-150" borderRadius="regular">
                <Text><b>Job ID:</b> <code>{result.jobId}</code></Text>
                <Text>Status is checked automatically. If the job fails, this ID and the error can be used to diagnose or retry it.</Text>
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
            <Text>Check the job manifest in <b>{folder}/output/_idapi-job.json</b>, then retry after correcting the reported issue.</Text>
            <ButtonGroup><Button variant="accent" onPress={close}>Close</Button></ButtonGroup>
          </Flex>
        )}

        {status === 'done' && result && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>✓ {result.count} banner(s) generated</Heading>
            <Text>Written to <b>{result.outputFolder}</b> — unpublished; review before publishing.</Text>
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
