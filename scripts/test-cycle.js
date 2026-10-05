'use strict';
const Database = require('better-sqlite3');
const { initSchema } = require('../server/db');
const { validateAll } = require('../server/validation');

// 与正式库同一套表结构（initSchema 建空表），仅插入校验所需的设备，
// 避免手写最小夹具随全量校验新增核对项（库存/停机窗口等）反复缺表缺列。
function memDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  initSchema(db);
  db.prepare('INSERT INTO equipment(id,code,name) VALUES (1,\'E1\',\'设备1\'),(2,\'E2\',\'设备2\')').run();
  return db;
}

// 无环：b1 <- b2 <- b3（过去引用链）
let db = memDb();
db.prepare("INSERT INTO batches(id,code) VALUES (1,'b1'),(2,'b2'),(3,'b3')").run();
const insE = db.prepare('INSERT INTO events(event_time,type,equipment_id,batch_id) VALUES (?,?,?,?)');
insE.run('2026-01-01T08:00', 'PROCESS', 1, 1);
insE.run('2026-01-01T09:00', 'PROCESS', 2, 2);
insE.run('2026-01-01T10:00', 'PROCESS', 1, 3);
db.prepare('INSERT INTO process_inputs(event_id,batch_id) VALUES (2,1),(3,2),(3,1)').run();
const acyclic = validateAll(db);
console.log('无环时错误数:', acyclic.length, '(期望 0)');

// 环检测专用夹具：不同设备、不同时间，仅靠引用关系成环
// b1(08:00,设备1) <- b2(09:00,设备2) <- b3(10:00,设备1)
// 正常边 b2->b1, b3->b2；额外加入 b1->b3（绕过未来引用检查由 DFS 兜底）
db = memDb();
db.prepare("INSERT INTO batches(id,code) VALUES (1,'b1'),(2,'b2'),(3,'b3')").run();
const insE2 = db.prepare('INSERT INTO events(event_time,type,equipment_id,batch_id) VALUES (?,?,?,?)');
insE2.run('2026-01-01T08:00', 'PROCESS', 1, 1);
insE2.run('2026-01-01T09:00', 'PROCESS', 2, 2);
insE2.run('2026-01-01T10:00', 'PROCESS', 1, 3);
db.prepare('INSERT INTO process_inputs(event_id,batch_id) VALUES (1,3),(2,1),(3,2)').run();
const errs = validateAll(db);
const cycleErrs = errs.filter((e) => e.includes('循环'));
console.log('循环错误条数:', cycleErrs.length, '(期望 3)');
console.log(cycleErrs);

if (acyclic.length !== 0 || cycleErrs.length !== 3) {
  console.error('测试失败');
  process.exit(1);
}
console.log('通过');
