// 動作確認用: 家族どうしの貸し借り → 収支の自動記録を、画面操作で通しで確かめる。
// 先に `python3 -m http.server 8765` と、tests/seed.html を開いた Chrome(cdp.mjs の説明どおり)を起動しておく。
// 実行: node tests/loan-flow.mjs <スクリーンショットの保存先フォルダ>
import { evaluate, send, screenshot, sleep, close } from './cdp.mjs';
const S = process.argv[2];
const db = () => evaluate(`JSON.parse(localStorage.getItem('kakeibo-local-v1'))`);
const linked = async () => (await db()).transactions.filter((t) => t.loan_id).map((t) => `${t.kind}/${t.amount}/${t.date}/${t.memo}`);
const click = (sel) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return 'NOTFOUND ' + ${JSON.stringify(sel)}; e.click(); return 'ok'; })()`);
const log = (...a) => console.log(...a);

await sleep(2500); // seed が終わるまで
await send('Page.navigate', { url: 'http://localhost:8765/tests/_local.html' });
await sleep(2500);
log('1. 起動時の同期(ゆい←ママ 1500):', await linked());
const cats = (await db()).categories.filter((c) => c.name === '貸し借り').map((c) => `${c.kind}/${c.icon}/archived=${c.archived}`);
log('   カテゴリ:', cats);

// 2. 画面から パパ→ママ 5000 を貸す
await click('[data-tab="settle"]'); await sleep(200);
await click('[data-action="settle-mode"][data-mode="loans"]'); await sleep(200);
await click('.plan-add[data-action="edit-loan"]'); await sleep(300);
log('2. シート:', await evaluate(`(() => { const f = document.querySelector('.sheet'); const mama = [...f.querySelectorAll('[name=counterparty]')].find((r) => r.nextElementSibling.textContent === 'ママ'); mama.click(); f.dispatchEvent(new Event('change')); f.querySelector('[name=amount]').value = '5000'; f.querySelector('[name=memo]').value = '旅行の立て替え'; const note = getComputedStyle(f.querySelector('.only-member')).display; f.requestSubmit(); return 'note display=' + note; })()`));
await sleep(800);
log('   トースト:', await evaluate(`document.getElementById('toast').textContent`));
log('   記録:', await linked());
await screenshot(`${S}/loans.png`);

// 3. 立て替えの精算: ママ→パパ
await click('[data-action="settle-mode"][data-mode="split"]'); await sleep(300);
log('3. 渡す:', await evaluate(`[...document.querySelectorAll('.transfer')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`));
await evaluate(`[...document.querySelectorAll('[data-action=record-settle]')].find((b) => b.closest('.transfer').textContent.includes('ママ'))?.click()`);
await sleep(300);
log('   注記:', await evaluate(`document.querySelector('.settle-loan-note')?.textContent`));
await screenshot(`${S}/settle-sheet.png`);
await evaluate(`document.querySelector('.sheet').requestSubmit()`);
await sleep(800);
log('   トースト:', await evaluate(`document.getElementById('toast').textContent`));
const d3 = await db();
log('   貸し借り:', d3.loans.map((l) => `${l.memo}:${l.amount}/repaid ${l.repaid}`));
log('   精算記録:', d3.settlements.map((s) => `${s.amount}`));
log('   記録:', await linked());
log('   渡す(後):', await evaluate(`[...document.querySelectorAll('.transfer, .settled')].map((e) => e.textContent.replace(/\\s+/g, ' ').trim())`));

// 4. ゆいの返済 500(日付を指定)
await click('[data-action="settle-mode"][data-mode="loans"]'); await sleep(300);
await evaluate(`[...document.querySelectorAll('[data-action=repay-loan]')].find((b) => b.closest('li').textContent.includes('ゲーム'))?.click()`);
await sleep(300);
log('4. 返済シート注記:', await evaluate(`document.querySelector('.sheet .sheet-body').textContent.replace(/\\s+/g, ' ').trim()`));
await evaluate(`(() => { const f = document.querySelector('.sheet'); f.querySelector('[name=amount]').value = '500'; f.querySelector('[name=date]').value = '2026-09-20'; f.requestSubmit(); })()`);
await sleep(800);
log('   記録:', await linked());

// 5. 返済の記録を取り消す
await evaluate(`[...document.querySelectorAll('[data-action=edit-loan]')].find((b) => b.textContent.includes('ゲーム'))?.click()`);
await sleep(300);
await evaluate(`window.confirm = () => true`);
log('5.', await click('[data-undo-repaid]'));
await sleep(800);
log('   ゆいの貸し借り:', (await db()).loans.filter((l) => l.memo.includes('ゲーム')).map((l) => l.repaid));
log('   記録:', await linked());

// 6. 貸し借りの金額を直す → 記録も直る
await evaluate(`[...document.querySelectorAll('[data-action=edit-loan]')].find((b) => b.textContent.includes('ゲーム'))?.click()`);
await sleep(300);
await evaluate(`(() => { const f = document.querySelector('.sheet'); f.querySelector('[name=amount]').value = '2000'; f.requestSubmit(); })()`);
await sleep(800);
log('6. 金額変更後:', await linked());

// 7. 履歴から自動記録をタップ → 案内シート → 貸し借りを開く
await click('[data-tab="history"]'); await sleep(300);
await evaluate(`[...document.querySelectorAll('.tx')].find((b) => b.textContent.includes('ママに貸した'))?.click()`);
await sleep(300);
log('7. 案内:', await evaluate(`document.querySelector('.sheet')?.textContent.replace(/\\s+/g, ' ').trim()`));
await screenshot(`${S}/linked-sheet.png`);
await evaluate(`document.querySelector('.sheet').requestSubmit()`);
await sleep(500);
log('   開いたシート:', await evaluate(`document.querySelector('.sheet header h2')?.textContent`), '/ タブ:', await evaluate(`document.querySelector('.page-head h1')?.textContent`));

// 8. 貸し借りを削除 → 記録も消える
await evaluate(`document.querySelector('.sheet [data-delete]').click()`);
await sleep(800);
log('8. 削除後:', await linked(), await evaluate(`document.getElementById('toast').textContent`));

// 9. まとめ画面
await click('[data-tab="home"]'); await sleep(1500);
await screenshot(`${S}/home.png`);
await click('[data-tab="history"]'); await sleep(300);
await screenshot(`${S}/history.png`);
log('errors?', await evaluate(`document.querySelector('.center-card')?.textContent || 'none'`));
close();
