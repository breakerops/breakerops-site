#!/usr/bin/env bash
# invite-redeem-race-pin.sh: durable regression pin for the invite redeem
# race invariants (proof originally executed on real PG during review; this
# pins the important cases reproducibly). LOCAL FIXTURE ONLY - requires a
# fixture DB with fixture.sql + invite-core.sql loaded. Never run on live.
# Usage: PGHOST=/tmp/pgsrv PGUSER=postgres DB=bo_fixture ./invite-redeem-race-pin.sh
set -u
DB="${DB:-bo_fixture}"
JAKE='80f2d1a2-7634-40e8-abf6-904e0aae73b4'
CUST='f3333333-3333-4333-8333-333333333333'
PHONE='+15557654321'
FAIL=0

reset() {
  psql -d "$DB" -qc "delete from invite_stage.audit; delete from invite_stage.businesses; delete from invite_stage.links; delete from invite_stage.customers;" >/dev/null
  psql -d "$DB" -qc "insert into invite_stage.customers(id, owner_user_id, allowance, phone) values ('$CUST','$JAKE',5,'+15553330000'); update invite_stage.settings set activation_enabled=true;" >/dev/null
}

echo "== pin 1: 6 concurrent redeems of one issued link -> 1 admitted, 5 member, 1 business, 1 audit =="
reset
psql -d "$DB" -qc "insert into invite_stage.links(customer_id,intended_phone,request_key,issued_by,expires_at) values ('$CUST','$PHONE','pin-1','$JAKE',now()+interval '7 days');" >/dev/null
for i in 1 2 3 4 5 6; do
  psql -d "$DB" -tAc "select invite_stage.redeem_on_inbound('$PHONE')->>'status'" >> /tmp/pin1-out.txt & P=$!; eval P$i=$P
done
wait
grep -c admitted /tmp/pin1-out.txt | grep -qx 1 || { echo "FAIL: admitted count != 1"; FAIL=1; }
grep -c member /tmp/pin1-out.txt | grep -qx 5 || { echo "FAIL: member count != 5"; FAIL=1; }
B=$(psql -d "$DB" -tAc "select count(*) from invite_stage.businesses where owner_phone='$PHONE'")
A=$(psql -d "$DB" -tAc "select count(*) from invite_stage.audit where event='accepted'")
L=$(psql -d "$DB" -tAc "select count(*) from invite_stage.links where request_key='pin-1' and accepted_at is not null")
[ "$B" = 1 ] && [ "$A" = 1 ] && [ "$L" = 1 ] || { echo "FAIL: business=$B audit=$A accepted_links=$L"; FAIL=1; }
[ $FAIL = 0 ] && echo "pin 1 PASS" || true
rm -f /tmp/pin1-out.txt

echo "== pin 2: 20 rounds issue+redeem same phone concurrently -> single coherent outcome each round =="
for r in $(seq 1 20); do
  reset
  psql -d "$DB" -qc "select set_config('request.jwt.claim.sub','$JAKE',true); select invite_stage.issue('$CUST','$PHONE','pin-2-$r',now()+interval '7 days');" >/dev/null & I=$!
  psql -d "$DB" -tAc "select invite_stage.redeem_on_inbound('$PHONE')->>'status'" > /tmp/pin2-out.txt & R=$!
  wait $I $R
  S=$(cat /tmp/pin2-out.txt)
  NB=$(psql -d "$DB" -tAc "select count(*) from invite_stage.businesses where owner_phone='$PHONE'")
  # coherent outcomes: redeem-before-issue sees 'none' and no business, or serialized admit with exactly one
  if [ "$S" = "none" ]; then
    [ "$NB" = 0 ] || { echo "FAIL round $r: none but business exists"; FAIL=1; }
  else
    [ "$S" = "admitted" ] && [ "$NB" = 1 ] || { echo "FAIL round $r: status=$S business=$NB"; FAIL=1; }
  fi
done
[ $FAIL = 0 ] && echo "pin 2 PASS (20 rounds)" || true
rm -f /tmp/pin2-out.txt

echo "== pin 3: 20 rounds cross-customer issue race for one phone -> never 2 pending =="
for r in $(seq 1 20); do
  reset
  psql -d "$DB" -qc "insert into invite_stage.customers(owner_user_id, allowance, phone) values ('$JAKE',5,'+15553330001');" >/dev/null
  C2=$(psql -d "$DB" -tAc "select id from invite_stage.customers where phone='+15553330001'")
  psql -d "$DB" -qc "select set_config('request.jwt.claim.sub','$JAKE',true); select invite_stage.issue('$CUST','$PHONE','pin-3a-$r',now()+interval '7 days');" >/dev/null 2>/dev/null & A=$!
  psql -d "$DB" -qc "select set_config('request.jwt.claim.sub','$JAKE',true); select invite_stage.issue('$C2','$PHONE','pin-3b-$r',now()+interval '7 days');" >/dev/null 2>/dev/null & B2=$!
  wait $A $B2
  P=$(psql -d "$DB" -tAc "select count(*) from invite_stage.links where intended_phone='$PHONE' and accepted_at is null and revoked_at is null")
  [ "$P" -le 1 ] || { echo "FAIL round $r: $P pending links for one phone"; FAIL=1; }
done
[ $FAIL = 0 ] && echo "pin 3 PASS (20 rounds)" || true

reset
[ $FAIL = 0 ] && echo "ALL PINS PASS" || { echo "PINS FAILED"; exit 1; }
