import {
  makeWASocket,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { MongoClient, WithId } from "mongodb";
import { ApifyLumaEvent } from "./type";
import { AuthDoc, useMongoDBAuthState } from "./util/useMongoDBAuthState";
import pino from "pino";
import * as dotenv from "dotenv";
import * as qrcode from "qrcode-terminal";

dotenv.config();

const MONGO_URI = process.env.MONGODB_URI as string;
const GROUP_JID = process.env.GROUP_JID as string;
const DB_NAME = process.env.DB_NAME as string;
const COLLECTION_NAME = process.env.COLLECTION_NAME as string;
const AUTH_COLLECTION_NAME = process.env.AUTH_COLLECTION_NAME as string;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min: number, max: number) =>
  delay(Math.floor(Math.random() * (max - min + 1) + min));

async function fetchLatestEvent(): Promise<WithId<ApifyLumaEvent> | null> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection<ApifyLumaEvent>(COLLECTION_NAME);
    return collection.findOne({}, { sort: { _id: -1 } });
  } finally {
    await client.close();
  }
}

function formatEventDate(startAt: string | null, timezone: string): string {
  if (!startAt) return `TBA (${timezone})`;

  const dateObj = new Date(startAt);
  if (Number.isNaN(dateObj.getTime())) return `TBA (${timezone})`;

  const weekdayMonthDay = dateObj.toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  const timePart = dateObj.toLocaleString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  return `${weekdayMonthDay} · ${timePart} (${timezone})`;
}

function buildGoogleMapsLink(
  event: WithId<ApifyLumaEvent> | ApifyLumaEvent,
): string | null {
  const location = event.location;
  if (!location) return null;

  if ((location.locationType || "").toLowerCase() === "online") return null;

  if (location.latitude != null && location.longitude != null) {
    return `https://maps.google.com/?q=${location.latitude},${location.longitude}`;
  }

  const query = location.fullAddress || location.city;
  if (!query) return null;

  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}

export function createSummaryMessage(
  event: WithId<ApifyLumaEvent> | ApifyLumaEvent | null,
): string | null {
  if (!event) return null;

  const title = event.name || "Untitled Event";
  const timezone = event.timezone || "Asia/Kuala_Lumpur";
  const hostName =
    event.organizer?.name?.trim() || event.target_profile || "Unknown Host";
  const locationName =
    event.location?.fullAddress || event.location?.city || "Online";
  const registerLink = event.eventUrl || "Link not available";
  const mapsLink = buildGoogleMapsLink(event);

  const lines = [
    `Event: ${title}`,
    "",
    `Host: ${hostName}`,
    `When: ${formatEventDate(event.startAt, timezone)}`,
    `Where: ${locationName}`,
  ];

  if (mapsLink) {
    lines.push(`📍 ${mapsLink}`);
  }

  lines.push("");
  lines.push(`🔗 Register: ${registerLink}`);

  return lines.join("\n");
}

async function connectWhatsApp() {
  const authClient = new MongoClient(MONGO_URI);
  await authClient.connect();
  const authCollection = authClient
    .db(DB_NAME)
    .collection<AuthDoc>(AUTH_COLLECTION_NAME);
  const { state, saveCreds } = await useMongoDBAuthState(authCollection);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(
    `Using WhatsApp Web v${version.join(".")}, isLatest: ${isLatest}`,
  );

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "info" }) as any,
    browser: ["Windows", "Chrome", "20.0.04"],
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg) return;
    if (m.type === "notify" && !msg.key.fromMe) {
      const incomingJid = msg.key.remoteJid;
      const messageContent =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      if (messageContent === "!getId" && incomingJid) {
        await sock.sendMessage(incomingJid, {
          text: `The JID for this chat is:\n\n*${incomingJid}*`,
        });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onUpdate = (update: any) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        qrcode.generate(qr, { small: true });
        console.log("Scan the QR code above with WhatsApp!");
      }
      if (connection === "open") {
        sock.ev.off("connection.update", onUpdate);
        resolve();
      } else if (connection === "close") {
        sock.ev.off("connection.update", onUpdate);
        reject(
          lastDisconnect?.error || new Error("Connection closed before open"),
        );
      }
    };
    sock.ev.on("connection.update", onUpdate);
  });

  return { sock, authClient };
}

async function closeWhatsApp(
  connection: Awaited<ReturnType<typeof connectWhatsApp>>,
): Promise<void> {
  const { sock, authClient } = connection;
  try {
    sock.end(undefined);
  } catch {
    // ignore socket close issues
  }
  try {
    await authClient.close();
  } catch {
    // ignore mongo close issues
  }
}

export async function sendEventSummary(event: ApifyLumaEvent): Promise<void> {
  const result = await sendEventSummaries([event]);
  if (result.failed > 0) {
    throw new Error("Failed to send event summary.");
  }
}

export async function sendEventSummaries(
  events: ApifyLumaEvent[],
): Promise<{ sent: number; failed: number }> {
  if (events.length === 0) return { sent: 0, failed: 0 };

  const connection = await connectWhatsApp();
  const { sock } = connection;
  let sent = 0;
  let failed = 0;

  try {
    for (const event of events) {
      const messageText = createSummaryMessage(event);
      if (!messageText) continue;

      try {
        // appear as "typing"
        await sock.sendPresenceUpdate("composing", GROUP_JID);

        await randomDelay(2000, 4000);

        // stop typing
        await sock.sendPresenceUpdate("paused", GROUP_JID);

        await sock.sendMessage(GROUP_JID, { text: messageText });
        sent += 1;

        // if there is more events, wait a few second before sending
        if (events.indexOf(event) < events.length - 1) {
          await randomDelay(3000, 7000); // Wait 3-7 seconds between messages
        }
      } catch (error) {
        failed += 1;
        console.error(`Failed sending event "${event.name}"`, error);
      }
    }

    await delay(3000);
  } finally {
    await closeWhatsApp(connection);
  }

  return { sent, failed };
}

async function startWhatsAppAndSendLatest() {
  const event = await fetchLatestEvent();
  console.log("\nRAW EVENT FROM DATABASE:", event, "\n");

  if (!event) {
    console.log("No events found in MongoDB.");
    return;
  }

  const { sent, failed } = await sendEventSummaries([event]);
  console.log(`Latest event send completed. sent=${sent}, failed=${failed}`);
}

if (require.main === module) {
  startWhatsAppAndSendLatest().catch((error) => {
    console.error("Notifier run failed:", error);
    process.exitCode = 1;
  });
}
