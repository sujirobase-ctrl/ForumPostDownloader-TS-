/**
 * GM_* API Compatibility Shim for Chrome Extension (Manifest V3).
 *
 * Replaces Tampermonkey APIs with native browser extension equivalents:
 *   GM_xmlhttpRequest  -> XMLHttpRequest (cross-origin via host_permissions)
 *   GM_download        -> chrome.runtime.sendMessage -> chrome.downloads
 *   GM_setValue         -> chrome.storage.local (cached for sync reads)
 *   GM_getValue         -> chrome.storage.local (cached for sync reads)
 *   GM_openInTab        -> chrome.runtime.sendMessage -> chrome.tabs
 *   GM_log              -> console.log
 */

// ---------------------------------------------------------------------------
// Storage: in-memory cache for synchronous GM_getValue
// ---------------------------------------------------------------------------
const _gmStorageCache = {};
chrome.storage.local.get(null, (items) => {
  if (items) Object.assign(_gmStorageCache, items);
});

function GM_getValue(key, fallback) {
  return Object.prototype.hasOwnProperty.call(_gmStorageCache, key)
    ? _gmStorageCache[key]
    : fallback;
}

function GM_setValue(key, value) {
  _gmStorageCache[key] = value;
  try { chrome.storage.local.set({ [key]: value }); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
function GM_log(...args) {
  console.log('[XFPD]', ...args);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function GM_openInTab(url, options) {
  if (typeof options === 'boolean') {
    options = { active: !options };
  }
  options = options || {};

  let _tabId = null;
  const _promise = chrome.runtime.sendMessage({
    action: 'openTab',
    url: String(url),
    active: !!options.active,
  }).then(r => {
    if (r && r.tabId) _tabId = r.tabId;
  }).catch(() => {});

  return {
    close: () => {
      if (_tabId) {
        try { chrome.runtime.sendMessage({ action: 'closeTab', tabId: _tabId }); } catch (e) {}
      } else {
        _promise.then(() => {
          if (_tabId) try { chrome.runtime.sendMessage({ action: 'closeTab', tabId: _tabId }); } catch (e) {}
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------
function GM_download(optionsOrUrl, nameArg) {
  let opts;
  if (typeof optionsOrUrl === 'string') {
    opts = { url: optionsOrUrl, name: nameArg || '' };
  } else {
    opts = optionsOrUrl || {};
  }

  const { url, name, headers, onload, onerror, ontimeout, onprogress } = opts;

  chrome.runtime.sendMessage({
    action: 'download',
    url: String(url || ''),
    filename: name || '',
    headers: headers || {},
  }).then(r => {
    if (r && r.ok) {
      if (typeof onload === 'function') onload();
    } else {
      if (typeof onerror === 'function') onerror({ error: (r && r.error) || 'Download failed' });
    }
  }).catch(e => {
    if (typeof onerror === 'function') onerror({ error: e.message || 'Download failed' });
  });
}

// ---------------------------------------------------------------------------
// XMLHttpRequest wrapper (replaces GM_xmlhttpRequest)
//
// Uses native XMLHttpRequest from the content script context.
// Cross-origin requests work because host_permissions includes https://*/*.
//
// Note: Referer and Origin are forbidden headers in XHR;
// the browser sets them automatically based on the page context.
// ---------------------------------------------------------------------------
function GM_xmlhttpRequest(options) {
  const {
    method = 'GET',
    url,
    headers = {},
    data,
    responseType = '',
    onload,
    onerror,
    onprogress,
    onreadystatechange,
    ontimeout,
    timeout,
    anonymous,
    withCredentials,
  } = options || {};

  const xhr = new XMLHttpRequest();

  // For 'document' responseType: fetch as text, then parse with DOMParser
  const needsDocParse = responseType === 'document';
  const xhrType = needsDocParse ? 'text' : (responseType || '');

  try {
    xhr.open(method || 'GET', url, true);
  } catch (e) {
    if (typeof onerror === 'function') {
      onerror({ readyState: 4, status: 0, responseText: '', responseHeaders: '', error: e });
    }
    return { abort: () => {} };
  }

  if (xhrType) {
    try { xhr.responseType = xhrType; } catch (e) { /* ignore */ }
  }

  if (timeout) xhr.timeout = Number(timeout);
  if (withCredentials) xhr.withCredentials = true;

  // Set request headers (skip browser-forbidden ones)
  const forbiddenHeaders = new Set([
    'referer', 'origin', 'host', 'connection', 'content-length',
    'accept-encoding', 'access-control-request-headers',
    'access-control-request-method',
  ]);
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.startsWith('__xfpd_')) continue;
    if (forbiddenHeaders.has(key.toLowerCase())) continue;
    try { xhr.setRequestHeader(key, String(value)); } catch (e) { /* forbidden header */ }
  }

  // readystatechange callback
  if (typeof onreadystatechange === 'function') {
    xhr.onreadystatechange = () => {
      try {
        onreadystatechange({
          readyState: xhr.readyState,
          status: xhr.readyState >= 2 ? xhr.status : 0,
          responseHeaders: xhr.readyState >= 2 ? (xhr.getAllResponseHeaders() || '') : '',
          responseText: '',
          response: null,
          finalUrl: xhr.responseURL || url,
        });
      } catch (e) { /* callback error */ }
    };
  }

  // progress callback
  if (typeof onprogress === 'function') {
    xhr.onprogress = (e) => {
      try {
        onprogress({
          loaded: e.loaded || 0,
          total: e.lengthComputable ? e.total : -1,
          totalSize: e.lengthComputable ? e.total : -1,
        });
      } catch (ex) { /* callback error */ }
    };
  }

  // load callback
  xhr.onload = () => {
    let resp;
    if (needsDocParse) {
      const parser = new DOMParser();
      const dom = parser.parseFromString(xhr.responseText || '', 'text/html');
      resp = {
        readyState: 4,
        status: xhr.status,
        responseText: xhr.responseText || '',
        response: dom,
        responseHeaders: xhr.getAllResponseHeaders() || '',
        finalUrl: xhr.responseURL || url,
      };
    } else {
      const rt = typeof xhr.response === 'string' ? xhr.response : '';
      resp = {
        readyState: 4,
        status: xhr.status,
        responseText: rt || xhr.responseText || '',
        response: xhr.response,
        responseHeaders: xhr.getAllResponseHeaders() || '',
        finalUrl: xhr.responseURL || url,
      };
    }
    if (typeof onload === 'function') onload(resp);
  };

  // error callback
  xhr.onerror = (e) => {
    if (typeof onerror === 'function') {
      onerror({ readyState: 4, status: 0, responseText: '', responseHeaders: '', error: e });
    }
  };

  // timeout callback
  if (typeof ontimeout === 'function') {
    xhr.ontimeout = () => {
      ontimeout({ readyState: 4, status: 0, responseText: '', responseHeaders: '' });
    };
  }

  try {
    xhr.send(data || null);
  } catch (e) {
    if (typeof onerror === 'function') {
      onerror({ readyState: 4, status: 0, responseText: '', responseHeaders: '', error: e });
    }
  }

  return {
    abort: () => { try { xhr.abort(); } catch (e) {} },
  };
}

// Expose on window so the userscript code can access them
window.GM_xmlhttpRequest = GM_xmlhttpRequest;
window.GM_download = GM_download;
window.GM_setValue = GM_setValue;
window.GM_getValue = GM_getValue;
window.GM_openInTab = GM_openInTab;
window.GM_log = GM_log;
