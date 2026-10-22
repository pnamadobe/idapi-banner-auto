/*
 * <license header>
 */

import React from 'react';
import { Text } from '@adobe/react-spectrum';
import { register } from '@adobe/uix-guest';
import { extensionId } from './Constants';

function findAemAuthorUrl(...sources) {
  const seen = new Set();
  const visit = (value, depth = 0) => {
    if (depth > 5 || value == null) return '';
    if (typeof value === 'string') {
      const match = value.match(/https:\/\/author-[a-z0-9-]+\.adobeaemcloud\.com/i);
      return match ? match[0].replace(/\/+$/, '') : '';
    }
    if (typeof value !== 'object' || seen.has(value)) return '';
    seen.add(value);
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      const result = visit(item, depth + 1);
      if (result) return result;
    }
    return '';
  };
  return sources.map(visit).find(Boolean) || '';
}

const TEMPLATE_RE = /\.(indd|psd)$/i;

// resourceSelection is documented as { resources: [{ id, path }, …] }.
function selectionPaths(resourceSelection) {
  const sel = (resourceSelection && Array.isArray(resourceSelection.resources))
    ? resourceSelection.resources
    : (Array.isArray(resourceSelection) ? resourceSelection
      : (resourceSelection ? [resourceSelection] : []));
  return sel.map((r) => String(
    (r && (r.path || r.id || r.repositoryPath || r['repo:path'] || r.name ||
      (r.repositoryMetadata && (r.repositoryMetadata['repo:path'] || r.repositoryMetadata.path)))) || ''
  ));
}

// The user selects the .indd / .psd template; its parent folder is the "job key"
// (holds the CSVs + images). Returns '' when no template is selected.
function selectedTemplatePath(resourceSelection) {
  // Exactly one template: with several selected it would be ambiguous which one to run.
  const templates = selectionPaths(resourceSelection).filter((p) => TEMPLATE_RE.test(p));
  return templates.length === 1 ? templates[0] : '';
}

function ExtensionRegistration() {
  const init = async () => {
    const guestConnection = await register({
      id: extensionId,
      methods: {
        actionBar: {
          async getActions({ context, resourceSelection }) {
            try { console.log('[idapi] getActions context=', JSON.stringify(context), 'resourceSelection=', JSON.stringify(resourceSelection)); } catch (e) { console.log('[idapi] getActions', context, resourceSelection); }
            // Only offer the action when an .indd or .psd template is selected.
            const template = selectedTemplatePath(resourceSelection);
            console.log('[idapi v2] template selected:', template || 'none', '->', template ? 'show button' : 'hide button');
            if (!template) return [];
            return [
              {
                'id': 'indesign-banners-generation',
                'icon': 'AdDisplay',
                'label': 'Generate Banners',
                'onClick': async () => {
                  let assetPath = selectedTemplatePath(resourceSelection);
                  // strip any urn/scheme prefix so we get a /content/dam/... path
                  const dam = assetPath.indexOf('/content/dam');
                  if (dam > 0) assetPath = assetPath.slice(dam);
                  const folder = assetPath.includes('/') ? assetPath.slice(0, assetPath.lastIndexOf('/')) : '';
                  const templateName = assetPath.split('/').pop() || '';
                  // Assets View may include the current AEM author URL in the
                  // resource metadata or host context. Pass it through when
                  // available so one deployment can serve multiple envs.
                  const aemAuthorUrl = findAemAuthorUrl(context, resourceSelection);
                  // The Runtime action authenticates to AEM itself, so we just hand
                  // it the job folder (via localStorage — shared across the
                  // extension's same-origin iframes).
                  const job = { folder, templateName, assetPath, aemAuthorUrl };
                  try { localStorage.setItem('idapi_job', JSON.stringify(job)); } catch (e) {}
                  const qs = `folder=${encodeURIComponent(folder)}&template=${encodeURIComponent(templateName)}&aemAuthorUrl=${encodeURIComponent(aemAuthorUrl)}`;
                  guestConnection.host.modal.openDialog({
                    title: 'Banners from template',
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
