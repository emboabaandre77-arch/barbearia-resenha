-- RESENHA BARBEARIA: esquema Supabase (cole no SQL Editor)
-- Serviços configurados: Corte R$ 40/30 min; Barba R$ 35/30 min; Corte + barba R$ 70/60 min; Sobrancelha R$ 15/30 min.
-- Funcionamento: segunda a sexta 09:00–19:00; sábado 09:00–17:00; domingo fechado.
-- A configuração abaixo também atualiza os valores caso app_config já exista.
-- Depois de executar, crie um usuário em Authentication > Users e atribua role=admin em public.profiles.
create extension if not exists pgcrypto;

create table if not exists public.app_config (
  id integer primary key default 1 check (id=1),
  config jsonb not null
);
insert into public.app_config(id,config) values (1, jsonb_build_object(
  'nome','Resenha Barbearia','whatsapp','5547999999999','pixChave','SUA-CHAVE-PIX-AQUI','pixNome','NOME DO FAVORECIDO',
  'passoMin',30,'diasAFrente',30,'timezone','America/Sao_Paulo',
  'horarios', jsonb_build_object(
    '0',jsonb_build_object('aberto',false,'abre','00:00','fecha','00:00'),
    '1',jsonb_build_object('aberto',true,'abre','09:00','fecha','19:00'),
    '2',jsonb_build_object('aberto',true,'abre','09:00','fecha','19:00'),
    '3',jsonb_build_object('aberto',true,'abre','09:00','fecha','19:00'),
    '4',jsonb_build_object('aberto',true,'abre','09:00','fecha','19:00'),
    '5',jsonb_build_object('aberto',true,'abre','09:00','fecha','19:00'),
    '6',jsonb_build_object('aberto',true,'abre','09:00','fecha','17:00')),
  'servicos',jsonb_build_array(
    jsonb_build_object('nome','Corte','minutos',30,'preco',40),
    jsonb_build_object('nome','Barba','minutos',30,'preco',35),
    jsonb_build_object('nome','Corte + barba','minutos',60,'preco',70),
    jsonb_build_object('nome','Sobrancelha','minutos',30,'preco',15))
)) on conflict(id) do update set config = excluded.config;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'client' check (role in ('client','admin'))
);
create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_date date not null,
  booking_time time not null,
  service_name text not null,
  minutes integer not null check(minutes > 0),
  customer_name text not null check(char_length(trim(customer_name)) >= 2),
  phone text not null,
  status text not null default 'pendente' check(status in ('pendente','confirmado','cancelado')),
  created_at timestamptz not null default now()
);
create table if not exists public.blocked_days (
  blocked_date date primary key,
  created_at timestamptz not null default now()
);
create index if not exists bookings_date_time_idx on public.bookings(booking_date, booking_time);

alter table public.app_config enable row level security;
alter table public.profiles enable row level security;
alter table public.bookings enable row level security;
alter table public.blocked_days enable row level security;
drop policy if exists "admins read own profile" on public.profiles;
create policy "admins read own profile" on public.profiles for select to authenticated using (id=auth.uid());
-- Tables are accessed through controlled SECURITY DEFINER functions; no direct public table policies.
revoke all on public.app_config, public.bookings, public.blocked_days from anon, authenticated;
grant select on public.profiles to authenticated;


create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path=public,auth as $$
  select exists(select 1 from public.profiles where id=auth.uid() and role='admin');
$$;

create or replace function public.public_config() returns jsonb
language sql stable security definer set search_path=public as $$
  select jsonb_build_object('ok',true,'config',config) from public.app_config where id=1;
$$;

create or replace function public.get_slots(p_data date, p_servico text) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare c jsonb; svc jsonb; day_config jsonb; open_min int; close_min int; dur int; step_min int; start_min int; now_min int; slot_time time; found_conflict boolean; result jsonb := '[]'::jsonb;
begin
  select config into c from public.app_config where id=1;
  if p_data < (now() at time zone 'America/Sao_Paulo')::date or p_data >= (now() at time zone 'America/Sao_Paulo')::date + ((c->>'diasAFrente')::int * interval '1 day') then
    return jsonb_build_object('ok',true,'slots',result);
  end if;
  select x into svc from jsonb_array_elements(c->'servicos') x where x->>'nome'=p_servico limit 1;
  if svc is null then raise exception 'Serviço inválido.'; end if;
  dur := (svc->>'minutos')::int; step_min := (c->>'passoMin')::int;
  day_config := c->'horarios'->(extract(dow from p_data)::int)::text;
  if coalesce((day_config->>'aberto')::boolean,false)=false or exists(select 1 from public.blocked_days where blocked_date=p_data) then return jsonb_build_object('ok',true,'slots',result); end if;
  open_min := split_part(day_config->>'abre',':',1)::int*60+split_part(day_config->>'abre',':',2)::int;
  close_min := split_part(day_config->>'fecha',':',1)::int*60+split_part(day_config->>'fecha',':',2)::int;
  now_min := extract(hour from (now() at time zone 'America/Sao_Paulo'))::int*60+extract(minute from (now() at time zone 'America/Sao_Paulo'))::int;
  for start_min in select generate_series(open_min, close_min-dur, step_min) loop
    if p_data=(now() at time zone 'America/Sao_Paulo')::date and start_min <= now_min then continue; end if;
    slot_time := make_time(start_min/60,start_min%60,0);
    select exists(select 1 from public.bookings b where b.booking_date=p_data and b.status <> 'cancelado' and int4range(start_min,start_min+dur,'[)') && int4range(extract(hour from b.booking_time)::int*60+extract(minute from b.booking_time)::int, extract(hour from b.booking_time)::int*60+extract(minute from b.booking_time)::int+b.minutes,'[)')) into found_conflict;
    if not found_conflict then result := result || to_jsonb(to_char(slot_time,'HH24:MI')); end if;
  end loop;
  return jsonb_build_object('ok',true,'slots',result);
end; $$;

create or replace function public.book_slot(p_data date,p_hora time,p_servico text,p_nome text,p_telefone text) returns jsonb
language plpgsql security definer set search_path=public as $$
declare c jsonb; svc jsonb; slots jsonb; new_booking public.bookings%rowtype; phone_digits text;
begin
  if char_length(trim(coalesce(p_nome,''))) < 2 or char_length(trim(p_nome)) > 100 then raise exception 'Confira seu nome: informe pelo menos 2 caracteres.'; end if;
  phone_digits := regexp_replace(coalesce(p_telefone,''),'\D','','g');
  if length(phone_digits)<10 or length(phone_digits)>15 then raise exception 'Confira seu telefone com DDD.'; end if;
  select config into c from public.app_config where id=1;
  select x into svc from jsonb_array_elements(c->'servicos') x where x->>'nome'=p_servico limit 1;
  if svc is null then raise exception 'Serviço inválido.'; end if;
  perform pg_advisory_xact_lock(hashtext(p_data::text));
  slots := public.get_slots(p_data,p_servico)->'slots';
  if not slots ? to_char(p_hora,'HH24:MI') then raise exception 'Esse horário acabou de ser reservado. Escolha outro.'; end if;
  insert into public.bookings(booking_date,booking_time,service_name,minutes,customer_name,phone,status)
  values(p_data,p_hora,p_servico,(svc->>'minutos')::int,trim(p_nome),trim(p_telefone),'pendente') returning * into new_booking;
  return jsonb_build_object('ok',true,'agendamento',jsonb_build_object('id',new_booking.id,'data',new_booking.booking_date,'hora',to_char(new_booking.booking_time,'HH24:MI'),'servico',new_booking.service_name,'minutos',new_booking.minutes,'nome',new_booking.customer_name,'telefone',new_booking.phone,'status',new_booking.status,'preco',(svc->>'preco')::numeric));
end; $$;

create or replace function public.admin_list(p_data date) returns jsonb
language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.is_admin() then raise exception 'Acesso administrativo negado.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'data',b.booking_date,'hora',to_char(b.booking_time,'HH24:MI'),'servico',b.service_name,'minutos',b.minutes,'nome',b.customer_name,'telefone',b.phone,'status',b.status,'preco',coalesce((select (x->>'preco')::numeric from public.app_config c,jsonb_array_elements(c.config->'servicos') x where x->>'nome'=b.service_name limit 1),0)) order by b.booking_time),'[]'::jsonb) into result from public.bookings b where b.booking_date=p_data;
  return jsonb_build_object('ok',true,'data',p_data,'bloqueado',exists(select 1 from public.blocked_days where blocked_date=p_data),'agendamentos',result);
end; $$;

create or replace function public.admin_set_status(p_id uuid,p_status text) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Acesso administrativo negado.'; end if;
  if p_status not in ('confirmado','cancelado') then raise exception 'Status inválido.'; end if;
  update public.bookings set status=p_status where id=p_id;
  if not found then raise exception 'Agendamento não encontrado.'; end if;
  return jsonb_build_object('ok',true,'id',p_id,'status',p_status);
end; $$;

create or replace function public.admin_set_block(p_data date,p_bloqueado boolean) returns jsonb
language plpgsql security definer set search_path=public as $$
begin
  if not public.is_admin() then raise exception 'Acesso administrativo negado.'; end if;
  if p_bloqueado then insert into public.blocked_days(blocked_date) values(p_data) on conflict do nothing;
  else delete from public.blocked_days where blocked_date=p_data; end if;
  return jsonb_build_object('ok',true,'data',p_data,'bloqueado',p_bloqueado);
end; $$;

revoke all on function public.is_admin() from public;
revoke all on function public.public_config() from public;
revoke all on function public.get_slots(date,text) from public;
revoke all on function public.book_slot(date,time,text,text,text) from public;
revoke all on function public.admin_list(date) from public;
revoke all on function public.admin_set_status(uuid,text) from public;
revoke all on function public.admin_set_block(date,boolean) from public;
grant execute on function public.public_config() to anon, authenticated;
grant execute on function public.get_slots(date,text) to anon, authenticated;
grant execute on function public.book_slot(date,time,text,text,text) to anon, authenticated;
grant execute on function public.admin_list(date) to authenticated;
grant execute on function public.admin_set_status(uuid,text) to authenticated;
grant execute on function public.admin_set_block(date,boolean) to authenticated;
