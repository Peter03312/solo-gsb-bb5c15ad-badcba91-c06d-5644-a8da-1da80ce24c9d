'use strict';
// 隔离令联动评估状态版本（本轮修复）：端到端 HTTP 测试。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   签发隔离令：原本已待评估的出货单同样推进状态版本；变化前查询取得的版本
//     提交召回/继续流转均 409 VERSION_EXPIRED 且不产生处置记录；
//   解除隔离令：批次脱离生效令后旧版本仍不能提交（含继续流转），须重新查询；
//   事件更正使批次脱离生效范围：旧版本同样 409 VERSION_EXPIRED；
//   重新查询后按最新隔离状态判断：隔离期间只能召回，脱离全部生效令后按原条件
//     判断继续流转（可落账）；
//   未受影响出货单的版本不无故失效（他批隔离令签发/解除后旧版本仍可用）。
//   node scripts/test-quarantine-version.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39161';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quar-version-test-'));
const dbPath = path.join(tmpDir, 'test.db');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures += 1;
    console.error(`  ✗ ${name}`, extra !== undefined ? JSON.stringify(extra) : '');
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
    env: { ...process.env, PORT, HOST: '127.0.0.1', DB_PATH: dbPath, SEED_DEMO: 'true' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

  try {
    await waitReady(proc);
    console.log('服务已就绪，开始测试');

    let r;
    const state = () => api('GET', '/api/state').then((x) => x.json);
    const evalOf = (code) => api('GET', `/api/shipments/${code}/evaluation`).then((x) => x.json);
    const submit = (code, body) => api('POST', `/api/shipments/${code}/dispositions`, body);

    const st0 = await state();
    const MILK = st0.materials.find((m) => m.code === 'MILK-01').id;
    const SALT = st0.materials.find((m) => m.code === 'SALT-01').id;
    const lotId = (code) =>
      st0.materials.flatMap((m) => m.lots).find((l) => l.lot_code === code).id;
    const MILK_A = lotId('SUP-MILK-20260925-A');
    const MILK_B = lotId('SUP-MILK-20260926-B');
    const LINE_A = st0.equipment.find((q) => q.code === 'LINE-A').id;
    const FRYER_B = st0.equipment.find((q) => q.code === 'FRYER-B').id;
    const B3 = st0.batches.find((b) => b.code === 'BATCH-003').id;
    const REL1 = st0.batches.find((b) => b.code === 'BATCH-003')
      .releases.find((x) => x.status === 'ACTIVE').id;

    // ---------- 1. 签发隔离令：原本已待评估的单据版本同样推进 ----------
    console.log('1) 已待评估单查询后签发隔离令：旧版本提交召回/继续流转均 409 VERSION_EXPIRED');
    r = await api('DELETE', `/api/releases/${REL1}`);
    check('删除放行：LABEL-0001 停用、SHIP-0001 转待评估（版本 0→1）',
      r.status === 200 &&
      r.json.pending_shipments.some((s) => s.shipment_code === 'SHIP-0001'), r.json);
    let ev = await evalOf('SHIP-0001');
    check('待评估、状态版本 1、无历史结论',
      ev.review.pending_review === true && ev.status_version === 1 && ev.history.length === 0,
      { sv: ev.status_version, h: ev.history.length });
    const tokenA = ev.version;

    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '供应商通报该批可能混入异常原料，隔离待查',
      issued_by: '质检员-王敏', issued_at: '2026-10-05T09:00'
    });
    check('签发 QUAR-0001：BATCH-002/003 新受控',
      r.status === 200 && r.json.order.order_code === 'QUAR-0001' &&
      r.json.quarantine.newly_controlled.map((b) => b.batch_code).sort()
        .join(',') === 'BATCH-002,BATCH-003', r.json);
    check('SHIP-0001 原本已待评估：不再出现在 pending_shipments（无状态转换）',
      r.json.pending_shipments.length === 0, r.json.pending_shipments);
    const QUAR1 = r.json.order.id;

    ev = await evalOf('SHIP-0001');
    check('已待评估单的状态版本仍被推进（1→2）且标记受控',
      ev.status_version === 2 && ev.conditions.quarantined === true &&
      ev.conditions.can_continue === false &&
      ev.conditions.quarantine_orders[0].order_code === 'QUAR-0001',
      { sv: ev.status_version, cond: ev.conditions });

    r = await submit('SHIP-0001', {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '查询后新受控，旧版本召回', version: tokenA
    });
    check('旧版本提交召回 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    r = await submit('SHIP-0001', {
      decision: 'CONTINUE', decided_by: '质检-陈静', basis: '查询后新受控，旧版本继续流转', version: tokenA
    });
    check('旧版本提交继续流转 → 409 VERSION_EXPIRED（而非按新状态判条件）',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    ev = await evalOf('SHIP-0001');
    check('两次被拒均不产生处置记录', ev.history.length === 0, ev.history);

    const tokenB = ev.version;
    r = await submit('SHIP-0001', {
      decision: 'CONTINUE', decided_by: '质检-陈静', basis: '隔离期间试图继续流转', version: tokenB
    });
    check('重新查询后隔离期间 CONTINUE → 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED', r.json);
    r = await submit('SHIP-0001', {
      decision: 'RECALL', decided_by: '质检-陈静',
      basis: '批号隔离待查，先召回在途品', version: tokenB, decided_at: '2026-10-05T09:30'
    });
    check('重新查询后隔离期间 RECALL 落账（版本 2→3）',
      r.status === 200 && r.json.disposition.decision === 'RECALL' &&
      r.json.disposition.life_status === 'ACTIVE' &&
      r.json.evaluation.status_version === 3, r.json);

    // ---------- 2. 解除隔离令：旧版本仍不能提交（含继续流转） ----------
    console.log('2) 解除隔离令：变化前版本提交继续流转/召回均 409 VERSION_EXPIRED');
    ev = await evalOf('SHIP-0001');
    const tokenC = ev.version; // 隔离中查询取得（版本 3）
    r = await api('POST', `/api/quarantine-orders/${QUAR1}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '供应商复检合格，解除隔离'
    });
    check('解除 QUAR-0001：BATCH-002/003 脱离全部生效令',
      r.status === 200 &&
      r.json.quarantine.released.map((b) => b.batch_code).sort().join(',') === 'BATCH-002,BATCH-003',
      r.json);
    ev = await evalOf('SHIP-0001');
    check('解除后状态版本推进（3→4）、不再受控',
      ev.status_version === 4 && ev.conditions.quarantined === false, { sv: ev.status_version });
    r = await submit('SHIP-0001', {
      decision: 'CONTINUE', decided_by: '质检-陈静', basis: '解除后旧版本继续流转', version: tokenC
    });
    check('解除后旧版本提交继续流转 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    r = await submit('SHIP-0001', {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '解除后旧版本召回', version: tokenC
    });
    check('解除后旧版本提交召回 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    ev = await evalOf('SHIP-0001');
    check('解除后被拒不产生新记录（仍只有隔离期间的召回 #1）',
      ev.history.length === 1 && ev.history[0].decision === 'RECALL', ev.history);

    r = await api('POST', '/api/releases', {
      batch_id: B3, released_at: '2026-10-05T10:00', released_by: '质检员-王敏(复核)'
    });
    check('登记新放行：原召回结论标需重评（有效放行变化）',
      r.status === 200 &&
      (r.json.stale_dispositions || []).some((d) => d.decision === 'RECALL'), r.json);
    ev = await evalOf('SHIP-0001');
    check('脱离全部生效令后按原条件判断：三条件齐全 can_continue=true',
      ev.conditions.can_continue === true && ev.conditions.quarantined === false,
      ev.conditions);
    r = await submit('SHIP-0001', {
      decision: 'CONTINUE', decided_by: '质检-陈静',
      basis: '复检合格且新放行有效，准予继续流转', version: ev.version
    });
    check('重新查询后 CONTINUE 落账（脱离全部生效令才允许）',
      r.status === 200 && r.json.disposition.decision === 'CONTINUE', r.json);

    // ---------- 3. 事件更正使批次脱离生效范围：旧版本 409 ----------
    console.log('3) 新批 BATCH-QV1：签发→解除→再签发→事件更正脱离，全程旧版本 409');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-05T08:00', equipment_id: FRYER_B,
      batch_code: 'BATCH-QV1', note: '隔离版本验证批（奶 B 批）',
      material_inputs: [{ material_id: MILK, lot_id: MILK_B }]
    });
    check('BATCH-QV1 创建（全脂奶粉 B 批）', r.status === 200, r.json);
    const stQV1 = await state();
    const B_QV1 = stQV1.batches.find((b) => b.code === 'BATCH-QV1').id;
    const qv1Allergens = stQV1.batches.find((b) => b.code === 'BATCH-QV1').allergens;
    check('BATCH-QV1 推导过敏原 = [乳]',
      JSON.stringify(qv1Allergens) === JSON.stringify(['乳']), qv1Allergens);
    r = await api('POST', '/api/releases', {
      batch_id: B_QV1, released_at: '2026-10-05T08:30', released_by: '质检员-王敏'
    });
    const REL_QV1 = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: B_QV1, release_id: REL_QV1, allergens: ['乳'],
      print_qty: 50, registered_by: '包装组长-李雷'
    });
    const ROLL_QV1 = r.json.id;
    await api('POST', `/api/label-rolls/${ROLL_QV1}/consume`,
      { expected_revision: 0, applied: 10, voided: 0, used_by: '包装工-赵强' });
    r = await api('POST', '/api/shipments', {
      batch_id: B_QV1, ship_qty: 10, shipped_by: '仓管-孙倩',
      allocations: [{ roll_id: ROLL_QV1, qty: 10 }]
    });
    const SHIP_QV1 = r.json.shipment_code;
    check('BATCH-QV1 出货 10 张（SHIP-0002）',
      r.status === 200 && SHIP_QV1 === 'SHIP-0002', r.json);
    r = await api('DELETE', `/api/releases/${REL_QV1}`);
    check('删除放行：SHIP-0002 转待评估',
      r.json.pending_shipments.some((s) => s.shipment_code === SHIP_QV1), r.json);
    r = await api('POST', '/api/releases', {
      batch_id: B_QV1, released_at: '2026-10-05T08:50', released_by: '质检员-王敏'
    });
    check('重新登记放行（可继续流转条件恢复）', r.status === 200, r.json);
    ev = await evalOf(SHIP_QV1);
    check('SHIP-0002 待评估、版本 1、可继续流转',
      ev.review.pending_review === true && ev.status_version === 1 &&
      ev.conditions.can_continue === true, { sv: ev.status_version });
    const tokenE = ev.version;

    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '再次通报异常，复检', issued_by: '质检员-王敏'
    });
    check('签发 QUAR-0002：BATCH-QV1 新受控',
      r.status === 200 &&
      r.json.quarantine.newly_controlled.some((b) => b.batch_code === 'BATCH-QV1'), r.json);
    const QUAR2 = r.json.order.id;
    ev = await evalOf(SHIP_QV1);
    check('已待评估的 SHIP-0002 版本推进（1→2）且只能召回',
      ev.status_version === 2 && ev.conditions.quarantined === true &&
      ev.conditions.can_continue === false, { sv: ev.status_version });
    r = await submit(SHIP_QV1, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '签发前旧版本召回', version: tokenE
    });
    check('签发前旧版本提交 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    check('被拒后仍无处置记录',
      (await evalOf(SHIP_QV1)).history.length === 0);

    const tokenF = (await evalOf(SHIP_QV1)).version; // 隔离中查询（版本 2）
    r = await api('POST', `/api/quarantine-orders/${QUAR2}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '复检排除异常'
    });
    check('解除 QUAR-0002：BATCH-QV1 脱离全部生效令',
      r.status === 200 &&
      r.json.quarantine.released.some((b) => b.batch_code === 'BATCH-QV1'), r.json);
    ev = await evalOf(SHIP_QV1);
    check('解除后 SHIP-0002 版本推进（2→3）',
      ev.status_version === 3 && ev.conditions.quarantined === false, { sv: ev.status_version });
    r = await submit(SHIP_QV1, {
      decision: 'CONTINUE', decided_by: '质检-陈静',
      basis: '解除后旧版本试图继续流转', version: tokenF
    });
    check('解除后旧版本提交继续流转 → 409 VERSION_EXPIRED（修复前此处会落账）',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    r = await submit(SHIP_QV1, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '解除后旧版本召回', version: tokenF
    });
    check('解除后旧版本提交召回 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    check('仍无处置记录', (await evalOf(SHIP_QV1)).history.length === 0);

    ev = await evalOf(SHIP_QV1);
    r = await submit(SHIP_QV1, {
      decision: 'CONTINUE', decided_by: '质检-陈静',
      basis: '脱离全部生效令，按原条件准予继续流转', version: ev.version
    });
    check('重新查询后 CONTINUE 落账（版本 3→4）',
      r.status === 200 && r.json.disposition.decision === 'CONTINUE' &&
      r.json.evaluation.status_version === 4, r.json);

    // 再签发：有效“准予继续流转”结论转需重评；随后事件更正使批次脱离范围
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '第三次通报异常', issued_by: '质检员-王敏'
    });
    check('签发 QUAR-0003：有效 CONTINUE 结论同事务转需重评',
      r.status === 200 &&
      r.json.stale_dispositions.some((d) => d.shipment_code === SHIP_QV1 &&
        d.decision === 'CONTINUE'), r.json);
    const QUAR3 = r.json.order.id;
    ev = await evalOf(SHIP_QV1);
    check('SHIP-0002 版本推进（4→5）、旧结论 STALE、隔离中只能召回',
      ev.status_version === 5 && ev.current_disposition.life_status === 'STALE' &&
      ev.conditions.can_continue === false, { sv: ev.status_version });
    const tokenH = ev.version;

    const qv1Event = (await state()).events.find((e) => e.batch_code === 'BATCH-QV1');
    r = await api('PUT', `/api/events/${qv1Event.id}`, {
      type: 'PROCESS', event_time: '2026-10-05T08:00', equipment_id: FRYER_B,
      batch_code: 'BATCH-QV1', note: '更正为正常奶批（A 批）',
      material_inputs: [{ material_id: MILK, lot_id: MILK_A }], ref_batch_ids: []
    });
    check('事件更正：BATCH-QV1 脱离生效范围（quarantine.released）',
      r.status === 200 &&
      r.json.quarantine.released.some((b) => b.batch_code === 'BATCH-QV1'), r.json);
    ev = await evalOf(SHIP_QV1);
    check('事件更正后 SHIP-0002 版本推进（5→6）、恢复可继续流转',
      ev.status_version === 6 && ev.conditions.quarantined === false &&
      ev.conditions.can_continue === true, { sv: ev.status_version });
    r = await submit(SHIP_QV1, {
      decision: 'RECALL', decided_by: '质检-陈静', basis: '事件更正前旧版本召回', version: tokenH
    });
    check('事件更正前旧版本提交召回 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    r = await submit(SHIP_QV1, {
      decision: 'CONTINUE', decided_by: '质检-陈静', basis: '事件更正前旧版本继续流转', version: tokenH
    });
    check('事件更正前旧版本提交继续流转 → 409 VERSION_EXPIRED',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    ev = await evalOf(SHIP_QV1);
    check('被拒不产生记录（仍只有 1 条 STALE 结论）',
      ev.history.length === 1 && ev.history[0].life_status === 'STALE', ev.history);
    r = await submit(SHIP_QV1, {
      decision: 'CONTINUE', decided_by: '质检-陈静',
      basis: '更正为正常奶批并脱离全部生效令，重新评估后准予继续流转', version: ev.version
    });
    check('重新查询后 CONTINUE 落账（第二条记录，第一条 STALE 保留）',
      r.status === 200 && r.json.disposition.decision === 'CONTINUE' &&
      r.json.evaluation.history.length === 2 &&
      r.json.evaluation.history[0].life_status === 'STALE', r.json);

    // ---------- 4. 未受影响出货单的版本不无故失效 ----------
    console.log('4) 他批隔离令签发/解除不影响本单：SHIP-0003 旧版本仍可用');
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-05T09:00', equipment_id: LINE_A,
      batch_code: 'BATCH-QV2', note: '无过敏原验证批（食盐）',
      material_inputs: [{ material_id: SALT }]
    });
    check('BATCH-QV2 创建（食盐，无过敏原）', r.status === 200, r.json);
    const B_QV2 = (await state()).batches.find((b) => b.code === 'BATCH-QV2').id;
    r = await api('POST', '/api/releases', {
      batch_id: B_QV2, released_at: '2026-10-05T09:10', released_by: '质检员-王敏'
    });
    const REL_QV2 = r.json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: B_QV2, release_id: REL_QV2, allergens: [],
      print_qty: 20, registered_by: '包装组长-李雷'
    });
    const ROLL_QV2 = r.json.id;
    await api('POST', `/api/label-rolls/${ROLL_QV2}/consume`,
      { expected_revision: 0, applied: 5, voided: 0, used_by: '包装工-赵强' });
    r = await api('POST', '/api/shipments', {
      batch_id: B_QV2, ship_qty: 5, shipped_by: '仓管-孙倩',
      allocations: [{ roll_id: ROLL_QV2, qty: 5 }]
    });
    const SHIP_QV2 = r.json.shipment_code;
    check('BATCH-QV2 出货 5 张（SHIP-0003）', r.status === 200 && SHIP_QV2 === 'SHIP-0003', r.json);
    await api('DELETE', `/api/releases/${REL_QV2}`);
    ev = await evalOf(SHIP_QV2);
    check('SHIP-0003 待评估、版本 1（只能召回：无有效放行）',
      ev.review.pending_review === true && ev.status_version === 1 &&
      ev.conditions.can_continue === false, { sv: ev.status_version });
    const tokenU = ev.version;

    r = await api('POST', `/api/quarantine-orders/${QUAR3}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '第三次排查结束'
    });
    check('解除 QUAR-0003（为第四节清理生效令）', r.status === 200, r.json);
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '第四次通报异常', issued_by: '质检员-王敏'
    });
    check('签发 QUAR-0004：不影响 BATCH-QV2（食盐批）',
      r.status === 200 &&
      !r.json.quarantine.newly_controlled.some((b) => b.batch_code === 'BATCH-QV2'), r.json);
    const QUAR4 = r.json.order.id;
    r = await api('POST', `/api/quarantine-orders/${QUAR4}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '排查结束'
    });
    check('解除 QUAR-0004', r.status === 200, r.json);
    ev = await evalOf(SHIP_QV2);
    check('他批隔离令签发/解除后 SHIP-0003 版本仍为 1（不无故失效）',
      ev.status_version === 1 && ev.conditions.quarantined === false, { sv: ev.status_version });
    r = await submit(SHIP_QV2, {
      decision: 'RECALL', decided_by: '质检-陈静',
      basis: '放行已删除，维持召回（他批隔离令不影响本单版本）', version: tokenU
    });
    check('变化前查询的版本仍可使用：RECALL 落账',
      r.status === 200 && r.json.disposition.decision === 'RECALL', r.json);

  } finally {
    proc.kill('SIGTERM');
    await sleep(300);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  if (failures) {
    console.error(`\n失败 ${failures} 项`);
    process.exit(1);
  }
  console.log('\n全部通过');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
