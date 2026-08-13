import postgres from "postgres";
const sql = postgres(process.env.DATABASE_MIGRATION_URL || process.env.DATABASE_URL, { prepare: false, max: 1 });

// Does the theoretical report read the ledger at all? If it derives from
// recipes only, posting consumption cannot create circularity.
const [beef] = await sql`
  select i.id, i.name, coalesce(sum(m.quantity),0)::float as ledger
  from ingredients i left join stock_movements m on m.ingredient_id=i.id
  where lower(i.name)='beef' group by i.id, i.name order by ledger desc limit 1`;

const sold = await sql`
  select sl.menu_item_name, sum(sl.quantity)::float as qty
  from sale_lines sl join sales s on s.id=sl.sale_id
  where s.status='recorded' group by sl.menu_item_name`;

console.log("Beef ledger balance:", beef?.ledger, "(purchases only — no sale depletion)");
console.log("Sold so far:", sold.map(s => `${s.menu_item_name} x${s.qty}`).join(", ") || "none");
console.log("\nSo a physical count today would show LESS beef than the ledger claims,");
console.log("and the whole gap is expected sales usage — which drowns the real signal.");
await sql.end();
