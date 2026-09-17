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
      return { folder: j.folder || '', template: j.templateName || '', assetPath: j.assetPath || '', token: j.token || '' };
    }
  } catch (e) { /* ignore */ }
  // fallback: hash query
  const h = window.location.hash || '';
  const q = h.includes('?') ? h.slice(h.indexOf('?') + 1) : '';
  const sp = new URLSearchParams(q);
  return { folder: sp.get('folder') || '', template: sp.get('template') || '' };
}
function resolveActionUrl() {
  // config.json is populated at build/deploy with { "<pkg>/<action>": "https://…" }
  const hit = Object.entries(actionsConfig || {}).find(([k]) => k.includes('generate-idapi-banners'));
  return hit ? hit[1] : null;
}

export default function ModalIndesignBannersGeneration() {
  const [guestConnection, setGuestConnection] = useState();
  const [colorScheme, setColorScheme] = useState('light');
  const [job] = useState(readJob);
  const { folder, template } = job;
  const [status, setStatus] = useState('idle'); // idle | running | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      const gc = await attach({ id: extensionId });
      setGuestConnection(gc);
      try { const t = await gc.host.theme.getThemeInfo(); if (t && t.colorScheme) setColorScheme(t.colorScheme); } catch (e) {}
    })();
  }, []);

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
    const call = actionWebInvoke(url, {}, { folder, writeIndd: writeIndd ? '1' : '' })
      .then((r) => ({ done: true, r }))
      .catch((e) => ({ done: true, err: e }));
    const outcome = await Promise.race([
      call,
      new Promise((res) => setTimeout(() => res({ started: true }), 6000)),
    ]);
    if (outcome.started) { setStatus('started'); return; }
    if (outcome.err) { setError(String((outcome.err && outcome.err.message) || outcome.err)); setStatus('error'); return; }
    const res = outcome.r;
    if (res && (res.error || (res.statusCode && res.statusCode >= 400))) { setError(res.error || ('action returned ' + res.statusCode)); setStatus('error'); return; }
    setResult(res); setStatus('done');
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
            <ButtonGroup><Button variant="accent" onPress={close}>Close</Button></ButtonGroup>
          </Flex>
        )}

        {status === 'done' && result && (
          <Flex direction="column" gap="size-150">
            <Heading level={3}>✓ {result.count} banner(s) generated</Heading>
            <Text>Written to <b>{result.outputFolder}</b> — unpublished; review before publishing.</Text>
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
