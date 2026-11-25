import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingReasons } from '../src/core/bid/policy.js';

test('core commercial keywords add reasons without dropping declared pending', () => {
  const reasons = pendingReasons({
    context: '总价和交货期以及税率优惠',
    unverifiedFact: true,
    declared: { category: '其他', note: '需负责人确认' },
  });
  assert.deepEqual(reasons.map(reason => reason.category), ['其他', '报价', '工期交期', '待核对']);
});

test('narrowed policy covers 报价/工期交期/质保, ignores 偏离/承诺, and gates unverifiedFact cleanly', () => {
  assert.deepEqual(pendingReasons({ context: '合价 交货时间 交付时间 维保' }).map(reason => reason.category), ['报价', '工期交期', '质保']);
  assert.deepEqual(pendingReasons({ context: '技术偏离表及售后服务承诺与响应时间' }), []);
  assert.deepEqual(pendingReasons({ context: '质保期限', unverifiedFact: false }).map(reason => reason.category), ['质保']);
  assert.deepEqual(pendingReasons({ context: '普通项目介绍', unverifiedFact: false }), []);
  assert.deepEqual(pendingReasons({ context: '普通项目介绍', unverifiedFact: true }), [
    { category: '待核对', note: '事实来源未核实', source: 'unverified' },
  ]);
  assert.deepEqual(
    pendingReasons({ context: '无偏离承诺', declared: { category: '偏离', note: '实质性负偏离' } }),
    [{ category: '偏离', note: '实质性负偏离', source: 'declared' }],
  );
});
