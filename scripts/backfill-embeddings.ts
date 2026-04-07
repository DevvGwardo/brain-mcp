#!/usr/bin/env npx tsx
/**
 * Backfill embeddings for existing memories that don't have them.
 *
 * Usage: npx tsx scripts/backfill-embeddings.ts
 * Requires: OPENAI_API_KEY in environment
 */

import { BrainDB } from '../src/db.js';
import { createEmbeddingProvider } from '../src/embeddings.js';

async function main() {
  const provider = createEmbeddingProvider();
  if (!provider) {
    console.error('No embedding provider available. Set OPENAI_API_KEY.');
    process.exit(1);
  }

  const db = new BrainDB(process.env.BRAIN_DB_PATH);
  db.setEmbeddingProvider(provider);

  // Find all memories without embeddings
  const stmt = (db as any).db.prepare(
    'SELECT id, key, content FROM memory WHERE embedding IS NULL'
  );
  const memories = stmt.all() as Array<{ id: string; key: string; content: string }>;

  if (memories.length === 0) {
    console.log('All memories already have embeddings.');
    return;
  }

  console.log(`Found ${memories.length} memories without embeddings. Backfilling...`);

  const BATCH_SIZE = 100;
  let processed = 0;

  for (let i = 0; i < memories.length; i += BATCH_SIZE) {
    const batch = memories.slice(i, i + BATCH_SIZE);
    const texts = batch.map(m => `${m.key} ${m.content}`);

    try {
      const embeddings = await provider.embedBatch(texts);
      for (let j = 0; j < batch.length; j++) {
        db.storeMemoryEmbedding(batch[j].id, embeddings[j]);
      }
      processed += batch.length;
      console.log(`  Embedded ${processed}/${memories.length} memories...`);
    } catch (err: any) {
      console.error(`  Error embedding batch ${i}-${i + batch.length}: ${err.message}`);
    }
  }

  console.log(`Done. ${processed}/${memories.length} memories now have embeddings.`);
  db.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
