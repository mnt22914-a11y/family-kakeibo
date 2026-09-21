// 実行: node --test tests/logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, recurringDate, dueRecurring, computeSettlement, summarize, budgetStatus, toCsv, yen, recordingStatus, quickPresets, scheduleForMonth, occursIn, summarizeLoans, goalProgress } from '../js/logic.js';

test('月の足し引きは年をまたげる', () => {
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  assert.equal(addMonths('2026-09', -5), '2026-04');
});

test('31日指定の固定費は月末に寄せる', () => {
  assert.equal(recurringDate('2026-02', 31), '2026-02-28');
  assert.equal(recurringDate('2028-02', 31), '2028-02-29');
  assert.equal(recurringDate('2026-09', 31), '2026-09-30');
});

const rec = (o) => ({ id: 'r1', active: true, kind: 'expense', amount: 80000, category_id: 'c', member_id: 'm', shared: true, name: '家賃', day: 27, start_month: '2026-09', end_month: null, last_generated: null, ...o });

test('固定費: 発生日より前は作らない', () => {
  const { rows, updates } = dueRecurring([rec()], '2026-09-18');
  assert.equal(rows.length, 0);
  assert.equal(updates.length, 0);
});

test('固定費: 発生日を過ぎたら1件作り、二重には作らない', () => {
  const first = dueRecurring([rec()], '2026-09-27');
  assert.deepEqual(first.rows.map((r) => r.date), ['2026-09-27']);
  assert.deepEqual(first.updates, [{ id: 'r1', last_generated: '2026-09' }]);
  const again = dueRecurring([rec({ last_generated: '2026-09' })], '2026-09-30');
  assert.equal(again.rows.length, 0);
});

test('固定費: しばらく開かなくても抜けた月をまとめて作る', () => {
  const { rows, updates } = dueRecurring([rec({ last_generated: '2026-09' })], '2027-01-10');
  assert.deepEqual(rows.map((r) => r.date), ['2026-10-27', '2026-11-27', '2026-12-27']);
  assert.equal(updates[0].last_generated, '2026-12');
});

test('固定費: 停止中・終了月を過ぎたものは作らない', () => {
  assert.equal(dueRecurring([rec({ active: false })], '2026-12-31').rows.length, 0);
  assert.deepEqual(dueRecurring([rec({ end_month: '2026-10' })], '2026-12-31').rows.map((r) => r.date), ['2026-09-27', '2026-10-27']);
});

const M = (id, in_settlement = true) => ({ id, in_settlement });

test('精算: 2人なら差額の半分を渡す', () => {
  const r = computeSettlement([M('a'), M('b')], { a: 100000, b: 40000 }, []);
  assert.deepEqual(r.transfers, [{ from: 'b', to: 'a', amount: 30000 }]);
});

test('精算: 記録済みの精算は差し引かれる', () => {
  const r = computeSettlement([M('a'), M('b')], { a: 100000, b: 40000 }, [{ from_member: 'b', to_member: 'a', amount: 30000 }]);
  assert.deepEqual(r.transfers, []);
  assert.ok(r.balances.every((b) => b.balance === 0));
});

test('精算: 子ども(対象外)は割り勘に含めない', () => {
  const r = computeSettlement([M('a'), M('b'), M('kid', false)], { a: 60000, kid: 5000 }, []);
  assert.equal(r.balances.length, 2);
  assert.deepEqual(r.transfers, [{ from: 'b', to: 'a', amount: 30000 }]);
});

test('精算: 3人でも合計が合う', () => {
  const r = computeSettlement([M('a'), M('b'), M('c')], { a: 90000, b: 30000, c: 0 }, []);
  assert.deepEqual(r.transfers, [{ from: 'c', to: 'a', amount: 40000 }, { from: 'b', to: 'a', amount: 10000 }]);
});

test('精算: 割り切れなくても1円以上ずれない', () => {
  const r = computeSettlement([M('a'), M('b'), M('c')], { a: 100 }, []);
  const sent = r.transfers.reduce((s, t) => s + t.amount, 0);
  assert.ok(Math.abs(sent - 67) <= 1, `sent=${sent}`);
});

test('精算: 対象が1人以下なら何もしない', () => {
  assert.deepEqual(computeSettlement([M('a')], { a: 100 }, []).transfers, []);
});

test('集計', () => {
  const s = summarize([
    { kind: 'expense', amount: 1000, category_id: 'food', member_id: 'a' },
    { kind: 'expense', amount: 500, category_id: 'food', member_id: 'b' },
    { kind: 'income', amount: 5000, category_id: 'pay', member_id: 'a' },
  ]);
  assert.equal(s.expense, 1500);
  assert.equal(s.income, 5000);
  assert.equal(s.balance, 3500);
  assert.equal(s.byCategory.get('food'), 1500);
  assert.equal(s.byMember.get('a'), 1000);
});

test('予算の状態', () => {
  assert.equal(budgetStatus(100, 0), null);
  assert.equal(budgetStatus(5000, 10000).key, 'ok');
  assert.equal(budgetStatus(8000, 10000).key, 'warn');
  assert.equal(budgetStatus(10000, 10000).key, 'warn');
  assert.equal(budgetStatus(10001, 10000).key, 'over');
});

test('CSVと金額表示', () => {
  assert.equal(toCsv([['a', 'b,c', 'd"e']]), 'a,"b,c","d""e"');
  assert.equal(yen(1234567), '¥1,234,567');
  assert.equal(yen(-500), '-¥500');
});

test('記録状況: 固定費の自動記録は数えず、最後の入力からの日数を出す', () => {
  const tx = [
    { date: '2026-09-18', recurring_id: 'r' },
    { date: '2026-09-14', recurring_id: null },
    { date: '2026-09-14', recurring_id: null },
    { date: '2026-09-02', recurring_id: null },
    { date: '2026-08-30', recurring_id: null },
  ];
  assert.deepEqual(recordingStatus(tx, '2026-09-18'), { today: false, daysThisMonth: 2, gapDays: 4 });
  assert.deepEqual(recordingStatus(tx, '2026-09-14'), { today: true, daysThisMonth: 2, gapDays: 0 });
  assert.deepEqual(recordingStatus([], '2026-09-18'), { today: false, daysThisMonth: 0, gapDays: null });
});

test('よく使う入力: 2回以上使ったメモ付きだけ、回数順、金額は直近のもの', () => {
  const t = (memo, amount, category_id = 'food') => ({ kind: 'expense', category_id, memo, amount, shared: true, recurring_id: null });
  const presets = quickPresets([t('スーパー', 3200), t('ランチ', 900, 'eat'), t('スーパー', 2800), t('スーパー', 4100), t('ランチ', 1000, 'eat'), t('一度だけ', 500), t('', 100), t('', 200)]);
  assert.deepEqual(presets.map((p) => [p.memo, p.amount, p.count]), [['スーパー', 3200, 3], ['ランチ', 900, 2]]);
});

test('予定: 毎年のものは指定の月だけ発生し、自動記録もその月だけ', () => {
  const tax = rec({ id: 'tax', every: 'year', month_of_year: 5, day: 31, start_month: '2026-01' });
  assert.equal(occursIn(tax, '2026-05'), true);
  assert.equal(occursIn(tax, '2026-06'), false);
  assert.deepEqual(dueRecurring([tax], '2027-06-01').rows.map((r) => r.date), ['2026-05-31', '2027-05-31']);
});

test('予定: 1回だけのものは、その月にしか出ない', () => {
  const once = rec({ id: 'once', day: 5, start_month: '2026-11', end_month: '2026-11' });
  assert.equal(occursIn(once, '2026-10'), false);
  assert.equal(occursIn(once, '2026-12'), false);
  assert.deepEqual(dueRecurring([once], '2027-03-01').rows.map((r) => r.date), ['2026-11-05']);
});

test('予定の一覧: 済み・これから・記録なしを分け、実際に記録された金額を使う', () => {
  const list = [rec({ id: 'phone', day: 1, amount: 7800 }), rec({ id: 'rent', day: 27 }), rec({ id: 'gym', day: 10, amount: 8800 }), rec({ id: 'off', active: false })];
  const tx = [{ recurring_id: 'phone', date: '2026-09-01', amount: 8100 }];
  const s = scheduleForMonth(list, '2026-09', '2026-09-18', tx);
  assert.deepEqual(s.items.map((i) => [i.r.id, i.status, i.amount, i.daysLeft]), [['phone', 'done', 8100, -17], ['gym', 'skipped', 8800, -8], ['rent', 'upcoming', 80000, 9]]);
  assert.equal(s.expenseUpcoming, 80000);
  assert.equal(s.expenseDone, 8100);
});

const loan = (o) => ({ id: Math.random().toString(36), date: '2026-09-01', member_id: 'papa', direction: 'lent', counterparty_member_id: null, counterparty_name: 'たろう', amount: 10000, repaid: 0, memo: '', ...o });

test('貸し借り: 同じ相手とは差し引きし、返し終わったものは別にする', () => {
  const s = summarizeLoans([
    loan({ amount: 10000 }),
    loan({ direction: 'borrowed', amount: 3000 }),
    loan({ amount: 5000, repaid: 5000 }),
  ]);
  assert.equal(s.pairs.length, 1);
  assert.deepEqual([s.pairs[0].from.name, s.pairs[0].to.member_id, s.pairs[0].amount], ['たろう', 'papa', 7000]);
  assert.equal(s.pairs[0].items.length, 2);
  assert.equal(s.settled.length, 1);
  assert.equal(s.lentOutside, 10000);
  assert.equal(s.borrowedOutside, 3000);
});

test('貸し借り: 一部返済で残りが減る。家族どうしは外との合計に入れない', () => {
  const s = summarizeLoans([loan({ counterparty_member_id: 'mama', counterparty_name: '', direction: 'borrowed', amount: 8000, repaid: 3000 })]);
  assert.deepEqual([s.pairs[0].from.member_id, s.pairs[0].to.member_id, s.pairs[0].amount], ['papa', 'mama', 5000]);
  assert.equal(s.lentOutside + s.borrowedOutside, 0);
});

test('貯金目標: 進み具合と、期限までの毎月の目安', () => {
  const goal = { id: 'g', target: 300000, deadline_month: '2027-02' };
  const deposits = [{ goal_id: 'g', member_id: 'papa', amount: 60000 }, { goal_id: 'g', member_id: 'mama', amount: 30000 }, { goal_id: 'other', member_id: 'papa', amount: 999 }];
  const p = goalProgress(goal, deposits, '2026-09-21');
  assert.equal(p.saved, 90000);
  assert.equal(p.left, 210000);
  assert.equal(p.monthsLeft, 6); // 9,10,11,12,1,2月
  assert.equal(p.perMonth, 35000);
  assert.equal(p.byMember.get('papa'), 60000);
  assert.equal(p.reached, false);
});

test('貯金目標: 達成・期限切れ・期限なし', () => {
  assert.equal(goalProgress({ id: 'g', target: 1000 }, [{ goal_id: 'g', amount: 1500 }], '2026-09-21').ratio, 1);
  assert.equal(goalProgress({ id: 'g', target: 1000 }, [{ goal_id: 'g', amount: 1500 }], '2026-09-21').reached, true);
  assert.equal(goalProgress({ id: 'g', target: 1000, deadline_month: '2026-08' }, [], '2026-09-21').overdue, true);
  assert.equal(goalProgress({ id: 'g', target: 1000 }, [], '2026-09-21').perMonth, null);
});
