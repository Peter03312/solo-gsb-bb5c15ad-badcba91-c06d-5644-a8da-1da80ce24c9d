'use strict';
// 时间写法（分钟精度 09:00 与带秒 09:00:00）按“实际时刻”判定的端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务（空白库，自建数据），验证四条写入路径：
//   1. 单条事件新增/更正：同设备同刻异写冲突整次拒绝（不改事件、不重算结论）；
//      合法的异时刻更正仍按原规则重算；既有两种写法继续可用、原文保留。
//   2. 断网整包补录：包内同刻引用不属“严格更早”，整包拒绝、不写台账；
//      同号同内容重试（含写法差异）沿用既有幂等约定。
//   3. 换线预演：把事件改成与同设备另一事件同刻（异写）-> 预演拒绝、不写正式数据。
//   4. 批次引用先后：引用批次产出时间为同刻异写时，引用事件整次拒绝。
//   node scripts/test-time-instants.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39167';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'time-instants-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error('  ✗ ' + name, extra !== undefined ? JSON.stringify(extra) : '');
  }
}

async function api(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try { json = await res.json(); } catch (_) { /* 非 JSON */ }
  return { status: res.status, json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/state');
      if (res.ok) return;
    } catch (_) { /* 未就绪 */ }
    if (proc.exitCode !== null) throw new Error('服务提前退出');
    await sleep(250);
  }
  throw new Error('服务启动超时');
}

async function main() {
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'false' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    const newId = async (url, body) => (await api('POST', url, body)).json.id;
    const MILK = await newId('/api/materials', { code: 'MILK', name: '全脂奶粉', allergens: ['乳'] });
    const EGG = await newId('/api/materials', { code: 'EGG', name: '全蛋液', allergens: ['蛋'] });
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '烘焙A线' });
    const LINE2 = await newId('/api/equipment', { code: 'LINE-B', name: '烘焙B线' });
    const state = async () => (await api('GET', '/api/state')).json;
    let r;

    // ---------- 1. 单条新增：两种写法都可用，同设备同刻异写冲突 ----------
    console.log('1) 单条新增：分钟写法与带秒写法均可用；同设备同刻异写整次拒绝');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T08:00', equipment_id: LINE,
      batch_code: 'B-MORNING', material_ids: [MILK]
    });
    check('分钟写法加工成功', r.status === 200, r.json);
    const procMorningId = r.json.id;

    // 与上一条同设备、同一实际时刻，但用带秒写法：必须拒绝（旧逻辑会放行）。
    const before = await state();
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T08:00:00', equipment_id: LINE, note: '同刻清洗'
    });
    check('同设备同刻（异写）清洗被拒绝 400', r.status === 400, r.json);
    check(
      '拒绝原因点明同设备同刻',
      r.json && Array.isArray(r.json.details) &&
        r.json.details.some((d) => d.includes('时间冲突')),
      r.json
    );
    const after = await state();
    check('整次拒绝：事件数不变', after.events.length === before.events.length);
    check('整次拒绝：既有事件时间文本保持原样',
      after.events.some((e) => e.id === procMorningId && e.event_time === '2026-10-01T08:00'));

    // 同刻但不同设备：允许（冲突只按同设备判定）。
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T08:00:00', equipment_id: LINE2, note: '另一设备同刻清洗'
    });
    check('同刻异设备允许', r.status === 200, r.json);
    check('带秒写法原文保留',
      (await state()).events.some((e) => e.event_time === '2026-10-01T08:00:00'));

    // 同文本同刻同样拒绝（原有行为不回退）。
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T08:00', equipment_id: LINE, note: '同文同刻'
    });
    check('同设备同刻（同文）仍拒绝', r.status === 400, r.json);

    // ---------- 2. 批次引用先后：同刻异写不算“严格更早” ----------
    console.log('2) 批次引用：引用同刻（异写）产出的批次整次拒绝');
    // 前序批次 09:00（分钟写法，设备 LINE2，避免与 08:00 冲突）。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00', equipment_id: LINE2,
      batch_code: 'B-BASE', material_ids: [EGG]
    });
    check('前序批次加工成功', r.status === 200, r.json);
    const st = await state();
    const baseBatch = st.batches.find((b) => b.code === 'B-BASE');
    check('找到前序批次', !!baseBatch);

    // 引用方 09:00:00（带秒）= 同一实际时刻：引用必须严格更早，故拒绝。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00:00', equipment_id: LINE,
      batch_code: 'B-SAME-INSTANT', material_ids: [MILK], ref_batch_ids: [baseBatch.id]
    });
    check('引用同刻异写批次被拒绝', r.status === 400, r.json);
    check(
      '拒绝原因点明同时刻',
      r.json && Array.isArray(r.json.details) &&
        r.json.details.some((d) => d.includes('同时刻')),
      r.json
    );

    // 异时刻（严格晚 1 秒）引用：合法，按原规则接受并重算（含设备残留并入）。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T09:00:01', equipment_id: LINE,
      batch_code: 'B-AFTER', material_ids: [MILK], ref_batch_ids: [baseBatch.id]
    });
    check('异时刻（晚 1 秒）引用合法', r.status === 200, r.json);
    const st2 = await state();
    const afterBatch = st2.batches.find((b) => b.code === 'B-AFTER');
    check('合法引用批次过敏原并入引用批次（蛋）',
      afterBatch && afterBatch.allergens.includes('蛋'), afterBatch);

    // ---------- 3. 单条更正：改成同刻异写拒绝且结论不变；合法异时更正重算 ----------
    console.log('3) 单条更正：同刻异写更正整次拒绝；合法异时更正仍重算');
    // LINE 上 B-MORNING 是 08:00；在 LINE 上再放一条 10:00 的加工。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-01T10:00', equipment_id: LINE,
      batch_code: 'B-TEN', material_ids: [EGG]
    });
    check('10:00 加工成功', r.status === 200, r.json);
    const tenId = r.json.id;

    // 把 10:00 更正为 08:00:00（与 B-MORNING 同刻异写）：拒绝。
    const beforeCorr = await state();
    r = await api('PUT', `/api/events/${tenId}`, {
      type: 'PROCESS', event_time: '2026-10-01T08:00:00', equipment_id: LINE,
      batch_code: 'B-TEN', material_ids: [EGG]
    });
    check('更正为同刻异写被拒绝', r.status === 400, r.json);
    const afterCorr = await state();
    const tenStill = afterCorr.events.find((e) => e.id === tenId);
    check('被拒更正不改变事件时间原文', tenStill && tenStill.event_time === '2026-10-01T10:00');
    check('被拒更正不产生放行失效等结论变化',
      JSON.stringify(beforeCorr.batches.map((b) => [b.code, b.allergens])) ===
      JSON.stringify(afterCorr.batches.map((b) => [b.code, b.allergens])));

    // 合法的异时刻更正（11:00，仍晚于引用相关事件）：接受并重算。
    r = await api('PUT', `/api/events/${tenId}`, {
      type: 'PROCESS', event_time: '2026-10-01T11:00', equipment_id: LINE,
      batch_code: 'B-TEN', material_ids: [EGG]
    });
    check('合法异时更正接受', r.status === 200, r.json);
    check('更正后时间为新文本',
      (await state()).events.some((e) => e.id === tenId && e.event_time === '2026-10-01T11:00'));

    // ---------- 4. 断网整包补录：包内同刻异写引用整包拒绝 ----------
    console.log('4) 断网补录：包内同刻引用整包回滚；同号同内容重试幂等');
    const backfillSameInstant = {
      backfill_code: 'BF-TIME-1',
      records: [
        { external_ref: 'R1', type: 'PROCESS', event_time: '2026-10-02T08:00',
          equipment_id: LINE, batch_code: 'BF-B1', material_ids: [MILK] },
        // R2 与 R1 同刻（带秒写法），却引用 R1 产出：必须拒绝（不属严格更早）。
        { external_ref: 'R2', type: 'PROCESS', event_time: '2026-10-02T08:00:00',
          equipment_id: LINE2, batch_code: 'BF-B2', material_ids: [EGG],
          ref_batch_codes: ['BF-B1'] }
      ]
    };
    const beforeBf = await state();
    r = await api('POST', '/api/backfills', backfillSameInstant);
    check('同刻包内引用整包拒绝', r.status === 400, r.json);
    check(
      '拒绝原因含“不严格早于/同一实际时刻”',
      r.json && Array.isArray(r.json.details) &&
        r.json.details.some((d) => d.includes('严格早于') || d.includes('同一实际时刻')),
      r.json
    );
    const afterBf = await state();
    check('整包回滚：事件数不变', afterBf.events.length === beforeBf.events.length);
    r = await api('GET', '/api/backfills/BF-TIME-1');
    check('整包回滚：补录批号台账不存在（404）', r.status === 404);

    // 合法补录包（R2 晚 1 分钟）成功。
    const backfillOk = {
      backfill_code: 'BF-TIME-2',
      records: [
        { external_ref: 'S1', type: 'PROCESS', event_time: '2026-10-02T08:00',
          equipment_id: LINE, batch_code: 'BF-OK-1' },
        { external_ref: 'S2', type: 'CLEAN', event_time: '2026-10-02T08:30:00',
          equipment_id: LINE, note: '带秒写法清洗' },
        { external_ref: 'S3', type: 'PROCESS', event_time: '2026-10-02T09:00',
          equipment_id: LINE, batch_code: 'BF-OK-2', material_ids: [MILK],
          ref_batch_codes: ['BF-OK-1'] }
      ]
    };
    r = await api('POST', '/api/backfills', backfillOk);
    check('合法补录包成功', r.status === 200, r.json);
    const firstOk = r.json;
    check('补录写入 3 条事件', firstOk.impact_summary && firstOk.impact_summary.inserted_events === 3,
      firstOk.impact_summary);
    // 同号同内容重试：原样幂等返回（把写法改成等同时刻的另一写法不属于“同内容”，
    // 这里按完全相同的报文重试，验证既定幂等约定不变）。
    r = await api('POST', '/api/backfills', backfillOk);
    check('同号同内容重试幂等', r.status === 200 && r.json.idempotent === true, r.json);

    // ---------- 5. 换线预演/确认：同刻异写的更正预演即拒绝 ----------
    console.log('5) 换线预演：改成同设备同刻（异写）的更正被拒绝，不写正式数据');
    // LINE 上 08:00 已有 B-MORNING；预演把 11:00 的 B-TEN 改成 08:00:00（同刻异写）。
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: tenId, type: 'PROCESS',
          event_time: '2026-10-01T08:00:00', equipment_id: LINE,
          batch_code: 'B-TEN', material_ids: [EGG] }
      ]
    });
    check('同刻异写预演拒绝', r.status === 400, r.json);
    check(
      '预演拒绝含时间冲突',
      r.json && Array.isArray(r.json.details) && r.json.details.some((d) => d.includes('时间冲突')),
      r.json
    );
    const afterPrev = await state();
    const tenAfterPreview = afterPrev.events.find((e) => e.id === tenId);
    check('预演拒绝不改变正式事件（仍 11:00）',
      tenAfterPreview && tenAfterPreview.event_time === '2026-10-01T11:00');

    // 合法预演（把 11:00 改为 12:00）成功并可确认，应用后按原规则重算。
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: tenId, type: 'PROCESS',
          event_time: '2026-10-01T12:00', equipment_id: LINE,
          batch_code: 'B-TEN', material_ids: [EGG] }
      ]
    });
    check('合法异时预演成功', r.status === 200, r.json);
    const version = r.json.version;
    r = await api('POST', '/api/replan/apply', {
      version,
      changes: [
        { op: 'update', event_id: tenId, type: 'PROCESS',
          event_time: '2026-10-01T12:00', equipment_id: LINE,
          batch_code: 'B-TEN', material_ids: [EGG] }
      ]
    });
    check('合法异时确认应用成功', r.status === 200, r.json);
    check('应用后事件时间更新为 12:00',
      (await state()).events.some((e) => e.id === tenId && e.event_time === '2026-10-01T12:00'));

  } finally {
    proc.kill();
  }

  if (failures) {
    console.error(`\n${failures} 项检查失败`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error('测试执行异常：', err);
  process.exit(1);
});
