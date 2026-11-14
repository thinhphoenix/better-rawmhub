/* Lightweight i18n layer.
   Translates English text nodes and a few attributes in place, so the existing
   views do not need to be rewritten. Original English is kept in WeakMaps and
   re-applied when the language changes. */
(() => {
  const STORAGE_KEY = 'rawmhub.lang';

  const LANGUAGES = [
    { id: 'en', label: 'English' },
    { id: 'vi', label: 'Tiếng Việt' },
    { id: 'zh', label: '中文' },
    { id: 'ja', label: '日本語' },
    { id: 'th', label: 'ไทย' },
    { id: 'ko', label: '한국어' },
    { id: 'es', label: 'Español' },
  ];

  const LOCALES = __LOCALES__;
  const PATTERNS = [
    { re: /^([\d,]+) programmable buttons$/, out: { vi: '{1} nút lập trình', zh: '{1} 个可编程按键', ja: '{1} 個のプログラマブルボタン', th: 'ปุ่มปรับแต่งได้ {1} ปุ่ม', ko: '프로그래밍 가능한 버튼 {1}개', es: '{1} botones programables' } },
    { re: /^([\d,]+) mice · ([\d,]+) keyboards$/, out: { vi: '{1} chuột · {2} bàn phím', zh: '{1} 个鼠标 · {2} 个键盘', ja: '{1} マウス · {2} キーボード', th: 'เมาส์ {1} · คีย์บอร์ด {2}', ko: '마우스 {1} · 키보드 {2}', es: '{1} ratones · {2} teclados' } },
    { re: /^([\d,]+) onboard stages$/, out: { vi: '{1} mức onboard', zh: '{1} 个板载档位', ja: '{1} オンボード段階', th: '{1} ระดับออนบอร์ด', ko: '{1}개 온보드 단계', es: '{1} etapas integradas' } },
    { re: /^([\d,]+) slots$/, out: { vi: '{1} slot', zh: '{1} 个槽位', ja: '{1} スロット', th: '{1} ช่อง', ko: '{1}개 슬롯', es: '{1} ranuras' } },
    { re: /^([\d,]+) HZ MAX$/, out: { vi: '{1} HZ TỐI ĐA', zh: '最高 {1} HZ', ja: '最大 {1} HZ', th: 'สูงสุด {1} HZ', ko: '최대 {1} HZ', es: '{1} HZ MÁX' } },
    { re: /^([\d,]+) LOD$/, out: { vi: '{1} LOD', zh: '{1} 档 LOD', ja: '{1} LOD', th: '{1} LOD', ko: '{1} LOD', es: '{1} LOD' } },
    { re: /^SLOT (\d+)$/, out: { vi: 'SLOT {1}', zh: '槽位 {1}', ja: 'スロット {1}', th: 'ช่อง {1}', ko: '슬롯 {1}', es: 'RANURA {1}' } },
    { re: /^STAGE ([\d,]+)$/, out: { vi: 'STAGE {1}', zh: '档位 {1}', ja: '段階 {1}', th: 'ระดับ {1}', ko: '단계 {1}', es: 'ETAPA {1}' } },
    { re: /^DPI \/ CPI · (.+) in (.+) steps$/, out: { vi: 'DPI / CPI · {1} với bước {2}', zh: 'DPI / CPI · {1}，步进 {2}', ja: 'DPI / CPI · {1}、{2} 刻み', th: 'DPI / CPI · {1} ทีละ {2}', ko: 'DPI / CPI · {1}, {2} 단위', es: 'DPI / CPI · {1} en pasos de {2}' } },
  ];

  const textOriginal = new WeakMap();
  const attrOriginal = new WeakMap();
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

  function detect() {
    const stored = (() => { try { return localStorage.getItem(STORAGE_KEY); } catch { return null; } })();
    if (stored && LANGUAGES.some((l) => l.id === stored)) return stored;
    const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en';
    const low = String(nav).toLowerCase();
    if (low.startsWith('vi')) return 'vi';
    if (low.startsWith('zh')) return 'zh';
    if (low.startsWith('ja')) return 'ja';
    if (low.startsWith('th')) return 'th';
    if (low.startsWith('ko')) return 'ko';
    if (low.startsWith('es')) return 'es';
    return 'en';
  }

  let lang = detect();

  function core(key) {
    if (!key) return key;
    const row = LOCALES[lang];
    const hit = row && row[key];
    if (hit) return hit;
    for (const p of PATTERNS) {
      const m = key.match(p.re);
      if (m && p.out[lang]) return p.out[lang].replace('{1}', m[1]).replace('{2}', m[2] || '');
    }
    return key;
  }

  function t(key) {
    return core(key);
  }

  function translateValue(value) {
    if (lang === 'en' || !value || !value.trim()) return value;
    const leading = value.match(/^\s*/)[0];
    const trailing = value.match(/\s*$/)[0];
    const body = value.trim();
    const next = core(body);
    return next === body ? value : leading + next + trailing;
  }

  function apply(root = document) {
    if (!root || !root.isConnected) return;
    const doc = root.ownerDocument || document;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || p.tagName === 'SCRIPT' || p.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (!textOriginal.has(node)) textOriginal.set(node, node.nodeValue);
      const original = textOriginal.get(node);
      const next = translateValue(original);
      if (node.nodeValue !== next) node.nodeValue = next;
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('*').forEach((el) => {
        let saved = attrOriginal.get(el);
        ATTRS.forEach((attr) => {
          if (!el.hasAttribute(attr)) return;
          if (!saved) { saved = {}; attrOriginal.set(el, saved); }
          if (saved[attr] == null) saved[attr] = el.getAttribute(attr);
          const next = translateValue(saved[attr]);
          if (el.getAttribute(attr) !== next) el.setAttribute(attr, next);
        });
      });
    }
  }

  function setLang(next) {
    if (!LANGUAGES.some((l) => l.id === next)) next = 'en';
    lang = next;
    try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* ignore */ }
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;
  }

  document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;

  window.RAWM_I18N = {
    languages: LANGUAGES,
    apply,
    setLang,
    t,
    get lang() { return lang; },
  };
})();
