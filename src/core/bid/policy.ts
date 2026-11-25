export type PendingCategory = '报价' | '工期交期' | '质保' | '偏离' | '承诺' | '待核对' | '其他';
export interface PendingReason { category: PendingCategory; note: string; source: 'declared' | 'keyword' | 'unverified'; }

const rules: ReadonlyArray<readonly [PendingCategory, RegExp]> = [
  ['报价', /报价|总价|单价|合价|金额|税率|保证金|优惠/],
  ['工期交期', /工期|交货期|交付期|交货时间|交付时间/],
  ['质保', /质保|保修|维保/],
];

/** Return all applicable reasons so automatic tightening cannot remove a declaration. */
export function pendingReasons(input: {
  context: string;
  unverifiedFact?: boolean;
  declared?: { category: PendingCategory; note: string };
}): PendingReason[] {
  const reasons: PendingReason[] = [];
  if (input.declared) reasons.push({ ...input.declared, source: 'declared' });
  for (const [category, pattern] of rules) {
    const match = pattern.exec(input.context);
    if (match) reasons.push({ category, note: match[0], source: 'keyword' });
  }
  if (input.unverifiedFact) reasons.push({ category: '待核对', note: '事实来源未核实', source: 'unverified' });
  return reasons;
}
