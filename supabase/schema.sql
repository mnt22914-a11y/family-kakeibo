-- 家族の家計簿: データベース定義
-- Supabase の「SQL Editor」に全文を貼り付けて Run してください(1回だけ)。

-- ───────── テーブル ─────────

create table households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text unique not null default upper(substr(md5(gen_random_uuid()::text), 1, 8)),
  created_at timestamptz not null default now()
);

-- 家族メンバー。user_id が入っている人はログインできる人。
-- 子どもなどログインしない人は user_id なしで登録できる。
create table members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null,
  user_id uuid references auth.users on delete set null,
  in_settlement boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now(),
  unique (household_id, user_id)
);

create table categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  kind text not null check (kind in ('expense', 'income')),
  name text not null,
  icon text not null default '📦',
  sort int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);

create table recurring (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null,
  kind text not null check (kind in ('expense', 'income')),
  amount integer not null check (amount > 0),
  category_id uuid references categories on delete set null,
  member_id uuid references members on delete set null,
  shared boolean not null default true,
  -- every: 'month' = 毎月 / 'year' = 毎年(month_of_year の月だけ)。1回だけの予定は start_month = end_month で表す
  every text not null default 'month' check (every in ('month', 'year')),
  month_of_year int check (month_of_year between 1 and 12),
  day int not null check (day between 1 and 31),
  start_month text not null,
  end_month text,
  last_generated text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  date date not null,
  kind text not null check (kind in ('expense', 'income')),
  amount integer not null check (amount > 0),
  category_id uuid references categories on delete set null,
  member_id uuid references members on delete set null,
  shared boolean not null default true,
  memo text not null default '',
  recurring_id uuid references recurring on delete set null,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (recurring_id, date)
);
create index transactions_household_date on transactions (household_id, date);

create table budgets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  category_id uuid not null references categories on delete cascade,
  amount integer not null check (amount >= 0),
  unique (household_id, category_id)
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  date date not null,
  from_member uuid not null references members on delete cascade,
  to_member uuid not null references members on delete cascade,
  amount integer not null check (amount > 0),
  memo text not null default '',
  created_at timestamptz not null default now()
);

-- 個人間の貸し借り。member_id の人から見て direction = 'lent'(貸した)/ 'borrowed'(借りた)。
-- 相手が家族なら counterparty_member_id、家族以外なら counterparty_name に名前を入れる。
create table loans (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  date date not null,
  member_id uuid references members on delete set null,
  direction text not null check (direction in ('lent', 'borrowed')),
  counterparty_member_id uuid references members on delete set null,
  counterparty_name text not null default '',
  amount integer not null check (amount > 0),
  repaid integer not null default 0 check (repaid >= 0),
  memo text not null default '',
  created_at timestamptz not null default now()
);

-- みんなで一緒の貯金目標と、その入金
create table goals (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  name text not null,
  icon text not null default '🎯',
  target integer not null check (target > 0),
  deadline_month text,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table goal_deposits (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households on delete cascade,
  goal_id uuid not null references goals on delete cascade,
  member_id uuid references members on delete set null,
  amount integer not null check (amount > 0),
  date date not null,
  memo text not null default '',
  created_at timestamptz not null default now()
);

-- ───────── アクセス制御(自分の家族のデータだけ読み書きできる) ─────────

create or replace function is_household_user(hid uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from members where household_id = hid and user_id = auth.uid());
$$;

alter table households enable row level security;
alter table members enable row level security;
alter table categories enable row level security;
alter table recurring enable row level security;
alter table transactions enable row level security;
alter table budgets enable row level security;
alter table settlements enable row level security;
alter table loans enable row level security;
alter table goals enable row level security;
alter table goal_deposits enable row level security;

create policy households_select on households for select to authenticated using (is_household_user(id));
create policy households_update on households for update to authenticated using (is_household_user(id)) with check (is_household_user(id));

create policy members_all on members for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy categories_all on categories for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy recurring_all on recurring for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy transactions_all on transactions for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy budgets_all on budgets for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy settlements_all on settlements for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy loans_all on loans for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy goals_all on goals for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));
create policy goal_deposits_all on goal_deposits for all to authenticated using (is_household_user(household_id)) with check (is_household_user(household_id));

-- ───────── 家計の作成・参加 ─────────

-- 新しい家計を作る(作った人が最初のメンバーになる)
create or replace function create_household(p_name text, p_member_name text, p_categories jsonb)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  hid uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'すでに家計に参加しています';
  end if;
  insert into households (name) values (p_name) returning id into hid;
  insert into members (household_id, name, user_id) values (hid, p_member_name, auth.uid());
  insert into categories (household_id, kind, name, icon, sort)
  select hid, c->>0, c->>1, c->>2, (ord - 1)::int
  from jsonb_array_elements(p_categories) with ordinality as t(c, ord);
  return hid;
end;
$$;

-- 招待コードで家計に参加する。
-- 同じ名前でログイン未連携のメンバーがいれば、その人として参加する。
create or replace function join_household(p_code text, p_member_name text)
returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  hid uuid;
  mid uuid;
begin
  if auth.uid() is null then raise exception 'ログインが必要です'; end if;
  if exists (select 1 from members where user_id = auth.uid()) then
    raise exception 'すでに家計に参加しています';
  end if;
  select id into hid from households where invite_code = upper(trim(p_code));
  if hid is null then raise exception '招待コードが見つかりません'; end if;
  select id into mid from members
    where household_id = hid and user_id is null and name = p_member_name limit 1;
  if mid is not null then
    update members set user_id = auth.uid() where id = mid;
  else
    insert into members (household_id, name, user_id, sort)
    values (hid, p_member_name, auth.uid(), (select count(*) from members where household_id = hid));
  end if;
  return hid;
end;
$$;

revoke execute on function create_household(text, text, jsonb) from public, anon;
revoke execute on function join_household(text, text) from public, anon;
grant execute on function create_household(text, text, jsonb) to authenticated;
grant execute on function join_household(text, text) to authenticated;

-- 精算用: メンバーごとの「家族共通の支出」合計(全期間)
create or replace function shared_paid_totals(p_household uuid)
returns table (member_id uuid, total bigint)
language sql stable
as $$
  select member_id, sum(amount)::bigint
  from transactions
  where household_id = p_household and kind = 'expense' and shared and member_id is not null
  group by member_id;
$$;

-- ───────── リアルタイム同期 ─────────

alter publication supabase_realtime add table transactions, members, categories, recurring, budgets, settlements, households, loans, goals, goal_deposits;
