// クラウドモード: Supabase に保存して家族で同期する
import { DEFAULT_CATEGORIES } from './logic.js';

const PAGE = 1000;

function jaError(error) {
  const msg = error?.message || String(error);
  const table = [
    ['Invalid login credentials', 'メールアドレスかパスワードが違います'],
    ['User already registered', 'このメールアドレスは登録済みです。ログインしてください'],
    ['Email not confirmed', '確認メールのリンクを開いてからログインしてください'],
    ['Password should be at least', 'パスワードは6文字以上にしてください'],
    ['Failed to fetch', '通信できませんでした。電波の状態を確認してください'],
  ];
  for (const [en, ja] of table) if (msg.includes(en)) return new Error(ja);
  return new Error(msg);
}

// ブラウザに「このサイトの保存データを勝手に消さないで」と頼む(ログイン状態が消えにくくなる)
function keepStorage() {
  navigator.storage?.persist?.().catch(() => {});
}

export async function createSupabaseBackend(url, anonKey) {
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  const sb = createClient(url, anonKey);
  let user = null;
  let me = null; // 自分の members 行
  let household = null;

  const check = ({ data, error }) => {
    if (error) throw jaError(error);
    return data;
  };

  async function loadMembership() {
    me = null;
    household = null;
    const rows = check(await sb.from('members').select('*').eq('user_id', user.id).limit(1));
    if (!rows.length) return false;
    me = rows[0];
    household = check(await sb.from('households').select('*').eq('id', me.household_id).single());
    return true;
  }

  return {
    mode: 'cloud',

    async init() {
      const { data } = await sb.auth.getSession();
      user = data.session?.user || null;
      if (!user) {
        // ログイン情報は残っているのに電波がなくて確認できないだけなら、ログイン画面には戻さない
        const remembered = Object.keys(localStorage).some((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
        return remembered && !navigator.onLine ? 'offline' : 'needs-auth';
      }
      keepStorage();
      try {
        return (await loadMembership()) ? 'ready' : 'needs-household';
      } catch (e) {
        if (!navigator.onLine) return 'offline';
        throw e;
      }
    },

    userEmail() {
      return user?.email || '';
    },

    async signUp(email, password) {
      const data = check(await sb.auth.signUp({ email, password }));
      if (!data.session) return 'confirm-email';
      user = data.user;
      keepStorage();
      return 'ok';
    },

    async signIn(email, password) {
      const data = check(await sb.auth.signInWithPassword({ email, password }));
      user = data.user;
      keepStorage();
    },

    async signOut() {
      await sb.auth.signOut();
      user = null;
    },

    async createHousehold(name, memberName) {
      check(await sb.rpc('create_household', { p_name: name, p_member_name: memberName, p_categories: DEFAULT_CATEGORIES }));
      await loadMembership();
    },

    async joinHousehold(code, memberName) {
      check(await sb.rpc('join_household', { p_code: code, p_member_name: memberName }));
      await loadMembership();
    },

    async getHousehold() {
      return household;
    },

    async saveHousehold(patch) {
      household = check(await sb.from('households').update(patch).eq('id', household.id).select().single());
    },

    async myMemberId() {
      return me?.id || null;
    },

    async list(table, range) {
      const out = [];
      for (let offset = 0; ; offset += PAGE) {
        let q = sb.from(table).select('*').eq('household_id', household.id);
        if (range) q = q.gte('date', range.from).lte('date', range.to);
        const rows = check(await q.order('id').range(offset, offset + PAGE - 1));
        out.push(...rows);
        if (rows.length < PAGE) break;
      }
      return out;
    },

    async save(table, row) {
      const payload = { ...row, household_id: household.id };
      return check(await sb.from(table).upsert(payload).select().single());
    },

    // まとめて追加(お試しデータの引き継ぎ用)
    async insertMany(table, rows) {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500).map((r) => ({ ...r, household_id: household.id }));
        check(await sb.from(table).insert(chunk));
      }
    },

    async patch(table, id, fields) {
      check(await sb.from(table).update(fields).eq('id', id));
    },

    async remove(table, id) {
      check(await sb.from(table).delete().eq('id', id));
    },

    async insertGenerated(rows) {
      if (!rows.length) return;
      const payload = rows.map((r) => ({ ...r, household_id: household.id }));
      check(await sb.from('transactions').upsert(payload, { onConflict: 'recurring_id,date', ignoreDuplicates: true }));
    },

    // 「メンバーで分割」をすべて解除し、精算をゼロから始め直す(渡したお金の記録も消す)
    async clearAllSplits() {
      check(await sb.from('transactions').update({ shared: false }).eq('household_id', household.id).eq('shared', true));
      check(await sb.from('recurring').update({ shared: false }).eq('household_id', household.id).eq('shared', true));
      check(await sb.from('settlements').delete().eq('household_id', household.id));
    },

    async sharedPaidTotals() {
      const rows = check(await sb.rpc('shared_paid_totals', { p_household: household.id }));
      const totals = {};
      for (const r of rows) totals[r.member_id] = Number(r.total);
      return totals;
    },

    // 家族の誰かがデータを変えたら呼ばれる
    onChange(callback) {
      const channel = sb.channel('household-changes');
      for (const table of ['transactions', 'members', 'categories', 'recurring', 'budgets', 'settlements', 'loans', 'goals', 'goal_deposits']) {
        // 絞り込みは付けない(削除の通知は絞り込めないため)。他の家族のデータは RLS により届かない
        channel.on('postgres_changes', { event: '*', schema: 'public', table }, callback);
      }
      channel.subscribe();
    },

    async exportAll() {
      const out = { household };
      for (const t of ['members', 'categories', 'transactions', 'budgets', 'recurring', 'settlements', 'loans', 'goals', 'goal_deposits']) out[t] = await this.list(t);
      return out;
    },
  };
}
