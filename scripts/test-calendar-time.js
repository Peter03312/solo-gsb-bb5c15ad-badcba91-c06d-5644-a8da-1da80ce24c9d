'use strict';
// 日历时间校验的端到端 HTTP 测试（真实服务 + 临时 SQLite 文件）。
//
// 背景：旧实现仅按字符格式（/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/）校验，
// 2026-02-30T09:00（2 月没有 30 日）或 2026-10-01T25:61（25 时 61 分）这类
// 不存在的时刻也能写入，参与事件排序、停机窗口冲突与批次引用先后判断。
//
// 本测试覆盖四个被点名入口与若干同口径时间字段：
//   1. 单条加工/清洗事件新增与更正：不存在的日期/时分秒在写入前 400 拒绝，
//      原事件、窗口与推导结论不变；
//   2. 检修停机窗口登记/调整：起止任一为不存在时刻即 400 拒绝，原窗口不变；
//   3. 断网整包补录：包内任一记录时间非法 -> 整包 400、台账回滚；
//   4. 换线预演：非法时间在预演阶段即拒绝，不写正式数据（apply 同样拒绝）。
// 另验证：分钟写法与带秒写法继续可用且原文保留；闰年按公历判定；
// 合法边界时间（23:59:59、月末、闰日）仍按现有规则执行。
//   node scripts/test-calendar-time.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39168';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-time-test-'));
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

// 期望 400，且错误文案点明“真实存在/不存在/合法时分秒/闰”等日历语义，
// 不能只是笼统的内部错误。
function expectCalendarRejection(name, r) {
  check(name + '：HTTP 400', r.status === 400, r.json);
  const text = JSON.stringify(r.json || {});
  check(
    name + '：错误信息点明日历/时分秒不合法',
    /真实存在|不存在|合法时分秒|闰|日期/.test(text),
    r.json
  );
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
    const LINE = await newId('/api/equipment', { code: 'LINE-A', name: '烘焙A线' });
    const state = async () => (await api('GET', '/api/state')).json;
    let r;

    // ---------- 1. 单条事件：非法日历时间写入前拒绝 ----------
    console.log('1) 单条加工/清洗事件：不存在的日期与时分秒一律拒绝，既有数据不变');
    const before = await state();

    for (const bad of ['2026-02-30T09:00', '2026-10-01T25:61']) {
      r = await api('POST', '/api/events', {
        type: 'PROCESS', event_time: bad, equipment_id: LINE,
        batch_code: 'B-BAD-' + bad, material_ids: [MILK]
      });
      expectCalendarRejection(`加工 ${bad}`, r);
    }
    // 平年没有 2 月 29 日；带秒写法同样拒绝。
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-02-29T08:00:00', equipment_id: LINE, note: '平年闰日清洗'
    });
    expectCalendarRejection('清洗 2026-02-29（2026 平年）', r);
    // 小月 31 日、非法秒。
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-04-31T08:00', equipment_id: LINE
    });
    expectCalendarRejection('清洗 2026-04-31（4 月仅 30 天）', r);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-01T08:00:60', equipment_id: LINE
    });
    expectCalendarRejection('清洗秒 60', r);

    const after = await state();
    check('非法时间均未写入（事件数不变）', after.events.length === before.events.length);
    check('非法时间未产生任何批次', after.batches.length === before.batches.length);

    // 合法闰日（2024 闰年、2000 闰年）与边界秒仍可用；1900 整百年非闰年仍拒绝。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2024-02-29T23:59:59', equipment_id: LINE,
      batch_code: 'B-LEAP-2024', material_ids: [MILK]
    });
    check('2024 闰日 23:59:59（带秒写法）合法写入', r.status === 200, r.json);
    check('带秒原文保留',
      (await state()).events.some((e) => e.event_time === '2024-02-29T23:59:59'));
    const leapId = r.json.id;

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2000-02-29T08:00', equipment_id: LINE,
      batch_code: 'B-LEAP-2000', material_ids: [MILK]
    });
    check('2000-02-29（能被 400 整除的闰年）合法', r.status === 200, r.json);

    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '1900-02-29T08:00', equipment_id: LINE,
      batch_code: 'B-1900', material_ids: [MILK]
    });
    expectCalendarRejection('1900-02-29（整百年非 400 整除，平年）', r);

    // 更正为非法时间：拒绝且原事件时间原文、推导结论不变。
    const beforeCorr = await state();
    r = await api('PUT', `/api/events/${leapId}`, {
      type: 'PROCESS', event_time: '2024-02-30T10:00', equipment_id: LINE,
      batch_code: 'B-LEAP-2024', material_ids: [MILK]
    });
    expectCalendarRejection('更正为 2024-02-30', r);
    const afterCorr = await state();
    check('被拒更正不改时间原文',
      afterCorr.events.some((e) => e.id === leapId && e.event_time === '2024-02-29T23:59:59'));
    check('被拒更正不改推导结论（批次过敏原快照一致）',
      JSON.stringify(beforeCorr.batches.map((b) => [b.code, b.allergens])) ===
      JSON.stringify(afterCorr.batches.map((b) => [b.code, b.allergens])));

    // ---------- 2. 检修停机窗口：非法起止时间拒绝，原窗口不变 ----------
    console.log('2) 停机窗口：起止为不存在时刻整次拒绝；合法窗口仍可登记');
    const winBefore = (await api('GET', '/api/downtime-windows')).json.length;

    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE, start_time: '2026-02-30T08:00', end_time: '2026-02-30T12:00',
      reason: '不存在的日期检修', operator: 'tester'
    });
    expectCalendarRejection('窗口起点 2026-02-30', r);
    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE, start_time: '2026-10-01T08:00', end_time: '2026-10-01T25:61',
      reason: '非法终点', operator: 'tester'
    });
    expectCalendarRejection('窗口终点 25:61', r);
    check('非法窗口均未登记',
      (await api('GET', '/api/downtime-windows')).json.length === winBefore);

    // 合法窗口（带秒写法）登记成功。
    r = await api('POST', '/api/downtime-windows', {
      equipment_id: LINE, start_time: '2026-03-01T08:00:00', end_time: '2026-03-01T12:00:00',
      reason: '合法检修', operator: 'tester'
    });
    check('合法窗口登记成功', r.status === 200, r.json);
    const winId = r.json.id;
    check('窗口时间原文保留两种写法',
      r.json.start_time === '2026-03-01T08:00:00' && r.json.end_time === '2026-03-01T12:00:00');

    // 调整为非法时间：拒绝、原窗口不变。
    r = await api('PUT', `/api/downtime-windows/${winId}`, {
      equipment_id: LINE, start_time: '2026-13-01T08:00', end_time: '2026-03-01T12:00',
      reason: '非法月份', operator: 'tester'
    });
    expectCalendarRejection('窗口调整为 13 月', r);
    const winStill = (await api('GET', `/api/downtime-windows/${winId}`)).json;
    check('被拒调整不改原窗口', winStill.start_time === '2026-03-01T08:00:00');

    // ---------- 3. 断网整包补录：任一记录时间非法 -> 整包回滚 ----------
    console.log('3) 断网补录：包内非法日历时间整包拒绝、台账回滚；合法包成功');
    const beforeBf = await state();
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CAL-1',
      records: [
        { external_ref: 'OK1', type: 'PROCESS', event_time: '2026-05-01T08:00',
          equipment_id: LINE, batch_code: 'BF-CAL-B1', material_ids: [MILK] },
        // 第二条是不存在的日期：整包都不能落库。
        { external_ref: 'BAD1', type: 'CLEAN', event_time: '2026-02-30T09:00',
          equipment_id: LINE, note: '不存在的日期' }
      ]
    });
    expectCalendarRejection('含 2026-02-30 的补录包', r);
    const afterBf = await state();
    check('整包回滚：事件数不变', afterBf.events.length === beforeBf.events.length);
    check('整包回滚：合法首条也未落批次',
      !afterBf.batches.some((b) => b.code === 'BF-CAL-B1'));
    r = await api('GET', '/api/backfills/BF-CAL-1');
    check('整包回滚：补录台账不存在（404）', r.status === 404);

    // 非法时分秒补录包同样整包拒绝。
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CAL-2',
      records: [
        { external_ref: 'X1', type: 'CLEAN', event_time: '2026-05-02T25:61', equipment_id: LINE }
      ]
    });
    expectCalendarRejection('含 25:61 的补录包', r);
    check('BF-CAL-2 台账不存在',
      (await api('GET', '/api/backfills/BF-CAL-2')).status === 404);

    // 合法补录包（分钟/带秒混写、月末边界）成功。
    r = await api('POST', '/api/backfills', {
      backfill_code: 'BF-CAL-OK',
      records: [
        { external_ref: 'S1', type: 'CLEAN', event_time: '2026-05-31T23:59', equipment_id: LINE,
          note: '月末分钟写法' },
        { external_ref: 'S2', type: 'CLEAN', event_time: '2026-06-01T00:00:00', equipment_id: LINE,
          note: '次月零点带秒写法' }
      ]
    });
    check('合法补录包成功', r.status === 200, r.json);
    check('合法补录写入 2 条事件', r.json.impact_summary && r.json.impact_summary.inserted_events === 2,
      r.json.impact_summary);

    // ---------- 4. 换线预演：非法时间预演即拒绝，不写正式数据 ----------
    console.log('4) 换线预演/确认：非法日历时间在预演阶段拒绝，正式数据不变');
    const beforeReplan = await state();
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: leapId, type: 'PROCESS',
          event_time: '2026-02-30T09:00', equipment_id: LINE,
          batch_code: 'B-LEAP-2024', material_ids: [MILK] }
      ]
    });
    expectCalendarRejection('预演更正为 2026-02-30', r);
    const afterReplan = await state();
    const leapStill = afterReplan.events.find((e) => e.id === leapId);
    check('预演拒绝不改正式事件（仍 2024-02-29T23:59:59）',
      leapStill && leapStill.event_time === '2024-02-29T23:59:59');
    check('预演拒绝不产生事件集变化',
      afterReplan.events.length === beforeReplan.events.length);

    // 拟插入清洗为非法时间：预演拒绝。
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'insert_clean', event_time: '2026-10-01T25:61', equipment_id: LINE,
          client_key: 'c1', note: '非法插入清洗' }
      ]
    });
    expectCalendarRejection('预演插入 25:61 清洗', r);

    // 即使绕过预演直接 apply（伪造 version），非法时间仍在写入前拒绝。
    r = await api('POST', '/api/replan/apply', {
      version: 'bogus-version-token',
      changes: [
        { op: 'update', event_id: leapId, type: 'PROCESS',
          event_time: '2026-02-30T09:00', equipment_id: LINE,
          batch_code: 'B-LEAP-2024', material_ids: [MILK] }
      ]
    });
    check('直接 apply 非法时间仍拒绝（400）', r.status === 400, r.json);
    const leapAfterApply = (await state()).events.find((e) => e.id === leapId);
    check('apply 拒绝后正式事件不变',
      leapAfterApply && leapAfterApply.event_time === '2024-02-29T23:59:59');

    // 合法预演（把事件更正为另一合法时刻）仍可成功并确认应用。
    r = await api('POST', '/api/replan/preview', {
      changes: [
        { op: 'update', event_id: leapId, type: 'PROCESS',
          event_time: '2024-02-29T23:58', equipment_id: LINE,
          batch_code: 'B-LEAP-2024', material_ids: [MILK] }
      ]
    });
    check('合法预演成功', r.status === 200, r.json);
    const version = r.json.version;
    r = await api('POST', '/api/replan/apply', {
      version,
      changes: [
        { op: 'update', event_id: leapId, type: 'PROCESS',
          event_time: '2024-02-29T23:58', equipment_id: LINE,
          batch_code: 'B-LEAP-2024', material_ids: [MILK] }
      ]
    });
    check('合法确认应用成功', r.status === 200, r.json);
    check('应用后正式时间更新（分钟写法原文保留）',
      (await state()).events.some((e) => e.id === leapId && e.event_time === '2024-02-29T23:58'));

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
