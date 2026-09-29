-- 2026-09-29 家族どうしの貸し借りを収支に自動で記録する
-- すでに schema.sql を実行済みの Supabase で、この内容を SQL Editor に貼り付けて Run してください(1回だけ)。
-- これまでの貸し借りの分の収支は、アプリを開いたときに自動で作られます。

alter table transactions add column if not exists loan_id uuid references loans on delete cascade;
create index if not exists transactions_loan on transactions (loan_id) where loan_id is not null;
