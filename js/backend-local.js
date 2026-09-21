// お試しモード: この端末のブラウザ内(localStorage)だけに保存する
import { DEFAULT_CATEGORIES } from './logic.js';

const KEY = 'kakeibo-local-v1';
const TABLES = ['members', 'categories', 'transactions', 'budgets', 'recurring', 'settlements', 'loans', 'goals', 'goal_deposits'];

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || null;
  } catch {
    return null;
  }
}

// key を変えると別の保存場所になる(動作確認で「クラウド役」を代用するときに使う)
export function createLocalBackend(key = KEY) {
  let db = load(key);
  // 後から増えたテーブルを、保存済みのデータにも足しておく
  if (db) for (const t of TABLES) db[t] ||= [];
  const persist = () => localStorage.setItem(key, JSON.stringify(db));
  const uid = () => crypto.randomUUID();

  return {
    mode: 'local',

    async init() {
      return db ? 'ready' : 'needs-household';
    },

    async createHousehold(name, memberName) {
      db = { household: { id: uid(), name, invite_code: null } };
      for (const t of TABLES) db[t] = [];
      db.members.push({ id: uid(), name: memberName, user_id: 'local', in_settlement: true, sort: 0 });
      DEFAULT_CATEGORIES.forEach(([kind, cname, icon], i) => {
        db.categories.push({ id: uid(), kind, name: cname, icon, sort: i, archived: false });
      });
      persist();
    },

    async getHousehold() {
      return db.household;
    },

    async saveHousehold(patch) {
      Object.assign(db.household, patch);
      persist();
    },

    async myMemberId() {
      return db.members.find((m) => m.user_id === 'local')?.id || null;
    },

    async list(table, range) {
      let rows = db[table].slice();
      if (range) rows = rows.filter((r) => r.date >= range.from && r.date <= range.to);
      return rows;
    },

    async save(table, row) {
      const rows = db[table];
      if (row.id) {
        const i = rows.findIndex((r) => r.id === row.id);
        if (i >= 0) rows[i] = { ...rows[i], ...row };
        else rows.push(row);
      } else {
        row = { ...row, id: uid(), created_at: new Date().toISOString() };
        rows.push(row);
      }
      persist();
      return row;
    },

    async insertMany(table, rows) {
      for (const row of rows) db[table].push({ ...row, id: uid(), created_at: new Date().toISOString() });
      persist();
    },

    async patch(table, id, fields) {
      const row = db[table].find((r) => r.id === id);
      if (row) Object.assign(row, fields);
      persist();
    },

    async remove(table, id) {
      db[table] = db[table].filter((r) => r.id !== id);
      // 参照の後始末(クラウド側の on delete と同じ動き)
      if (table === 'categories') {
        db.budgets = db.budgets.filter((b) => b.category_id !== id);
        for (const t of [...db.transactions, ...db.recurring]) if (t.category_id === id) t.category_id = null;
      }
      if (table === 'members') {
        db.settlements = db.settlements.filter((s) => s.from_member !== id && s.to_member !== id);
        for (const t of [...db.transactions, ...db.recurring, ...db.loans, ...db.goal_deposits]) if (t.member_id === id) t.member_id = null;
        for (const l of db.loans) if (l.counterparty_member_id === id) l.counterparty_member_id = null;
      }
      if (table === 'goals') db.goal_deposits = db.goal_deposits.filter((d) => d.goal_id !== id);
      if (table === 'recurring') {
        for (const t of db.transactions) if (t.recurring_id === id) t.recurring_id = null;
      }
      persist();
    },

    async insertGenerated(rows) {
      for (const row of rows) {
        const dup = db.transactions.some((t) => t.recurring_id === row.recurring_id && t.date === row.date);
        if (!dup) db.transactions.push({ ...row, id: uid(), created_at: new Date().toISOString() });
      }
      persist();
    },

    async clearAllSplits() {
      for (const t of [...db.transactions, ...db.recurring]) t.shared = false;
      db.settlements = [];
      persist();
    },

    async sharedPaidTotals() {
      const totals = {};
      for (const t of db.transactions) {
        if (t.kind === 'expense' && t.shared && t.member_id) {
          totals[t.member_id] = (totals[t.member_id] || 0) + t.amount;
        }
      }
      return totals;
    },

    onChange() {},

    async exportAll() {
      return db;
    },

    async resetAll() {
      localStorage.removeItem(key);
      db = null;
    },
  };
}
