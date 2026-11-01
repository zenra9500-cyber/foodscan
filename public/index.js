'use strict';

(() => {
  const $ = id => document.getElementById(id);
  const KEYS = ['calories', 'protein', 'carbs', 'fat', 'sugar', 'sodium', 'fiber'];
  const LABELS = ['พลังงาน', 'โปรตีน', 'คาร์โบไฮเดรต', 'ไขมัน', 'น้ำตาล', 'โซเดียม', 'ใยอาหาร'];
  const ENGLISH = ['Calories', 'Protein', 'Carbohydrates', 'Fat', 'Sugar', 'Sodium', 'Fiber'];
  const SYMBOLS = ['ϟ', '◈', '◒', '◐', '◇', '▧', '❋'];
  const STORAGE = 'foodscan.history.v1';
  const MAX_AGE = 365 * 86400000;
  const state = { image: null, preview: null, busy: false, foods: [], selectedFood: null, result: null, history: [], chartMacro: null, chartBar: null, request: null, imageVersion: 0 };
  let toastTimer;
  let searchController;
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }
  function notify(message, error = false) {
    clearTimeout(toastTimer);
    $('toast').textContent = message;
    $('toast').className = `toast${error ? ' error' : ''}`;
    $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 8000 : 4500);
  }
  const fmt = value => new Intl.NumberFormat('th-TH', { maximumFractionDigits: 1 }).format(value);
  const sourceLabel = source => ({ ai: 'AI · ค่าประมาณจากภาพ', demo: 'DEMO · ไม่ได้ตรวจจับภาพ', reference: 'ข้อมูลอ้างอิง · ไม่ใช่ AI' })[source] || '';
  function validRecord(item) {
    return item && typeof item.id === 'string' && item.id.length <= 100 && typeof item.name === 'string' && item.name.length <= 160 && ['ai', 'demo', 'reference'].includes(item.source) && Number.isFinite(Date.parse(item.createdAt)) && Date.parse(item.createdAt) <= Date.now() + 60000 && Date.now() - Date.parse(item.createdAt) <= MAX_AGE && Number.isFinite(item.grams) && item.grams > 0 && item.grams <= 10000 && (item.confidence === null || (Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1)) && KEYS.every(key => Number.isFinite(item.nutrients?.[key]) && item.nutrients[key] >= 0 && item.nutrients[key] <= 100000) && Array.isArray(item.ingredients) && item.ingredients.length <= 20 && item.ingredients.every(x => typeof x === 'string' && x.length <= 100) && typeof item.notes === 'string' && item.notes.length <= 2400 && (!item.thumbnail || (typeof item.thumbnail === 'string' && item.thumbnail.length < 300000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(item.thumbnail)));
  }
  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      const filtered = Array.isArray(parsed) ? parsed.filter(validRecord).slice(0, 30) : [];
      if (JSON.stringify(filtered) !== raw) localStorage.setItem(STORAGE, JSON.stringify(filtered));
      return filtered;
    } catch { notify('เข้าถึงประวัติไม่ได้ พื้นที่เก็บข้อมูลอาจถูกปิดหรือมีข้อมูลเสียหาย', true); return []; }
  }
  function writeHistory(items) {
    try { localStorage.setItem(STORAGE, JSON.stringify(items)); state.history = items; renderHistory(); return true; }
    catch { notify('บันทึกไม่ได้ พื้นที่เบราว์เซอร์อาจเต็ม กรุณาลบประวัติบางรายการหรืออนุญาตพื้นที่จัดเก็บ', true); return false; }
  }
  async function confirmDelete(title, description) {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-description').textContent = description;
    dialog.returnValue = 'cancel';
    return new Promise(resolve => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
      dialog.showModal();
    });
  }
  function route() {
    const hash = location.hash.slice(1) || 'home';
    if (hash === 'main') { $('main').focus({ preventScroll: true }); $('main').scrollIntoView(); return; }
    const page = ['home', 'scan', 'history', 'about'].includes(hash) ? hash : 'home';
    document.querySelectorAll('.page').forEach(element => { element.hidden = element.id !== page; });
    document.querySelectorAll('[data-nav]').forEach(link => {
      link.classList.toggle('active', link.dataset.nav === page);
      if (link.dataset.nav === page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    });
    $('navigation').classList.remove('open');
    $('menu-toggle').setAttribute('aria-expanded', 'false');
    if (page === 'history') { state.history = loadHistory(); renderHistory(); }
    document.title = `${({ home: 'เข้าใจทุกคำ ดูแลทุกวัน', scan: 'วิเคราะห์อาหาร', history: 'ประวัติมื้ออาหาร', about: 'เกี่ยวกับเว็บไซต์' })[page]} — AI FOOD SCANNER`;
    if (hash !== 'how-it-works') window.scrollTo({ top: 0, behavior: 'instant' });
    else requestAnimationFrame(() => $('how-it-works').scrollIntoView({ behavior: 'smooth' }));
  }
  function setTab(name, focus = false) {
    const photo = name === 'photo';
    $('photo-panel').hidden = !photo;
    $('search-panel').hidden = photo;
    for (const tab of ['photo', 'search']) {
      const selected = name === tab;
      $(`tab-${tab}`).setAttribute('aria-selected', String(selected));
      $(`tab-${tab}`).tabIndex = selected ? 0 : -1;
      $(`tab-${tab}`).classList.toggle('active', selected);
    }
    if (focus) $(`tab-${name}`).focus();
  }
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
    let body;
    try { body = await response.json(); } catch { throw new Error('เซิร์ฟเวอร์ส่งคำตอบไม่ถูกต้อง กรุณาลองใหม่'); }
    if (!response.ok) throw new Error(body.error || 'คำขอไม่สำเร็จ กรุณาลองใหม่');
    return body;
  }
  async function loadFoods(query = '') {
    searchController?.abort();
    searchController = new AbortController();
    $('food-list').textContent = 'กำลังค้นหาอาหาร…';
    state.selectedFood = null;
    $('quantity-controls').hidden = true;
    try {
      const data = await api(`/api/foods?q=${encodeURIComponent(query)}`, { signal: AbortSignal.any([searchController.signal, AbortSignal.timeout(15000)]) });
      state.foods = data.foods;
      renderFoods();
      if (!query && $('demo-food').options.length < 2) {
        $('demo-food').replaceChildren(node('option', '', 'เลือกอาหารตัวอย่าง'));
        $('demo-food').firstChild.value = '';
        data.foods.forEach(food => {
          const option = node('option', '', food.name);
          option.value = food.id;
          $('demo-food').append(option);
        });
      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      $('food-list').textContent = 'โหลดรายการไม่สำเร็จ ลองกดค้นหาอีกครั้ง';
      notify('โหลดข้อมูลอาหารไม่สำเร็จ ตรวจว่า Backend เปิดอยู่ แล้วกดค้นหาเพื่อลองใหม่', true);
    }
  }
  function renderFoods() {
    $('food-list').replaceChildren();
    if (!state.foods.length) {
      const empty = node('p', 'field-help', 'ไม่พบอาหารนี้ ลองค้นหา ข้าว ไก่ ไข่ กล้วย บรอกโคลี แซลมอน ข้าวโอ๊ต หรือแอปเปิล');
      $('food-list').append(empty);
      return;
    }
    state.foods.forEach(food => {
      const button = node('button', 'food-option');
      button.type = 'button';
      button.setAttribute('aria-pressed', String(state.selectedFood?.id === food.id));
      button.append(node('span', '', food.category), node('strong', '', food.name), node('small', '', `${fmt(food.nutrients.calories)} kcal / 100 กรัม`));
      button.addEventListener('click', () => {
        state.selectedFood = food;
        $('quantity-controls').hidden = false;
        renderFoods();
        $('search-grams').focus();
      });
      $('food-list').append(button);
    });
  }
  async function selectImage(file) {
    if (state.busy || !file) return;
    const version = ++state.imageVersion;
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.type)) return notify('รองรับ JPG, PNG, GIF และ WebP เท่านั้น หากเป็น HEIC ให้แปลงเป็น JPG ก่อน', true);
    if (file.size > 5 * 1024 * 1024 || file.size === 0) return notify('เลือกรูปขนาดมากกว่า 0 และไม่เกิน 5 MB', true);
    const url = URL.createObjectURL(file);
    let accepted = false;
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      if (image.naturalWidth * image.naturalHeight > 20000000) throw new Error('ภาพต้องมีความละเอียดไม่เกิน 20 ล้านพิกเซล กรุณาลดขนาดก่อน');
      const reader = new FileReader();
      const data = await new Promise((resolve, reject) => { reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('อ่านไฟล์ไม่ได้ กรุณาเลือกรูปใหม่')); reader.readAsDataURL(file); });
      if (version !== state.imageVersion) return;
      if (state.preview) URL.revokeObjectURL(state.preview);
      state.image = data;
      state.preview = url;
      accepted = true;
      $('preview-image').src = url;
      $('preview-box').hidden = false;
      $('dropzone').hidden = true;
      $('file-label').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
      clearResult();
    } catch (error) { notify(error.message || 'เปิดภาพไม่ได้ กรุณาลองรูปอื่น', true); }
    finally { if (!accepted) URL.revokeObjectURL(url); }
  }
  function removeImage() {
    state.imageVersion++;
    if (state.preview) URL.revokeObjectURL(state.preview);
    state.image = null;
    state.preview = null;
    $('preview-image').removeAttribute('src');
    $('preview-box').hidden = true;
    $('dropzone').hidden = false;
    $('file-input').value = '';
    $('camera-input').value = '';
    clearResult();
  }
  function clearResult() {
    state.result = null;
    $('results').hidden = true;
    state.chartMacro?.destroy();
    state.chartBar?.destroy();
    state.chartMacro = null;
    state.chartBar = null;
  }
  function resetScan() {
    state.request?.abort();
    removeImage();
    $('demo-food').value = '';
    $('demo-grams').value = '100';
    $('access-code').value = '';
    $('image-consent').checked = false;
    $('food-query').value = '';
    $('search-grams').value = '100';
    state.selectedFood = null;
    $('quantity-controls').hidden = true;
    setTab('photo');
    notify('ล้างข้อมูลแล้ว เลือกรูปเพื่อเริ่มมื้อใหม่ได้เลย');
  }
  function updateMode() {
    const demo = document.querySelector('input[name=mode]:checked').value === 'demo';
    $('demo-options').hidden = !demo;
    $('ai-options').hidden = demo;
    clearResult();
  }
  function setBusy(busy) {
    state.busy = busy;
    $('progress').hidden = !busy;
    $('photo-panel').setAttribute('aria-busy', String(busy));
    $('photo-panel').querySelectorAll('button,input,select').forEach(element => { element.disabled = busy; });
    $('analyze-button').textContent = busy ? 'กำลังวิเคราะห์…' : 'วิเคราะห์สารอาหาร ↗';
  }
  async function analyze() {
    if (state.busy) return;
    if (!state.image) { notify('กรุณาเลือกรูปหรือถ่ายภาพอาหารก่อนวิเคราะห์', true); $('choose-image').focus(); return; }
    const mode = document.querySelector('input[name=mode]:checked').value;
    const grams = Number($('demo-grams').value);
    if (mode === 'demo' && !$('demo-food').value) { notify('เลือกอาหารตัวอย่างก่อน โหมดทดลองไม่ได้ตรวจจับอาหารในภาพ', true); $('demo-food').focus(); return; }
    if (mode === 'demo' && (!Number.isFinite(grams) || grams < 1 || grams > 2000)) return notify('กรุณาระบุปริมาณ 1–2,000 กรัม', true);
    if (mode === 'ai' && !$('image-consent').checked) return notify('กรุณายินยอมให้ส่งภาพไปยังผู้ให้บริการ AI ก่อน', true);
    if (mode === 'ai' && !$('access-code').value.trim()) { notify('กรุณาระบุรหัสเข้าใช้ AI จากผู้ดูแล ไม่ใช่ API Key', true); $('access-code').focus(); return; }
    const access = $('access-code').value;
    $('access-code').value = '';
    clearResult();
    setBusy(true);
    state.request = new AbortController();
    $('progress-text').textContent = mode === 'demo' ? 'กำลังเตรียมภาพและคำนวณข้อมูลตัวอย่าง…' : 'กำลังส่งภาพที่ลบ metadata แล้วให้ AI ประเมิน…';
    try {
      const result = await api('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(mode === 'ai' ? { Authorization: `Bearer ${access}` } : {}) }, body: JSON.stringify({ image: state.image, mode, foodId: $('demo-food').value, grams }), signal: AbortSignal.any([state.request.signal, AbortSignal.timeout(60000)]) });
      if (!validRecord(result)) throw new Error('ข้อมูลผลวิเคราะห์ไม่ถูกต้อง กรุณาลองอีกครั้ง');
      showResult(result);
      if (location.hash !== '#scan') notify('วิเคราะห์เรียบร้อยแล้ว เปิดเมนูวิเคราะห์อาหารเพื่อดูผล');
    } catch (error) {
      notify(error.name === 'TimeoutError' ? 'การวิเคราะห์หมดเวลา กรุณาลองอีกครั้ง' : error.name === 'AbortError' ? 'ยกเลิกการวิเคราะห์แล้ว' : error.message || 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจอินเทอร์เน็ตและ Backend', true);
    } finally { setBusy(false); state.request = null; }
  }
  function showResult(result) {
    state.result = result;
    $('results').hidden = false;
    $('result-title').textContent = result.name;
    $('result-badge').textContent = sourceLabel(result.source);
    $('result-badge').className = `badge${result.source === 'demo' ? ' amber' : ''}`;
    $('result-portion').textContent = `ปริมาณ${result.source === 'ai' ? 'ประมาณ' : ''} ${fmt(result.grams)} กรัม`;
    $('result-confidence').textContent = result.confidence === null ? '' : `ความมั่นใจที่ AI ประเมินเอง ${Math.round(result.confidence * 100)}%`;
    $('result-ingredients').textContent = result.ingredients.join(' · ');
    $('result-notes').textContent = result.notes;
    $('result-image').hidden = !result.thumbnail;
    if (result.thumbnail) $('result-image').src = result.thumbnail; else $('result-image').removeAttribute('src');
    $('nutrient-grid').replaceChildren();
    KEYS.forEach((key, index) => {
      const card = node('article', 'nutrient-card');
      const value = node('strong', '', fmt(result.nutrients[key]));
      value.append(node('span', 'nutrient-unit', index === 0 ? 'kcal' : key === 'sodium' ? 'mg' : 'g'));
      card.append(node('span', 'nutrient-symbol', SYMBOLS[index]), value, node('p', '', LABELS[index]), node('small', '', ENGLISH[index]));
      $('nutrient-grid').append(card);
    });
    updateSaveButton();
    requestAnimationFrame(() => {
      drawCharts(result);
      if (location.hash === '#scan') { $('results').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('result-title').focus({ preventScroll: true }); }
    });
  }
  function drawCharts(result) {
    state.chartMacro?.destroy(); state.chartBar?.destroy();
    if (!window.Chart) { notify('โหลด Chart.js ไม่สำเร็จ โปรดติดตั้ง dependencies และรีเฟรชหน้า ข้อมูลสารอาหารยังอ่านได้จากการ์ด', true); return; }
    Chart.defaults.font.family = "'Noto Sans Thai', sans-serif";
    Chart.defaults.color = '#788078';
    const n = result.nutrients;
    const energy = [n.protein * 4, n.carbs * 4, n.fat * 9];
    const total = energy.reduce((a, b) => a + b, 0);
    $('macro-chart').setAttribute('aria-label', `สัดส่วนพลังงาน: โปรตีน ${total ? Math.round(energy[0] / total * 100) : 0}% คาร์บ ${total ? Math.round(energy[1] / total * 100) : 0}% ไขมัน ${total ? Math.round(energy[2] / total * 100) : 0}%`);
    const animation = matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 650 };
    state.chartMacro = new Chart($('macro-chart'), { type: 'doughnut', data: { labels: ['โปรตีน', 'คาร์โบไฮเดรต', 'ไขมัน'], datasets: [{ data: energy, backgroundColor: ['#176b49', '#99b978', '#e5ce8e'], borderWidth: 5, borderColor: '#fff', borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '74%', animation, plugins: { legend: { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', padding: 17, font: { size: 10 }, boxWidth: 7 } }, tooltip: { callbacks: { label: ctx => `${ctx.label}: ${fmt(ctx.raw)} kcal (${total ? Math.round(ctx.raw / total * 100) : 0}%)` } } } } });
    state.chartBar = new Chart($('nutrient-chart'), { type: 'bar', data: { labels: ['โปรตีน', 'คาร์บ', 'ไขมัน', 'น้ำตาล', 'ใยอาหาร'], datasets: [{ data: [n.protein, n.carbs, n.fat, n.sugar, n.fiber], backgroundColor: ['#176b49', '#6c925a', '#a7bf88', '#d7cc9a', '#dbe6ca'], borderRadius: 5, maxBarThickness: 35 }] }, options: { responsive: true, maintainAspectRatio: false, animation, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 9 } } }, y: { beginAtZero: true, border: { display: false }, grid: { color: '#f0f2eb' }, title: { display: true, text: 'กรัม (g)', font: { size: 9 } }, ticks: { font: { size: 9 } } } }, plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => `${fmt(ctx.raw)} กรัม` } } } } });
  }
  function updateSaveButton() {
    const saved = state.history.some(item => item.id === state.result?.id);
    $('save-result').textContent = saved ? 'บันทึกแล้ว ✓' : 'บันทึกมื้อนี้ ＋';
    $('save-result').disabled = saved;
  }
  function renderHistory() {
    $('history-count').textContent = state.history.length;
    $('clear-history').disabled = state.history.length === 0;
    $('history-list').replaceChildren();
    if (!state.history.length) {
      const empty = node('div', 'empty-state');
      const link = node('a', 'button', 'เริ่มวิเคราะห์มื้อแรก ↗');
      link.href = '#scan';
      empty.append(node('span', '', '▤'), node('h2', '', 'มื้อแรกของคุณ เริ่มได้เลย'), node('p', '', 'เมื่อวิเคราะห์แล้ว กด “บันทึกมื้อนี้” เพื่อเก็บไว้ย้อนดูได้ที่นี่'), link);
      $('history-list').append(empty);
    }
    state.history.forEach(item => {
      const card = node('article', 'history-card');
      if (item.thumbnail) { const img = node('img', 'history-thumb'); img.src = item.thumbnail; img.alt = item.name; img.loading = 'lazy'; card.append(img); }
      else card.append(node('div', 'history-placeholder', '❋'));
      const content = node('div', 'history-body');
      content.append(node('span', `badge${item.source === 'demo' ? ' amber' : ''}`, sourceLabel(item.source)), node('h2', '', item.name));
      content.append(node('p', '', new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.createdAt))), node('p', '', `${fmt(item.grams)} กรัม · ${fmt(item.nutrients.calories)} kcal`));
      const buttons = node('div', 'history-card-actions');
      const open = node('button', 'icon-button', 'ดูรายละเอียด ↗');
      open.addEventListener('click', () => { location.hash = '#scan'; setTab('photo'); route(); showResult(item); });
      const remove = node('button', 'icon-button danger', 'ลบ');
      remove.setAttribute('aria-label', `ลบประวัติ ${item.name}`);
      remove.addEventListener('click', async () => {
        if (await confirmDelete('ลบมื้อนี้หรือไม่?', `รายการ “${item.name}” จะถูกลบจากเบราว์เซอร์นี้และกู้คืนไม่ได้`)) {
          state.history = loadHistory();
          if (writeHistory(state.history.filter(x => x.id !== item.id))) { notify('ลบประวัติแล้ว'); updateSaveButton(); }
        }
      });
      buttons.append(open, remove); content.append(buttons); card.append(content); $('history-list').append(card);
    });
  }
  $('menu-toggle').addEventListener('click', () => { const open = $('navigation').classList.toggle('open'); $('menu-toggle').setAttribute('aria-expanded', String(open)); });
  window.addEventListener('hashchange', route);
  window.addEventListener('storage', event => { if (event.key === STORAGE || event.key === null) { state.history = loadHistory(); renderHistory(); updateSaveButton(); } });
  window.addEventListener('pagehide', () => { state.request?.abort(); if (state.preview) URL.revokeObjectURL(state.preview); });
  for (const tab of ['photo', 'search']) {
    $(`tab-${tab}`).addEventListener('click', () => setTab(tab));
    $(`tab-${tab}`).addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); setTab(event.key === 'Home' ? 'photo' : event.key === 'End' ? 'search' : tab === 'photo' ? 'search' : 'photo', true); } });
  }
  $('choose-image').addEventListener('click', () => $('file-input').click());
  $('replace-image').addEventListener('click', () => $('file-input').click());
  $('take-photo').addEventListener('click', () => $('camera-input').click());
  for (const id of ['file-input', 'camera-input']) $(id).addEventListener('change', event => { selectImage(event.target.files[0]); event.target.value = ''; });
  $('remove-image').addEventListener('click', removeImage);
  $('dropzone').addEventListener('dragover', event => { event.preventDefault(); if (!state.busy) $('dropzone').classList.add('dragging'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragging'));
  $('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragging'); if (event.dataTransfer.files.length > 1) notify('ใช้รูปแรกเท่านั้น วิเคราะห์ได้ครั้งละหนึ่งภาพ'); selectImage(event.dataTransfer.files[0]); });
  document.querySelectorAll('input[name=mode]').forEach(input => input.addEventListener('change', updateMode));
  $('analyze-button').addEventListener('click', analyze);
  $('reset-scan').addEventListener('click', resetScan);
  $('new-scan').addEventListener('click', () => { resetScan(); window.scrollTo({ top: 0, behavior: 'smooth' }); $('choose-image').focus({ preventScroll: true }); });
  $('search-form').addEventListener('submit', event => { event.preventDefault(); loadFoods($('food-query').value.trim()); });
  $('calculate-food').addEventListener('click', () => {
    const grams = Number($('search-grams').value);
    if (!state.selectedFood) return notify('กรุณาเลือกอาหารก่อน', true);
    if (!Number.isFinite(grams) || grams < 1 || grams > 2000) return notify('กรุณาระบุปริมาณ 1–2,000 กรัม', true);
    const food = state.selectedFood;
    showResult({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), name: food.name, grams, source: 'reference', confidence: null, ingredients: food.ingredients, notes: food.notes, thumbnail: null, nutrients: Object.fromEntries(KEYS.map(key => [key, Math.round(food.nutrients[key] * grams) / 100])) });
  });
  $('save-result').addEventListener('click', () => {
    if (!state.result) return;
    state.history = loadHistory();
    if (state.history.some(item => item.id === state.result.id)) return updateSaveButton();
    if (writeHistory([state.result, ...state.history].slice(0, 30))) { notify('บันทึกมื้อนี้แล้ว · ดูได้ในเมนูประวัติ'); updateSaveButton(); }
  });
  $('clear-history').addEventListener('click', async () => {
    if (await confirmDelete('ลบประวัติทั้งหมด?', 'รูปย่อและผลที่บันทึกในเบราว์เซอร์นี้จะถูกลบทั้งหมด ไม่สามารถกู้คืนได้')) {
      if (writeHistory([])) { notify('ลบประวัติทั้งหมดแล้ว'); updateSaveButton(); }
    }
  });
  state.history = loadHistory();
  renderHistory();
  route();
  loadFoods();
  api('/api/config').then(config => {
    $('ai-badge').textContent = config.aiAvailable ? 'ตั้งค่าแล้ว' : 'ยังไม่เชื่อมต่อ';
    $('ai-status').textContent = config.aiAvailable ? 'ตั้งค่า Backend แล้ว แต่ยังไม่ยืนยันการเชื่อมต่อผู้ให้บริการ ใช้รหัสเข้าใช้ส่วนตัวและยินยอมก่อนส่งภาพ' : 'ยังไม่มีการตั้งค่า AI จริง ผู้ดูแลต้องกำหนด Gateway URL, API Key และรหัสเข้าใช้ใน .env ก่อน คุณยังทดลองระบบได้โดยไม่ใช้ API';
  }).catch(() => { $('ai-badge').textContent = 'ออฟไลน์'; $('ai-status').textContent = 'เชื่อมต่อ Backend ไม่สำเร็จ รีเฟรชเมื่อเปิดเซิร์ฟเวอร์แล้ว'; notify('เชื่อมต่อ Backend ไม่ได้ กรุณาเปิดเว็บไซต์ผ่านเซิร์ฟเวอร์ ไม่ใช่เปิดไฟล์ HTML โดยตรง', true); });
})();
