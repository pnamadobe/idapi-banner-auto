/*
 * <license header>
 */

import React from 'react';
import { Text } from '@adobe/react-spectrum';
import { register } from '@adobe/uix-guest';
import { extensionId } from './Constants';

function ExtensionRegistration() {
  const init = async () => {
    const guestConnection = await register({
      id: extensionId,
      methods: {
        actionBar: {
          async getActions({ context, resourceSelection }) {
            try { console.log('[idapi] getActions context=', JSON.stringify(context), 'resourceSelection=', JSON.stringify(resourceSelection)); } catch (e) { console.log('[idapi] getActions', context, resourceSelection); }
            return [
              {
                'id': 'indesign-banners-generation',
                'icon': 'AdDisplay',
                'label': 'Generate Banners',
                'onClick': async () => {
                  // The user selects the .indd template; its parent folder is the
                  // "job key" (holds the CSVs + images). Derive both from the selection.
                  // resourceSelection is documented as { resources: [{ id, path }, …] }.
                  const sel = (resourceSelection && Array.isArray(resourceSelection.resources))
                    ? resourceSelection.resources
                    : (Array.isArray(resourceSelection) ? resourceSelection
                      : (resourceSelection ? [resourceSelection] : []));
                  const pathOf = (r) => String(
                    (r && (r.path || r.id || r.repositoryPath || r['repo:path'] ||
                      (r.repositoryMetadata && (r.repositoryMetadata['repo:path'] || r.repositoryMetadata.path)))) || ''
                  );
                  let assetPath = '';
                  for (const r of sel) { const p = pathOf(r); if (/\.indd$/i.test(p)) { assetPath = p; break; } }
                  if (!assetPath && sel.length) assetPath = pathOf(sel[0]);
                  // strip any urn/scheme prefix so we get a /content/dam/... path
                  const dam = assetPath.indexOf('/content/dam');
                  if (dam > 0) assetPath = assetPath.slice(dam);
                  const folder = assetPath.includes('/') ? assetPath.slice(0, assetPath.lastIndexOf('/')) : '';
                  const templateName = assetPath.split('/').pop() || '';
                  // The Runtime action authenticates to AEM itself, so we just hand
                  // it the job folder (via localStorage — shared across the
                  // extension's same-origin iframes).
                  const job = { folder, templateName, assetPath };
                  try { localStorage.setItem('idapi_job', JSON.stringify(job)); } catch (e) {}
                  const qs = `folder=${encodeURIComponent(folder)}&template=${encodeURIComponent(templateName)}`;
                  guestConnection.host.modal.openDialog({
                    title: 'Banners from InDesign template',
                    // cache-bust index.html at runtime so the modal iframe always
                    // loads the current bundle (adobeio-static caches index.html)
                    contentUrl: `/index.html?cb=${Date.now()}#modal-indesign-banners-generation?${qs}`,
                    type: 'modal',
                    size: 'L',
                    payload: job
                  });
                },
              },
            ];
          },
          async getHiddenBuiltInActions({ context, resourceSelection }) {
            return [];
          },
          async overrideBuiltInAction({ actionId, context, resourceSelection }) {
            // perform some custom tasks
            // override built-in action by return true;
            // return true;
            // or return false to continue with built-in action
            return false;
          },
        },
        quickActions: {
          async getHiddenBuiltInActions({ context, resource }) {
            return [];
          },
          async overrideBuiltInAction({ actionId, context, resource }) {
            // perform some custom tasks
            // override built-in action by return true;
            // return true;
            // or return false to continue with built-in action
            return false;
          },
        },
        detailSidePanel: {
          getPanels(resource) {
            // YOUR SIDE PANELS CODE SHOULD BE HERE
            return [
            ];
          },
          async getHiddenBuiltInPanels({ resource }) {
            return [];
          },
          async overrideBuiltInPanel({ panelId, resource }) {
            return null;
          },
        },
        headerMenu: {
          async getButtons({ context, resource }) {
            // YOUR HEADER MENU BUTTONS SHOULD BE RETURNED IN THE ARRAY
            return [
            ];
          },
          async getHiddenButtonIds({ context, resource }) {
            return [];
          },
          async overrideButton({ buttonId, context, resource }) {
            // perform some custom tasks
            // return true to skip built-in handler; return false to use built-in handler
            return false;
          },
        },
      },
    });
  };
  init().catch(console.error);

  return <Text>IFrame for integration with Host (AEM Assets View)...</Text>;
}

export default ExtensionRegistration;
