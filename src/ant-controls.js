/* Real Ant Design control layer.
   The application keeps its own layout/state; buttons, switches, selects and
   sliders are replaced with antd components while keeping the original events. */
(() => {
  const { React, ReactDOMClient, antd } = window;
  const FLAGS = __FLAGS__;
  if (!React || !ReactDOMClient || !antd) return;
  const { ConfigProvider, Button, Switch, Select, Slider, Segmented, theme } = antd;
  const h = React.createElement;
  const roots = [];

  const themeConfig = {
    algorithm: theme.darkAlgorithm,
    token: {
      colorPrimary: '#3b82f6',
      colorInfo: '#3b82f6',
      colorBgBase: '#08090b',
      colorTextBase: '#eef0f3',
      colorBgContainer: '#141414',
      colorBgElevated: '#16191e',
      colorBorder: '#3a3f46',
      colorText: '#eef0f3',
      colorTextSecondary: '#8d949f',
      borderRadius: 4,
      controlHeight: 32,
      fontFamily: '"Instrument Sans", ui-sans-serif, system-ui, sans-serif',
      fontSize: 13,
    },
    components: {
      Button: {
        defaultBg: '#141414',
        defaultBorderColor: '#3a3f46',
        defaultColor: 'rgba(255,255,255,.88)',
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Switch: { trackHeight: 20, trackMinWidth: 40, handleSize: 16 },
    },
  };

  const cleanup = () => {
    while (roots.length) {
      const { root, host, el } = roots.pop();
      try { root.unmount(); } catch { /* noop */ }
      if (host && host.parentNode) host.remove();
      if (el) {
        delete el.dataset.ant;
        el.style.display = '';
      }
    }
  };

  const mount = (el, node, block = false, meta = {}) => {
    if (!el.parentNode) return null;
    const host = document.createElement('span');
    host.className = 'ant-host' + (block ? ' ant-host-block' : '');
    if (el.classList.contains('topbar-extra')) host.classList.add('topbar-extra');
    if (el.classList.contains('lang-select')) host.classList.add('lang-host');
    if (el.classList.contains('fw-select')) host.classList.add('fw-host');
    el.insertAdjacentElement('afterend', host);
    el.dataset.ant = '1';
    el.style.display = 'none';
    const root = ReactDOMClient.createRoot(host);
    root.render(h(ConfigProvider, { theme: themeConfig }, node));
    const entry = { root, host, el, sync: null, bind: null, ...meta };
    roots.push(entry);
    return entry;
  };

  const iconNode = (el) => {
    const svg = el.querySelector('svg');
    return svg ? h('span', { className: 'ant-ic', dangerouslySetInnerHTML: { __html: svg.outerHTML } }) : undefined;
  };

  const buttonNode = (el, href) => {
    const cls = el.className || '';
    // A trailing badge (e.g. the GitHub star count) keeps its own styling: the
    // plain textContent would lose the separator and the mono font.
    const badge = el.querySelector('[data-star-count]');
    const text = (badge ? el.textContent.replace(badge.textContent, '') : el.textContent).trim();
    const props = {
      type: cls.includes('btn-primary') ? 'primary' : 'default',
      danger: cls.includes('btn-danger'),
      size: cls.includes('btn-sm') ? 'small' : cls.includes('btn-lg') ? 'large' : 'middle',
      icon: iconNode(el),
      shape: !text && !href ? 'circle' : undefined,
      block: el.style.width === '100%' || cls.includes('w-full'),
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
      href,
      target: href ? el.getAttribute('target') || undefined : undefined,
      rel: href ? el.getAttribute('rel') || undefined : undefined,
      title: el.getAttribute('title') || undefined,
      onClick: href ? undefined : () => el.click(),
      className: [
        cls.includes('btn-ghost') ? 'ant-btn-quiet' : '',
        cls.includes('btn-bmc') ? 'ant-btn-bmc' : '',
      ].filter(Boolean).join(' ') || undefined,
    };
    const children = badge
      ? [text || null, h('span', {
        key: 'badge',
        className: 'star-count',
        'data-star-count': '',
        hidden: badge.hidden || undefined,
        dangerouslySetInnerHTML: { __html: badge.innerHTML },
      })]
      : (text || null);
    return h(Button, props, children);
  };

  const scan = (root = document) => {
    root.querySelectorAll('button.btn, a.btn').forEach((el) => {
      if (el.dataset.ant || el.hidden || el.closest('.ant-host')) return;
      mount(el, buttonNode(el, el.tagName === 'A' ? el.getAttribute('href') : undefined),
        el.style.width === '100%' || el.className.includes('w-full'));
    });

    root.querySelectorAll('.icon-btn').forEach((el) => {
      if (el.dataset.ant || el.hidden || el.closest('.ant-host')) return;
      mount(el, h(Button, {
        type: 'text',
        shape: 'circle',
        size: 'small',
        icon: iconNode(el),
        onClick: () => el.click(),
      }));
    });

    root.querySelectorAll('label.switch').forEach((el) => {
      if (el.dataset.ant || el.closest('.ant-host')) return;
      const input = el.querySelector('input[type="checkbox"]');
      if (!input) return;
      mount(el, h(Switch, {
        size: 'small',
        checked: input.checked,
        disabled: input.disabled,
        onChange: (checked) => {
          input.checked = checked;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        },
      }));
    });

    root.querySelectorAll('select.input, select.fw-select').forEach((el) => {
      if (el.dataset.ant || el.hidden || el.closest('.ant-host')) return;
      const isLang = el.id === 'lang-select';
      const options = Array.from(el.options).map((o) => ({
        value: o.value,
        label: isLang && FLAGS[o.value]
          ? h('span', { className: 'lang-option' },
            h('img', { src: FLAGS[o.value], alt: '', width: 16, height: 12 }),
            h('span', null, o.textContent))
          : o.textContent,
      }));
      mount(el, h(Select, {
        value: el.value,
        options,
        disabled: el.disabled,
        size: el.classList.contains('fw-select') ? 'small' : 'middle',
        popupMatchSelectWidth: false,
        style: el.classList.contains('lang-select')
          ? { minWidth: 122 }
          : el.classList.contains('fw-select') ? { minWidth: 130 } : { width: '100%' },
        onChange: (value) => {
          el.value = value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        },
      }), true);
    });

    root.querySelectorAll('input.range').forEach((el) => {
      if (el.dataset.ant || el.closest('.ant-host')) return;
      const sliderNode = (value) => h(ConfigProvider, { theme: themeConfig }, h(Slider, {
        min: Number(el.min) || 0,
        max: Number(el.max) || 100,
        step: Number(el.step) || 1,
        value,
        tooltip: { formatter: (v) => v },
        onChange: (next) => {
          el.value = next;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        },
      }));
      const entry = mount(el, sliderNode(Number(el.value)), true, { bind: el.dataset.bind || null });
      if (!entry) return;
      // Allows the app to push a value changed elsewhere (+/- buttons, device
      // notifications) into the mounted slider without rebuilding the page.
      entry.sync = (value) => {
        el.value = value;
        entry.root.render(sliderNode(Number(value)));
      };
    });

    root.querySelectorAll('.seg').forEach((el) => {
      if (el.dataset.ant || el.closest('.ant-host') || el.classList.contains('seg-wrap')) return;
      const buttons = Array.from(el.querySelectorAll('button'));
      if (!buttons.length) return;
      const active = buttons.findIndex((b) => b.classList.contains('is-active'));
      const options = buttons.map((b, i) => ({ label: b.textContent.trim(), value: i }));
      mount(el, h(Segmented, {
        options,
        value: active < 0 ? 0 : active,
        block: el.classList.contains('full'),
        onChange: (value) => { const b = buttons[value]; if (b) b.click(); },
      }), true);
    });
  };

  window.__antMount = (root) => scan(root || document);
  window.__antSyncValue = (bind, value) => {
    roots.forEach((entry) => {
      if (entry.bind === bind && entry.sync) entry.sync(value);
    });
  };
  window.__antCleanup = cleanup;
  scan(document);
})();
