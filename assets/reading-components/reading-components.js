(() => {
  'use strict';

  function copyWithSelection(text) {
    const previousFocus = document.activeElement;
    const input = document.createElement('textarea');
    input.value = text;
    input.setAttribute('readonly', '');
    input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(input);
    input.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      const restoreFocus = document.activeElement === input;
      input.remove();
      if (restoreFocus && previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    }
    if (!copied) throw new Error('Clipboard is unavailable');
  }

  async function copyText(text) {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return;
      } catch {
        // Embedded readers can restrict Clipboard API access.
      }
    }
    copyWithSelection(text);
  }

  document.querySelectorAll('.reading-code').forEach((panel) => {
    const code = panel.querySelector('pre code');
    const caption = panel.querySelector('.reading-code__caption');
    if (!code || !caption || caption.querySelector('.reading-code__copy')) return;

    const filename = caption.querySelector('.reading-code__file')?.textContent || '代码';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'reading-code__copy';
    button.textContent = '复制';
    button.setAttribute('aria-label', `复制${filename}`);

    const status = document.createElement('span');
    status.className = 'reading-code__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    caption.append(status, button);

    let reset;
    let pending = false;
    button.addEventListener('click', async () => {
      if (pending) return;
      pending = true;
      clearTimeout(reset);
      button.setAttribute('aria-disabled', 'true');
      button.textContent = '复制中…';
      status.textContent = '';
      try {
        await copyText(code.textContent || '');
        button.textContent = '已复制';
        status.textContent = `${filename}已复制`;
      } catch {
        button.textContent = '重试复制';
        status.textContent = '复制未完成，请选中代码手动复制。';
      } finally {
        pending = false;
        button.removeAttribute('aria-disabled');
        reset = setTimeout(() => {
          button.textContent = '复制';
          status.textContent = '';
        }, 4000);
      }
    });
  });
})();
