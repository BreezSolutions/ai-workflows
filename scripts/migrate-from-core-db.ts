/**
 * One-shot migration: copies automation-owned collections from the core db
 * (`prod-ai-bot`) into the new automation db (`prod-ai-automation`) on the
 * same Mongo cluster.
 *
 * Usage:
 *   MONGO_URI=mongodb+srv://... tsx scripts/migrate-from-core-db.ts
 *   MONGO_URI=... DRY_RUN=1 tsx scripts/migrate-from-core-db.ts   # count only
 *
 * Both apps should be stopped before running. After the automation app has
 * run successfully against the new db for a day, drop the originals from
 * `prod-ai-bot` (a separate command, not automated here).
 */
import "dotenv/config";
import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI ?? process.env.MONGODB_URI;
if (!MONGO_URI) { console.error("MONGO_URI is required"); process.exit(1); }

const SOURCE_DB = process.env.SOURCE_DB ?? "prod-ai-bot";
const TARGET_DB = process.env.TARGET_DB ?? "prod-ai-automation";
const DRY_RUN = process.env.DRY_RUN === "1";

const COLLECTIONS = ["workflows", "execution_runs", "execution_items", "thread_sessions"];

async function main() {
  const client = new MongoClient(MONGO_URI!);
  await client.connect();
  const source = client.db(SOURCE_DB);
  const target = client.db(TARGET_DB);

  console.log(`${DRY_RUN ? "[DRY RUN] " : ""}Migrating ${SOURCE_DB} → ${TARGET_DB}`);

  for (const name of COLLECTIONS) {
    const srcCount = await source.collection(name).countDocuments();
    const tgtBefore = await target.collection(name).countDocuments();
    console.log(`  ${name}: ${srcCount} docs in source, ${tgtBefore} docs already in target`);

    if (DRY_RUN || srcCount === 0) continue;
    if (tgtBefore > 0) {
      console.log(`    ⚠ target already has docs — skipping to avoid duplicates. Drop the target collection first if you want to re-run.`);
      continue;
    }

    const docs = await source.collection(name).find({}).toArray();
    await target.collection(name).insertMany(docs);
    const tgtAfter = await target.collection(name).countDocuments();
    console.log(`    ✓ copied ${tgtAfter - tgtBefore} docs`);
  }

  console.log(`Done. Source collections NOT dropped — remove manually after verification.`);
  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
