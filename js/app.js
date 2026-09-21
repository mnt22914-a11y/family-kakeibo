import {
  toDateStr, monthOf, addMonths, monthRange, monthLabel, yen, daysInMonth, scheduleForMonth, isOnce,
  summarizeLoans, loanParties, goalProgress,
  dueRecurring, summarize, computeSettlement, budgetStatus, toCsv, recordingStatus, quickPresets,
} from './logic.js';
import { createLocalBackend } from './backend-local.js';

const $app = document.getElementById('app');
const $tabbar = document.getElementById('tabbar');
const $sheetRoot = document.getElementById('sheet-root');
const $toast = document.getElementById('toast');

let backend;
const state = {
  tab: ['home', 'plan', 'goals', 'history', 'settle', 'settings'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'quick',
  quickAmount: '', // かんたん入力で打ちかけの金額
  bubbleMode: 'category', // まとめの泡: 'category' = カテゴリ別 / 'member' = 家族別
  month: monthOf(toDateStr(new Date())),
  historyMember: 'all',
  household: null,
  myMemberId: null,
  members: [],
  categories: [],
  budgets: [],
  recurring: [],
  settlements: [],
  loans: [],
  goals: [],
  goalDeposits: [],
  settleMode: 'split', // 精算タブ: 'split' = 立て替えの精算 / 'loans' = 個人の貸し借り
  tx: [], // 表示月を含む直近6か月分
  paidTotals: {},
};

// ───────── 小道具 ─────────

const h = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => toDateStr(new Date());
const byId = (list, id) => list.find((x) => x.id === id);
const memberName = (id) => byId(state.members, id)?.name || '未設定';
const memberSlot = (id) => {
  const i = state.members.findIndex((m) => m.id === id);
  return i < 0 ? 0 : (i % 8) + 1;
};
const category = (id) => byId(state.categories, id) || { name: '未分類', icon: '❔' };

function parseAmount(text) {
  const half = String(text).replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  const n = parseInt(half.replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

let toastTimer;
// actions: [{ label, run }] を渡すと、押せるボタン付きで少し長く表示する
function toast(message, actions = []) {
  $toast.textContent = message;
  for (const a of actions) {
    const btn = document.createElement('button');
    btn.textContent = a.label;
    btn.addEventListener('click', () => { $toast.classList.remove('show'); a.run(); });
    $toast.append(btn);
  }
  $toast.classList.toggle('actionable', actions.length > 0);
  $toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toast.classList.remove('show'), actions.length ? 6000 : 2200);
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    toast(e.message || 'エラーが起きました');
    return undefined;
  }
}

// ───────── 起動 ─────────

async function boot() {
  const cfg = window.KAKEIBO_CONFIG || {};
  if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
    const { createSupabaseBackend } = await import('./backend-supabase.js');
    backend = await createSupabaseBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  } else {
    backend = createLocalBackend();
  }
  await route(await backend.init());
}

async function route(status) {
  $tabbar.hidden = true;
  if (status === 'needs-auth') return renderAuth();
  if (status === 'needs-household') return renderSetup();
  await startMain();
}

async function startMain() {
  $app.innerHTML = '<p class="loading">読み込み中…</p>';
  state.household = await backend.getHousehold();
  state.myMemberId = await backend.myMemberId();
  await runRecurring();
  await loadAll();
  $tabbar.hidden = false;
  render();

  let timer;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if ($app.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return refresh();
      await guard(loadAll);
      render();
    }, 600);
  };
  backend.onChange(refresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
}

async function runRecurring() {
  await guard(async () => {
    const list = await backend.list('recurring');
    const { rows, updates } = dueRecurring(list, today());
    if (!rows.length) return;
    await backend.insertGenerated(rows);
    for (const u of updates) await backend.patch('recurring', u.id, { last_generated: u.last_generated });
  });
}

async function loadAll() {
  const range = { from: `${addMonths(state.month, -5)}-01`, to: monthRange(state.month).to };
  const [members, categories, budgets, recurring, settlements, tx, paidTotals, loans, goals, goalDeposits] = await Promise.all([
    backend.list('members'),
    backend.list('categories'),
    backend.list('budgets'),
    backend.list('recurring'),
    backend.list('settlements'),
    backend.list('transactions', range),
    backend.sharedPaidTotals(),
    backend.list('loans'),
    backend.list('goals'),
    backend.list('goal_deposits'),
  ]);
  const bySort = (a, b) => a.sort - b.sort || String(a.created_at).localeCompare(String(b.created_at));
  state.members = members.sort(bySort);
  state.categories = categories.sort(bySort);
  state.budgets = budgets;
  state.recurring = recurring.sort((a, b) => a.day - b.day);
  state.settlements = settlements.sort((a, b) => b.date.localeCompare(a.date));
  state.tx = tx.sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
  state.paidTotals = paidTotals;
  state.loans = loans;
  state.goals = goals.sort(bySort);
  state.goalDeposits = goalDeposits.sort((a, b) => b.date.localeCompare(a.date) || String(b.created_at).localeCompare(String(a.created_at)));
}

async function reload(message) {
  await guard(loadAll);
  render();
  if (message) toast(message);
}

// ───────── ログイン・初期設定 ─────────

function renderAuth() {
  $app.innerHTML = `
    <section class="center-card">
      <div class="logo">👛</div>
      <h1>家族の家計簿</h1>
      <p class="muted">家族それぞれが自分のメールアドレスで登録します。</p>
      <form id="auth-form" class="form">
        <label>メールアドレス<input name="email" type="email" autocomplete="email" required></label>
        <label>パスワード(6文字以上)<input name="password" type="password" autocomplete="current-password" minlength="6" required></label>
        <button class="btn primary" name="mode" value="signin">ログイン</button>
        <button class="btn" name="mode" value="signup">はじめての方: 新規登録</button>
      </form>
    </section>`;
  document.getElementById('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const mode = e.submitter?.value || 'signin';
    guard(async () => {
      if (mode === 'signup') {
        const result = await backend.signUp(f.get('email'), f.get('password'));
        if (result === 'confirm-email') return toast('確認メールを送りました。メール内のリンクを開いてからログインしてください');
      } else {
        await backend.signIn(f.get('email'), f.get('password'));
      }
      await route(await backend.init());
    });
  });
}

function renderSetup() {
  const cloud = backend.mode === 'cloud';
  $app.innerHTML = `
    <section class="center-card">
      <div class="logo">👛</div>
      <h1>はじめに</h1>
      ${cloud ? '' : '<p class="notice">お試しモードです。データはこの端末のブラウザ内だけに保存されます。</p>'}
      <form id="create-form" class="form">
        <h2>新しく家計を作る</h2>
        <label>家計の名前<input name="name" required placeholder="例: 山田家" maxlength="30"></label>
        <label>あなたの呼び名<input name="member" required placeholder="例: パパ" maxlength="20"></label>
        <button class="btn primary">この内容ではじめる</button>
      </form>
      ${cloud ? `
      <form id="join-form" class="form">
        <h2>家族が作った家計に参加する</h2>
        <label>招待コード<input name="code" required placeholder="8文字のコード" maxlength="8" autocapitalize="characters"></label>
        <label>あなたの呼び名<input name="member" required placeholder="例: ママ" maxlength="20"></label>
        <button class="btn">参加する</button>
      </form>
      <button class="link" id="signout">別のアカウントでログインし直す</button>` : ''}
    </section>`;
  document.getElementById('create-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    guard(async () => {
      await backend.createHousehold(f.get('name').trim(), f.get('member').trim());
      await startMain();
    });
  });
  document.getElementById('join-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    guard(async () => {
      await backend.joinHousehold(f.get('code'), f.get('member').trim());
      await startMain();
    });
  });
  document.getElementById('signout')?.addEventListener('click', async () => {
    await backend.signOut();
    route('needs-auth');
  });
}

// ───────── 画面の描画 ─────────

function render() {
  const activeTab = ['plan', 'goals'].includes(state.tab) ? 'home' : state.tab; // 支払い予定・貯金目標は「まとめ」の中のページ
  for (const b of $tabbar.querySelectorAll('[data-tab]')) b.classList.toggle('active', b.dataset.tab === activeTab);
  const view = { quick: viewQuick, home: viewHome, plan: viewPlan, goals: viewGoals, history: viewHistory, settle: viewSettle, settings: viewSettings }[state.tab];
  $app.classList.toggle('quick-mode', state.tab === 'quick');
  stopBubbles();
  $app.innerHTML = view();
  if (state.tab === 'home') startBubbles();
}

function monthNav() {
  const isCurrent = state.month >= addMonths(monthOf(today()), 12);
  return `
    <header class="month-nav">
      <button data-action="month" data-delta="-1" aria-label="前の月">‹</button>
      <h1>${monthLabel(state.month)}</h1>
      <button data-action="month" data-delta="1" aria-label="次の月" ${isCurrent ? 'disabled' : ''}>›</button>
    </header>`;
}

const monthTx = () => state.tx.filter((t) => monthOf(t.date) === state.month);

// ───────── かんたん入力(最初の画面) ─────────
// 金額を打つ → カードを左(支出)か右(収入)へスワイプ → カテゴリをタップした瞬間に保存

const SWIPE_THRESHOLD = 70;
const quickAmountText = () => yen(Number(state.quickAmount || 0));

function viewQuick() {
  const t = today();
  const todaySpent = state.tx.filter((x) => x.kind === 'expense' && x.date === t).reduce((a, x) => a + x.amount, 0);
  const monthSpent = state.tx.filter((x) => x.kind === 'expense' && monthOf(x.date) === monthOf(t)).reduce((a, x) => a + x.amount, 0);
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '00', '0', 'back'];
  return `
    <section class="quick">
      <p class="quick-context">今日 <b>${yen(todaySpent)}</b><span>・</span>今月 <b>${yen(monthSpent)}</b></p>
      <div class="swipe-zone">
        <div class="swipe-card" tabindex="0" aria-label="金額カード。左にスワイプで支出、右にスワイプで収入">
          <span class="swipe-label expense">← 支出</span>
          <span class="swipe-label income">収入 →</span>
          <div class="swipe-amount ${state.quickAmount ? '' : 'empty'}">${quickAmountText()}</div>
          <div class="swipe-hint">金額を入れて、左右にスワイプ</div>
        </div>
      </div>
      <div class="swipe-buttons">
        <button data-action="quick-commit" data-kind="expense">‹ 支出</button>
        <button data-action="quick-commit" data-kind="income">収入 ›</button>
      </div>
      <div class="keypad">${keys.map((k) => `<button data-action="key" data-k="${k}" ${k === 'back' ? 'aria-label="1文字消す"' : ''}>${k === 'back' ? '⌫' : k}</button>`).join('')}</div>
      <button class="link quick-detail" data-action="add-tx">日付やメモも入れる(詳しく入力)</button>
    </section>`;
}

const calmMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SPRING = 'transform 0.55s cubic-bezier(0.2, 1.7, 0.4, 1)'; // 行き過ぎてから戻る、バネっぽい動き

function pressKey(k) {
  const before = state.quickAmount;
  let v = before;
  if (k === 'back') v = v.slice(0, -1);
  else if (k === 'clear') v = '';
  else v = (v + k).replace(/^0+/, '').slice(0, 9);
  state.quickAmount = v;
  const el = $app.querySelector('.swipe-amount');
  if (!el) return;
  el.textContent = quickAmountText();
  el.classList.toggle('empty', !v);
  if (calmMotion()) return;
  // 押すたびに金額が弾む。入れ始めたら「スワイプしてね」とカードが小さく揺れる
  el.animate([{ transform: `scale(${v.length >= before.length ? 1.14 : 0.92})` }, { transform: 'scale(1)' }], { duration: 160, easing: 'ease-out' });
  if (!before && v) {
    const card = $app.querySelector('.swipe-card');
    card.classList.remove('nudge');
    void card.offsetWidth;
    card.classList.add('nudge');
  }
}

// 引っ張り具合を見た目に反映する。決定ラインを越えた瞬間は小さく振動
function setCardPull(card, dx, transition) {
  const zone = card.parentElement;
  card.style.transition = transition || 'none';
  card.style.transform = dx ? `translate(${dx}px, ${Math.abs(dx) * 0.06}px) rotate(${dx / 16}deg)` : '';
  const pull = Math.max(-1, Math.min(1, dx / SWIPE_THRESHOLD));
  zone.style.setProperty('--pull-expense', Math.max(0, -pull));
  zone.style.setProperty('--pull-income', Math.max(0, pull));
  const armed = Math.abs(dx) >= SWIPE_THRESHOLD ? (dx < 0 ? 'expense' : 'income') : '';
  if (armed !== (zone.dataset.armed || '')) {
    zone.dataset.armed = armed;
    if (armed) navigator.vibrate?.(8);
  }
}

function resetCard() {
  const card = $app.querySelector('.swipe-card');
  if (card) setCardPull(card, 0, SPRING);
}

// 演出用の要素を動かし、終わったら消す。アニメーションが止まる環境でも、時間がくれば必ず先へ進む
function playAndRemove(el, frames, options) {
  el.animate(frames, { fill: 'both', ...options });
  return new Promise((resolve) => setTimeout(() => { el.remove(); resolve(); }, options.duration + (options.delay || 0) + 50));
}

// 絵文字をぱっと散らす。dir: -1 = 左へ飛び去る / 1 = 右から降ってくる / 0 = 四方に弾ける
function burst(emojis, rect, dir) {
  if (calmMotion()) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  for (let i = 0; i < 12; i++) {
    const el = document.createElement('span');
    el.className = 'particle';
    el.textContent = emojis[i % emojis.length];
    document.body.append(el);
    const spreadY = (Math.random() - 0.5) * 220;
    const far = 140 + Math.random() * 200;
    const angle = Math.random() * Math.PI * 2;
    const frames = dir === 0
      ? [{ transform: `translate(${cx}px, ${cy}px) scale(0.3)`, opacity: 1 }, { transform: `translate(${cx + Math.cos(angle) * far}px, ${cy + Math.sin(angle) * far}px) scale(1.4) rotate(${(Math.random() - 0.5) * 500}deg)`, opacity: 0 }]
      : dir < 0
      ? [{ transform: `translate(${cx}px, ${cy}px) scale(0.4)`, opacity: 1 }, { transform: `translate(${cx - far}px, ${cy + spreadY - 60}px) scale(1.3) rotate(${-200 - Math.random() * 200}deg)`, opacity: 0 }]
      : [{ transform: `translate(${cx + far}px, ${cy - 200 - Math.random() * 120}px) scale(1.3) rotate(${200 + Math.random() * 200}deg)`, opacity: 0 }, { opacity: 1, offset: 0.3 }, { transform: `translate(${cx + (Math.random() - 0.5) * 140}px, ${cy + (Math.random() - 0.5) * 50}px) scale(0.5)`, opacity: 0 }];
    playAndRemove(el, frames, { duration: 650 + Math.random() * 350, delay: i * 18, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
  }
}

// 絵文字が from から to へ吸い込まれる
function flyEmoji(emoji, from, to) {
  if (calmMotion() || !from || !to) return Promise.resolve();
  const el = document.createElement('span');
  el.className = 'particle big';
  el.textContent = emoji;
  document.body.append(el);
  const x0 = from.left + from.width / 2, y0 = from.top + from.height / 2;
  const x1 = to.left + to.width / 2, y1 = to.top + to.height / 2;
  return playAndRemove(el, [
    { transform: `translate(${x0}px, ${y0}px) scale(1.2)`, opacity: 1 },
    { transform: `translate(${(x0 + x1) / 2 + 60}px, ${(y0 + y1) / 2}px) scale(1.7) rotate(20deg)`, opacity: 1, offset: 0.55 },
    { transform: `translate(${x1}px, ${y1}px) scale(0.3) rotate(0deg)`, opacity: 0.2 },
  ], { duration: 620, easing: 'cubic-bezier(0.5, 0, 0.3, 1)' });
}

function quickCommit(kind) {
  const amount = Number(state.quickAmount || 0);
  const card = $app.querySelector('.swipe-card');
  if (!amount) {
    if (card) {
      setCardPull(card, 0, SPRING);
      card.classList.remove('shake');
      void card.offsetWidth;
      card.classList.add('shake');
    }
    return toast('先に金額を入れてください');
  }
  if (!card || calmMotion()) return openCategoryPicker(kind, amount);
  // カードを勢いよく飛ばしてから、カテゴリを出す
  const dir = kind === 'expense' ? -1 : 1;
  burst(kind === 'expense' ? ['💸', '💸', '🪙'] : ['🪙', '💰', '✨'], card.getBoundingClientRect(), dir);
  navigator.vibrate?.(14);
  setCardPull(card, dir * SWIPE_THRESHOLD, 'none');
  requestAnimationFrame(() => {
    card.style.transition = 'transform 0.32s cubic-bezier(0.4, 0, 0.9, 0.5)';
    card.style.transform = `translate(${dir * (window.innerWidth + 80)}px, 60px) rotate(${dir * 32}deg)`;
  });
  setTimeout(() => openCategoryPicker(kind, amount), 240);
}

// カテゴリは、よく使う順に並べる
function categoriesByUse(kind) {
  const uses = new Map();
  for (const t of state.tx) uses.set(t.category_id, (uses.get(t.category_id) || 0) + 1);
  return state.categories
    .filter((c) => c.kind === kind && !c.archived)
    .sort((a, b) => (uses.get(b.id) || 0) - (uses.get(a.id) || 0));
}

function openCategoryPicker(kind, amount) {
  const cats = categoriesByUse(kind);
  const presets = quickPresets(state.tx).filter((p) => p.kind === kind && cats.some((c) => c.id === p.category_id));
  $sheetRoot.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <div class="sheet picker ${kind}" role="dialog" aria-label="カテゴリを選ぶ">
      <header><h2><b>${yen(amount)}</b> の${kind === 'expense' ? '支出' : '収入'}</h2><button type="button" class="icon-btn" data-close aria-label="やめる">✕</button></header>
      <div class="sheet-body">
        ${presets.length ? `<div class="chips">${presets.map((p, i) => `<button class="chip" data-preset="${i}">${category(p.category_id).icon} ${h(p.memo)}</button>`).join('')}</div>` : ''}
        <div class="tiles">${cats.map((c, i) => `<button class="tile" style="--i:${i}" data-cat="${c.id}"><span>${c.icon}</span>${h(c.name)}</button>`).join('')}</div>
        <p class="muted small picker-note">タップするとすぐ保存します(今日・${h(memberName(state.myMemberId))})</p>
      </div>
    </div>`;
  const close = () => { $sheetRoot.innerHTML = ''; };
  let busy = false;
  $sheetRoot.querySelector('.picker').addEventListener('click', async (e) => {
    const tile = e.target.closest('[data-cat]');
    const chip = e.target.closest('[data-preset]');
    if ((!tile && !chip) || busy) return;
    busy = true;
    const preset = chip ? presets[Number(chip.dataset.preset)] : null;
    const row = {
      kind, amount, date: today(), member_id: state.myMemberId, recurring_id: null,
      category_id: preset ? preset.category_id : tile.dataset.cat,
      memo: preset ? preset.memo : '',
      shared: kind === 'expense' ? (preset ? preset.shared : true) : false,
    };
    const fromRect = (tile || chip).getBoundingClientRect();
    const saved = await guard(() => backend.save('transactions', row));
    busy = false;
    if (!saved) return;
    close();
    navigator.vibrate?.([10, 40, 18]);
    state.quickAmount = '';
    state.month = monthOf(row.date);
    const c = category(row.category_id);
    // 選んだ絵文字が「今日」の合計へ吸い込まれ、数字が増えて、新しいカードが弾んで出てくる
    const flying = flyEmoji(c.icon, fromRect, $app.querySelector('.quick-context')?.getBoundingClientRect());
    await Promise.all([flying, guard(loadAll)]);
    render();
    $app.querySelector('.swipe-card')?.classList.add('enter');
    $app.querySelector('.quick-context')?.classList.add('bump');
    toast(`${c.icon} ${row.memo || c.name} ${yen(amount)} を記録`, [
      { label: '取り消す', run: async () => { await guard(() => backend.remove('transactions', saved.id)); await reload('取り消しました'); } },
      { label: '詳細', run: () => openTxSheet(saved.id) },
    ]);
  });
  // やめたときは、飛んでいったカードがバネで戻ってくる
  for (const el of $sheetRoot.querySelectorAll('[data-close]')) el.addEventListener('click', () => { close(); resetCard(); });
}

// カードのスワイプ。ゆっくり引いても、軽くはじいても決定できる
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest('.swipe-card');
  if (!card) return;
  drag = { card, x: e.clientX, dx: 0, lastX: e.clientX, lastT: e.timeStamp, v: 0 };
  card.classList.remove('nudge', 'enter', 'shake');
  card.setPointerCapture?.(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dt = e.timeStamp - drag.lastT;
  if (dt > 0) drag.v = 0.6 * drag.v + 0.4 * ((e.clientX - drag.lastX) / dt); // px/ms をならしたもの
  drag.lastX = e.clientX;
  drag.lastT = e.timeStamp;
  drag.dx = e.clientX - drag.x;
  setCardPull(drag.card, drag.dx, 'none');
});
const endDrag = () => {
  if (!drag) return;
  const { card, dx, v } = drag;
  drag = null;
  const flicked = Math.abs(v) > 0.55 && Math.abs(dx) > 24 && Math.sign(v) === Math.sign(dx);
  if (Math.abs(dx) >= SWIPE_THRESHOLD || flicked) return quickCommit(dx < 0 ? 'expense' : 'income');
  setCardPull(card, 0, SPRING);
};
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

// パソコンではキーボードでも入力できる(数字・Backspace・←支出・→収入)
document.addEventListener('keydown', (e) => {
  if (state.tab !== 'quick' || $tabbar.hidden || $sheetRoot.childElementCount || e.metaKey || e.ctrlKey || e.altKey) return;
  if (/^INPUT|TEXTAREA|SELECT$/.test(e.target.tagName)) return;
  if (/^[0-9]$/.test(e.key)) pressKey(e.key);
  else if (e.key === 'Backspace') pressKey('back');
  else if (e.key === 'Escape') pressKey('clear');
  else if (e.key === 'ArrowLeft') quickCommit('expense');
  else if (e.key === 'ArrowRight') quickCommit('income');
  else return;
  e.preventDefault();
});

// 今月を見ているときだけ出す、記録の続き具合
function recordCard() {
  if (state.month !== monthOf(today())) return '';
  const st = recordingStatus(state.tx, today());
  if (st.gapDays !== null && st.gapDays < 3) return '';
  let message;
  if (st.today) message = '<b class="pos">✓ 今日は入力済み</b>';
  else if (st.gapDays === null) message = '<b>最初の1件を入力してみましょう</b>';
  else if (st.gapDays >= 3) message = `<b>最後の入力は${st.gapDays}日前</b><small>レシートやカード明細を見ながら、まとめて入力しても大丈夫です。</small>`;
  else message = '<b>今日の入力はまだありません</b><small>使わなかった日はそのままでOKです。</small>';
  return `
    <section class="card record-card">
      <div class="record-text">${message}<small>今月は ${st.daysThisMonth}日 記録しました</small></div>
      ${st.today ? '' : '<button class="btn primary small" data-tab="quick">入力する</button>'}
    </section>`;
}

const shortYen = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : yen(n));

function viewHome() {
  const sum = summarize(monthTx());
  const budgetOf = new Map(state.budgets.filter((b) => b.amount > 0).map((b) => [b.category_id, b.amount]));
  const totalBudget = [...budgetOf.values()].reduce((a, b) => a + b, 0);
  const budgetedSpent = [...budgetOf.keys()].reduce((a, id) => a + (sum.byCategory.get(id) || 0), 0);
  const expenseCats = state.categories.filter((c) => c.kind === 'expense');
  const thisMonth = monthOf(today());

  // 主役: あと使えるお金
  let hero;
  if (totalBudget > 0) {
    const left = totalBudget - budgetedSpent;
    const daysLeft = state.month === thisMonth ? daysInMonth(state.month) - Number(today().slice(8)) + 1 : 0;
    const st = budgetStatus(budgetedSpent, totalBudget);
    hero = `
      <div class="hero-label">${state.month === thisMonth ? '今月あと使えるお金' : '予算の残り'}</div>
      <div class="hero-value ${left < 0 ? 'neg' : ''}">${left < 0 ? `${yen(-left)} オーバー` : yen(left)}</div>
      <div class="bar-track hero-meter"><div class="bar-fill status-${st.key}" style="width:${Math.min(100, st.ratio * 100)}%"></div></div>
      <p class="hero-note">${left > 0 && daysLeft > 0 ? `1日あたり <b>${yen(Math.floor(left / daysLeft))}</b>(残り${daysLeft}日)・` : ''}予算 ${yen(totalBudget)} のうち ${yen(budgetedSpent)} 使用</p>`;
  } else {
    hero = `
      <div class="hero-label">今月の支出</div>
      <div class="hero-value">${yen(sum.expense)}</div>
      <p class="hero-note">「設定」で月の予算を決めると、ここに「あと使えるお金」が出ます。</p>`;
  }

  // 泡
  const mode = state.bubbleMode;
  let bubbles = '';
  if (mode === 'category') {
    const rows = [...sum.byCategory.entries()].sort((a, b) => b[1] - a[1]);
    const max = rows.length ? rows[0][1] : 1;
    bubbles = rows.map(([id, amount]) => {
      const c = category(id);
      const st = budgetStatus(amount, budgetOf.get(id));
      const tint = Math.round(10 + 34 * Math.sqrt(amount / max));
      return `
        <button class="bubble ${st ? `has-budget ${st.key}` : ''}" data-bubble="${id || 'none'}" data-amount="${amount}"
          style="--tint:${tint}%;--ring:${st ? Math.min(1, st.ratio) : 0}"
          aria-label="${h(c.name)} ${yen(amount)}${st ? ` 予算の${Math.round(st.ratio * 100)}% ${st.label}` : ''}">
          <span class="bubble-inner"><span class="bubble-emoji">${c.icon}</span><span class="bubble-amt">${shortYen(amount)}</span></span>
          ${st && st.key !== 'ok' ? `<i class="bubble-badge ${st.key}">!</i>` : ''}
        </button>`;
    }).join('');
  } else {
    bubbles = [...sum.byMember.entries()].sort((a, b) => b[1] - a[1]).map(([id, amount]) => `
        <button class="bubble member" data-bubble="${id || 'none'}" data-amount="${amount}" style="--series:var(--series-${memberSlot(id)})"
          aria-label="${h(memberName(id))} ${yen(amount)}">
          <span class="bubble-inner"><span class="bubble-name">${h(memberName(id))}</span><span class="bubble-amt">${shortYen(amount)}</span></span>
        </button>`).join('');
  }
  const seg = (value, label) => `<button class="${mode === value ? 'on' : ''}" data-action="bubble-mode" data-mode="${value}">${label}</button>`;

  // 気をつけたいカテゴリ(予算の8割以上)だけを見せる
  const watch = expenseCats
    .filter((c) => budgetOf.has(c.id) && (sum.byCategory.get(c.id) || 0) / budgetOf.get(c.id) >= 0.8)
    .map((c) => meterRow(`${c.icon} ${h(c.name)}`, sum.byCategory.get(c.id) || 0, budgetOf.get(c.id))).join('');
  const allBudgets = expenseCats.filter((c) => budgetOf.has(c.id)).map((c) => meterRow(`${c.icon} ${h(c.name)}`, sum.byCategory.get(c.id) || 0, budgetOf.get(c.id))).join('');

  // 一覧(泡の中身を数字で確かめたい人向け)
  const catRows = [...sum.byCategory.entries()].sort((a, b) => b[1] - a[1]);
  const maxCat = catRows.length ? catRows[0][1] : 0;
  const catHtml = catRows.map(([id, amount]) => {
    const c = category(id);
    return barRow(`${c.icon} ${h(c.name)}`, amount, maxCat, 'var(--seq)', `${sum.expense ? Math.round((amount / sum.expense) * 100) : 0}%`);
  }).join('');
  const memRows = [...sum.byMember.entries()].sort((a, b) => b[1] - a[1]);
  const maxMem = memRows.length ? memRows[0][1] : 0;
  const memHtml = memRows.map(([id, amount]) =>
    barRow(`<span class="dot" style="background:var(--series-${memberSlot(id)})"></span>${h(memberName(id))}`, amount, maxMem, `var(--series-${memberSlot(id)})`)).join('');

  return `
    ${monthNav()}
    <section class="hero">
      ${hero}
    </section>
    ${balanceCard(sum)}
    ${recordCard()}
    <section class="card bubble-card">
      <div class="bubble-head"><h2>${mode === 'category' ? '何に使った?' : '誰が払った?'}</h2><div class="mini-seg">${seg('category', 'カテゴリ')}${seg('member', '家族')}</div></div>
      ${bubbles
        ? `<div class="bubble-field" style="height:${catRows.length > 9 && mode === 'category' ? 340 : 290}px">${bubbles}</div>
           <p class="muted small bubble-note">${mode === 'category' ? '大きい泡ほど多く使っています。輪は予算の進み具合。' : '払った人ごとの合計です。'}タップで中身を表示。</p>`
        : '<p class="muted">この月の支出はまだありません。</p>'}
    </section>
    ${totalBudget > 0 ? `
      <section class="card">
        <h2>気をつけたい</h2>
        ${watch || '<p class="settled">✓ どのカテゴリも予算内で順調です</p>'}
        <details class="fold"><summary>すべての予算を見る</summary>${allBudgets}</details>
      </section>` : ''}
    ${goalsCard()}
    ${planCard()}
    ${catRows.length ? `
      <details class="fold card"><summary>一覧で見る(カテゴリ・家族)</summary>
        <h3>カテゴリ別</h3>${catHtml}
        <h3>誰が払ったか</h3>${memHtml}
      </details>` : ''}
    <details class="fold card"><summary>6か月の推移を見る</summary>${trendChart()}</details>`;
}

// 収入を100%として、使った分・これから払う予定・残る見込みを1本の帯で見せる
function balanceCard(sum) {
  const upcoming = state.month === monthOf(today()) ? scheduleForMonth(state.recurring, state.month, today(), state.tx).expenseUpcoming : 0;
  const { income, expense } = sum;
  if (!income && !expense) return '';
  const out = expense + upcoming;
  const base = Math.max(income, out, 1);
  const left = income - out;
  const pct = (n) => (income ? `${Math.round((n / income) * 100)}%` : '');
  const w = (n) => `${(n / base) * 100}%`;
  let headline;
  if (!income) headline = '<b>収入がまだ入力されていません</b><small>給料などを入力すると、使った割合が出ます。</small>';
  else if (expense > income) headline = `<b class="neg">収入を ${yen(expense - income)} 上回っています</b><small>収入の ${pct(expense)} を使いました。</small>`;
  else headline = `<b>収入の <em>${pct(expense)}</em> を使いました</b>${upcoming ? `<small>これから払う予定も入れると ${pct(out)}。</small>` : ''}`;
  const legend = (cls, label, amount, share) => `<li><i class="sw ${cls}"></i><span>${label}</span><span class="num">${yen(amount)}${share ? `<small>${share}</small>` : ''}</span></li>`;
  return `
    <section class="card balance">
      <h2>収入と支出のバランス</h2>
      <p class="balance-head">${headline}</p>
      <div class="balance-bar" role="img" aria-label="収入 ${yen(income)}、支出 ${yen(expense)}、これから払う予定 ${yen(upcoming)}">
        ${expense ? `<span class="seg spent" style="width:${w(expense)}"></span>` : ''}
        ${upcoming ? `<span class="seg planned" style="width:${w(upcoming)}"></span>` : ''}
        ${left > 0 ? `<span class="seg left" style="width:${w(left)}"></span>` : ''}
        ${income && out > income ? `<span class="income-mark" style="left:${w(income)}"><span>収入</span></span>` : ''}
      </div>
      <ul class="balance-legend">
        ${legend('spent', '使った', expense, pct(expense))}
        ${upcoming ? legend('planned', 'これから払う予定', upcoming, pct(upcoming)) : ''}
        ${income ? (left >= 0 ? legend('left', '残る見込み', left, pct(left)) : legend('over', '足りない見込み', -left, '')) : ''}
      </ul>
      <p class="balance-foot">収入 <b>${yen(income)}</b></p>
    </section>`;
}

// ───────── 動く泡 ─────────
// 下から浮かんできて、ぶつかり合いながら真ん中に集まる。つかんで動かすと周りが押しのけられる

let bubbleSim = null;
const bubbleMemory = new Map(); // 画面を描き直しても、泡が元の位置から続くようにする

function stopBubbles() {
  if (bubbleSim) cancelAnimationFrame(bubbleSim.raf);
  bubbleSim = null;
}

function startBubbles() {
  const field = $app.querySelector('.bubble-field');
  const els = field ? [...field.querySelectorAll('.bubble')] : [];
  if (!els.length) return;
  const W = field.clientWidth;
  const H = field.clientHeight;
  const amounts = els.map((el) => Number(el.dataset.amount));
  const k = Math.sqrt((0.5 * W * H) / (Math.PI * amounts.reduce((a, b) => a + b, 0)));
  const calm = calmMotion();
  const nodes = els.map((el, i) => {
    const r = Math.max(22, Math.min(Math.min(W, H) * 0.3, k * Math.sqrt(amounts[i])));
    el.style.setProperty('--r', `${r}px`);
    el.style.setProperty('--bob', `${(Math.random() * 3).toFixed(2)}s`);
    const key = `${state.bubbleMode}:${el.dataset.bubble}`;
    const mem = bubbleMemory.get(key);
    const node = { key, el, r, vx: 0, vy: 0, inside: Boolean(mem) || calm, phase: Math.random() * Math.PI * 2, pace: 0.7 + Math.random() * 0.6 };
    // 大きい泡ほど真ん中寄りから出す(隅に取り残されないように)
    const spread = i === 0 ? 0 : 0.7;
    node.x = mem ? mem.x : W * (0.5 + (Math.random() - 0.5) * spread);
    node.y = mem ? mem.y : calm ? H * (0.5 + (Math.random() - 0.5) * spread) : H + r + (i / els.length) * H * 0.9;
    return node;
  });
  const maxR = Math.max(...nodes.map((n) => n.r));
  const FINGER_R = 36; // 指(マウス)のまわりの、泡を押しのける範囲
  const sim = { raf: 0, nodes, drag: null, time: 0, finger: null };
  bubbleSim = sim;

  // drift: 1 なら、泡がそれぞれのリズムでずっと漂い続ける(0 は静かな配置だけ求める)
  const step = (drift = 1) => {
    sim.time += 1;
    for (const n of nodes) {
      if (n === sim.drag?.node) continue;
      const pull = 0.4 + 1.2 * (n.r / maxR); // 大きい泡ほど強く真ん中へ
      const t = sim.time * 0.018 * n.pace + n.phase;
      const wander = drift * 0.16 * (1.4 - n.r / maxR); // 小さい泡ほど軽やかに動く
      n.vx = (n.vx + (W / 2 - n.x) * 0.0022 * pull + Math.cos(t) * wander) * 0.9;
      n.vy = (n.vy + (H / 2 - n.y) * 0.0034 * pull + Math.sin(t * 1.3) * wander) * 0.9;
      n.x += n.vx;
      n.y += n.vy;
    }
    // 指が触れているところから泡がよける。指の速さも泡に伝わる(かき回す感じ)
    const fg = sim.finger;
    if (fg) {
      for (const n of nodes) {
        if (n === sim.drag?.node) continue;
        let dx = n.x - fg.x, dy = n.y - fg.y;
        let d = Math.hypot(dx, dy);
        const min = n.r + FINGER_R;
        if (d >= min) continue;
        if (d < 0.01) { dx = 0; dy = -1; d = 1; }
        const depth = min - d;
        n.x += (dx / d) * depth * 0.5;
        n.y += (dy / d) * depth * 0.5;
        n.vx += (dx / d) * depth * 0.1 + fg.vx * 0.1;
        n.vy += (dy / d) * depth * 0.1 + fg.vy * 0.1;
      }
      fg.vx *= 0.7;
      fg.vy *= 0.7;
    }
    for (let pass = 0; pass < 5; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d = Math.hypot(dx, dy);
          const min = a.r + b.r + 4;
          if (d >= min) continue;
          if (d < 0.01) { dx = 1; dy = 0; d = 1; }
          const push = (min - d) / d;
          // つかんでいる泡は動かさず、相手だけ押しのける。大きい泡ほど動きにくい
          const wa = a === sim.drag?.node ? 0 : b === sim.drag?.node ? 1 : b.r / (a.r + b.r);
          a.x -= dx * push * wa; a.y -= dy * push * wa;
          b.x += dx * push * (1 - wa); b.y += dy * push * (1 - wa);
        }
      }
      for (const n of nodes) {
        n.x = Math.max(n.r, Math.min(W - n.r, n.x));
        if (n.inside) n.y = Math.max(n.r, Math.min(H - n.r, n.y));
      }
    }
    for (const n of nodes) {
      n.x = Math.max(n.r, Math.min(W - n.r, n.x));
      if (n.y < H - n.r) n.inside = true;
      n.y = Math.max(n.r, n.inside ? Math.min(H - n.r, n.y) : n.y);
      n.el.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px)`;
      bubbleMemory.set(n.key, { x: n.x, y: n.y });
    }
  };

  field.classList.add('ready');
  let wake = () => {};
  if (calm) {
    // 動きを減らす設定のときは、落ち着いた配置を一度で計算する(タップやつかむ操作はそのまま使える)
    for (let i = 0; i < 400; i++) step(0);
    wake = () => step(0);
  } else {
    // まとめ画面を見ている間は漂い続ける(画面が裏に回ると requestAnimationFrame ごと自動で止まる)
    const loop = () => {
      if (bubbleSim !== sim) return;
      step();
      sim.raf = requestAnimationFrame(loop);
    };
    sim.raf = requestAnimationFrame(loop);
  }

  const local = (e) => {
    const rect = field.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // 触った場所から泡がふわっと逃げ、波紋が広がる
  const poke = ({ x, y }) => {
    for (const n of nodes) {
      const dx = n.x - x, dy = n.y - y;
      const d = Math.max(30, Math.hypot(dx, dy));
      const force = Math.min(7, 1100 / d);
      n.vx += (dx / d) * force;
      n.vy += (dy / d) * force;
    }
    const ring = document.createElement('span');
    ring.className = 'ripple';
    ring.style.left = `${x}px`;
    ring.style.top = `${y}px`;
    field.append(ring);
    setTimeout(() => ring.remove(), 700);
  };

  const moveFinger = (e) => {
    const p = local(e);
    const prev = sim.finger;
    sim.finger = { x: p.x, y: p.y, vx: prev ? p.x - prev.x : 0, vy: prev ? p.y - prev.y : 0, touching: prev?.touching || false };
  };

  field.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.bubble');
    const node = nodes.find((n) => n.el === el);
    if (!node) {
      // 何もないところ: 指でなぞって泡をかき分ける
      if (calm) return;
      sim.finger = { ...local(e), vx: 0, vy: 0, touching: true };
      poke(sim.finger);
      field.setPointerCapture?.(e.pointerId);
      return;
    }
    sim.suppressClick = false;
    const p = local(e);
    sim.drag = { node, ox: node.x - p.x, oy: node.y - p.y, startX: e.clientX, startY: e.clientY, moved: false };
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('held');
    wake();
  });
  field.addEventListener('pointermove', (e) => {
    const d = sim.drag;
    if (!d) {
      // 触れている間(マウスなら上を通るだけでも)泡がよける
      if (!calm && (sim.finger?.touching || e.pointerType === 'mouse')) moveFinger(e);
      return;
    }
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6) d.moved = true;
    const p = local(e);
    const nx = p.x + d.ox, ny = p.y + d.oy;
    d.node.vx = (nx - d.node.x) * 0.9;
    d.node.vy = (ny - d.node.y) * 0.9;
    d.node.x = nx;
    d.node.y = ny;
    wake();
  });
  field.addEventListener('pointerleave', () => { if (!sim.finger?.touching) sim.finger = null; });
  const release = (e) => {
    const d = sim.drag;
    if (!d) {
      sim.finger = e.pointerType === 'mouse' && sim.finger ? { ...sim.finger, touching: false } : null;
      return;
    }
    sim.drag = null;
    d.node.el.classList.remove('held');
    wake();
    sim.suppressClick = d.moved || e.type !== 'pointerup'; // 動かしたあとの click では明細を開かない
  };
  field.addEventListener('pointerup', release);
  field.addEventListener('pointercancel', release);
  // タップ(またはキーボードの Enter)で中身を開く。
  // pointerup ではなく click で開くのは、直後に届く click が、開いたシートの中のボタンを押してしまわないようにするため
  field.addEventListener('click', (e) => {
    const el = e.target.closest('.bubble');
    if (!el) return;
    if (sim.suppressClick) { sim.suppressClick = false; return; }
    if (!calm) el.querySelector('.bubble-inner').animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
    openBubbleDetail(el.dataset.bubble);
  });
}

// 泡の中身(その月の明細)
function openBubbleDetail(rawId) {
  const id = rawId === 'none' ? null : rawId;
  const byCategory = state.bubbleMode === 'category';
  const list = monthTx().filter((t) => t.kind === 'expense' && (byCategory ? t.category_id : t.member_id) === id);
  const total = list.reduce((a, t) => a + t.amount, 0);
  const title = byCategory ? `${category(id).icon} ${h(category(id).name)}` : `${h(memberName(id))} が払った分`;
  const budget = byCategory ? state.budgets.find((b) => b.category_id === id && b.amount > 0) : null;
  $sheetRoot.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-label="${byCategory ? h(category(id).name) : h(memberName(id))}の明細">
      <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="閉じる">✕</button></header>
      <div class="sheet-body detail-body">
        <div class="detail-total">${yen(total)}<small>${monthLabel(state.month)}・${list.length}件</small></div>
        ${budget ? meterRow('予算', total, budget.amount) : ''}
        <ul class="tx-list">${list.map((t) => txRow(t, true)).join('')}</ul>
      </div>
    </div>`;
  for (const el of $sheetRoot.querySelectorAll('[data-close]')) el.addEventListener('click', () => { $sheetRoot.innerHTML = ''; });
}

function barRow(labelHtml, amount, max, color, note = '') {
  const w = max ? Math.max(2, (amount / max) * 100) : 0;
  return `
    <div class="bar-row">
      <div class="bar-head"><span>${labelHtml}</span><span class="num">${yen(amount)}${note ? `<small>${note}</small>` : ''}</span></div>
      <div class="bar-track plain"><div class="bar-fill" style="width:${w}%;background:${color}"></div></div>
    </div>`;
}

function meterRow(labelHtml, spent, budget, big = false) {
  const st = budgetStatus(spent, budget);
  const w = Math.min(100, st.ratio * 100);
  const left = budget - spent;
  const icon = { ok: '✓', warn: '!', over: '✕' }[st.key];
  return `
    <div class="bar-row ${big ? 'big' : ''}">
      <div class="bar-head"><span>${labelHtml}</span><span class="num">${left >= 0 ? `残り ${yen(left)}` : `${yen(-left)} オーバー`}</span></div>
      <div class="bar-track"><div class="bar-fill status-${st.key}" style="width:${w}%"></div></div>
      <div class="bar-foot"><span class="status-tag status-text-${st.key}">${icon} ${st.label}</span><span>${yen(spent)} / ${yen(budget)}</span></div>
    </div>`;
}

// 6か月の支出推移。表示中の月だけ強調し、他は控えめな色にする
function trendChart() {
  const months = Array.from({ length: 6 }, (_, i) => addMonths(state.month, i - 5));
  const totals = months.map((m) => state.tx.filter((t) => t.kind === 'expense' && monthOf(t.date) === m).reduce((a, t) => a + t.amount, 0));
  const max = Math.max(...totals, 1);
  const W = 320, H = 150, top = 22, base = 120, slot = W / 6, bw = 28;
  const bars = months.map((m, i) => {
    const bh = Math.round((totals[i] / max) * (base - top));
    const x = i * slot + (slot - bw) / 2;
    const y = base - bh;
    const active = m === state.month;
    const r = Math.min(4, bh);
    const path = bh > 0 ? `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + bw - r} Q${x + bw},${y} ${x + bw},${y + r} V${base} Z` : '';
    const man = totals[i] >= 10000 ? `${(totals[i] / 10000).toFixed(1)}万` : totals[i].toLocaleString('ja-JP');
    return `
      <g data-action="goto-month" data-month="${m}" class="trend-col ${active ? 'active' : ''}" role="button" aria-label="${monthLabel(m)} ${yen(totals[i])}">
        <rect x="${i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>
        ${path ? `<path d="${path}"/>` : ''}
        <text class="val" x="${x + bw / 2}" y="${y - 6}" text-anchor="middle">${totals[i] ? man : ''}</text>
        <text class="lbl" x="${x + bw / 2}" y="${base + 18}" text-anchor="middle">${Number(m.slice(5))}月</text>
      </g>`;
  }).join('');
  return `
    <svg class="trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="直近6か月の支出">
      <line x1="0" x2="${W}" y1="${base}" y2="${base}" class="axis"/>
      ${bars}
    </svg>
    <p class="muted small">棒をタップするとその月に移動します。</p>`;
}

// ───────── 支払い予定 ─────────

const WEEK = '日月火水木金土';
const shortDate = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]})`;
};
const countdown = (days) => (days === 0 ? '今日' : days === 1 ? '明日' : `あと${days}日`);
const planIcon = (r) => (r.category_id ? category(r.category_id).icon : r.kind === 'income' ? '💰' : '📦');

// 予定の1行。左の丸がスタンプになっていて、済むと「済」のハンコが押される
function planRow(item) {
  const { r } = item;
  const repeat = isOnce(r) ? '1回だけ' : r.every === 'year' ? '毎年' : '毎月';
  const stamp = item.status === 'done' ? '<i class="hanko">済</i>' : item.status === 'skipped' ? '<i class="hanko none">なし</i>' : '';
  const chip = item.status === 'upcoming'
    ? `<span class="count-chip ${item.daysLeft <= 3 ? 'soon' : ''}">${countdown(item.daysLeft)}</span>`
    : `<span class="count-chip done">${item.status === 'done' ? '記録済み' : '記録なし'}</span>`;
  return `
    <li><button class="plan-row ${item.status}" data-action="edit-recurring" data-id="${r.id}">
      <span class="stamp-circle"><span class="stamp-emoji">${planIcon(r)}</span>${stamp}</span>
      <span class="tx-main"><b>${h(r.name)}</b><small>${shortDate(item.date)} ・ ${repeat}</small></span>
      <span class="plan-right"><span class="num ${r.kind === 'income' ? 'pos' : ''}">${r.kind === 'income' ? '+' : ''}${yen(item.amount)}</span>${chip}</span>
    </button></li>`;
}

// 次の支払いを大きく1枚で
function nextPayCard(item) {
  const days = item.daysLeft;
  return `
    <button class="next-pay ${days <= 3 ? 'soon' : ''}" data-action="edit-recurring" data-id="${item.r.id}">
      <span class="next-label">次の支払い</span>
      <span class="next-body">
        <span class="next-emoji">${planIcon(item.r)}</span>
        <span class="next-main"><b>${h(item.r.name)}</b><small>${shortDate(item.date)}</small><span class="next-amount">${yen(item.amount)}</span></span>
        <span class="next-count">${days <= 1 ? `<b class="word">${countdown(days)}</b>` : `あと<b>${days}</b>日`}</span>
      </span>
    </button>`;
}

// 「いくらのうち、いくら済んだか」の帯
function planProgress(schedule) {
  const total = schedule.expenseDone + schedule.expenseUpcoming;
  return `
    <div class="bar-track plan-meter"><div class="bar-fill" style="width:${total ? (schedule.expenseDone / total) * 100 : 0}%;background:var(--accent)"></div></div>
    <div class="bar-foot"><span>✓ 済んだ ${yen(schedule.expenseDone)}</span><span>合計 ${yen(total)}</span></div>`;
}

function viewPlan() {
  const schedule = scheduleForMonth(state.recurring, state.month, today(), state.tx);
  const pays = schedule.items.filter((i) => i.r.kind === 'expense');
  const upcoming = pays.filter((i) => i.status === 'upcoming');
  const past = pays.filter((i) => i.status !== 'upcoming');
  const incomes = schedule.items.filter((i) => i.r.kind === 'income');
  const inSchedule = new Set(schedule.items.map((i) => i.r.id));
  const others = state.recurring.filter((r) => !inSchedule.has(r.id));
  const describe = (r) => (!r.active ? '停止中' : isOnce(r) ? `${monthLabel(r.start_month)}${r.day}日 ・ 1回だけ` : r.every === 'year' ? `毎年${r.month_of_year}月${r.day}日` : `毎月${r.day}日`);

  let hero = '';
  if (pays.length) {
    hero = upcoming.length
      ? `<div class="plan-hero-label">この月、これから払うお金</div>
         <div class="plan-hero-value">${yen(schedule.expenseUpcoming)}<small>あと${upcoming.length}件</small></div>`
      : '<div class="plan-hero-label">この月の支払いは</div><div class="plan-hero-value done">✓ すべて完了</div>';
    hero = `<section class="plan-hero">${hero}${planProgress(schedule)}</section>`;
  }

  return `
    <header class="month-nav">
      <button data-action="month" data-delta="-1" aria-label="前の月">‹</button>
      <h1>${monthLabel(state.month)}の予定</h1>
      <button data-action="month" data-delta="1" aria-label="次の月">›</button>
    </header>
    ${hero}
    ${upcoming.length ? nextPayCard(upcoming[0]) : ''}
    ${upcoming.length > 1 ? `<div class="day-head"><span>そのあと</span></div><ul class="tx-list">${upcoming.slice(1).map(planRow).join('')}</ul>` : ''}
    ${past.length ? `<div class="day-head"><span>済んだもの</span></div><ul class="tx-list">${past.map(planRow).join('')}</ul>` : ''}
    ${incomes.length ? `<div class="day-head"><span>入ってくる予定</span><span class="pos">+${yen(schedule.incomeUpcoming + schedule.incomeDone)}</span></div><ul class="tx-list">${incomes.map(planRow).join('')}</ul>` : ''}
    ${!state.recurring.length ? '<section class="card hint"><p class="muted">家賃・スマホ代・サブスク・保険・給料日などを登録すると、その日に自動で記録され、ここに「あと何日」で並びます。</p></section>' : ''}
    <button class="btn primary plan-add" data-action="edit-recurring">+ 予定を追加</button>
    ${others.length ? `
      <details class="plan-past"><summary>この月に予定がないもの(${others.length}件)</summary>
      <ul class="tx-list">${others.map((r) => `
        <li><button class="plan-row done" data-action="edit-recurring" data-id="${r.id}">
          <span class="tx-icon">${planIcon(r)}</span>
          <span class="tx-main"><b>${h(r.name)}</b><small>${describe(r)}</small></span>
          <span class="num">${yen(r.amount)}</span>
        </button></li>`).join('')}</ul></details>` : ''}
    <button class="link plan-back" data-tab="home">‹ まとめに戻る</button>`;
}

// 「まとめ」に出すコンパクト版(今月を見ているときだけ)
function planCard() {
  if (state.month !== monthOf(today())) return '';
  if (!state.recurring.length) {
    return '<section class="card hint"><h2>支払い予定</h2><p class="muted">家賃やサブスクを登録すると、自動で記録され「あと何日」で見られます。</p><button class="btn small" data-tab="plan">予定を登録する</button></section>';
  }
  const schedule = scheduleForMonth(state.recurring, state.month, today(), state.tx);
  const next = schedule.items.find((i) => i.status === 'upcoming' && i.r.kind === 'expense');
  return `
    <section class="card">
      <div class="bubble-head"><h2>支払い予定</h2><button class="link" data-tab="plan">すべて見る ›</button></div>
      ${next ? nextPayCard(next) : '<p class="settled">✓ 今月の支払いはすべて完了</p>'}
      ${planProgress(schedule)}
    </section>`;
}

function viewHistory() {
  let list = monthTx();
  if (state.historyMember !== 'all') list = list.filter((t) => t.member_id === state.historyMember);
  const chips = [`<button class="chip ${state.historyMember === 'all' ? 'on' : ''}" data-action="filter-member" data-id="all">すべて</button>`]
    .concat(state.members.map((m) => `<button class="chip ${state.historyMember === m.id ? 'on' : ''}" data-action="filter-member" data-id="${m.id}">${h(m.name)}</button>`)).join('');

  const groups = new Map();
  for (const t of list) {
    if (!groups.has(t.date)) groups.set(t.date, []);
    groups.get(t.date).push(t);
  }
  const week = '日月火水木金土';
  const body = [...groups.entries()].map(([date, items]) => {
    const d = new Date(`${date}T00:00:00`);
    const dayTotal = items.filter((t) => t.kind === 'expense').reduce((a, t) => a + t.amount, 0);
    return `
      <div class="day-head"><span>${d.getMonth() + 1}/${d.getDate()}(${week[d.getDay()]})</span><span>${dayTotal ? yen(dayTotal) : ''}</span></div>
      <ul class="tx-list">${items.map(txRow).join('')}</ul>`;
  }).join('');

  return `
    ${monthNav()}
    <div class="chips">${chips}</div>
    ${body || '<p class="muted empty">この月の記録はありません。</p>'}`;
}

function txRow(t, showDate = false) {
  const c = category(t.category_id);
  const tags = [
    showDate === true ? shortDate(t.date) : '',
    t.member_id ? `<span class="dot" style="background:var(--series-${memberSlot(t.member_id)})"></span>${h(memberName(t.member_id))}` : '',
    t.kind === 'expense' && !t.shared ? '<span class="tag">個人</span>' : '',
    t.recurring_id ? '<span class="tag">固定</span>' : '',
  ].filter(Boolean).join(' ');
  return `
    <li><button class="tx" data-action="edit-tx" data-id="${t.id}">
      <span class="tx-icon">${c.icon}</span>
      <span class="tx-main"><b>${h(t.memo || c.name)}</b><small>${t.memo ? `${h(c.name)} ・ ` : ''}${tags}</small></span>
      <span class="num ${t.kind === 'income' ? 'pos' : ''}">${t.kind === 'income' ? '+' : ''}${yen(t.amount)}</span>
    </button></li>`;
}

function viewSettle() {
  const seg = (value, label) => `<button class="${state.settleMode === value ? 'on' : ''}" data-action="settle-mode" data-mode="${value}">${label}</button>`;
  return `
    <header class="page-head"><h1>${state.settleMode === 'split' ? '精算' : '貸し借り'}</h1><div class="mini-seg">${seg('split', '立て替え')}${seg('loans', '貸し借り')}</div></header>
    ${state.settleMode === 'split' ? viewSplit() : viewLoans()}`;
}

// ───────── みんなで一緒の貯金目標 ─────────

// 水がたまっていく丸いタンク。level は 0〜1
function tank(icon, ratio, size = '') {
  return `
    <span class="tank ${size} ${ratio >= 1 ? 'full' : ''}" style="--level:${(1 - ratio) * 100}%" aria-hidden="true">
      <span class="water back"></span><span class="water"></span>
      <span class="tank-icon">${icon}</span>
    </span>`;
}

function goalDeadlineText(goal, p) {
  if (p.reached) return '<b class="pos">🎉 達成!</b>';
  if (!goal.deadline_month) return `あと <b>${yen(p.left)}</b>`;
  if (p.overdue) return `あと <b>${yen(p.left)}</b> ・ 期限(${monthLabel(goal.deadline_month)})を過ぎています`;
  return `あと <b>${yen(p.left)}</b> ・ ${monthLabel(goal.deadline_month)}まで<br>毎月 <b>${yen(p.perMonth)}</b> で間に合います(あと${p.monthsLeft}か月)`;
}

function viewGoals() {
  const cards = state.goals.map((g) => {
    const p = goalProgress(g, state.goalDeposits, today());
    const members = [...p.byMember.entries()].sort((a, b) => b[1] - a[1]);
    return `
      <section class="card goal" data-goal="${g.id}">
        <div class="goal-top">
          ${tank(g.icon, p.ratio)}
          <div class="goal-main">
            <button class="goal-name" data-action="edit-goal" data-id="${g.id}">${h(g.name)} <span aria-hidden="true">✎</span></button>
            <div class="goal-pct">${Math.floor(p.ratio * 100)}<small>%</small></div>
            <div class="goal-nums">${yen(p.saved)} <span>/ ${yen(g.target)}</span></div>
          </div>
        </div>
        <p class="goal-note">${goalDeadlineText(g, p)}</p>
        ${members.length ? `
          <div class="who-bar" role="img" aria-label="だれがいくら入れたか">${members.map(([id, amt]) => `<span style="width:${(amt / p.saved) * 100}%;background:var(--series-${memberSlot(id)})"></span>`).join('')}</div>
          <ul class="who-legend">${members.map(([id, amt]) => `<li><span class="dot" style="background:var(--series-${memberSlot(id)})"></span>${h(memberName(id))}<span class="num">${yen(amt)}</span></li>`).join('')}</ul>` : ''}
        <div class="goal-actions">
          <button class="btn primary grow" data-action="deposit-goal" data-id="${g.id}">${p.reached ? 'さらに貯金する' : '貯金する'}</button>
          ${p.count ? `<button class="btn" data-action="goal-history" data-id="${g.id}">履歴</button>` : ''}
        </div>
      </section>`;
  }).join('');
  return `
    <header class="page-head"><h1>みんなの貯金目標</h1></header>
    ${cards || '<section class="card hint"><p class="muted">「家族旅行」「新しい冷蔵庫」など、みんなで貯めたい目標を作りましょう。貯金するたびにタンクに水がたまっていきます。</p></section>'}
    <button class="btn ${cards ? '' : 'primary'} plan-add" data-action="edit-goal">+ 目標を作る</button>
    <p class="muted small loan-note">貯金は、家計の支出や収入には含めません。</p>
    <button class="link plan-back" data-tab="home">‹ まとめに戻る</button>`;
}

// 「まとめ」に出すコンパクト版
function goalsCard() {
  if (!state.goals.length) {
    return '<section class="card hint"><h2>みんなの貯金目標</h2><p class="muted">旅行や家電など、家族で貯めたい目標を作れます。</p><button class="btn small" data-tab="goals">目標を作る</button></section>';
  }
  return `
    <section class="card">
      <div class="bubble-head"><h2>みんなの貯金目標</h2><button class="link" data-tab="goals">すべて見る ›</button></div>
      <div class="goal-minis">${state.goals.slice(0, 3).map((g) => {
        const p = goalProgress(g, state.goalDeposits, today());
        return `<button class="goal-mini" data-tab="goals">${tank(g.icon, p.ratio, 'small')}<b>${h(g.name)}</b><span>${p.reached ? '🎉 達成' : `${Math.floor(p.ratio * 100)}%`}</span></button>`;
      }).join('')}</div>
    </section>`;
}

function openGoalSheet(id) {
  const g = id ? byId(state.goals, id) : null;
  openSheet(g ? '目標を編集' : '目標を作る', `
    <label>目標の名前<input name="name" value="${h(g?.name || '')}" required maxlength="30" placeholder="例: 家族で沖縄旅行"></label>
    <label>絵文字<input name="icon" value="${h(g?.icon || '🎯')}" maxlength="4"></label>
    <label>目標金額<input name="target" class="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${g?.target || ''}" required></label>
    <label>いつまでに(任意)<input name="deadline_month" type="month" value="${g?.deadline_month || ''}"></label>
    <p class="muted small">期限を入れると「毎月いくらで間に合うか」が出ます。</p>`, {
    onSubmit: async (f) => {
      const name = f.get('name').trim();
      if (!name) throw new Error('目標の名前を入力してください');
      const target = parseAmount(f.get('target'));
      if (target <= 0) throw new Error('目標金額を入力してください');
      await backend.save('goals', {
        ...(g ? { id: g.id, sort: g.sort } : { sort: state.goals.length }),
        name, icon: f.get('icon').trim() || '🎯', target, deadline_month: f.get('deadline_month') || null,
      });
      await reload('保存しました');
    },
    onDelete: g ? async () => { await backend.remove('goals', g.id); await reload('削除しました(入金の記録も消えます)'); } : null,
  });
}

function openDepositSheet(goalId) {
  const g = byId(state.goals, goalId);
  if (!g) return;
  const before = goalProgress(g, state.goalDeposits, today());
  const form = openSheet(`${g.icon} ${h(g.name)}に貯金する`, `
    <label>金額<input name="amount" class="amount" inputmode="numeric" autocomplete="off" placeholder="0" required></label>
    ${before.perMonth ? `<div class="chips"><button type="button" class="chip" data-fill="${before.perMonth}">今月の目安 ${yen(before.perMonth)}</button></div>` : ''}
    <div class="field"><span class="field-label">だれが</span>${radioChips('member_id', memberOptions(), state.myMemberId)}</div>
    <label>日付<input name="date" type="date" value="${today()}" required></label>
    <label>メモ(任意)<input name="memo" maxlength="60" placeholder="例: ボーナスから"></label>`, {
    submitLabel: '貯金する',
    onSubmit: async (f) => {
      const amount = parseAmount(f.get('amount'));
      if (amount <= 0) throw new Error('金額を入力してください');
      await backend.save('goal_deposits', { goal_id: g.id, member_id: f.get('member_id') || null, amount, date: f.get('date') || today(), memo: f.get('memo').trim() });
      await guard(loadAll);
      state.tab = 'goals';
      render();
      // コインがタンクに降ってきて、達成した瞬間は紙吹雪
      const rect = $app.querySelector(`[data-goal="${g.id}"] .tank`)?.getBoundingClientRect();
      const after = goalProgress(g, state.goalDeposits, today());
      if (rect) {
        burst(['🪙', '🪙', '✨'], rect, 1);
        if (after.reached && !before.reached) setTimeout(() => burst(['🎉', '🎊', '✨', '🥳'], rect, 0), 500);
      }
      navigator.vibrate?.(after.reached && !before.reached ? [20, 60, 20, 60, 40] : 12);
      toast(after.reached && !before.reached ? `🎉 「${g.name}」達成!` : `${yen(amount)} 貯金しました(${Math.floor(after.ratio * 100)}%)`);
    },
  });
  form.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-fill]');
    if (chip) form.querySelector('.amount').value = chip.dataset.fill;
  });
  form.querySelector('.amount').focus();
}

function openGoalHistory(goalId) {
  const g = byId(state.goals, goalId);
  if (!g) return;
  const list = state.goalDeposits.filter((d) => d.goal_id === goalId);
  $sheetRoot.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <div class="sheet" role="dialog" aria-label="${h(g.name)}の入金履歴">
      <header><h2>${g.icon} ${h(g.name)}の履歴</h2><button type="button" class="icon-btn" data-close aria-label="閉じる">✕</button></header>
      <div class="sheet-body detail-body"><ul class="tx-list">${list.map((d) => `
        <li class="tx">
          <span class="tx-icon">🪙</span>
          <span class="tx-main"><b>${h(d.memo || '貯金')}</b><small>${shortDate(d.date)}${d.member_id ? ` ・ <span class="dot" style="background:var(--series-${memberSlot(d.member_id)})"></span>${h(memberName(d.member_id))}` : ''}</small></span>
          <span class="num pos">+${yen(d.amount)}</span>
          <button class="icon-btn" data-action="delete-deposit" data-id="${d.id}" aria-label="この入金を削除">🗑</button>
        </li>`).join('')}</ul></div>
    </div>`;
  for (const el of $sheetRoot.querySelectorAll('[data-close]')) el.addEventListener('click', () => { $sheetRoot.innerHTML = ''; });
}

// ───────── 個人間の貸し借り ─────────

const partyName = (p) => (p.member_id ? memberName(p.member_id) : p.name);
const partyDot = (p) => (p.member_id
  ? `<span class="avatar" style="background:var(--series-${memberSlot(p.member_id)})">${h([...memberName(p.member_id)][0] || '?')}</span>`
  : `<span class="avatar other">${h([...p.name][0] || '?')}</span>`);

function viewLoans() {
  const sum = summarizeLoans(state.loans);
  const pairs = sum.pairs.map((pair) => `
    <section class="card loan-pair">
      <div class="loan-head">
        <div class="loan-who">${partyDot(pair.from)}<b>${h(partyName(pair.from))}</b><span class="loan-arrow">→</span>${partyDot(pair.to)}<b>${h(partyName(pair.to))}</b></div>
        <div class="loan-amount">${pair.amount ? `あと ${yen(pair.amount)}` : '差し引きゼロ'}</div>
        <p class="muted small">${pair.amount ? `${h(partyName(pair.from))} が ${h(partyName(pair.to))} に返す分` : 'おたがいの貸し借りが同じ金額です'}</p>
      </div>
      <ul class="loan-items">${pair.items.map((it) => `
        <li>
          <button class="loan-item" data-action="edit-loan" data-id="${it.loan.id}">
            <span class="tx-main"><b>${h(it.loan.memo || `${partyName(it.lender)} が貸した`)}</b><small>${shortDate(it.loan.date)} ・ ${h(partyName(it.lender))} → ${h(partyName(it.borrower))}${it.loan.repaid ? ` ・ ${yen(it.loan.repaid)} 返済済み` : ''}</small></span>
            <span class="num">${yen(it.remaining)}</span>
          </button>
          <button class="btn small" data-action="repay-loan" data-id="${it.loan.id}">返済を記録</button>
        </li>`).join('')}</ul>
    </section>`).join('');

  const settled = sum.settled.map((l) => {
    const { lender, borrower } = loanParties(l);
    return `<li><button class="tx" data-action="edit-loan" data-id="${l.id}">
      <span class="stamp-circle"><span class="stamp-emoji">💴</span><i class="hanko">済</i></span>
      <span class="tx-main"><b>${h(l.memo || `${partyName(lender)} が貸した`)}</b><small>${shortDate(l.date)} ・ ${h(partyName(lender))} → ${h(partyName(borrower))}</small></span>
      <span class="num">${yen(l.amount)}</span></button></li>`;
  }).join('');

  return `
    <section class="loan-hero">
      <div><span>貸している(返ってくる)</span><b class="pos">${yen(sum.lentOutside)}</b></div>
      <div><span>借りている(返す)</span><b class="${sum.borrowedOutside ? 'neg' : ''}">${yen(sum.borrowedOutside)}</b></div>
    </section>
    <p class="muted small loan-note">上の合計は家族以外との分です。貸し借りは、家計の支出や収入には含めません。</p>
    ${pairs || '<section class="card hint"><p class="muted">「お昼代を立て替えた」「友だちに1万円借りた」など、あとで返す・返してもらうお金を記録できます。家族どうしでも、家族以外でもOKです。</p></section>'}
    <button class="btn primary plan-add" data-action="edit-loan">+ 貸し借りを記録</button>
    ${settled ? `<details class="plan-past"><summary>返し終わったもの(${sum.settled.length}件)</summary><ul class="tx-list plan-rows">${settled}</ul></details>` : ''}`;
}

function openLoanSheet(id) {
  const l = id ? byId(state.loans, id) : null;
  const v = l || { direction: 'lent', member_id: state.myMemberId, counterparty_member_id: null, counterparty_name: '', date: today(), memo: '', repaid: 0 };
  const cp = v.counterparty_member_id || 'other';
  const names = [...new Set(state.loans.map((x) => x.counterparty_name).filter(Boolean))];
  const form = openSheet(l ? '貸し借りを編集' : '貸し借りを記録', `
    <div class="segmented">
      <label><input type="radio" name="direction" value="lent" ${v.direction === 'lent' ? 'checked' : ''}><span>貸した</span></label>
      <label><input type="radio" name="direction" value="borrowed" ${v.direction === 'borrowed' ? 'checked' : ''}><span>借りた</span></label>
    </div>
    <label>金額<input name="amount" class="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${v.amount || ''}" required></label>
    <div class="field"><span class="field-label">家族のだれが</span>${radioChips('member_id', memberOptions(), v.member_id)}</div>
    <div class="field"><span class="field-label">相手</span>${radioChips('counterparty', [...memberOptions(), { id: 'other', label: '家族以外の人' }], cp)}</div>
    <label class="only-other">相手の名前<input name="counterparty_name" value="${h(v.counterparty_name)}" maxlength="20" placeholder="例: たろう" list="loan-names"></label>
    <datalist id="loan-names">${names.map((n) => `<option value="${h(n)}">`).join('')}</datalist>
    <label>日付<input name="date" type="date" value="${v.date}" required></label>
    <label>メモ(任意)<input name="memo" value="${h(v.memo)}" maxlength="60" placeholder="例: ランチ代の立て替え"></label>
    ${l && l.repaid ? `<p class="muted small">これまでに ${yen(l.repaid)} 返済済みです。</p>` : ''}`, {
    onSubmit: async (f) => {
      const amount = parseAmount(f.get('amount'));
      if (amount <= 0) throw new Error('金額を入力してください');
      const member_id = f.get('member_id');
      if (!member_id) throw new Error('家族のだれの貸し借りかを選んでください');
      const who = f.get('counterparty');
      const name = f.get('counterparty_name').trim();
      if (who === 'other' && !name) throw new Error('相手の名前を入力してください');
      if (who === member_id) throw new Error('自分自身とは貸し借りできません');
      if (l && amount < l.repaid) throw new Error(`すでに ${yen(l.repaid)} 返済済みなので、それより小さくできません`);
      await backend.save('loans', {
        ...(l ? { id: l.id } : {}),
        direction: f.get('direction'), amount, member_id,
        counterparty_member_id: who === 'other' ? null : who,
        counterparty_name: who === 'other' ? name : '',
        date: f.get('date') || today(), memo: f.get('memo').trim(), repaid: l ? l.repaid : 0,
      });
      await reload('保存しました');
    },
    onDelete: l ? async () => { await backend.remove('loans', l.id); await reload('削除しました'); } : null,
  });
  const sync = () => { form.dataset.cp = new FormData(form).get('counterparty') === 'other' ? 'other' : 'member'; };
  form.addEventListener('change', sync);
  sync();
  if (!l) form.querySelector('.amount').focus();
}

function openRepaySheet(id) {
  const l = byId(state.loans, id);
  if (!l) return;
  const { lender, borrower } = loanParties(l);
  const remaining = l.amount - l.repaid;
  openSheet('返済を記録', `
    <p><b>${h(partyName(borrower))}</b> → <b>${h(partyName(lender))}</b> <span class="muted">(残り ${yen(remaining)})</span></p>
    <label>返した金額<input name="amount" class="amount" inputmode="numeric" value="${remaining}" required></label>
    <p class="muted small">一部だけ返したときは、その金額に直してください。</p>`, {
    submitLabel: '記録する',
    onSubmit: async (f) => {
      const amount = parseAmount(f.get('amount'));
      if (amount <= 0) throw new Error('金額を入力してください');
      if (amount > remaining) throw new Error(`残りは ${yen(remaining)} です`);
      await backend.patch('loans', l.id, { repaid: l.repaid + amount });
      await reload(amount === remaining ? '✓ 返し終わりました' : '返済を記録しました');
    },
  });
}

function viewSplit() {
  const result = computeSettlement(state.members, state.paidTotals, state.settlements);
  if (!result.balances.length) {
    return `
      <section class="card hint"><p class="muted">精算は、お金を出し合うメンバーが2人以上いるときに使えます。「設定 → メンバー」で家族を追加してください。</p></section>`;
  }
  const transfers = result.transfers.length
    ? result.transfers.map((t) => `
        <div class="transfer">
          <div class="transfer-who"><b>${h(memberName(t.from))}</b><span>→</span><b>${h(memberName(t.to))}</b></div>
          <div class="transfer-amount">${yen(t.amount)}</div>
          <button class="btn primary small" data-action="record-settle" data-from="${t.from}" data-to="${t.to}" data-amount="${t.amount}">渡したら記録</button>
        </div>`).join('')
    : '<p class="settled">✓ いまは精算するものがありません</p>';

  const balances = result.balances.map((b) => `
    <div class="bal-row">
      <span><span class="dot" style="background:var(--series-${memberSlot(b.member_id)})"></span>${h(memberName(b.member_id))}</span>
      <span class="muted">支払い ${yen(b.paid)}</span>
      <span class="num">${b.balance === 0 ? '±0' : b.balance > 0 ? `${yen(b.balance)} もらう` : `${yen(-b.balance)} 払う`}</span>
    </div>`).join('');

  const history = state.settlements.map((s) => `
    <li class="tx">
      <span class="tx-icon">🤝</span>
      <span class="tx-main"><b>${h(memberName(s.from_member))} → ${h(memberName(s.to_member))}</b><small>${s.date}${s.memo ? ` ・ ${h(s.memo)}` : ''}</small></span>
      <span class="num">${yen(s.amount)}</span>
      <button class="icon-btn" data-action="delete-settle" data-id="${s.id}" aria-label="この精算記録を削除">🗑</button>
    </li>`).join('');

  return `
    <section class="card"><h2>いま渡す金額</h2>${transfers}</section>
    <section class="card">
      <h2>内訳(これまでの合計)</h2>
      <p class="muted small">「家族共通」の支出 ${yen(result.total)} を ${result.balances.length}人で均等に割っています(1人あたり ${yen(result.share)})。</p>
      ${balances}
    </section>
    ${history ? `<section class="card"><h2>精算の記録</h2><ul class="tx-list">${history}</ul></section>` : ''}`;
}

function viewSettings() {
  const cloud = backend.mode === 'cloud';
  const hh = state.household;
  const budgetOf = new Map(state.budgets.map((b) => [b.category_id, b.amount]));
  const cats = (kind) => state.categories.filter((c) => c.kind === kind && !c.archived);

  return `
    <header class="page-head"><h1>設定</h1></header>
    ${cloud ? '' : '<p class="notice">お試しモード: データはこの端末のブラウザ内だけに保存されています。家族と共有するにはクラウド同期の設定が必要です(README 参照)。</p>'}

    <section class="card">
      <h2>${h(hh.name)}</h2>
      ${cloud ? `
        <p class="muted small">家族を招待するには、このコードを伝えてください。</p>
        <div class="invite"><code>${h(hh.invite_code)}</code><button class="btn small" data-action="copy-invite">コピー</button></div>` : ''}
      <button class="link" data-action="rename-household">家計の名前を変える</button>
    </section>

    <section class="card">
      <h2>メンバー</h2>
      <ul class="set-list">${state.members.map((m) => `
        <li><button data-action="edit-member" data-id="${m.id}">
          <span><span class="dot" style="background:var(--series-${memberSlot(m.id)})"></span>${h(m.name)}${m.id === state.myMemberId ? '(あなた)' : ''}</span>
          <small>${m.in_settlement ? '精算に含む' : '精算に含まない'} ›</small>
        </button></li>`).join('')}</ul>
      <button class="btn small" data-action="edit-member">+ メンバーを追加</button>
    </section>

    <section class="card">
      <h2>月の予算</h2>
      <p class="muted small">カテゴリごとに1か月の上限を入力します(空欄は予算なし)。</p>
      ${cats('expense').map((c) => `
        <label class="budget-row"><span>${c.icon} ${h(c.name)}</span>
          <input inputmode="numeric" data-budget="${c.id}" value="${budgetOf.get(c.id) || ''}" placeholder="なし"></label>`).join('')}
    </section>

    <section class="card">
      <h2>支払い予定(固定費)</h2>
      <p class="muted small">家賃・サブスク・給料日など。登録した日に自動で記録されます(いま ${state.recurring.filter((r) => r.active).length}件)。</p>
      <button class="btn small" data-tab="plan">支払い予定を開く</button>
    </section>

    <section class="card">
      <h2>カテゴリ</h2>
      ${['expense', 'income'].map((kind) => `
        <h3>${kind === 'expense' ? '支出' : '収入'}</h3>
        <div class="chips wrap">${cats(kind).map((c) => `<button class="chip" data-action="edit-category" data-id="${c.id}">${c.icon} ${h(c.name)}</button>`).join('')}
          <button class="chip add" data-action="edit-category" data-kind="${kind}">+ 追加</button></div>`).join('')}
    </section>

    <section class="card">
      <h2>データ</h2>
      <button class="btn small" data-action="export-csv">CSVで書き出す(Excel用)</button>
      ${cloud
        ? `<p class="muted small">ログイン中: ${h(backend.userEmail())}</p><button class="btn small" data-action="signout">ログアウト</button>`
        : '<button class="btn small danger" data-action="reset-local">お試しデータをすべて消す</button>'}
    </section>`;
}

// ───────── 入力シート ─────────

function openSheet(title, bodyHtml, { onSubmit, onDelete, onAgain, submitLabel = '保存' } = {}) {
  $sheetRoot.innerHTML = `
    <div class="sheet-backdrop" data-close></div>
    <form class="sheet" novalidate>
      <header><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="閉じる">✕</button></header>
      <div class="sheet-body form">${bodyHtml}</div>
      <footer>
        ${onDelete ? '<button type="button" class="btn danger" data-delete>削除</button>' : ''}
        ${onAgain ? '<button class="btn" name="then" value="again">続けて入力</button>' : ''}
        <button class="btn primary grow">${submitLabel}</button>
      </footer>
    </form>`;
  const form = $sheetRoot.querySelector('form');
  const close = () => { $sheetRoot.innerHTML = ''; };
  for (const el of $sheetRoot.querySelectorAll('[data-close]')) el.addEventListener('click', close);
  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    const again = e.submitter?.value === 'again';
    const ok = await guard(async () => (await onSubmit(new FormData(form), form)) !== false);
    busy = false;
    if (!ok) return;
    close();
    if (again) onAgain();
  });
  form.querySelector('[data-delete]')?.addEventListener('click', async () => {
    if (!confirm('削除しますか?')) return;
    const ok = await guard(async () => { await onDelete(); return true; });
    if (ok) close();
  });
  return form;
}

const radioChips = (name, options, selected) => `
  <div class="chips wrap">${options.map((o) => `
    <label class="chip radio"><input type="radio" name="${name}" value="${o.id}" ${o.id === selected ? 'checked' : ''}><span>${o.label}</span></label>`).join('')}</div>`;

const catOptions = (kind, keepId) => state.categories
  .filter((c) => c.kind === kind && (!c.archived || c.id === keepId))
  .map((c) => ({ id: c.id, label: `${c.icon} ${h(c.name)}` }));
const memberOptions = () => state.members.map((m) => ({ id: m.id, label: h(m.name) }));

// 支出/収入の切り替え・カテゴリ・支払った人・共通かどうか(取引と固定費で共用)
function entryFields(v) {
  return `
    <div class="segmented">
      <label><input type="radio" name="kind" value="expense" ${v.kind === 'expense' ? 'checked' : ''}><span>支出</span></label>
      <label><input type="radio" name="kind" value="income" ${v.kind === 'income' ? 'checked' : ''}><span>収入</span></label>
    </div>
    <label>金額<input name="amount" class="amount" inputmode="numeric" autocomplete="off" placeholder="0" value="${v.amount || ''}" required></label>
    ${v.extraTop || ''}
    <div class="field only-expense"><span class="field-label">カテゴリ</span>${radioChips('category_expense', catOptions('expense', v.category_id), v.category_id)}</div>
    <div class="field only-income"><span class="field-label">カテゴリ</span>${radioChips('category_income', catOptions('income', v.category_id), v.category_id)}</div>
    <div class="field"><span class="field-label"><span class="only-expense">支払った人</span><span class="only-income">受け取った人</span></span>${radioChips('member_id', memberOptions(), v.member_id)}</div>
    <label class="check only-expense"><input type="checkbox" name="shared" ${v.shared ? 'checked' : ''}><span>家族共通の支出(精算の対象にする)</span></label>`;
}

function bindKind(form) {
  const sync = () => {
    const f = new FormData(form);
    form.dataset.kind = f.get('kind');
    if (f.get('repeat')) form.dataset.repeat = f.get('repeat');
  };
  form.addEventListener('change', sync);
  sync();
}

function readEntry(f) {
  const kind = f.get('kind');
  const amount = parseAmount(f.get('amount'));
  if (amount <= 0) throw new Error('金額を入力してください');
  const category_id = f.get(`category_${kind}`);
  if (!category_id) throw new Error('カテゴリを選んでください');
  return {
    kind,
    amount,
    category_id,
    member_id: f.get('member_id') || null,
    shared: kind === 'expense' ? f.get('shared') === 'on' : false,
  };
}

function openTxSheet(id, defaults = {}) {
  const t = id ? byId(state.tx, id) : null;
  const v = t || { kind: 'expense', date: today(), member_id: state.myMemberId, shared: true, memo: '', ...defaults };
  const presets = t ? [] : quickPresets(state.tx).filter((p) => byId(state.categories, p.category_id) && !category(p.category_id).archived);
  const yesterday = toDateStr(new Date(Date.now() - 86400000));
  const presetHtml = presets.length ? `
    <div class="field"><span class="field-label">よく使う入力</span>
      <div class="chips">${presets.map((p, i) => `<button type="button" class="chip" data-preset="${i}">${category(p.category_id).icon} ${h(p.memo)}</button>`).join('')}</div>
    </div>` : '';
  const form = openSheet(t ? '記録を編集' : '収支を入力', presetHtml + entryFields({
    ...v,
    extraTop: `
      <label>日付<input name="date" type="date" value="${v.date}" required></label>
      <div class="chips date-chips">
        <button type="button" class="chip" data-date="${today()}">今日</button>
        <button type="button" class="chip" data-date="${yesterday}">昨日</button>
      </div>`,
  }) + `<label>メモ(任意)<input name="memo" value="${h(v.memo)}" maxlength="60" placeholder="例: スーパー"></label>`, {
    onSubmit: async (f) => {
      const row = { ...readEntry(f), date: f.get('date'), memo: f.get('memo').trim() };
      if (!row.date) throw new Error('日付を入力してください');
      if (t) { row.id = t.id; row.recurring_id = t.recurring_id ?? null; }
      await backend.save('transactions', row);
      state.month = monthOf(row.date);
      lastEntry = { date: row.date, member_id: row.member_id };
      await reload('保存しました');
    },
    // まとめ入力しやすいよう、日付と支払った人は前の入力を引き継ぐ
    onAgain: t ? null : () => openTxSheet(null, lastEntry),
    onDelete: t ? async () => { await backend.remove('transactions', t.id); await reload('削除しました'); } : null,
  });
  bindKind(form);
  const amountInput = form.querySelector('.amount');
  form.addEventListener('click', (e) => {
    const dateChip = e.target.closest('[data-date]');
    if (dateChip) form.querySelector('[name=date]').value = dateChip.dataset.date;
    const presetChip = e.target.closest('[data-preset]');
    if (!presetChip) return;
    const p = presets[Number(presetChip.dataset.preset)];
    form.querySelector(`[name=kind][value=${p.kind}]`).checked = true;
    const radio = [...form.querySelectorAll(`[name=category_${p.kind}]`)].find((r) => r.value === p.category_id);
    if (radio) radio.checked = true;
    form.querySelector('[name=shared]').checked = p.shared;
    form.querySelector('[name=memo]').value = p.memo;
    amountInput.value = p.amount;
    form.dispatchEvent(new Event('change'));
    amountInput.focus();
    amountInput.select();
  });
  if (!t) amountInput.focus();
}
let lastEntry = {};

function openRecurringSheet(id) {
  const r = id ? byId(state.recurring, id) : null;
  const v = r || { kind: 'expense', member_id: state.myMemberId, shared: true, day: 1, name: '', active: true };
  const repeat = r ? (isOnce(r) ? 'once' : r.every === 'year' ? 'year' : 'month') : 'month';
  const now = new Date();
  const onceDate = r && isOnce(r) ? `${r.start_month}-${String(Math.min(r.day, daysInMonth(r.start_month))).padStart(2, '0')}` : today();
  const seg = (value, label) => `<label><input type="radio" name="repeat" value="${value}" ${repeat === value ? 'checked' : ''}><span>${label}</span></label>`;
  const form = openSheet(r ? '予定を編集' : '予定を追加', `
    <label>名前<input name="name" value="${h(v.name)}" required maxlength="40" placeholder="例: 家賃、動画サブスク、自動車税"></label>
    ${entryFields({
      ...v,
      extraTop: `
        <div class="field"><span class="field-label">くり返し</span><div class="segmented three">${seg('month', '毎月')}${seg('year', '毎年')}${seg('once', '1回だけ')}</div></div>
        <div class="row-fields">
          <label class="only-year">何月<input name="month_of_year" type="number" min="1" max="12" value="${v.month_of_year || now.getMonth() + 1}"></label>
          <label class="only-month only-year">何日<input name="day" type="number" min="1" max="31" value="${v.day}"></label>
          <label class="only-once">日付<input name="once_date" type="date" value="${onceDate}"></label>
        </div>`,
    })}
    <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}><span>有効(オフにすると自動記録を止めます)</span></label>
    <p class="muted small">その日になると自動で記録されます。金額が変わる月は、記録されたあと履歴から直せます。</p>`, {
    onSubmit: async (f) => {
      const name = f.get('name').trim();
      if (!name) throw new Error('名前を入力してください');
      const mode = f.get('repeat');
      const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, parseInt(n, 10) || lo));
      const thisMonth = monthOf(today());
      const row = { ...readEntry(f), name, active: f.get('active') === 'on', every: 'month', month_of_year: null, end_month: null };
      // 1回だけ→くり返しに変えたときは、今月から数え直す
      const start = r && !isOnce(r) ? r.start_month : thisMonth;
      if (mode === 'once') {
        const date = f.get('once_date');
        if (!date) throw new Error('日付を入力してください');
        Object.assign(row, { day: Number(date.slice(8)), start_month: monthOf(date), end_month: monthOf(date) });
      } else {
        Object.assign(row, { day: clamp(f.get('day'), 1, 31), start_month: start });
        if (mode === 'year') Object.assign(row, { every: 'year', month_of_year: clamp(f.get('month_of_year'), 1, 12) });
      }
      row.last_generated = r && r.start_month === row.start_month ? r.last_generated ?? null : null;
      if (r) row.id = r.id;
      await backend.save('recurring', row);
      await runRecurring();
      await reload('保存しました');
    },
    onDelete: r ? async () => { await backend.remove('recurring', r.id); await reload('削除しました(過去の記録は残ります)'); } : null,
  });
  bindKind(form);
}

function openMemberSheet(id) {
  const m = id ? byId(state.members, id) : null;
  const canDelete = m && !m.user_id;
  openSheet(m ? 'メンバーを編集' : 'メンバーを追加', `
    <label>呼び名<input name="name" value="${h(m?.name || '')}" required maxlength="20" placeholder="例: ママ"></label>
    <label class="check"><input type="checkbox" name="in_settlement" ${!m || m.in_settlement ? 'checked' : ''}><span>精算に含める(お金を出し合う人)</span></label>
    ${m ? '' : `<p class="muted small">子どもなどログインしない人も追加できます。${backend.mode === 'cloud' ? '本人があとから招待コードで参加するときは、同じ呼び名を入力するとこのメンバーに紐づきます。' : ''}</p>`}`, {
    onSubmit: async (f) => {
      const name = f.get('name').trim();
      if (!name) throw new Error('呼び名を入力してください');
      const row = m ? { ...m, name, in_settlement: f.get('in_settlement') === 'on' }
        : { name, in_settlement: f.get('in_settlement') === 'on', sort: state.members.length, user_id: null };
      await backend.save('members', row);
      await reload('保存しました');
    },
    onDelete: canDelete ? async () => { await backend.remove('members', m.id); await reload('削除しました'); } : null,
  });
}

function openCategorySheet(id, kind) {
  const c = id ? byId(state.categories, id) : null;
  openSheet(c ? 'カテゴリを編集' : 'カテゴリを追加', `
    <label>名前<input name="name" value="${h(c?.name || '')}" required maxlength="20"></label>
    <label>絵文字アイコン<input name="icon" value="${h(c?.icon || '📦')}" maxlength="4"></label>`, {
    onSubmit: async (f) => {
      const name = f.get('name').trim();
      if (!name) throw new Error('名前を入力してください');
      const icon = f.get('icon').trim() || '📦';
      const row = c ? { ...c, name, icon } : { kind, name, icon, sort: state.categories.length, archived: false };
      await backend.save('categories', row);
      await reload('保存しました');
    },
    // 過去の記録の表示を壊さないよう、削除ではなく「使わない」にする
    onDelete: c ? async () => { await backend.save('categories', { ...c, archived: true }); await reload('カテゴリを非表示にしました'); } : null,
  });
}

function openSettleSheet({ from, to, amount }) {
  openSheet('精算を記録', `
    <p><b>${h(memberName(from))}</b> → <b>${h(memberName(to))}</b></p>
    <label>渡した金額<input name="amount" class="amount" inputmode="numeric" value="${amount}" required></label>
    <label>日付<input name="date" type="date" value="${today()}" required></label>
    <label>メモ(任意)<input name="memo" maxlength="60" placeholder="例: 9月分 振込"></label>`, {
    submitLabel: '記録する',
    onSubmit: async (f) => {
      const value = parseAmount(f.get('amount'));
      if (value <= 0) throw new Error('金額を入力してください');
      await backend.save('settlements', { from_member: from, to_member: to, amount: value, date: f.get('date') || today(), memo: f.get('memo').trim() });
      await reload('精算を記録しました');
    },
  });
}

// ───────── 操作 ─────────

const actions = {
  'bubble-mode': (d) => { state.bubbleMode = d.mode; render(); },
  'add-tx': () => openTxSheet(null, state.tab === 'quick' && state.quickAmount ? { amount: Number(state.quickAmount) } : {}),
  key: (d) => pressKey(d.k),
  'quick-commit': (d) => quickCommit(d.kind),
  'edit-tx': (d) => openTxSheet(d.id),
  month: async (d) => { state.month = addMonths(state.month, Number(d.delta)); await reload(); },
  'goto-month': async (d) => { state.month = d.month; await reload(); },
  'filter-member': (d) => { state.historyMember = d.id; render(); },
  'record-settle': (d) => openSettleSheet({ from: d.from, to: d.to, amount: Number(d.amount) }),
  'delete-settle': async (d) => {
    if (!confirm('この精算記録を削除しますか?')) return;
    await guard(() => backend.remove('settlements', d.id));
    await reload('削除しました');
  },
  'settle-mode': (d) => { state.settleMode = d.mode; render(); },
  'edit-loan': (d) => openLoanSheet(d.id),
  'repay-loan': (d) => openRepaySheet(d.id),
  'edit-goal': (d) => openGoalSheet(d.id),
  'deposit-goal': (d) => openDepositSheet(d.id),
  'goal-history': (d) => openGoalHistory(d.id),
  'delete-deposit': async (d) => {
    if (!confirm('この入金の記録を削除しますか?')) return;
    await guard(() => backend.remove('goal_deposits', d.id));
    $sheetRoot.innerHTML = '';
    await reload('削除しました');
  },
  'edit-member': (d) => openMemberSheet(d.id),
  'edit-recurring': (d) => openRecurringSheet(d.id),
  'edit-category': (d) => openCategorySheet(d.id, d.kind),
  'copy-invite': async () => {
    await guard(() => navigator.clipboard.writeText(state.household.invite_code));
    toast('招待コードをコピーしました');
  },
  'rename-household': async () => {
    const name = prompt('家計の名前', state.household.name)?.trim();
    if (!name) return;
    await guard(() => backend.saveHousehold({ name }));
    state.household = await backend.getHousehold();
    render();
  },
  'export-csv': () => guard(async () => {
    const all = (await backend.list('transactions')).sort((a, b) => a.date.localeCompare(b.date));
    const rows = [['日付', '種類', 'カテゴリ', '金額', '支払った人', '区分', 'メモ']];
    for (const t of all) {
      rows.push([t.date, t.kind === 'income' ? '収入' : '支出', category(t.category_id).name, t.amount,
        t.member_id ? memberName(t.member_id) : '', t.kind === 'expense' ? (t.shared ? '家族共通' : '個人') : '', t.memo]);
    }
    const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `家計簿_${today()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }),
  signout: async () => {
    if (!confirm('ログアウトしますか?')) return;
    await backend.signOut();
    location.reload();
  },
  'reset-local': async () => {
    if (!confirm('この端末のお試しデータをすべて消します。元に戻せません。よろしいですか?')) return;
    await backend.resetAll();
    location.reload();
  },
};

document.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) {
    state.tab = tab.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (el && actions[el.dataset.action]) actions[el.dataset.action](el.dataset);
});

// 予算は入力欄から離れたときに保存
$app.addEventListener('change', (e) => {
  const categoryId = e.target.dataset?.budget;
  if (!categoryId) return;
  guard(async () => {
    const amount = parseAmount(e.target.value);
    const existing = state.budgets.find((b) => b.category_id === categoryId);
    await backend.save('budgets', { ...(existing || {}), category_id: categoryId, amount });
    e.target.blur();
    await reload('予算を保存しました');
  });
});

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot().catch((e) => {
  console.error(e);
  $app.innerHTML = `<section class="center-card"><h1>起動できませんでした</h1><p class="muted">${h(e.message)}</p><button class="btn" onclick="location.reload()">もう一度試す</button></section>`;
});
