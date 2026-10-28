import { getDb, closeDb } from "../src/lib/db";
import { seedDemo } from "../src/lib/demo/seed";

async function main() {
  const db = getDb();
  const { story } = await seedDemo(db, { history: true });
  console.log("Demo seeded.");
  console.log("  blocked (mismatch):  " + story.blockedMismatch);
  console.log("  blocked (duplicate): " + story.blockedDuplicate);
  console.log("  approved (PayPal):   " + story.paypal);
  console.log("  awaiting (Stellar):  " + story.stellar);
  closeDb();
}
main().catch((e) => { console.error(e); process.exit(1); });
