(() => {
  'use strict';

  const STORAGE_KEY = 'inventory.v1';
  const $ = (sel) => document.querySelector(sel);

  // ---------- データ ----------
  // { items: [{id,name,category,location,unit,minQty,note}],
  //   records: { 'YYYY-MM': { [itemId]: {qty, checked, note, updatedAt} } } }
  let db = load();

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        if (data && Array.isArray(data.items) && data.records) return data;
      }
    } catch (e) { /* 読み込み失敗時は初期データ */ }
    return {
      items: (window.SEED_ITEMS || []).map((it) => ({ id: newId(), ...it })),
      records: {},
    };
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    } catch (e) {
      alert('保存に失敗しました。ブラウザの設定を確認してください。');
    }
  }

  function thisMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  // 指定月より前で最も新しい記録数量（前回の棚卸し値）
  function previousQty(itemId, ym) {
    const months = Object.keys(db.records).filter((k) => k < ym).sort().reverse();
    for (const k of months) {
      const r = db.records[k][itemId];
      if (r && r.qty !== null && r.qty !== undefined && r.qty !== '') return { qty: r.qty, month: k };
    }
    return null;
  }

  function record(ym, itemId) {
    return (db.records[ym] && db.records[ym][itemId]) || null;
  }

  function setRecord(ym, itemId, patch) {
    db.records[ym] = db.records[ym] || {};
    const cur = db.records[ym][itemId] || { qty: null, checked: false, note: '' };
    db.records[ym][itemId] = { ...cur, ...patch, updatedAt: new Date().toISOString() };
    save();
  }

  // ---------- 描画 ----------
  const monthInput = $('#month');
  monthInput.value = thisMonth();

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function uniq(key) {
    return [...new Set(db.items.map((i) => i[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  function fillSelect(sel, values, allLabel) {
    const current = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>` +
      values.map((v) => `<option>${escapeHtml(v)}</option>`).join('');
    sel.value = values.includes(current) ? current : '';
  }

  function refreshFilters() {
    fillSelect($('#filterLocation'), uniq('location'), 'すべての保管場所');
    fillSelect($('#filterCategory'), uniq('category'), 'すべてのカテゴリ');
    $('#categoryList').innerHTML = uniq('category').map((v) => `<option value="${escapeHtml(v)}">`).join('');
    $('#locationList').innerHTML = uniq('location').map((v) => `<option value="${escapeHtml(v)}">`).join('');
  }

  function visibleItems() {
    const q = $('#search').value.trim().toLowerCase();
    const loc = $('#filterLocation').value;
    const cat = $('#filterCategory').value;
    return db.items.filter((i) =>
      (!q || i.name.toLowerCase().includes(q)) &&
      (!loc || i.location === loc) &&
      (!cat || i.category === cat));
  }

  function render() {
    const ym = monthInput.value || thisMonth();
    const items = visibleItems();
    const tbody = $('#rows');
    tbody.innerHTML = items.map((it) => {
      const r = record(ym, it.id) || {};
      const prev = previousQty(it.id, ym);
      const hasQty = r.qty !== null && r.qty !== undefined && r.qty !== '';
      const diff = hasQty && prev ? r.qty - prev.qty : null;
      const low = hasQty && it.minQty !== null && it.minQty !== '' && it.minQty !== undefined && r.qty < it.minQty;
      const unit = escapeHtml(it.unit || '');
      return `
        <tr data-id="${it.id}" class="${r.checked ? 'checked' : ''} ${low ? 'low' : ''}">
          <td class="col-check" data-label="確認"><input type="checkbox" class="chk" ${r.checked ? 'checked' : ''} aria-label="${escapeHtml(it.name)}を確認済みにする"></td>
          <td class="name" data-label="品名">${escapeHtml(it.name)}${low ? ' <span class="badge">要補充</span>' : ''}</td>
          <td data-label="カテゴリ">${escapeHtml(it.category)}</td>
          <td data-label="保管場所">${it.location ? escapeHtml(it.location) : '<span class="muted">未設定</span>'}</td>
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
          <td class="no-print"><button type="button" class="edit link">編集</button></td>
        </tr>`;
    }).join('');
    $('#empty').hidden = items.length > 0;

    const total = db.items.length;
    const done = db.items.filter((i) => (record(ym, i.id) || {}).checked).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('#progress').innerHTML = `確認済み <strong>${done}</strong> / ${total} <span class="bar"><span style="width:${pct}%"></span></span>`;
  }

  // ---------- イベント ----------
  monthInput.addEventListener('change', render);
  ['#search', '#filterLocation', '#filterCategory'].forEach((s) => $(s).addEventListener('input', render));

  $('#rows').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const id = tr.dataset.id;
    const ym = monthInput.value;
    if (e.target.matches('.step')) {
      const input = tr.querySelector('.qty-input');
      const base = input.value === '' ? (previousQty(id, ym)?.qty ?? 0) : Number(input.value);
      const next = Math.max(0, base + Number(e.target.dataset.step));
      setRecord(ym, id, { qty: next });
      render();
    } else if (e.target.matches('.edit')) {
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
      const v = e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value)));
      setRecord(ym, id, { qty: v });
    } else if (e.target.matches('.note-input')) {
      setRecord(ym, id, { note: e.target.value });
      return;
    }
    render();
  });

  // 品目ダイアログ
  const dialog = $('#itemDialog');
  const form = $('#itemForm');
  let editingId = null;

  function openDialog(item) {
    editingId = item ? item.id : null;
    $('#dialogTitle').textContent = item ? '品目を編集' : '品目を追加';
    $('#deleteItem').hidden = !item;
    form.reset();
    if (item) {
      for (const k of ['name', 'category', 'location', 'unit', 'minQty', 'note']) {
        form.elements[k].value = item[k] ?? '';
      }
    }
    dialog.showModal();
  }

  $('#addItem').addEventListener('click', () => openDialog(null));

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const f = form.elements;
    const data = {
      name: f.name.value.trim(),
      category: f.category.value.trim(),
      location: f.location.value.trim(),
      unit: f.unit.value.trim(),
      minQty: f.minQty.value === '' ? null : Number(f.minQty.value),
      note: f.note.value.trim(),
    };
    if (!data.name) return;
    if (editingId) {
      Object.assign(db.items.find((i) => i.id === editingId), data);
    } else {
      db.items.push({ id: newId(), ...data });
    }
    save();
    refreshFilters();
    render();
  });

  $('#deleteItem').addEventListener('click', () => {
    const item = db.items.find((i) => i.id === editingId);
    if (!item || !confirm(`「${item.name}」を削除しますか？（過去の記録も削除されます）`)) return;
    db.items = db.items.filter((i) => i.id !== editingId);
    for (const ym of Object.keys(db.records)) delete db.records[ym][editingId];
    save();
    dialog.close('cancel');
    refreshFilters();
    render();
  });

  // CSV / 印刷 / バックアップ
  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  $('#exportCsv').addEventListener('click', () => {
    const ym = monthInput.value;
    const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['対象月', '品名', 'カテゴリ', '保管場所', '単位', '前月数量', '今月数量', '増減', '最低在庫数', '確認済み', 'メモ'];
    const lines = db.items.map((it) => {
      const r = record(ym, it.id) || {};
      const prev = previousQty(it.id, ym);
      const hasQty = r.qty !== null && r.qty !== undefined;
      return [ym, it.name, it.category, it.location, it.unit, prev ? prev.qty : '', hasQty ? r.qty : '',
        hasQty && prev ? r.qty - prev.qty : '', it.minQty ?? '', r.checked ? '済' : '', r.note || ''].map(csvCell).join(',');
    });
    // Excel で文字化けしないよう BOM 付き
    download(`棚卸し_${ym}.csv`, '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n'), 'text/csv');
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
      if (!Array.isArray(data.items) || typeof data.records !== 'object') throw new Error('形式が違います');
      if (!confirm('現在のデータをバックアップの内容で置き換えます。よろしいですか？')) return;
      db = data;
      save();
      refreshFilters();
      render();
    } catch (err) {
      alert('復元に失敗しました: ' + err.message);
    }
  });

  save();
  refreshFilters();
  render();
})();
