/**
 * GM_* API Compatibility Shim for Chrome Extension (Manifest V3).
 *
 * Routes all cross-origin requests through the background service worker
 * to bypass CORS restrictions. Uses chrome.runtime.connect (ports) for
 * streaming progress updates on large requests.
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
// Routes ALL requests through the background service worker via
// chrome.runtime.sendMessage to bypass CORS restrictions.
// The background uses fetch() with host_permissions for full cross-origin access.
// ---------------------------------------------------------------------------
let _gmReqId = 0;

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
  } = options || {};

  let aborted = false;
  const reqId = ++_gmReqId;

  // Notify readyState=1 (OPENED) immediately
  if (typeof onreadystatechange === 'function') {
    try {
      onreadystatechange({
        readyState: 1,
        status: 0,
        responseHeaders: '',
        responseText: '',
        response: null,
        finalUrl: url,
      });
    } catch (e) { /* callback error */ }
  }

  // Collect ALL headers including Referer/Origin (background can set them via fetch)
  const allHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.startsWith('__xfpd_')) continue;
    allHeaders[key] = String(value);
  }

  chrome.runtime.sendMessage({
    action: 'httpRequest',
    reqId,
    method: method || 'GET',
    url: String(url),
    headers: allHeaders,
    data: data || null,
    responseType: responseType || '',
    timeout: timeout || 0,
  }).then(result => {
    if (aborted) return;

    if (!result || !result.ok) {
      // Error
      if (typeof onreadystatechange === 'function') {
        try {
          onreadystatechange({
            readyState: 4,
            status: 0,
            responseHeaders: '',
            responseText: '',
            response: null,
            finalUrl: url,
          });
        } catch (e) {}
      }
      if (typeof onerror === 'function') {
        onerror({
          readyState: 4,
          status: 0,
          responseText: '',
          responseHeaders: '',
          error: (result && result.error) || 'Request failed',
        });
      }
      return;
    }

    const status = result.status || 0;
    const responseHeaders = result.responseHeaders || '';
    const finalUrl = result.finalUrl || url;
    let responseText = result.responseText || '';
    let response = null;

    // Notify readyState=2 (HEADERS_RECEIVED)
    if (typeof onreadystatechange === 'function') {
      try {
        onreadystatechange({
          readyState: 2,
          status,
          responseHeaders,
          responseText: '',
          response: null,
          finalUrl,
        });
      } catch (e) {}
    }

    // Build the response object based on responseType
    if (responseType === 'document') {
      const parser = new DOMParser();
      response = parser.parseFromString(responseText, 'text/html');
    } else if ((responseType === 'blob' || responseType === 'arraybuffer') && result.responseDataUrl) {
      // Convert data URL back to Blob
      try {
        const parts = result.responseDataUrl.split(',');
        const mime = parts[0].match(/:(.*?);/)[1];
        const bstr = atob(parts[1]);
        const u8arr = new Uint8Array(bstr.length);
        for (let i = 0; i < bstr.length; i++) {
          u8arr[i] = bstr.charCodeAt(i);
        }
        if (responseType === 'blob') {
          response = new Blob([u8arr], { type: mime });
        } else {
          response = u8arr.buffer;
        }
      } catch (e) {
        response = null;
      }
    } else {
      response = responseText;
    }

    // Emit a single progress event with the final size
    if (typeof onprogress === 'function' && response) {
      try {
        let total = 0;
        if (response instanceof Blob) total = response.size;
        else if (response instanceof ArrayBuffer) total = response.byteLength;
        else if (typeof response === 'string') total = response.length;
        onprogress({ loaded: total, total, totalSize: total });
      } catch (e) {}
    }

    // Notify readyState=4 (DONE)
    if (typeof onreadystatechange === 'function') {
      try {
        onreadystatechange({
          readyState: 4,
          status,
          responseHeaders,
          responseText,
          response,
          finalUrl,
        });
      } catch (e) {}
    }

    if (typeof onload === 'function') {
      onload({
        readyState: 4,
        status,
        responseText,
        response,
        responseHeaders,
        finalUrl,
      });
    }
  }).catch(e => {
    if (aborted) return;
    if (typeof onerror === 'function') {
      onerror({
        readyState: 4,
        status: 0,
        responseText: '',
        responseHeaders: '',
        error: e.message || 'Request failed',
      });
    }
  });

  return {
    abort: () => {
      aborted = true;
    },
  };
}

// Expose on window so the userscript code can access them
window.GM_xmlhttpRequest = GM_xmlhttpRequest;
window.GM_download = GM_download;
window.GM_setValue = GM_setValue;
window.GM_getValue = GM_getValue;
window.GM_openInTab = GM_openInTab;
window.GM_log = GM_log;
