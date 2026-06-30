/**
 * Background service worker for XenForo Post Downloader extension.
 *
 * Handles cross-origin HTTP requests (replacing GM_xmlhttpRequest),
 * file downloads (replacing GM_download), storage (replacing GM_setValue/GM_getValue),
 * and tab management (replacing GM_openInTab).
 */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'httpRequest') {
    handleHttpRequest(message, sendResponse);
    return true;
  }

  if (message.action === 'download') {
    handleDownload(message, sendResponse);
    return true;
  }

  if (message.action === 'getValue') {
    handleGetValue(message, sendResponse);
    return true;
  }

  if (message.action === 'setValue') {
    handleSetValue(message, sendResponse);
    return true;
  }

  if (message.action === 'openTab') {
    handleOpenTab(message, sender, sendResponse);
    return true;
  }

  if (message.action === 'closeTab') {
    handleCloseTab(message, sendResponse);
    return true;
  }

  return false;
});

async function handleHttpRequest(msg, sendResponse) {
  const { method, url, headers, data, responseType, timeout } = msg;

  try {
    const controller = new AbortController();
    let timeoutId = null;
    if (timeout && timeout > 0) {
      timeoutId = setTimeout(() => controller.abort(), timeout);
    }

    const fetchOpts = {
      method: method || 'GET',
      headers: {},
      signal: controller.signal,
    };

    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith('__xfpd_')) continue;
        fetchOpts.headers[k] = v;
      }
    }

    if (data && method && method.toUpperCase() !== 'GET') {
      fetchOpts.body = data;
    }

    const response = await fetch(url, fetchOpts);

    if (timeoutId) clearTimeout(timeoutId);

    const status = response.status;
    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });
    const responseHeadersStr = Object.entries(respHeaders).map(([k,v]) => `${k}: ${v}`).join('\r\n');

    let responseText = '';
    let responseDataUrl = null;

    if (responseType === 'blob' || responseType === 'arraybuffer') {
      const blob = await response.blob();
      responseDataUrl = await blobToDataUrl(blob);
      responseText = '';
    } else {
      responseText = await response.text();
    }

    sendResponse({
      ok: true,
      status,
      responseText,
      responseHeaders: responseHeadersStr,
      responseDataUrl,
      finalUrl: response.url || url,
    });
  } catch (e) {
    sendResponse({
      ok: false,
      status: 0,
      responseText: '',
      responseHeaders: '',
      responseDataUrl: null,
      finalUrl: url,
      error: e.message,
    });
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

async function handleDownload(msg, sendResponse) {
  const { url, filename, headers } = msg;

  try {
    let downloadUrl = url;

    if (url.startsWith('blob:') || url.startsWith('data:')) {
      downloadUrl = url;
    } else if (headers && Object.keys(headers).length > 0) {
      try {
        const fetchOpts = { headers: {} };
        for (const [k, v] of Object.entries(headers)) {
          fetchOpts.headers[k] = v;
        }
        const resp = await fetch(url, fetchOpts);
        const blob = await resp.blob();
        downloadUrl = await blobToDataUrl(blob);
      } catch (e) {
        downloadUrl = url;
      }
    }

    const downloadOpts = { url: downloadUrl };
    if (filename) {
      downloadOpts.filename = filename.replace(/[<>:"|?*]/g, '_');
    }

    chrome.downloads.download(downloadOpts, (downloadId) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, downloadId });
      }
    });
  } catch (e) {
    sendResponse({ ok: false, error: e.message });
  }
}

async function handleGetValue(msg, sendResponse) {
  const { key, fallback } = msg;
  try {
    chrome.storage.local.get([key], (result) => {
      if (chrome.runtime.lastError) {
        sendResponse({ value: fallback });
      } else {
        sendResponse({ value: result[key] !== undefined ? result[key] : fallback });
      }
    });
  } catch (e) {
    sendResponse({ value: fallback });
  }
}

async function handleSetValue(msg, sendResponse) {
  const { key, value } = msg;
  try {
    chrome.storage.local.set({ [key]: value }, () => {
      sendResponse({ ok: true });
    });
  } catch (e) {
    sendResponse({ ok: false });
  }
}

async function handleOpenTab(msg, sender, sendResponse) {
  const { url, active } = msg;
  try {
    chrome.tabs.create({ url, active: !!active }, (tab) => {
      sendResponse({ ok: true, tabId: tab.id });
    });
  } catch (e) {
    sendResponse({ ok: false });
  }
}

async function handleCloseTab(msg, sendResponse) {
  const { tabId } = msg;
  try {
    chrome.tabs.remove(tabId, () => {
      sendResponse({ ok: true });
    });
  } catch (e) {
    sendResponse({ ok: false });
  }
}
