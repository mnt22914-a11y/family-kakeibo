// 動作確認用: 実時間で動くヘッドレス Chrome に接続して、ページ内の式の評価・マウス操作・スクリーンショットを行う小道具。
// アニメーションの確認に使う(--virtual-time-budget では requestAnimationFrame が進まないため)。
// 先に Chrome を起動しておく:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 --user-data-dir=<一時フォルダ> <URL>
// 使う側: import { evaluate, send, screenshot, sleep, close } from './cdp.mjs';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 40 && !target; i++) {
  try { target = (await (await fetch('http://127.0.0.1:9333/json')).json()).find((t) => t.type === 'page'); } catch {}
  if (!target) await sleep(250);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let seq = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); };
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
export const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
export const screenshot = async (path) => { const r = await send('Page.captureScreenshot', { format: 'png' }); (await import('node:fs')).writeFileSync(path, Buffer.from(r.result.data, 'base64')); };
export { sleep, send };
export const close = () => ws.close();
