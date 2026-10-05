'use strict';
// 隔离令集合变化与评估状态版本：端到端 HTTP 测试（针对“原本已待评估单据”的缺陷修复）。
// 启动使用临时 SQLite 文件的真实服务实例（含演示数据），验证：
//   1) 原本已 PENDING_REVIEW 的出货单：签发隔离令不转待评估（无 pending_shipments），
//      但状态版本仍推进；变化前查询取得的版本（不论提交 CONTINUE 还是 RECALL）
//      一律 409 VERSION_EXPIRED 且不产生处置记录；
//   2) 重新查询后按最新隔离状态判断：隔离期间 CONTINUE 被 CONTINUE_NOT_ALLOWED 拒绝、
//      RECALL 可落账；脱离全部生效令后按原条件恢复，三条件齐全才可 CONTINUE；
//   3) 多令覆盖：解除其中一张（批次仍受控、released 为空）同样推进版本，旧版本 409；
//   4) 解除最后一张令：旧版本 409；重新查询 can_continue 恢复后 CONTINUE 成功；
//   5) 事件更正使批次进出受控范围（syncScopes 重算）同样推进版本、旧版本 409；
//   6) 未受影响出货单（其他批次）版本不无故失效：隔离签发后旧版本仍可成功提交，
//      其状态版本与有效结论始终不被连带改动。
//   node scripts/test-quarantine-versions.js
// 退出码 0 表示全部通过。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = '39151';
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quarantine-ver-test-'));
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
    const st = () => api('GET', '/api/state').then((x) => x.json);
    const s0 = await st();
    const matId = (code) => s0.materials.find((m) => m.code === code).id;
    const MILK = matId('MILK-01'), EGG = matId('EGG-01'), SALT = matId('SALT-01');
    const MILK_B = s0.materials.find((m) => m.code === 'MILK-01')
      .lots.find((l) => l.lot_code === 'SUP-MILK-20260926-B').id;
    const B3 = s0.batches.find((b) => b.code === 'BATCH-003').id;
    const SET3 = ['蛋', '乳', '芝麻'];
    const R1 = s0.batches.find((b) => b.code === 'BATCH-003')
      .releases.find((x) => x.status === 'ACTIVE').id;
    const LABEL1 = s0.label_rolls.find((x) => x.roll_code === 'LABEL-0001').id;

    // ---------- 0. 构造三张“签发前就已待评估”的出货单 ----------
    console.log('0) 准备：S1/S2（BATCH-003，删放行转待评估后补新放行，can_continue=true）');
    console.log('   S3（独立食盐批次，无放行 can_continue=false）用于“未受影响”对照');

    // S1 = 演示 SHIP-0001：删原放行 → 待评估、LABEL-0001 停用；补登记新放行 R2。
    r = await api('DELETE', `/api/releases/${R1}`);
    check('删除 R1：SHIP-0001 转待评估',
      r.status === 200 &&
      r.json.pending_shipments.some((x) => x.shipment_code === 'SHIP-0001'), r.json);
    r = await api('POST', '/api/releases',
      { batch_id: B3, released_at: '2026-10-05T08:10', released_by: '质检员-王敏' });
    check('BATCH-003 重新登记放行 R2', r.status === 200, r.json);

    // S2：新卷 L2 出货后同样转待评估，再补新放行 R4。
    const R3 = (await api('POST', '/api/releases',
      { batch_id: B3, released_at: '2026-10-05T08:20', released_by: '王敏' })).json.id;
    r = await api('POST', '/api/label-rolls', {
      batch_id: B3, release_id: R3, allergens: SET3,
      print_qty: 50, registered_by: '李雷'
    });
    const L2 = r.json.id;
    check('登记 L2', r.status === 200 && L2, r.json);
    r = await api('POST', `/api/label-rolls/${L2}/consume`,
      { expected_revision: 0, applied: 20, voided: 0, used_by: '赵强' });
    check('L2 贴用 20', r.status === 200, r.json);
    r = await api('POST', '/api/shipments', {
      batch_id: B3, ship_qty: 20, shipped_by: '周杰',
      allocations: [{ roll_id: L2, qty: 20 }]
    });
    const S2 = r.json.shipment_code;
    check(`S2 出货成功 ${S2}（SHIPPED）`, r.status === 200 && S2 === 'SHIP-0002', r.json);
    r = await api('DELETE', `/api/releases/${R3}`);
    check('删除 R3：S2 转待评估',
      r.status === 200 && r.json.pending_shipments.some((x) => x.shipment_code === S2), r.json);
    r = await api('POST', '/api/releases',
      { batch_id: B3, released_at: '2026-10-05T08:30', released_by: '王敏' });
    check('BATCH-003 再登记放行 R4（S1/S2 三条件齐全）', r.status === 200, r.json);

    // S3：独立设备 + 先全清，杜绝设备残留把奶/蛋批号流向带到该批。
    r = await api('POST', '/api/equipment', { code: 'LINE-T', name: '试验线' });
    const LINE_T = r.json.id;
    check('新建设备 LINE-T', r.status === 200 && LINE_T, r.json);
    r = await api('POST', '/api/events', {
      type: 'CLEAN', event_time: '2026-10-05T07:00', equipment_id: LINE_T,
      note: '试验前全清'
    });
    check('试验线先全清', r.status === 200, r.json);
    r = await api('POST', '/api/material-lots',
      { material_id: SALT, lot_code: 'SUP-SALT-TEST-1', supplier: '测试盐业' });
    const SALT_LOT = r.json.id;
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-05T08:00', equipment_id: LINE_T,
      batch_code: 'BATCH-SALT', note: '对照批（食盐）',
      material_inputs: [{ material_id: SALT, lot_id: SALT_LOT }]
    });
    check('BATCH-SALT 加工', r.status === 200, r.json);
    const B_SALT = (await st()).batches.find((b) => b.code === 'BATCH-SALT').id;
    const R5 = (await api('POST', '/api/releases',
      { batch_id: B_SALT, released_at: '2026-10-05T08:10', released_by: '王敏' })).json.id;
    const L3 = (await api('POST', '/api/label-rolls', {
      batch_id: B_SALT, release_id: R5, allergens: [],
      print_qty: 20, registered_by: '李雷'
    })).json.id;
    await api('POST', `/api/label-rolls/${L3}/consume`,
      { expected_revision: 0, applied: 10, voided: 0, used_by: '赵强' });
    r = await api('POST', '/api/shipments', {
      batch_id: B_SALT, ship_qty: 10, shipped_by: '周杰',
      allocations: [{ roll_id: L3, qty: 10 }]
    });
    const S3 = r.json.shipment_code;
    check(`S3 出货成功 ${S3}`, r.status === 200 && S3 === 'SHIP-0003', r.json);
    r = await api('DELETE', `/api/releases/${R5}`);
    check('删除 R5：S3 转待评估（无有效放行）',
      r.status === 200 && r.json.pending_shipments.some((x) => x.shipment_code === S3), r.json);

    // S4：同在试验线的另一食盐批，稍后用“事件更正”改为受控奶批。
    r = await api('POST', '/api/events', {
      type: 'PROCESS', event_time: '2026-10-05T09:00', equipment_id: LINE_T,
      batch_code: 'BATCH-TC', note: '更正演示批（食盐）',
      material_inputs: [{ material_id: SALT, lot_id: SALT_LOT }]
    });
    check('BATCH-TC 加工（食盐）', r.status === 200, r.json);
    const B_TC = (await st()).batches.find((b) => b.code === 'BATCH-TC').id;
    const R6 = (await api('POST', '/api/releases',
      { batch_id: B_TC, released_at: '2026-10-05T09:10', released_by: '王敏' })).json.id;
    const L4 = (await api('POST', '/api/label-rolls', {
      batch_id: B_TC, release_id: R6, allergens: [],
      print_qty: 20, registered_by: '李雷'
    })).json.id;
    await api('POST', `/api/label-rolls/${L4}/consume`,
      { expected_revision: 0, applied: 10, voided: 0, used_by: '赵强' });
    r = await api('POST', '/api/shipments', {
      batch_id: B_TC, ship_qty: 10, shipped_by: '周杰',
      allocations: [{ roll_id: L4, qty: 10 }]
    });
    const S4 = r.json.shipment_code;
    check(`S4 出货成功 ${S4}（SHIPPED）`, r.status === 200 && S4 === 'SHIP-0004', r.json);
    r = await api('DELETE', `/api/releases/${R6}`);
    check('删除 R6：S4 转待评估',
      r.status === 200 && r.json.pending_shipments.some((x) => x.shipment_code === S4), r.json);
    const R7 = (await api('POST', '/api/releases',
      { batch_id: B_TC, released_at: '2026-10-05T09:20', released_by: '王敏' })).json.id;
    check('S4 补登记放行 R7（更正前 can_continue=true）', !!R7);

    // 查询取得“变化前”版本（三张单都已待评估，状态版本均为 1）。
    const evalOf = (code) => api('GET', `/api/shipments/${code}/evaluation`).then((x) => x.json);
    const eS1a = await evalOf('SHIP-0001');
    const eS2a = await evalOf(S2);
    const eS3a = await evalOf(S3);
    const eS4a = await evalOf(S4);
    check('S1/S2/S3/S4 均待评估且状态版本=1',
      eS1a.status_version === 1 && eS2a.status_version === 1 &&
      eS3a.status_version === 1 && eS4a.status_version === 1,
      { s1: eS1a.status_version, s2: eS2a.status_version, s3: eS3a.status_version, s4: eS4a.status_version });
    check('签发前 S1/S2/S4 can_continue=true，S3=false（无放行）',
      eS1a.conditions.can_continue === true && eS2a.conditions.can_continue === true &&
      eS4a.conditions.can_continue === true && eS3a.conditions.can_continue === false,
      { s1: eS1a.conditions.can_continue, s3: eS3a.conditions.can_continue });
    const vS1a = eS1a.version;
    const vS2a = eS2a.version;
    const vS3a = eS3a.version;
    const vS4a = eS4a.version;

    // ---------- 1. 签发奶令：BATCH-002/003 新受控 ----------
    console.log('1) 签发隔离令：已待评估单不再转待评估，但版本必须推进；旧版本提交 409 无记录');
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: MILK_B, reason: '供应商通报该批可能混入异常原料，隔离待查',
      issued_by: '质检员-王敏'
    });
    const QUAR_M = r.json.order.id;
    check('奶令签发成功', r.status === 200 && r.json.order.order_code === 'QUAR-0001', r.json);
    check('S1/S2 本就待评估：pending_shipments 不再含 BATCH-003 单据',
      !r.json.pending_shipments.some((x) => ['SHIP-0001', S2].includes(x.shipment_code)),
      r.json.pending_shipments.map((x) => x.shipment_code));
    check('新受控批次含 BATCH-002/003',
      (r.json.quarantine.newly_controlled || []).some((x) => x.batch_code === 'BATCH-003'),
      r.json.quarantine);

    let e1 = await evalOf('SHIP-0001');
    let e2 = await evalOf(S2);
    let e3 = await evalOf(S3);
    let e4 = await evalOf(S4);
    check('S1/S2 状态版本 1→2（原本已待评估也推进）',
      e1.status_version === 2 && e2.status_version === 2,
      { s1: e1.status_version, s2: e2.status_version });
    check('S3/S4 未受影响：状态版本仍为 1',
      e3.status_version === 1 && e4.status_version === 1,
      { s3: e3.status_version, s4: e4.status_version });
    check('S1/S2 评估视图显示隔离中',
      e1.conditions.quarantined === true && e1.conditions.can_continue === false &&
      e2.conditions.quarantined === true && e2.conditions.can_continue === false);
    check('S3/S4 未受控',
      e3.conditions.quarantined === false && e4.conditions.quarantined === false);

    // 变化前版本：CONTINUE 与 RECALL 都必须 VERSION_EXPIRED（先核版本，无处置记录）。
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '陈静', basis: '旧版本试图继续流转', version: vS1a
    });
    check('S1 旧版本 CONTINUE → 409 VERSION_EXPIRED（非 CONTINUE_NOT_ALLOWED）',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    r = await api('POST', `/api/shipments/${S2}/dispositions`, {
      decision: 'RECALL', decided_by: '陈静', basis: '旧版本试图召回', version: vS2a
    });
    check('S2 旧版本 RECALL → 409 VERSION_EXPIRED（缺陷点：旧版本曾可提交召回）',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED', r.json);
    check('S1/S2 被拒后无任何处置记录',
      (await evalOf('SHIP-0001')).history.length === 0 &&
      (await evalOf(S2)).history.length === 0);

    // 未受影响出货单：变化前版本仍然有效，可正常提交（RECALL，S3 本就只能召回）。
    r = await api('POST', `/api/shipments/${S3}/dispositions`, {
      decision: 'RECALL', decided_by: '质检员-陈静',
      basis: '无有效放行，正常召回（与隔离令无关）', version: vS3a
    });
    check('S3 未受影响：旧版本提交 RECALL 成功落账',
      r.status === 200 && r.json.disposition.decision === 'RECALL' &&
      r.json.disposition.life_status === 'ACTIVE', r.json);

    // 重新查询后按最新隔离状态判断：CONTINUE 被拒、RECALL 落账（S1）。
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'CONTINUE', decided_by: '陈静', basis: '重新查询后仍试图继续流转',
      version: e1.version
    });
    check('S1 新版本隔离期间 CONTINUE → 409 CONTINUE_NOT_ALLOWED',
      r.status === 409 && r.json.code === 'CONTINUE_NOT_ALLOWED', r.json);
    r = await api('POST', '/api/shipments/SHIP-0001/dispositions', {
      decision: 'RECALL', decided_by: '质检员-陈静',
      basis: '批号隔离待查，先召回在途品', version: e1.version
    });
    check('S1 重新查询后隔离期间 RECALL 正常落账',
      r.status === 200 && r.json.disposition.decision === 'RECALL' &&
      r.json.disposition.life_status === 'ACTIVE', r.json);
    e1 = await evalOf('SHIP-0001');
    check('S1 落账后状态版本 2→3，历史 1 条',
      e1.status_version === 3 && e1.history.length === 1, e1.status_version);
    // 此后 S1 每次令变化 3→4(蛋令)→5(解蛋)→6(解奶)，结尾一并核对。

    // ---------- 2. 第二张令（蛋，批号未知无法排除覆盖 BATCH-003） ----------
    console.log('2) 多令覆盖：蛋令签发使 BATCH-003 生效令集合增大，S2 版本再推进');
    const vS2b = e2.version; // 奶令后重新查询的版本（状态版本 2）
    r = await api('POST', '/api/material-lots',
      { material_id: EGG, lot_code: 'SUP-EGG-TEST-1', supplier: '测试蛋品' });
    const EGG_LOT = r.json.id;
    r = await api('POST', '/api/quarantine-orders', {
      lot_id: EGG_LOT, reason: '蛋品供应商例行排查', issued_by: '王敏'
    });
    const QUAR_E = r.json.order.id;
    check('蛋令签发成功', r.status === 200 && r.json.order.order_code === 'QUAR-0002', r.json);
    check('蛋令范围含 BATCH-003（UNRESOLVED）',
      r.json.order.scope.batches.some((b) => b.batch_code === 'BATCH-003'),
      r.json.order.scope.batches);
    e2 = await evalOf(S2);
    e3 = await evalOf(S3);
    check('S2 状态版本 2→3（生效令集合变化）', e2.status_version === 3, e2.status_version);
    check('S3 不受蛋令影响：状态版本仍为 2（自身处置推进后的值）',
      e3.status_version === 2, e3.status_version);
    r = await api('POST', `/api/shipments/${S2}/dispositions`, {
      decision: 'RECALL', decided_by: '陈静', basis: '蛋令后用奶令时期的旧版本召回',
      version: vS2b
    });
    check('S2 奶令时期版本在蛋令后 → 409 VERSION_EXPIRED 且无记录',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED' &&
      (await evalOf(S2)).history.length === 0, r.json);

    // ---------- 3. 事件更正使 S4 新受控 / 脱离 ----------
    console.log('3) 事件更正（重算范围）：S4 进入/脱离生效令集合均推进版本，旧版本 409');
    const tcEvent = (await st()).events.find((x) => x.batch_code === 'BATCH-TC');
    r = await api('PUT', `/api/events/${tcEvent.id}`, {
      type: 'PROCESS', event_time: '2026-10-05T09:00', equipment_id: LINE_T,
      batch_code: 'BATCH-TC', note: '更正为受控奶批 SUP-MILK-20260926-B',
      material_inputs: [{ material_id: MILK, lot_id: MILK_B }],
      ref_batch_ids: []
    });
    check('更正后 BATCH-TC 新受控（响应 quarantine.newly_controlled）',
      r.status === 200 &&
      r.json.quarantine.newly_controlled.some((x) => x.batch_code === 'BATCH-TC'),
      r.json.quarantine);
    e4 = await evalOf(S4);
    check('S4 状态版本 1→2（事件更正新受控，且单据本已待评估）',
      e4.status_version === 2 && e4.conditions.quarantined === true &&
      e4.conditions.can_continue === false,
      { v: e4.status_version, q: e4.conditions.quarantined });
    r = await api('POST', `/api/shipments/${S4}/dispositions`, {
      decision: 'RECALL', decided_by: '陈静', basis: '更正后用更正前版本召回', version: vS4a
    });
    check('S4 更正前版本提交 → 409 VERSION_EXPIRED 且无记录',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED' &&
      (await evalOf(S4)).history.length === 0, r.json);

    // 再更正回食盐：脱离受控（奶令仍生效，但 BATCH-TC 不再在其范围）。
    r = await api('PUT', `/api/events/${tcEvent.id}`, {
      type: 'PROCESS', event_time: '2026-10-05T09:00', equipment_id: LINE_T,
      batch_code: 'BATCH-TC', note: '更正回食盐批',
      material_inputs: [{ material_id: SALT, lot_id: SALT_LOT }],
      ref_batch_ids: []
    });
    check('再次更正后 BATCH-TC 脱离生效范围',
      r.status === 200 &&
      r.json.quarantine.released.some((x) => x.batch_code === 'BATCH-TC'),
      r.json.quarantine);
    e4 = await evalOf(S4);
    check('S4 脱离受控：quarantined=false，状态版本 2→3',
      e4.conditions.quarantined === false && e4.status_version === 3,
      { v: e4.status_version, q: e4.conditions.quarantined });
    check('S4 脱离后记录数仍为 0（受控期间未落任何处置）', e4.history.length === 0);

    // ---------- 4. 解除蛋令：BATCH-003 仍受奶令覆盖（released 为空），版本仍推进 ----------
    console.log('4) 解除蛋令：仍受控但生效令集合变化，S2 版本推进、旧版本 409');
    const vS2c = e2.version; // 蛋令后查询的版本（状态版本 3）
    r = await api('POST', `/api/quarantine-orders/${QUAR_E}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '供应商排查排除异常'
    });
    check('解除蛋令成功，released 为空（奶令仍覆盖）',
      r.status === 200 && r.json.quarantine.released.length === 0, r.json.quarantine);
    e2 = await evalOf(S2);
    check('S2 仍隔离（quarantined=true），状态版本 3→4',
      e2.conditions.quarantined === true && e2.status_version === 4,
      { v: e2.status_version, q: e2.conditions.quarantined });
    r = await api('POST', `/api/shipments/${S2}/dispositions`, {
      decision: 'RECALL', decided_by: '陈静', basis: '解除蛋令后用蛋令时期版本召回',
      version: vS2c
    });
    check('S2 蛋令时期版本在蛋令解除后 → 409 VERSION_EXPIRED 且无记录',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED' &&
      (await evalOf(S2)).history.length === 0, r.json);

    // ---------- 5. 解除奶令：脱离全部生效令，重新查询后按原条件 CONTINUE ----------
    console.log('5) 解除奶令：旧版本 409；重新查询 can_continue 恢复，CONTINUE 成功');
    const vS2d = e2.version; // 蛋令解除后查询的版本（状态版本 4）
    r = await api('POST', `/api/quarantine-orders/${QUAR_M}/lift`, {
      lifted_by: '质检主管-刘芳', lift_reason: '供应商复检合格，解除隔离'
    });
    check('解除奶令：BATCH-003 脱离全部生效令',
      r.status === 200 &&
      r.json.quarantine.released.some((x) => x.batch_code === 'BATCH-003'),
      r.json.quarantine);
    r = await api('POST', `/api/shipments/${S2}/dispositions`, {
      decision: 'CONTINUE', decided_by: '陈静', basis: '解除后用蛋令解除时的旧版本继续流转',
      version: vS2d
    });
    check('S2 旧版本在奶令解除后 → 409 VERSION_EXPIRED（缺陷点：解除后旧版本曾可提交继续流转）',
      r.status === 409 && r.json.code === 'VERSION_EXPIRED' &&
      (await evalOf(S2)).history.length === 0, r.json);
    e2 = await evalOf(S2);
    check('重新查询：S2 脱离全部令 quarantined=false，原三条件恢复 can_continue=true',
      e2.conditions.quarantined === false && e2.conditions.can_continue === true &&
      e2.conditions.blockers.length === 0 && e2.status_version === 5,
      e2.conditions);
    r = await api('POST', `/api/shipments/${S2}/dispositions`, {
      decision: 'CONTINUE', decided_by: '质检员-陈静',
      basis: '隔离全部解除，批次/有效放行/快照覆盖三条件齐全，准予继续流转',
      version: e2.version
    });
    check('S2 重新查询后 CONTINUE 落账（唯一一条记录）',
      r.status === 200 && r.json.disposition.decision === 'CONTINUE' &&
      r.json.disposition.life_status === 'ACTIVE' &&
      r.json.evaluation.history.length === 1, r.json);

    // ---------- 6. 未受影响出货单终态核对 ----------
    console.log('6) S3（食盐）全程未受影响：版本不无故失效、有效召回结论保持 ACTIVE');
    e3 = await evalOf(S3);
    check('S3 最终状态版本仍为 2（仅自身转待评估与自身处置推进）',
      e3.status_version === 2, e3.status_version);
    check('S3 RECALL 结论始终 ACTIVE（未被任何隔离重算标 STALE）',
      e3.current_disposition && e3.current_disposition.decision === 'RECALL' &&
      e3.current_disposition.life_status === 'ACTIVE', e3.current_disposition);
    check('S3 始终未受控', e3.conditions.quarantined === false);

    // S1 的隔离期间 RECALL 已在第 1 步落账：随签发/解除与自身处置推进。
    e1 = await evalOf('SHIP-0001');
    check('S1 随各令签发/解除与自身处置版本推进至 6（与 S2 同批次，多一次自身处置）',
      e1.status_version === 6, e1.status_version);
    check('S1 隔离期间登记的 RECALL 结论仍 ACTIVE（解除不自动改动历史结论）',
      e1.current_disposition && e1.current_disposition.decision === 'RECALL' &&
      e1.current_disposition.life_status === 'ACTIVE', e1.current_disposition);

    console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
    proc.kill();
    process.exit(failures === 0 ? 0 : 1);
  } catch (err) {
    console.error('测试执行异常：', err);
    proc.kill();
    process.exit(1);
  }
}

main();
