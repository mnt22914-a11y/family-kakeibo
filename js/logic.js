// 画面に依存しない計算ロジック(node でテスト可能)

export const pad2 = (n) => String(n).padStart(2, '0');

export function toDateStr(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function monthOf(dateStr) {
  return dateStr.slice(0, 7);
}

export function addMonths(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthRange(month) {
  return { from: `${month}-01`, to: `${month}-${pad2(daysInMonth(month))}` };
}

export function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}年${m}月`;
}

export function yen(n) {
  const v = Math.round(n || 0);
  return `${v < 0 ? '-' : ''}¥${Math.abs(v).toLocaleString('ja-JP')}`;
}

// 固定費: 指定月の発生日(31日指定で30日までの月は月末に寄せる)
export function recurringDate(month, day) {
  return `${month}-${pad2(Math.min(day, daysInMonth(month)))}`;
}

// その月に発生する予定かどうか(毎月 / 毎年 / 1回だけ = 開始月と終了月が同じ)
export function occursIn(r, month) {
  if (!r.active) return false;
  if (month < r.start_month) return false;
  if (r.end_month && month > r.end_month) return false;
  if (r.every === 'year' && Number(month.slice(5)) !== r.month_of_year) return false;
  return true;
}

export const isOnce = (r) => Boolean(r.end_month) && r.start_month === r.end_month;

export function daysBetween(fromStr, toStr) {
  return Math.round((new Date(`${toStr}T00:00:00`) - new Date(`${fromStr}T00:00:00`)) / 86400000);
}

// ある月の支払い予定の一覧。
//  status: 'upcoming' これから / 'done' 記録済み / 'skipped' 日付は過ぎたが記録がない(手で消した等)
export function scheduleForMonth(recurringList, month, todayStr, transactions) {
  const items = recurringList.filter((r) => occursIn(r, month)).map((r) => {
    const date = recurringDate(month, r.day);
    const tx = transactions.find((t) => t.recurring_id === r.id && monthOf(t.date) === month);
    const status = date > todayStr ? 'upcoming' : tx ? 'done' : 'skipped';
    return { r, date, status, amount: tx ? tx.amount : r.amount, daysLeft: daysBetween(todayStr, date) };
  });
  items.sort((a, b) => a.date.localeCompare(b.date) || b.amount - a.amount);
  const sum = (kind, status) => items.filter((i) => i.r.kind === kind && i.status === status).reduce((a, i) => a + i.amount, 0);
  return {
    items,
    expenseUpcoming: sum('expense', 'upcoming'),
    expenseDone: sum('expense', 'done'),
    incomeUpcoming: sum('income', 'upcoming'),
    incomeDone: sum('income', 'done'),
  };
}

// 固定費から、まだ作られていない取引を作る。
// 戻り値: { rows: 追加する取引, updates: [{id, last_generated}] }
export function dueRecurring(recurringList, todayStr) {
  const thisMonth = monthOf(todayStr);
  const rows = [];
  const updates = [];
  for (const r of recurringList) {
    if (!r.active) continue;
    let month = r.last_generated ? addMonths(r.last_generated, 1) : r.start_month;
    // 長期間開いていなかった場合でも最大24か月分まで
    const oldest = addMonths(thisMonth, -24);
    if (month < oldest) month = oldest;
    let last = null;
    while (month <= thisMonth) {
      if (r.end_month && month > r.end_month) break;
      if (r.every === 'year' && Number(month.slice(5)) !== r.month_of_year) {
        month = addMonths(month, 1);
        continue;
      }
      const date = recurringDate(month, r.day);
      if (date > todayStr) break;
      rows.push({
        date,
        kind: r.kind,
        amount: r.amount,
        category_id: r.category_id,
        member_id: r.member_id,
        shared: r.shared,
        memo: r.name,
        recurring_id: r.id,
      });
      last = month;
      month = addMonths(month, 1);
    }
    if (last) updates.push({ id: r.id, last_generated: last });
  }
  return { rows, updates };
}

// 月の集計
export function summarize(transactions) {
  let income = 0;
  let expense = 0;
  const byCategory = new Map();
  const byMember = new Map();
  for (const t of transactions) {
    if (t.kind === 'income') {
      income += t.amount;
    } else {
      expense += t.amount;
      byCategory.set(t.category_id, (byCategory.get(t.category_id) || 0) + t.amount);
      byMember.set(t.member_id, (byMember.get(t.member_id) || 0) + t.amount);
    }
  }
  return { income, expense, balance: income - expense, byCategory, byMember };
}

// 精算の計算。
//  members: [{id, in_settlement}]
//  paidTotals: {member_id: 「メンバーで分割」にした支出として払った合計}
//  settlements: [{from_member, to_member, amount}]
// 分割にした支出は、精算対象メンバーで均等割り。
// 戻り値: { total, share, balances: [{member_id, paid, balance}], transfers: [{from, to, amount}] }
//  balance > 0 は「もらう側」、< 0 は「払う側」
export function computeSettlement(members, paidTotals, settlements) {
  const parts = members.filter((m) => m.in_settlement);
  if (parts.length < 2) return { total: 0, share: 0, balances: [], transfers: [] };
  const ids = new Set(parts.map((m) => m.id));
  let total = 0;
  for (const m of parts) total += paidTotals[m.id] || 0;
  const share = total / parts.length;
  const bal = new Map(parts.map((m) => [m.id, (paidTotals[m.id] || 0) - share]));
  for (const s of settlements) {
    if (ids.has(s.from_member)) bal.set(s.from_member, bal.get(s.from_member) + s.amount);
    if (ids.has(s.to_member)) bal.set(s.to_member, bal.get(s.to_member) - s.amount);
  }
  const balances = parts.map((m) => ({
    member_id: m.id,
    paid: paidTotals[m.id] || 0,
    balance: Math.round(bal.get(m.id)),
  }));

  // 多く払っている人へ、少ない人から順に送る
  const debtors = balances.filter((b) => b.balance < 0).map((b) => ({ id: b.member_id, v: -b.balance }));
  const creditors = balances.filter((b) => b.balance > 0).map((b) => ({ id: b.member_id, v: b.balance }));
  debtors.sort((a, b) => b.v - a.v);
  creditors.sort((a, b) => b.v - a.v);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].v, creditors[j].v);
    if (amount >= 1) transfers.push({ from: debtors[i].id, to: creditors[j].id, amount });
    debtors[i].v -= amount;
    creditors[j].v -= amount;
    if (debtors[i].v < 1) i++;
    if (creditors[j].v < 1) j++;
  }
  return { total, share, balances, transfers };
}

// 記録の続き具合(固定費の自動記録は数えない)
//  戻り値: { today: 今日入力したか, daysThisMonth: 今月記録した日数, gapDays: 最後の記録から何日か(記録なしは null) }
export function recordingStatus(transactions, todayStr) {
  const manual = transactions.filter((t) => !t.recurring_id && t.date <= todayStr);
  const thisMonth = monthOf(todayStr);
  const days = new Set(manual.filter((t) => monthOf(t.date) === thisMonth).map((t) => t.date));
  let last = null;
  for (const t of manual) if (!last || t.date > last) last = t.date;
  const gapDays = last ? daysBetween(last, todayStr) : null;
  return { today: days.has(todayStr), daysThisMonth: days.size, gapDays };
}

// よく使う入力(メモ付きで2回以上使った組み合わせ)。transactions は新しい順に並んでいること
export function quickPresets(transactions, limit = 6) {
  const map = new Map();
  for (const t of transactions) {
    if (t.recurring_id || !t.memo || !t.category_id) continue;
    const key = `${t.kind}|${t.category_id}|${t.memo}`;
    const p = map.get(key);
    if (p) p.count++;
    else map.set(key, { kind: t.kind, category_id: t.category_id, memo: t.memo, amount: t.amount, shared: t.shared, count: 1 });
  }
  return [...map.values()].filter((p) => p.count >= 2).sort((a, b) => b.count - a.count).slice(0, limit);
}

// ───────── 個人間の貸し借り ─────────

// 貸した側・借りた側を取り出す。相手は家族({member_id})か、家族以外({name})
export function loanParties(loan) {
  const me = { member_id: loan.member_id, name: '' };
  const other = loan.counterparty_member_id ? { member_id: loan.counterparty_member_id, name: '' } : { member_id: null, name: loan.counterparty_name || '相手' };
  return loan.direction === 'lent' ? { lender: me, borrower: other } : { lender: other, borrower: me };
}

const partyKey = (p) => (p.member_id ? `m:${p.member_id}` : `o:${p.name}`);

// まだ返し終わっていない貸し借りを、相手の組み合わせごとに差し引きしてまとめる。
//  戻り値: { pairs: [{ from(返す人), to(受け取る人), amount(差し引きの残り), items }], lentOutside, borrowedOutside, settled }
export function summarizeLoans(loans) {
  const groups = new Map();
  const settled = [];
  let lentOutside = 0;
  let borrowedOutside = 0;
  for (const loan of loans) {
    const remaining = loan.amount - loan.repaid;
    if (remaining <= 0) { settled.push(loan); continue; }
    const { lender, borrower } = loanParties(loan);
    if (!lender.member_id) borrowedOutside += remaining;
    if (!borrower.member_id) lentOutside += remaining;
    const [a, b] = [lender, borrower].sort((x, y) => partyKey(x).localeCompare(partyKey(y)));
    const key = `${partyKey(a)}|${partyKey(b)}`;
    const g = groups.get(key) || { a, b, net: 0, items: [] }; // net > 0 なら b が a に返す
    g.net += partyKey(lender) === partyKey(a) ? remaining : -remaining;
    g.items.push({ loan, remaining, lender, borrower });
    groups.set(key, g);
  }
  const pairs = [...groups.values()].map((g) => ({
    from: g.net >= 0 ? g.b : g.a,
    to: g.net >= 0 ? g.a : g.b,
    amount: Math.abs(g.net),
    items: g.items.sort((x, y) => x.loan.date.localeCompare(y.loan.date)),
  })).sort((x, y) => y.amount - x.amount);
  settled.sort((x, y) => y.date.localeCompare(x.date));
  return { pairs, lentOutside, borrowedOutside, settled };
}

// ───────── 貯金目標 ─────────

export function monthsBetween(fromMonth, toMonth) {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm);
}

// 目標の進み具合。期限があれば「毎月いくらで間に合うか」も出す(今月を含めて数える)
export function goalProgress(goal, deposits, todayStr) {
  const mine = deposits.filter((d) => d.goal_id === goal.id);
  const saved = mine.reduce((a, d) => a + d.amount, 0);
  const byMember = new Map();
  for (const d of mine) byMember.set(d.member_id, (byMember.get(d.member_id) || 0) + d.amount);
  const left = Math.max(0, goal.target - saved);
  let monthsLeft = null;
  let perMonth = null;
  let overdue = false;
  if (goal.deadline_month && left > 0) {
    const diff = monthsBetween(monthOf(todayStr), goal.deadline_month);
    overdue = diff < 0;
    if (!overdue) {
      monthsLeft = diff + 1;
      perMonth = Math.ceil(left / monthsLeft);
    }
  }
  return { saved, left, ratio: Math.min(1, saved / goal.target), reached: saved >= goal.target, byMember, monthsLeft, perMonth, overdue, count: mine.length };
}

// 予算の状態
export function budgetStatus(spent, budget) {
  if (!budget) return null;
  const ratio = spent / budget;
  if (ratio > 1) return { key: 'over', label: '予算オーバー', ratio };
  if (ratio >= 0.8) return { key: 'warn', label: 'もうすぐ上限', ratio };
  return { key: 'ok', label: '順調', ratio };
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

export const DEFAULT_CATEGORIES = [
  ['expense', '食費', '🍚'],
  ['expense', '日用品', '🧻'],
  ['expense', '外食', '🍽️'],
  ['expense', '住居', '🏠'],
  ['expense', '水道光熱', '💡'],
  ['expense', '通信', '📱'],
  ['expense', '交通', '🚃'],
  ['expense', '医療', '🏥'],
  ['expense', '教育・子ども', '🎒'],
  ['expense', '衣服・美容', '👕'],
  ['expense', '趣味・レジャー', '🎮'],
  ['expense', '保険', '🛡️'],
  ['expense', 'その他', '📦'],
  ['income', '給与', '💼'],
  ['income', '児童手当', '👶'],
  ['income', 'その他収入', '💰'],
];
