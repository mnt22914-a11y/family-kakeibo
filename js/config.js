// クラウド同期の設定。
// 空のままだと「お試しモード」(この端末だけに保存)で動きます。
// Supabase の Project Settings → API にある値を貼り付けてください(README 参照)。
window.KAKEIBO_CONFIG = {
  SUPABASE_URL: 'https://dgfrvqmyjbnrdvfwrdwt.supabase.co',
  // 公開用のキー(publishable)。秘密のキー(sb_secret_... / service_role)は絶対にここへ書かない
  SUPABASE_ANON_KEY: 'sb_publishable_nRjm6pxo09emz0HcMmANUw_6FQfitGp',
};
