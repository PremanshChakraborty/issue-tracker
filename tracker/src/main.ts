import * as fs from 'fs';
import * as path from 'path';
import type { Watchlist } from '@issue-tracker/types';

// Root of the repo — two levels up from tracker/src/
const ROOT = path.resolve(__dirname, '../..');

function loadWatchlist(): Watchlist {
  const filePath = path.join(ROOT, 'watchlist.json');
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw) as Watchlist;
}

async function main(): Promise<void> {
  console.log('=== Issue Tracker Cron Start ===');

  const watchlist = loadWatchlist();
  const issueRefs = Object.keys(watchlist.issues);

  if (issueRefs.length === 0) {
    console.log('No issues in watchlist, exiting.');
    process.exit(0);
  }

  console.log(`Found ${issueRefs.length} issue(s) in watchlist.`);
  // Phase 2 will implement the full fetch / detect / notify logic here.
  console.log('=== Phase 1 placeholder — full logic coming in Phase 2 ===');
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
