/* 
* <license header>
*/

/* This file exposes some common utilities for your actions */

/**
 *
 * Returns a log ready string of the action input parameters.
 * The `Authorization` header content will be replaced by '<hidden>'.
 *
 * @param {object} params action input parameters.
 *
 * @returns {string}
 *
 */
function stringParameters (params) {
  // Never log credentials: redact anything that looks like a secret, token or key.
  const secretKey = /secret|token|password|credential|private|_sc_json|api_?key|authorization/i
  const redact = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, secretKey.test(k) ? '<hidden>' : v]))
  return JSON.stringify({ ...redact(params), __ow_headers: redact(params.__ow_headers || {}) })
}

/**
 *
 * Returns the list of missing keys giving an object and its required keys.
 * A parameter is missing if its value is undefined or ''.
 * A value of 0 or null is not considered as missing.
 *
 * @param {object} obj object to check.
 * @param {array} required list of required keys.
 *        Each element can be multi level deep using a '.' separator e.g. 'myRequiredObj.myRequiredKey'
 *
 * @returns {array}
 * @private
 */
function getMissingKeys (obj, required) {
  return required.filter(r => {
    const splits = r.split('.')
    const last = splits[splits.length - 1]
    const traverse = splits.slice(0, -1).reduce((tObj, split) => { tObj = (tObj[split] || {}); return tObj }, obj)
    return traverse[last] === undefined || traverse[last] === '' // missing default params are empty string
  })
}

/**
 *
 * Returns the list of missing keys giving an object and its required keys.
 * A parameter is missing if its value is undefined or ''.
 * A value of 0 or null is not considered as missing.
 *
 * @param {object} params action input parameters.
 * @param {array} requiredHeaders list of required input headers.
 * @param {array} requiredParams list of required input parameters.
 *        Each element can be multi level deep using a '.' separator e.g. 'myRequiredObj.myRequiredKey'.
 *
 * @returns {string} if the return value is not null, then it holds an error message describing the missing inputs.
 *
 */
function checkMissingRequestInputs (params, requiredParams = [], requiredHeaders = []) {
  let errorMessage = null

  // input headers are always lowercase
  requiredHeaders = requiredHeaders.map(h => h.toLowerCase())
  // check for missing headers
  const missingHeaders = getMissingKeys(params.__ow_headers || {}, requiredHeaders)
  if (missingHeaders.length > 0) {
    errorMessage = `missing header(s) '${missingHeaders}'`
  }

  // check for missing parameters
  const missingParams = getMissingKeys(params, requiredParams)
  if (missingParams.length > 0) {
    if (errorMessage) {
      errorMessage += ' and '
    } else {
      errorMessage = ''
    }
    errorMessage += `missing parameter(s) '${missingParams}'`
  }

  return errorMessage
}

/**
 *
 * Extracts the bearer token string from the Authorization header in the request parameters.
 *
 * @param {object} params action input parameters.
 *
 * @returns {string|undefined} the token string or undefined if not set in request headers.
 *
 */
function getBearerToken (params) {
  if (params.__ow_headers &&
      params.__ow_headers.authorization &&
      params.__ow_headers.authorization.startsWith('Bearer ')) {
    return params.__ow_headers.authorization.substring('Bearer '.length)
  }
  return undefined
}

/**
 * Extracts the signed-in user's bearer token from the Authorization header,
 * falling back to `params.userToken` when a gateway or host path strips the header.
 *
 * @param {object} params action input parameters.
 * @returns {string|undefined}
 */
function userBearer (params = {}) {
  const t = getBearerToken(params) || (typeof params.userToken === 'string' ? params.userToken.trim() : '')
  return t || undefined
}

/**
 * Extracts the caller's IMS Organization ID from request headers, parameters, or JWT bearer claims.
 *
 * @param {object} params action input parameters.
 * @returns {string|undefined}
 */
function userImsOrg (params = {}) {
  const hdrs = params.__ow_headers || {}
  const raw = hdrs['x-gw-ims-org-id'] || hdrs['x-ims-org-id'] || (typeof params.imsOrg === 'string' ? params.imsOrg : '')
  const trimmed = String(raw || '').trim()
  if (/^[A-Za-z0-9_]+@AdobeOrg$/i.test(trimmed)) return trimmed
  const tok = userBearer(params)
  if (tok && tok.split('.').length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(tok.split('.')[1], 'base64').toString('utf8'))
      const claimOrg = String(payload.org || payload.imsOrg || '').trim()
      if (/^[A-Za-z0-9_]+@AdobeOrg$/i.test(claimOrg)) return claimOrg
    } catch (e) { /* opaque or non-JSON token */ }
  }
  return undefined
}

/**
 * Checks whether the caller's IMS Org is allowed when ALLOWED_IMS_ORGS is configured.
 * If no org header/claim is present on the request, defers to AEM folder access check (`hasFolderAccess`);
 * if an org is present, it must match the allowlist.
 *
 * @param {object} params action input parameters.
 * @returns {boolean}
 */
function isAllowedImsOrg (params = {}) {
  const allowedRaw = String(params.ALLOWED_IMS_ORGS || '').trim()
  if (!allowedRaw) return true
  const allowed = allowedRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (!allowed.length) return true
  const org = userImsOrg(params)
  return !org || allowed.includes(org.toLowerCase())
}

/**
 * Initializes @adobe/aio-lib-state, passing `{ region }` only when AIO_STATE_REGION is configured.
 *
 * @param {object} stateLib @adobe/aio-lib-state module
 * @param {object} [params] action input parameters
 * @returns {Promise<object>}
 */
function initState (stateLib, params = {}) {
  const region = String(params.AIO_STATE_REGION || '').trim().toLowerCase()
  if (region && ['amer', 'emea', 'apac', 'aus'].includes(region)) {
    return stateLib.init({ region })
  }
  return stateLib.init()
}
/**
 *
 * Returns an error response object and attempts to log.info the status code and error message
 *
 * @param {number} statusCode the error status code.
 *        e.g. 400
 * @param {string} message the error message.
 *        e.g. 'missing xyz parameter'
 * @param {*} [logger] an optional logger instance object with an `info` method
 *        e.g. `new require('@adobe/aio-sdk').Core.Logger('name')`
 *
 * @returns {object} the error object, ready to be returned from the action main's function.
 *
 */
function errorResponse (statusCode, message, logger) {
  if (logger && typeof logger.info === 'function') {
    logger.info(`${statusCode}: ${message}`)
  }
  return {
    error: {
      statusCode,
      body: {
        error: message
      }
    }
  }
}

module.exports = {
  errorResponse,
  getBearerToken,
  userBearer,
  userImsOrg,
  isAllowedImsOrg,
  initState,
  stringParameters,
  checkMissingRequestInputs
}
