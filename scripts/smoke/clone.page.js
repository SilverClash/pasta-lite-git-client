// Clone Repository…, checked in the real app (docs/plans/clone-repository.md C5): a PL_SMOKE_JS page
// script for the --smoke harness (main/smoke.js), evaluated in a New Tab's start screen, whose value
// is the run's `script` result: {ok, failures, steps}. scripts/smoke-clone.js runs it with the parent
// folder main's folder dialog answers (PL_SMOKE_CLONE_PARENT), and sets first the URL to type (a
// local smart-HTTP server of its fixtures: window.PL_SMOKE_URL) and the plan (window.PL_SMOKE_PLAN):
// 'exists,success' (a folder that exists, then a clone that opens in this tab) or 'cancel' (Cancel
// while git checks out a slow source). It drives the real controls: the start screen's Clone…, the
// URL typed as a user types it, the progress modal and the outcome.
(async () => {
  // The smoke window is shown transparent and inactive, so Chromium clamps its timers to a second;
  // waiting yields through a MessageChannel instead (a task, not a timer).
  const tick = () => new Promise((r) => {
    const c = new MessageChannel();
    c.port1.onmessage = () => r();
    c.port2.postMessage(0);
  });
  const until = async (f, ms = 15000) => {
    for (const t = performance.now(); performance.now() - t < ms; await tick()) {
      const v = f();
      if (v) return v;
    }
    return null;
  };
  const sleep = (ms) => until(() => false, ms);
  const failures = [];
  const steps = {};
  const check = (ok, what) => { if (!ok) failures.push(what); return ok; };
  const q = (sel) => document.querySelector(sel);
  const button = (text) => [...document.querySelectorAll('.dlg button')].find((b) => b.textContent === text) || null;
  const type = (input, value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const toast = () => { const t = q('#toast'); return t && !t.hidden ? t.textContent : ''; };

  /** Open the dialog from the start screen and type the URL; false when that failed. */
  async function form(name) {
    const clone = q('#clone-btn');
    if (!check(clone, 'the start screen has a Clone… button')) return false;
    clone.click();
    if (!check(await until(() => q('.clone-url')), 'the clone form opened')) return false;
    steps.parent = q('.clone-parent').value;
    type(q('.clone-url'), window.PL_SMOKE_URL);
    steps.source = q('.clone-url').value;
    steps.derived = q('.clone-name').value;
    if (!check(!button('Clone').disabled, `the URL is accepted (${q('.clone-url').getAttribute('aria-invalid')})`)) return false;
    if (name) type(q('.clone-name'), name);
    steps.preview = q('.clone-preview').textContent;
    return true;
  }

  async function exists() {
    if (!(await form('exists'))) return;
    button('Clone').click();
    const title = await until(() => { const h = q('.dlg-title'); return h && h.textContent === 'Folder already exists' ? h : null; });
    check(title, `exists: the "Folder already exists" explanation (got ${q('.dlg-title') && q('.dlg-title').textContent})`);
    steps.exists = q('.dlg-message') && q('.dlg-message').textContent;
    const back = button('Back');
    check(back, 'exists: Back is offered');
    button('Close').click();
    await until(() => !q('.dlg'));
  }

  async function success() {
    if (!(await form(null))) return;
    const t0 = performance.now();
    button('Clone').click();
    const repo = await until(() => document.body.dataset.view === 'repo' && document.body.dataset.ready === '1', 20000);
    check(repo, 'success: the clone opened in this tab (the repo view)');
    steps.successMs = Math.round(performance.now() - t0);
    steps.repo = window.PL && window.PL.store.state.repo && window.PL.store.state.repo.name;
    check(steps.repo === steps.derived, `success: the repo open is the clone (${steps.repo})`);
    steps.notice = await until(() => toast(), 3000);
    check(/^Cloned /.test(steps.notice || ''), `success: the "Cloned …" notice (${steps.notice})`);
    await until(() => window.PL.store.state.commits.length > 0, 5000);
    steps.commits = window.PL.store.state.commits.length;
  }

  async function cancel() {
    if (!(await form('cancelled'))) return;
    button('Clone').click();
    if (!check(await until(() => q('.clone-bar')), 'cancel: the progress modal')) return;
    // Esc does nothing while it runs.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    check(q('.clone-bar'), 'cancel: Esc leaves the progress open');
    // During the checkout (the slow smudge filter keeps "Updating files" going for seconds).
    steps.phase = await until(() => /^Updating files/.test(q('.clone-phase').textContent) && q('.clone-phase').textContent, 15000);
    check(steps.phase, `cancel: "Updating files" showed (${q('.clone-phase').textContent})`);
    const cancelBtn = button('Cancel');
    cancelBtn.click();
    steps.cancelling = cancelBtn.textContent;
    check(cancelBtn.disabled && cancelBtn.textContent === 'Cancelling…', 'cancel: the button reads Cancelling… and is disabled');
    const closed = await until(() => !q('.clone-bar'), 15000);
    check(closed, 'cancel: the progress closed once the clone settled');
    steps.notice = await until(() => toast(), 3000);
    check(steps.notice === 'Clone cancelled', `cancel: the "Clone cancelled" notice (${steps.notice})`);
    await sleep(1500); // the removal runs in main, off the op: give it a moment before the app quits
  }

  const plan = (window.PL_SMOKE_PLAN || 'exists,success').split(',');
  try {
    for (const step of plan) {
      if (step === 'exists') await exists();
      else if (step === 'success') await success();
      else if (step === 'cancel') await cancel();
    }
  } catch (e) {
    failures.push(`threw: ${e && e.message}`);
  }
  return { ok: failures.length === 0, failures, steps };
})();
