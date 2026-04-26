const SELECTORS = {
  PROMPT_TEXTAREA_ID: 'PINHOLE_TEXT_AREA_ELEMENT_ID',
  GENERATE_BUTTON_XPATH: "//button[.//i[text()='arrow_forward']] | //button[.//i[normalize-space(text())='arrow_forward']]",
  LOADING_XPATH: "//i[contains(text(), 'progress_activity')]",
};

function xpathOne(expr) {
  try {
    return document.evaluate(expr, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
  } catch (_) { return null; }
}

function injectText(text) {
  const el = document.getElementById(SELECTORS.PROMPT_TEXTAREA_ID);
  if (!el) return false;
  el.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter ? setter.call(el, text) : (el.value = text);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.blur();
  return true;
}

async function clickGenerate() {
  for (let i = 0; i < 30; i++) {
    const btn = xpathOne(SELECTORS.GENERATE_BUTTON_XPATH);
    if (btn && !btn.disabled) { btn.click(); return true; }
    await sleep(200);
  }
  return false;
}

async function waitForGenerationComplete(timeoutMs = 180000) {
  const start = Date.now();
  await sleep(2000);
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      if (Date.now() - start > timeoutMs) { clearInterval(poll); resolve(); return; }
      const loading = !!xpathOne(SELECTORS.LOADING_XPATH);
      const btn = xpathOne(SELECTORS.GENERATE_BUTTON_XPATH);
      if (!loading && btn && !btn.disabled) { clearInterval(poll); resolve(); }
    }, 1000);
  });
}

async function submitPrompt(prompt) {
  if (!injectText(prompt))
    return { success: false, error: 'Textarea PINHOLE_TEXT_AREA_ELEMENT_ID not found.' };
  await sleep(300);
  if (!await clickGenerate())
    return { success: false, error: 'Generate button not found or disabled after retries.' };
  await waitForGenerationComplete();
  return { success: true };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action !== 'SUBMIT_PROMPT') return false;
  submitPrompt(msg.prompt).then(sendResponse).catch(err => sendResponse({ success: false, error: err.message }));
  return true;
});

console.log('[Flow Auto Prompt] loaded.');
