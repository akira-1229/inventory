(() => {
  'use strict';

  const CONFIG = window.APP_CONFIG;
  const STORAGE_KEY = 'inventory.v2';
  const $ = (sel) => document.querySelector(sel);
  const FIELD_LABELS = { maker: 'メーカー', model: '型番', use: '用途', location: '場所', detail: '詳細', store: '購入店' };

  // ---------- 保存データ（localStorage） ----------
  // items:   エクセルの品目 + アプリ側の設定（unit, minQty, excluded）
  // records: { 'YYYY-MM': { [itemId]: {qty, checked, note, updatedAt} } }
  // source:  最後に読み込んだエクセルの情報
  let db = loadDb();

  function loadDb() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (data && Array.isArray(data.items) && data.records) return { source: null, ...data };
    } catch (e) { /* 初期化 */ }
    return { items: [], records: {}, source: null };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (e) {
      alert('保存に失敗しました。ブラウザの設定を確認してください。');
    }
  }

  // ---------- フォルダ・ファイルの保存（IndexedDB） ----------
  const idb = (() => {
    let dbp;
    const open = () => (dbp ||= new Promise((res, rej) => {
      const req = indexedDB.open('inventory', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    }));
    const tx = async (mode, fn) => {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction('kv', mode);
        const req = fn(t.objectStore('kv'));
        t.oncomplete = () => res(req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
      set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => undefined),
      del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => undefined),
    };
  })();

  // ---------- 日付 ----------
  const pad = (n) => String(n).padStart(2, '0');
  const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const fmt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}(${'日月火水木金土'[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const WEEKDAY = '日月火水木金土'[CONFIG.checkWeekday];

  // 直近の確認曜日（今日を含む）の 0:00
  function lastCheckDay() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() - CONFIG.checkWeekday + 7) % 7));
    return d;
  }
  const isStale = () => !db.source || new Date(db.source.loadedAt) < lastCheckDay();

  // ---------- エクセル読み込み ----------
  const photos = new Map(); // itemId -> [objectURL]（このページを開いている間だけ）

  function clean(v) {
    const s = (v ?? '').toString().trim();
    return s === '-' || s === '－' ? '' : s;
  }

  function rowsToItems(rows) {
    const headerRowIndex = rows.findIndex(Boolean);
    if (headerRowIndex < 0) throw new Error('エクセルにデータがありません');
    const header = rows[headerRowIndex].map((c) => clean(c && c.value));
    const colOf = {};
    for (const [key, label] of Object.entries(CONFIG.columns)) {
      const i = header.indexOf(label);
      if (i >= 0) colOf[key] = i;
    }
    if (colOf.name === undefined) {
      throw new Error(`見出し「${CONFIG.columns.name}」の列が見つかりません（1行目: ${header.filter(Boolean).join('、')}）`);
    }
    const photoCols = header.map((h, i) => (h.startsWith(CONFIG.photoColumnPrefix) ? i : -1)).filter((i) => i >= 0);

    const items = [];
    const used = new Set();
    for (const row of rows.slice(headerRowIndex + 1)) {
      if (!row) continue;
      const name = clean(row[colOf.name] && row[colOf.name].value);
      if (!name) continue;
      let id = name;
      for (let n = 2; used.has(id); n++) id = `${name} (${n})`;
      used.add(id);
      const item = { id, name };
      for (const key of Object.keys(FIELD_LABELS)) {
        item[key] = colOf[key] === undefined ? '' : clean(row[colOf[key]] && row[colOf[key]].value);
      }
      const images = photoCols.map((i) => row[i] && row[i].image).filter(Boolean);
      items.push({ item, images });
    }
    return items;
  }

  function hasRecords(id) {
    return Object.values(db.records).some((m) => m[id]);
  }

  // エクセルの内容で品目一覧を更新（数量などの記録は品目名で引き継ぐ）
  function syncItems(parsed) {
    const prev = new Map(db.items.map((i) => [i.id, i]));
    const next = parsed.map(({ item, images }) => {
      const old = prev.get(item.id) || {};
      return {
        ...item,
        photoCount: images.length,
        unit: old.unit || '',
        minQty: old.minQty ?? null,
        excluded: !!old.excluded,
        missing: false,
      };
    });
    const ids = new Set(next.map((i) => i.id));
    const added = next.filter((i) => !prev.has(i.id)).length;
    let removed = 0;
    for (const old of db.items) {
      if (ids.has(old.id)) continue;
      if (!old.missing) removed++;
      // 記録がある品目は「エクセルに無し」として残す
      if (hasRecords(old.id)) next.push({ ...old, missing: true });
    }
    db.items = next;
    return { added, removed };
  }

  function setPhotos(parsed) {
    for (const urls of photos.values()) urls.forEach((u) => URL.revokeObjectURL(u));
    photos.clear();
    for (const { item, images } of parsed) {
      if (images.length) photos.set(item.id, images.map((b) => URL.createObjectURL(b)));
    }
  }

  async function importFile(file, { folderName = null, cached = false } = {}) {
    const result = await window.XlsxReader.read(await file.arrayBuffer(), CONFIG.sheetName || '');
    const parsed = rowsToItems(result.rows);
    setPhotos(parsed);
    if (cached) return null; // 前回の写真を表示するだけ
    const diff = syncItems(parsed);
    db.source = {
      fileName: file.name,
      sheetName: result.sheetName,
      folderName,
      lastModified: new Date(file.lastModified).toISOString(),
      loadedAt: new Date().toISOString(),
    };
    save();
    idb.set('file', { name: file.name, lastModified: file.lastModified, blob: file });
    return { count: parsed.length, ...diff };
  }

  async function findExcel(dir) {
    if (CONFIG.excelFileName) {
      try {
        return await dir.getFileHandle(CONFIG.excelFileName);
      } catch (e) {
        const list = await listXlsx(dir);
        throw new Error(`「${CONFIG.excelFileName}」がフォルダ「${dir.name}」に見つかりません。` +
          (list.length ? `（フォルダ内のエクセル: ${list.join('、')}）` : ''));
      }
    }
    const list = await listXlsx(dir);
    if (list.length === 1) return dir.getFileHandle(list[0]);
    if (!list.length) throw new Error(`フォルダ「${dir.name}」にエクセル（.xlsx）がありません`);
    throw new Error(`フォルダにエクセルが複数あります（${list.join('、')}）。js/config.js の excelFileName にファイル名を設定してください`);
  }

  async function listXlsx(dir) {
    const names = [];
    for await (const [name, h] of dir.entries()) {
      // ~$ で始まるのはエクセルを開いている間の一時ファイル
      if (h.kind === 'file' && /\.xlsx$/i.test(name) && !name.startsWith('~$')) names.push(name);
    }
    return names.sort();
  }

  // ---------- 読み込み元の表示・操作 ----------
  const supportsFolder = 'showDirectoryPicker' in window;
  let dirHandle = null;

  function showMessage(text, kind = 'info') {
    const el = $('#sourceMessage');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = `source-message ${kind}`;
  }

  function renderSource(needsPermission = false) {
    const s = db.source;
    const stale = isStale();
    const lines = [];
    if (s) {
      lines.push(`<strong>${escapeHtml(s.fileName)}</strong>${s.folderName ? `（フォルダ: ${escapeHtml(s.folderName)}）` : ''}`);
      lines.push(`エクセルの更新: ${fmt(s.lastModified)}　最終読み込み: ${fmt(s.loadedAt)}`);
    } else {
      lines.push('<strong>エクセルがまだ読み込まれていません</strong>');
    }
    if (stale && s) lines.push(`<span class="warn">${WEEKDAY}曜日のエクセル確認がまだです</span>`);
    $('#sourceStatus').innerHTML = lines.join('<br>');
    $('#source').classList.toggle('stale', stale);
    $('#reload').hidden = !dirHandle;
    $('#reload').textContent = needsPermission ? 'エクセルを読み込む（許可）' : 'エクセルを再読み込み';
    $('#pickFolder').hidden = !supportsFolder;
    $('#pickFolder').textContent = dirHandle ? 'フォルダを変更' : 'フォルダを登録';
  }

  // auto: 起動時の自動読み込み。外付けHDDの接続待ちのため、見つからなければ10秒おきに再試行する
  const RETRY_LIMIT = 12;
  async function readFolder(auto = false, attempt = 1) {
    if (!dirHandle) return;
    try {
      let perm = await dirHandle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') perm = await dirHandle.requestPermission({ mode: 'read' });
      if (perm !== 'granted') {
        showMessage('フォルダの読み取りが許可されませんでした。「エクセルを読み込む」を押して許可してください。', 'error');
        renderSource(true);
        return;
      }
      const fh = await findExcel(dirHandle);
      const r = await importFile(await fh.getFile(), { folderName: dirHandle.name });
      showMessage(`${r.count}件を読み込みました` +
        (r.added || r.removed ? `（追加 ${r.added}件・エクセルから削除 ${r.removed}件）` : '（品目の増減なし）'), 'ok');
    } catch (e) {
      if (e.name === 'NotFoundError' && auto && attempt < RETRY_LIMIT) {
        showMessage(`外付けハードディスクの接続を待っています…（${attempt}/${RETRY_LIMIT - 1}）`, 'warn');
        setTimeout(() => readFolder(true, attempt + 1), 10000);
        return;
      }
      showMessage(e.name === 'NotFoundError' ? 'フォルダが見つかりません。外付けハードディスクが接続されているか確認してください。' : e.message, 'error');
    }
    renderSource();
    render();
  }

  $('#reload').addEventListener('click', () => readFolder());

  $('#pickFolder').addEventListener('click', async () => {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ id: 'inventory-excel', mode: 'read' });
    } catch (e) {
      return; // キャンセル
    }
    if (CONFIG.excelFolderName && handle.name !== CONFIG.excelFolderName &&
        !confirm(`選んだフォルダ「${handle.name}」は設定のフォルダ「${CONFIG.excelFolderName}」と名前が違います。このまま登録しますか？`)) {
      return;
    }
    dirHandle = handle;
    await idb.set('dir', handle);
    await readFolder();
  });

  $('#pickFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (CONFIG.excelFileName && file.name !== CONFIG.excelFileName &&
        !confirm(`選んだファイル「${file.name}」は設定のファイル名「${CONFIG.excelFileName}」と違います。読み込みますか？`)) {
      return;
    }
    try {
      const r = await importFile(file);
      showMessage(`${r.count}件を読み込みました（追加 ${r.added}件・エクセルから削除 ${r.removed}件）`, 'ok');
    } catch (err) {
      showMessage(err.message, 'error');
    }
    renderSource();
    render();
  });

  // ---------- チェック表 ----------
  const monthInput = $('#month');
  monthInput.value = ymOf(new Date());

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const hasValue = (v) => v !== null && v !== undefined && v !== '';
  const record = (ym, id) => (db.records[ym] && db.records[ym][id]) || null;

  // 対象月より前で最後に記録した数量
  function previousQty(id, ym) {
    for (const k of Object.keys(db.records).filter((m) => m < ym).sort().reverse()) {
      const r = db.records[k][id];
      if (r && hasValue(r.qty)) return { qty: r.qty, month: k };
    }
    return null;
  }

  function setRecord(ym, id, patch) {
    db.records[ym] = db.records[ym] || {};
    const cur = db.records[ym][id] || { qty: null, checked: false, note: '' };
    db.records[ym][id] = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    save();
  }

  const counted = (it) => !it.excluded && !it.missing;

  function visibleItems() {
    const q = $('#search').value.trim().toLowerCase();
    const showExcluded = $('#showExcluded').checked;
    const ym = monthInput.value;
    return db.items
      .filter((i) => showExcluded || !i.excluded)
      .filter((i) => !i.missing || record(ym, i.id))
      .filter((i) => !q || [i.name, i.use, i.location].some((v) => (v || '').toLowerCase().includes(q)))
      .sort((a, b) => (a.excluded - b.excluded) || (a.missing - b.missing));
  }

  function render() {
    const ym = monthInput.value || ymOf(new Date());
    const items = visibleItems();
    $('#rows').innerHTML = items.map((it) => {
      const r = record(ym, it.id) || {};
      const prev = previousQty(it.id, ym);
      const hasQty = hasValue(r.qty);
      const diff = hasQty && prev ? r.qty - prev.qty : null;
      const low = hasQty && hasValue(it.minQty) && r.qty < it.minQty;
      const unit = escapeHtml(it.unit);
      const badges = [
        low ? '<span class="badge warn">要補充</span>' : '',
        it.excluded ? '<span class="badge">対象外</span>' : '',
        it.missing ? '<span class="badge">エクセルに無し</span>' : '',
        it.photoCount ? `<span class="badge photo" title="写真 ${it.photoCount}枚">写真${it.photoCount}</span>` : '',
      ].join('');
      const cls = [r.checked && 'checked', low && 'low', (it.excluded || it.missing) && 'dim'].filter(Boolean).join(' ');
      return `
        <tr data-id="${escapeHtml(it.id)}" class="${cls}">
          <td class="col-check" data-label="確認"><input type="checkbox" class="chk" ${r.checked ? 'checked' : ''} aria-label="${escapeHtml(it.name)}を確認済みにする"></td>
          <td class="name" data-label="名称">
            <button type="button" class="link name-link">${escapeHtml(it.name)}</button>${badges}
            ${it.use && it.use !== it.name ? `<div class="sub">${escapeHtml(it.use)}</div>` : ''}
          </td>
          <td class="loc" data-label="場所">${it.location ? escapeHtml(it.location) : '<span class="muted">未記入</span>'}</td>
          <td class="num" data-label="前月">${prev ? `${prev.qty} ${unit}` : '<span class="muted">—</span>'}</td>
          <td class="num" data-label="今月数量">
            <div class="qty">
              <button type="button" class="step no-print" data-step="-1" aria-label="減らす">−</button>
              <input type="number" class="qty-input" min="0" step="1" inputmode="numeric" value="${hasQty ? r.qty : ''}" placeholder="—">
              <button type="button" class="step no-print" data-step="1" aria-label="増やす">＋</button>
              <span class="unit">${unit}</span>
            </div>
          </td>
          <td class="num diff ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}" data-label="増減">${diff === null ? '' : (diff > 0 ? '+' : '') + diff}</td>
          <td data-label="メモ"><input type="text" class="note-input" value="${escapeHtml(r.note || '')}"></td>
          <td class="no-print"><button type="button" class="edit link">詳細</button></td>
        </tr>`;
    }).join('');

    const empty = $('#empty');
    empty.hidden = items.length > 0;
    empty.textContent = db.items.length ? '該当する品目がありません。' :
      (supportsFolder ? '「フォルダを登録」から、エクセルが入っているフォルダを選んでください。' : '「ファイルを直接選択」からエクセルを読み込んでください。');

    const target = db.items.filter(counted);
    const done = target.filter((i) => (record(ym, i.id) || {}).checked).length;
    const pct = target.length ? Math.round((done / target.length) * 100) : 0;
    $('#progress').innerHTML = `確認済み <strong>${done}</strong> / ${target.length} <span class="bar"><span style="width:${pct}%"></span></span>`;
  }

  monthInput.addEventListener('change', render);
  $('#search').addEventListener('input', render);
  $('#showExcluded').addEventListener('change', render);

  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const ym = monthInput.value;
    if (e.target.matches('.step')) {
      const input = tr.querySelector('.qty-input');
      const base = input.value === '' ? (previousQty(id, ym)?.qty ?? 0) : Number(input.value);
      setRecord(ym, id, { qty: Math.max(0, base + Number(e.target.dataset.step)) });
      render();
    } else if (e.target.matches('.edit, .name-link')) {
      openDialog(db.items.find((i) => i.id === id));
    }
  });

  $('#rows').addEventListener('change', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const ym = monthInput.value;
    if (e.target.matches('.chk')) {
      setRecord(ym, id, { checked: e.target.checked });
    } else if (e.target.matches('.qty-input')) {
      setRecord(ym, id, { qty: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) });
    } else if (e.target.matches('.note-input')) {
      setRecord(ym, id, { note: e.target.value });
      return;
    }
    render();
  });

  // ---------- 詳細ダイアログ ----------
  const dialog = $('#itemDialog');
  const form = $('#itemForm');
  let editingId = null;

  function openDialog(item) {
    editingId = item.id;
    $('#dialogTitle').textContent = item.name;
    $('#excelFields').innerHTML = Object.entries(FIELD_LABELS)
      .filter(([k]) => item[k])
      .map(([k, label]) => `<dt>${label}</dt><dd>${escapeHtml(item[k])}</dd>`).join('');
    const urls = photos.get(item.id) || [];
    $('#photos').innerHTML = urls.map((u, i) => `<a href="${u}" target="_blank" rel="noopener"><img src="${u}" alt="${escapeHtml(item.name)} 写真${i + 1}"></a>`).join('') ||
      (item.photoCount ? '<p class="muted">写真はエクセルを読み込むと表示されます</p>' : '');
    form.reset();
    form.elements.unit.value = item.unit || '';
    form.elements.minQty.value = item.minQty ?? '';
    form.elements.excluded.checked = !!item.excluded;
    $('#forgetItem').hidden = !item.missing;
    dialog.showModal();
  }

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const item = db.items.find((i) => i.id === editingId);
    if (!item) return;
    const f = form.elements;
    item.unit = f.unit.value.trim();
    item.minQty = f.minQty.value === '' ? null : Number(f.minQty.value);
    item.excluded = f.excluded.checked;
    save();
    render();
  });

  $('#forgetItem').addEventListener('click', () => {
    const item = db.items.find((i) => i.id === editingId);
    if (!item || !confirm(`「${item.name}」と過去の記録を削除しますか？`)) return;
    db.items = db.items.filter((i) => i.id !== editingId);
    for (const ym of Object.keys(db.records)) delete db.records[ym][editingId];
    save();
    dialog.close('cancel');
    render();
  });

  // ---------- CSV / 印刷 / バックアップ ----------
  function download(filename, content, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#exportCsv').addEventListener('click', () => {
    const ym = monthInput.value;
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['対象月', '名称', 'メーカー', '型番', '用途', '場所', '購入店', '単位', '前月数量', '今月数量', '増減', '最低在庫数', '確認済み', '対象外', 'メモ'];
    const lines = db.items.filter((i) => !i.missing || record(ym, i.id)).map((it) => {
      const r = record(ym, it.id) || {};
      const prev = previousQty(it.id, ym);
      const hasQty = hasValue(r.qty);
      return [ym, it.name, it.maker, it.model, it.use, it.location, it.store, it.unit, prev ? prev.qty : '',
        hasQty ? r.qty : '', hasQty && prev ? r.qty - prev.qty : '', it.minQty ?? '',
        r.checked ? '済' : '', it.excluded ? '対象外' : '', r.note || ''].map(cell).join(',');
    });
    download(`棚卸し_${ym}.csv`, '﻿' + [header.map(cell).join(','), ...lines].join('\r\n'), 'text/csv');
  });

  $('#print').addEventListener('click', () => window.print());

  $('#backup').addEventListener('click', () => {
    download(`inventory-backup_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db, null, 2), 'application/json');
  });

  $('#restore').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.items) || typeof data.records !== 'object') throw new Error('バックアップの形式ではありません');
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      db = { source: null, ...data };
      save();
      renderSource();
      render();
    } catch (err) {
      alert('復元に失敗しました: ' + err.message);
    }
  });

  // ---------- 起動 ----------
  (async () => {
    render();
    renderSource();
    if (!supportsFolder) {
      showMessage('このブラウザはフォルダの登録に対応していません。Edge または Chrome で開くと、エクセルを自動で読み込めます。', 'info');
    }
    // 前回読み込んだエクセルから写真を復元
    const cachedFile = await idb.get('file');
    if (cachedFile && cachedFile.blob) {
      importFile(cachedFile.blob, { cached: true }).catch(() => {});
    }
    if (!supportsFolder) return;
    dirHandle = (await idb.get('dir')) || null;
    if (!dirHandle) {
      renderSource();
      return;
    }
    const perm = await dirHandle.queryPermission({ mode: 'read' }).catch(() => 'denied');
    if (perm === 'granted') {
      await readFolder(true);
    } else {
      renderSource(true);
      showMessage(`「エクセルを読み込む（許可）」を押すと、フォルダ「${dirHandle.name}」の最新のエクセルを読み込みます。`, isStale() ? 'warn' : 'info');
    }
  })();
})();
