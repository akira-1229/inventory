// 最小限の .xlsx 読み取り（外部ライブラリなし）
// 先頭（または指定）シートのセル値と、セル内に配置された画像（Excel の「セルに配置」）を取り出す。
// ブラウザ標準の DecompressionStream を使うため Edge / Chrome / Firefox / Safari の現行版で動作。
window.XlsxReader = (() => {
  'use strict';

  // ---------- ZIP ----------
  async function unzip(buffer) {
    const dv = new DataView(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Excel（.xlsx）ファイルとして読み込めませんでした');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP の構造が壊れています');
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = dec.decode(new Uint8Array(buffer, p + 46, nameLen));
      entries.set(name, { method, compSize, localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    async function read(name) {
      const e = entries.get(name);
      if (!e) return null;
      const start = e.localOff + 30 + dv.getUint16(e.localOff + 26, true) + dv.getUint16(e.localOff + 28, true);
      const raw = new Uint8Array(buffer, start, e.compSize);
      if (e.method === 0) return raw.slice();
      if (e.method !== 8) throw new Error('未対応の圧縮形式です');
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return { read, has: (n) => entries.has(n) };
  }

  // ---------- XML ヘルパー ----------
  async function xml(zip, path) {
    const bytes = await zip.read(path);
    return bytes ? new DOMParser().parseFromString(new TextDecoder().decode(bytes), 'application/xml') : null;
  }
  const all = (node, tag) => (node ? Array.from(node.getElementsByTagNameNS('*', tag)) : []);
  const first = (node, tag) => all(node, tag)[0] || null;

  function resolve(base, target) {
    if (target.startsWith('/')) return target.slice(1);
    const parts = base.split('/').slice(0, -1);
    for (const seg of target.split('/')) {
      if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg);
    }
    return parts.join('/');
  }
  async function rels(zip, partPath) {
    const i = partPath.lastIndexOf('/');
    const relPath = `${partPath.slice(0, i)}/_rels/${partPath.slice(i + 1)}.rels`;
    const doc = await xml(zip, relPath);
    const map = new Map();
    for (const r of all(doc, 'Relationship')) {
      map.set(r.getAttribute('Id'), { type: r.getAttribute('Type') || '', target: resolve(partPath, r.getAttribute('Target')) });
    }
    return map;
  }

  // 共有文字列（ふりがな rPh は除外）
  function siText(si) {
    let s = '';
    for (const t of all(si, 't')) {
      let p = t.parentNode, phonetic = false;
      while (p && p !== si) { if (p.localName === 'rPh') { phonetic = true; break; } p = p.parentNode; }
      if (!phonetic) s += t.textContent;
    }
    return s;
  }

  function colIndex(ref) {
    let n = 0;
    for (const ch of ref.replace(/[0-9]/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  const MIME = { jpeg: 'image/jpeg', jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' };

  // セル内画像: vm → metadata → rdrichvalue → richValueRel → 画像ファイル
  async function loadCellImages(zip, wbRels) {
    const find = (suffix) => [...wbRels.values()].find((r) => r.type.endsWith(suffix));
    const metaRel = find('/sheetMetadata');
    const rvRel = find('/rdRichValue');
    const rvRelRel = find('/richValueRel');
    if (!metaRel || !rvRel || !rvRelRel) return null;

    const meta = await xml(zip, metaRel.target);
    const types = all(first(meta, 'metadataTypes'), 'metadataType').map((t) => t.getAttribute('name'));
    const future = all(meta, 'futureMetadata').find((f) => f.getAttribute('name') === 'XLRICHVALUE');
    const futureIdx = future ? all(future, 'bk').map((bk) => Number(first(bk, 'rvb')?.getAttribute('i'))) : [];
    const valueMeta = all(first(meta, 'valueMetadata'), 'bk').map((bk) => {
      const rc = first(bk, 'rc');
      return types[Number(rc.getAttribute('t')) - 1] === 'XLRICHVALUE' ? futureIdx[Number(rc.getAttribute('v'))] : null;
    });

    // 構造ごとの LocalImageIdentifier の位置
    const structRel = find('/rdRichValueStructure');
    const structs = structRel ? all(await xml(zip, structRel.target), 's').map((s) =>
      all(s, 'k').findIndex((k) => k.getAttribute('n') === '_rvRel:LocalImageIdentifier')) : [];
    const richValues = all(await xml(zip, rvRel.target), 'rv').map((rv) => {
      const pos = structs[Number(rv.getAttribute('s'))] ?? 0;
      const v = all(rv, 'v')[pos < 0 ? 0 : pos];
      return pos < 0 || !v ? null : Number(v.textContent);
    });

    const relDoc = await xml(zip, rvRelRel.target);
    const relTargets = await rels(zip, rvRelRel.target);
    const relList = all(relDoc, 'rel').map((r) =>
      relTargets.get(r.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || r.getAttribute('r:id')));

    const cache = new Map();
    return async (vm) => {
      const rvIndex = valueMeta[vm - 1];
      if (rvIndex == null) return null;
      const relIndex = richValues[rvIndex];
      const target = relIndex == null ? null : relList[relIndex];
      if (!target) return null;
      if (!cache.has(target.target)) {
        const bytes = await zip.read(target.target);
        const ext = target.target.split('.').pop().toLowerCase();
        cache.set(target.target, bytes ? new Blob([bytes], { type: MIME[ext] || 'application/octet-stream' }) : null);
      }
      return cache.get(target.target);
    };
  }

  /**
   * @returns {Promise<{sheetName:string, rows:Array<Array<{value:string|null, image:Blob|null}>>}>}
   */
  async function read(arrayBuffer, sheetName) {
    const zip = await unzip(arrayBuffer);
    const wbPath = 'xl/workbook.xml';
    const wb = await xml(zip, wbPath);
    if (!wb) throw new Error('Excel（.xlsx）ファイルではありません');
    const wbRels = await rels(zip, wbPath);
    const sheets = all(wb, 'sheet');
    const sheet = (sheetName && sheets.find((s) => s.getAttribute('name') === sheetName)) || sheets[0];
    if (sheetName && sheet.getAttribute('name') !== sheetName) throw new Error(`シート「${sheetName}」が見つかりません`);
    const rid = sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheet.getAttribute('r:id');
    const sheetPath = wbRels.get(rid).target;

    const sstRel = [...wbRels.values()].find((r) => r.type.endsWith('/sharedStrings'));
    const sst = sstRel ? all(await xml(zip, sstRel.target), 'si').map(siText) : [];
    const imageFor = await loadCellImages(zip, wbRels);

    const doc = await xml(zip, sheetPath);
    const rows = [];
    for (const row of all(doc, 'row')) {
      const r = Number(row.getAttribute('r')) - 1;
      const cells = [];
      for (const c of all(row, 'c')) {
        const ci = colIndex(c.getAttribute('r'));
        const t = c.getAttribute('t');
        const v = first(c, 'v');
        let value = null;
        if (t === 's') value = v ? sst[Number(v.textContent)] ?? null : null;
        else if (t === 'inlineStr') value = siText(first(c, 'is'));
        else if (t === 'b') value = v ? (v.textContent === '1' ? 'TRUE' : 'FALSE') : null;
        else if (t === 'e') value = null; // #VALUE! など（セル内画像もここ）
        else value = v ? v.textContent : null;
        const vm = c.getAttribute('vm');
        const image = vm && imageFor ? await imageFor(Number(vm)) : null;
        if (value !== null || image) cells[ci] = { value, image };
      }
      if (cells.length) rows[r] = cells;
    }
    return { sheetName: sheet.getAttribute('name'), rows };
  }

  return { read };
})();
