import { MongoClient } from "mongodb";
import { ApifyLumaEvent } from "../type";
import { getDedupKeyFromEvent } from "../util/dedup";

const uri = process.env.MONGODB_URI;
let client: MongoClient | null = null;
let isConnected = false;

export interface UpsertSummary {
  attempted: number;
  inserted: number;
  existing: number;
  insertedEvents: ApifyLumaEvent[];
}

export function getInsertedEventsFromUpsert(
  normalizedEvents: ApifyLumaEvent[],
  upsertedIds: Record<number, unknown> | undefined,
): ApifyLumaEvent[] {
  if (!upsertedIds) return [];

  return Object.keys(upsertedIds)
    .map((key) => Number(key))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < normalizedEvents.length)
    .map((index) => normalizedEvents[index])
    .filter((event): event is ApifyLumaEvent => Boolean(event));
}

async function connectDB() {
  if (!uri) {
    throw new Error("MONGODB_URI is missing in .env file.");
  }

  if (!client) {
    client = new MongoClient(uri);
  }

  if (!isConnected) {
    await client.connect();
    isConnected = true;
    console.log("Connected to MongoDB Atlas");
  }

  const collection = client.db("luma_monitor").collection<ApifyLumaEvent>("events");

  await collection.createIndex(
    { dedupKey: 1 },
    { unique: true, sparse: true, name: "uniq_dedup_key" },
  );

  return collection;
}

export async function upsertEvents(events: ApifyLumaEvent[]): Promise<UpsertSummary> {
  if (events.length === 0) {
    return { attempted: 0, inserted: 0, existing: 0, insertedEvents: [] };
  }

  try {
    const collection = await connectDB();
    const normalizedEvents = events.map((event) => {
      const { id, target_profile, eventUrl, dedupKey, ...rest } = event;

      return {
        id,
        dedupKey: dedupKey || getDedupKeyFromEvent(event),
        target_profile,
        eventUrl,
        ...rest,
      };
    });

    const ops = normalizedEvents.map((event) => ({
      updateOne: {
        filter: { dedupKey: event.dedupKey },
        update: { $setOnInsert: event },
        upsert: true,
      },
    }));

    const result = await collection.bulkWrite(ops, { ordered: false });
    const inserted = result.upsertedCount ?? 0;
    const attempted = normalizedEvents.length;
    const existing = attempted - inserted;
    const insertedEvents = getInsertedEventsFromUpsert(
      normalizedEvents,
      result.upsertedIds as Record<number, unknown> | undefined,
    );

    return { attempted, inserted, existing, insertedEvents };
  } catch (error) {
    console.error("MongoDB Upsert Error:", error);
    return { attempted: events.length, inserted: 0, existing: events.length, insertedEvents: [] };
  }
}
