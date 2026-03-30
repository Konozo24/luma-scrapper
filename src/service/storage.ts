import { ApifyLumaEvent } from '../type';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
if (!uri) {
    throw new Error("MONGODB_URI is missing in .env file.");
}

const client = new MongoClient(uri);
let isConnected = false;

async function connectDB() {
    if (!isConnected) {
        await client.connect();
        isConnected = true;
        console.log("✅ Connected to MongoDB Atlas");
    }
    return client.db('luma_monitor').collection<ApifyLumaEvent>('events');
}

export async function getKnownEvents(): Promise<ApifyLumaEvent[]> {
    try {
        const collection = await connectDB();
        // Retrieve all events from the database
        return await collection.find({}, { projection: { _id: 0 } }).toArray();
    } catch (error) {
        console.error("❌ MongoDB Fetch Error:", error);
        return [];
    }
}

export async function insertNewEvents(newEvents: ApifyLumaEvent[]) {
    if (newEvents.length === 0) return;
    try {
        const collection = await connectDB();
        // Insert only the new records found in the latest scrape
        await collection.insertMany(newEvents);
        console.log(`Saved ${newEvents.length} new events to MongoDB.`);
    } catch (error) {
        console.error("❌ MongoDB Insert Error:", error);
    }
}