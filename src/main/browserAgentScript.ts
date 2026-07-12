// Injection scripts for agent control of Browser-panel WebContentsView pages.
// Each builder returns a JS string that is run fresh on the target page via
// webContents.executeJavaScript(). The scripts return only JSON-serializable
// values so the result can be marshalled over the local HTTP control server.
//
// Element ids (data-aiw-id="e1", "e2", ...) are assigned by snapshotScript.
// They are deliberately temporary and are paired with a snapshot id so click/type
// can return a structured stale-element error after a new snapshot or navigation.

const NEAR_VIEWPORT_MARGIN_PX = 800
const MAX_SNAPSHOT_ELEMENTS = 400

export function snapshotScript(snapshotId: string): string {
  const safeSnapshotId = JSON.stringify(snapshotId)
  return `(function(){
  try {
    var SNAPSHOT_ID = ${safeSnapshotId};
    var SELECTOR = 'a,button,input,textarea,select,summary,label,' +
      '[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],' +
      '[role="tab"],[role="menuitem"],[role="option"],[role="switch"],[contenteditable="true"],' +
      '[onclick],h1,h2,h3';
    var MARGIN = ${NEAR_VIEWPORT_MARGIN_PX};
    var MAX = ${MAX_SNAPSHOT_ELEMENTS};
    document.querySelectorAll('[data-aiw-id]').forEach(function(el){
      el.removeAttribute('data-aiw-id');
      el.removeAttribute('data-aiw-snapshot-id');
    });
    document.documentElement.setAttribute('data-aiw-snapshot-id', SNAPSHOT_ID);
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    var nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
    var out = [];
    var counter = 0;
    function label(el){
      var t = el.getAttribute('aria-label') || el.value || el.getAttribute('placeholder') ||
              el.innerText || el.textContent || el.getAttribute('title') || el.getAttribute('alt') || '';
      return String(t).replace(/\\s+/g, ' ').trim().slice(0, 200);
    }
    for (var i = 0; i < nodes.length; i++){
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom < -MARGIN || rect.top > vh + MARGIN) continue;
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity || '1') === 0) continue;
      var text = label(el);
      var tag = el.tagName.toLowerCase();
      var isHeading = tag === 'h1' || tag === 'h2' || tag === 'h3';
      if (!text && (isHeading || tag === 'label')) continue;
      counter++;
      var id = 'e' + counter;
      el.setAttribute('data-aiw-id', id);
      el.setAttribute('data-aiw-snapshot-id', SNAPSHOT_ID);
      var role = el.getAttribute('role') ||
        (tag === 'a' ? 'link' : tag === 'button' ? 'button' :
         (tag === 'input' || tag === 'textarea') ? 'textbox' :
         tag === 'select' ? 'combobox' : tag);
      var entry = {
        id: id,
        tag: tag,
        role: role,
        text: text,
        boundingRect: {
          x: Math.round(rect.x), y: Math.round(rect.y),
          width: Math.round(rect.width), height: Math.round(rect.height)
        },
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
      };
      var type = el.getAttribute('type');
      if (type) entry.type = type;
      if (tag === 'input' && type === 'file') {
        entry.multiple = !!el.multiple;
        entry.accept = String(el.getAttribute('accept') || '').slice(0, 300);
      }
      out.push(entry);
      if (counter >= MAX) break;
    }
    return out;
  } catch (e) {
    return { __error: String((e && e.message) || e) };
  }
})()`
}

export function contentScript(): string {
  return `(function(){
  try {
    function clean(s){
      return String(s || '')
        .replace(/\\u00a0/g, ' ')
        .replace(/[ \\t]+/g, ' ')
        .replace(/\\n[ \\t]+/g, '\\n')
        .replace(/\\n{3,}/g, '\\n\\n')
        .trim();
    }
    var root = document.querySelector('main, article, [role="main"]') || document.body;
    var clone = root.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,iframe,template').forEach(function(n){ n.remove(); });
    var text = clone.innerText || clone.textContent || '';
    return {
      title: document.title || '',
      url: location.href,
      text: clean(text).slice(0, 40000),
      truncated: clean(text).length > 40000
    };
  } catch (e) {
    return { __error: String((e && e.message) || e) };
  }
})()`
}

function isValidElementId(elementId: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(elementId)
}

export function clickScript(elementId: string): string {
  if (!isValidElementId(elementId)) {
    return `(function(){ return { ok:false, error:'Invalid element id' }; })()`
  }
  const safeElementId = JSON.stringify(elementId)
  return `(function(){
  try {
    var elementId = ${safeElementId};
    var expectedSnapshotId = document.documentElement.getAttribute('data-aiw-snapshot-id') || '';
    var el = document.querySelector('[data-aiw-id="' + elementId + '"]');
    if (!el) return { ok:false, error:'Element ' + elementId + ' not found - take a fresh snapshot first.', stale:true };
    if (el.getAttribute('data-aiw-snapshot-id') !== expectedSnapshotId) {
      return { ok:false, error:'Stale element ' + elementId + ' - take a fresh snapshot first.', stale:true };
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok:false, error:'Element is disabled' };
    el.scrollIntoView({ block:'center', inline:'center' });
    var opts = { bubbles:true, cancelable:true, view:window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
    return { ok:true };
  } catch (e) {
    return { ok:false, error:String((e && e.message) || e) };
  }
})()`
}

export interface TypeScriptOptions {
  replace?: boolean
  pressEnter?: boolean
}

export function typeScript(elementId: string, text: string, options: TypeScriptOptions = {}): string {
  if (!isValidElementId(elementId)) {
    return `(function(){ return { ok:false, error:'Invalid element id' }; })()`
  }
  const safeElementId = JSON.stringify(elementId)
  const value = JSON.stringify(text)
  const replace = options.replace !== false
  const pressEnter = options.pressEnter === true
  return `(function(){
  try {
    var elementId = ${safeElementId};
    var expectedSnapshotId = document.documentElement.getAttribute('data-aiw-snapshot-id') || '';
    var el = document.querySelector('[data-aiw-id="' + elementId + '"]');
    if (!el) return { ok:false, error:'Element ' + elementId + ' not found - take a fresh snapshot first.', stale:true };
    if (el.getAttribute('data-aiw-snapshot-id') !== expectedSnapshotId) {
      return { ok:false, error:'Stale element ' + elementId + ' - take a fresh snapshot first.', stale:true };
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return { ok:false, error:'Element is disabled' };
    el.scrollIntoView({ block:'center' });
    el.focus();
    var value = ${value};
    var replace = ${replace ? 'true' : 'false'};
    var tag = el.tagName.toLowerCase();
    var current = 'value' in el ? String(el.value || '') : String(el.textContent || '');
    var next = replace ? value : current + value;
    if (tag === 'input' || tag === 'textarea') {
      var proto = tag === 'input' ? window.HTMLInputElement.prototype : window.HTMLTextAreaElement.prototype;
      var desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, next); else el.value = next;
    } else if (el.isContentEditable) {
      el.textContent = next;
    } else if ('value' in el) {
      el.value = next;
    } else {
      el.textContent = next;
    }
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
    if (${pressEnter ? 'true' : 'false'}) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    }
    return { ok:true };
  } catch (e) {
    return { ok:false, error:String((e && e.message) || e) };
  }
})()`
}

export function scrollScript(direction: 'up' | 'down', amount?: number): string {
  const sign = direction === 'up' ? '-' : ''
  const safeAmount = Number.isFinite(amount) && amount && amount > 0 ? Math.min(Math.round(amount), 5000) : null
  return `(function(){
  try {
    var amount = ${safeAmount ?? 'Math.round((window.innerHeight || 600) * 0.85)'};
    window.scrollBy(0, ${sign}amount);
    return { ok:true, scrollY: window.scrollY };
  } catch (e) {
    return { ok:false, error:String((e && e.message) || e) };
  }
})()`
}
