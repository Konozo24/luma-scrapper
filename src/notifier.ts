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

function normalizeEnv(value: string | undefined): string {
  const trimmed = (value || "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "").trim();
}

const MONGO_URI = normalizeEnv(process.env.MONGODB_URI);
const GROUP_JID = normalizeEnv(process.env.GROUP_JID);
const DB_NAME = normalizeEnv(process.env.DB_NAME);
const COLLECTION_NAME = normalizeEnv(process.env.COLLECTION_NAME);
const AUTH_COLLECTION_NAME = normalizeEnv(process.env.AUTH_COLLECTION_NAME) || "whatsapp_auth";
if (!MONGO_URI) {
  throw new Error("[WA AUTH DEBUG] Missing MONGODB_URI after normalization.");
}
if (!DB_NAME) {
  throw new Error("[WA AUTH DEBUG] Missing DB_NAME after normalization.");
}
const SENT_NOTIFICATIONS_COLLECTION = "sent_notifications";
const NOTIFIER_ATTEMPTS_COLLECTION = "notifier_attempts";
const PENDING_NOTIFICATIONS_COLLECTION = "pending_notifications";
const MAX_MESSAGES_PER_RUN = 3;
const MAX_MESSAGES_PER_HOUR = 20;
const MAX_MESSAGES_PER_DAY = 100;
const DEDUP_WINDOW_HOURS = 24;
const FAILURE_WINDOW_SIZE = 20;
const FAILURE_RATIO_THRESHOLD = 0.2;
let sharedAuthClient: MongoClient | null = null;
let sharedAuthStatePromise:
  | Promise<Awaited<ReturnType<typeof useMongoDBAuthState>>>
  | null = null;
let authTargetLogged = false;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomDelay = (min: number, max: number) =>
  delay(Math.floor(Math.random() * (max - min + 1) + min));

async function getSharedMongoClient(): Promise<MongoClient> {
  if (!sharedAuthClient) {
    sharedAuthClient = new MongoClient(MONGO_URI);
    await sharedAuthClient.connect();
  }
  return sharedAuthClient;
}

async function getSentNotificationsCollection() {
  const client = await getSharedMongoClient();
  return client.db(DB_NAME).collection(SENT_NOTIFICATIONS_COLLECTION);
}

async function getNotifierAttemptsCollection() {
  const client = await getSharedMongoClient();
  return client.db(DB_NAME).collection(NOTIFIER_ATTEMPTS_COLLECTION);
}

async function getPendingNotificationsCollection() {
  const client = await getSharedMongoClient();
  return client.db(DB_NAME).collection(PENDING_NOTIFICATIONS_COLLECTION);
}

async function wasRecentlySent(dedupKey: string): Promise<boolean> {
  const collection = await getSentNotificationsCollection();
  const since = new Date(Date.now() - DEDUP_WINDOW_HOURS * 60 * 60 * 1000);
  const existing = await collection.findOne({
    dedupKey,
    groupJid: GROUP_JID,
    sentAt: { $gte: since },
  });
  return Boolean(existing);
}

async function markAsSent(event: ApifyLumaEvent): Promise<void> {
  const collection = await getSentNotificationsCollection();
  await collection.insertOne({
    dedupKey: event.dedupKey,
    eventId: event.id,
    eventName: event.name,
    groupJid: GROUP_JID,
    sentAt: new Date(),
  });
}

async function getSentCountSince(msAgo: number): Promise<number> {
  const collection = await getSentNotificationsCollection();
  const since = new Date(Date.now() - msAgo);
  return collection.countDocuments({
    groupJid: GROUP_JID,
    sentAt: { $gte: since },
  });
}

async function recordAttempt(
  event: ApifyLumaEvent,
  status: "sent" | "failed" | "skipped",
  reason?: string,
): Promise<void> {
  const collection = await getNotifierAttemptsCollection();
  await collection.insertOne({
    dedupKey: event.dedupKey,
    eventId: event.id,
    eventName: event.name,
    groupJid: GROUP_JID,
    status,
    reason: reason || null,
    at: new Date(),
  });
}

async function shouldPauseFromFailureRate(): Promise<boolean> {
  const collection = await getNotifierAttemptsCollection();
  const recent = await collection
    .find({ groupJid: GROUP_JID, status: { $in: ["sent", "failed"] } })
    .sort({ at: -1 })
    .limit(FAILURE_WINDOW_SIZE)
    .toArray();

  if (recent.length < FAILURE_WINDOW_SIZE) return false;
  const failures = recent.filter((row) => row.status === "failed").length;
  const ratio = failures / recent.length;
  return ratio > FAILURE_RATIO_THRESHOLD;
}

async function enqueuePending(event: ApifyLumaEvent, reason: string): Promise<void> {
  const collection = await getPendingNotificationsCollection();
  await collection.updateOne(
    { dedupKey: event.dedupKey, groupJid: GROUP_JID },
    {
      $setOnInsert: {
        dedupKey: event.dedupKey,
        event,
        groupJid: GROUP_JID,
        createdAt: new Date(),
      },
      $set: {
        reason,
        updatedAt: new Date(),
      },
      $inc: { attempts: 1 },
    },
    { upsert: true },
  );
}

async function removePending(dedupKey: string): Promise<void> {
  const collection = await getPendingNotificationsCollection();
  await collection.deleteOne({ dedupKey, groupJid: GROUP_JID });
}

async function loadPending(limit: number): Promise<ApifyLumaEvent[]> {
  const collection = await getPendingNotificationsCollection();
  const docs = await collection
    .find({ groupJid: GROUP_JID })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();

  return docs
    .map((doc: any) => doc.event as ApifyLumaEvent | undefined)
    .filter((event): event is ApifyLumaEvent => Boolean(event?.dedupKey));
}

async function fetchLatestEvent(): Promise<WithId<ApifyLumaEvent> | null> {
  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection<ApifyLumaEvent>(COLLECTION_NAME);
    const latestEvent = await collection.findOne({}, { sort: { _id: -1 } });
    return latestEvent;
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
  if (!sharedAuthClient) {
    sharedAuthClient = new MongoClient(MONGO_URI);
    await sharedAuthClient.connect();
  }

  if (!authTargetLogged) {
    let mongoHost = "unknown";
    try {
      mongoHost = new URL(MONGO_URI).host;
    } catch {
      mongoHost = "invalid-uri";
    }
    console.log(`[WA AUTH DEBUG] Mongo host: ${mongoHost}`);
    console.log(`[WA AUTH DEBUG] DB_NAME: ${DB_NAME}`);
    console.log(`[WA AUTH DEBUG] AUTH_COLLECTION_NAME: ${AUTH_COLLECTION_NAME}`);
    authTargetLogged = true;
  }

  if (!sharedAuthStatePromise) {
    const authCollection = sharedAuthClient
      .db(DB_NAME)
      .collection<AuthDoc>(AUTH_COLLECTION_NAME);
    const [totalDocs, credsDoc, keyDocs] = await Promise.all([
      authCollection.countDocuments({}),
      authCollection.findOne({ _id: "creds" }),
      authCollection.countDocuments({ _id: { $regex: "^key:" } }),
    ]);
    console.log(
      `[WA AUTH DEBUG] Auth collection docs total=${totalDocs}, credsExists=${Boolean(credsDoc)}, keyDocs=${keyDocs}`,
    );
    sharedAuthStatePromise = useMongoDBAuthState(authCollection);
  }

  const { state, saveCreds } = await sharedAuthStatePromise;
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`Using WhatsApp Web v${version.join(".")}, isLatest: ${isLatest}`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: "info" }) as any,
      browser: ["Windows", "Chrome", "20.0.04"],
    });

    let isClosing = false;
    const safeSaveCreds = async () => {
      if (isClosing) return;
      try {
        await saveCreds();
      } catch (error) {
        console.error("Failed to persist WhatsApp creds:", error);
      }
    };

    sock.ev.on("creds.update", safeSaveCreds);
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

    try {
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
            reject(lastDisconnect?.error || new Error("Connection closed before open"));
          }
        };
        sock.ev.on("connection.update", onUpdate);
      });

      await safeSaveCreds();
      console.log("[WA AUTH DEBUG] Forced saveCreds checkpoint after successful connect.");

      return { sock, safeSaveCreds, setClosing: () => (isClosing = true) };
    } catch (error: any) {
      const statusCode = error?.output?.statusCode || error?.data?.attrs?.code;
      const shouldRetry = String(statusCode) === "515" && attempt < 3;
      sock.ev.off("creds.update", safeSaveCreds);
      try {
        sock.end(undefined);
      } catch {
        // ignore close issues
      }
      if (shouldRetry) {
        console.log("[WA AUTH DEBUG] 515 restart-required received after pairing/connect. Retrying...");
        await delay(1500);
        continue;
      }
      throw error;
    }
  }

  throw new Error("Unable to connect WhatsApp after retries.");
}

async function closeWhatsApp(
  connection: Awaited<ReturnType<typeof connectWhatsApp>>,
): Promise<void> {
  const { sock, safeSaveCreds, setClosing } = connection;
  setClosing();
  sock.ev.off("creds.update", safeSaveCreds);
  try {
    sock.end(undefined);
  } catch {
    // ignore socket close issues
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
  const pendingEvents = await loadPending(50);
  const merged = [...pendingEvents, ...events];
  if (merged.length === 0) return { sent: 0, failed: 0 };

  const eventMap = new Map<string, ApifyLumaEvent>();
  for (const event of merged) {
    if (!event?.dedupKey) continue;
    if (!eventMap.has(event.dedupKey)) {
      eventMap.set(event.dedupKey, event);
    }
  }
  const allCandidates = Array.from(eventMap.values());
  await randomDelay(1000, 3000);

  const sentLastHour = await getSentCountSince(60 * 60 * 1000);
  if (sentLastHour >= MAX_MESSAGES_PER_HOUR) {
    for (const event of allCandidates) {
      await enqueuePending(event, "hourly_limit");
    }
    console.warn(
      `Skipping send: hourly limit reached (${sentLastHour}/${MAX_MESSAGES_PER_HOUR}).`,
    );
    return { sent: 0, failed: 0 };
  }

  const sentLastDay = await getSentCountSince(24 * 60 * 60 * 1000);
  if (sentLastDay >= MAX_MESSAGES_PER_DAY) {
    for (const event of allCandidates) {
      await enqueuePending(event, "daily_limit");
    }
    console.warn(
      `Skipping send: daily limit reached (${sentLastDay}/${MAX_MESSAGES_PER_DAY}).`,
    );
    return { sent: 0, failed: 0 };
  }

  const connection = await connectWhatsApp();
  const { sock } = connection;
  let sent = 0;
  let failed = 0;
  const eventsToSend = allCandidates.slice(0, MAX_MESSAGES_PER_RUN);
  const overflow = allCandidates.slice(MAX_MESSAGES_PER_RUN);

  if (overflow.length > 0) {
    for (const event of overflow) {
      await enqueuePending(event, "run_cap");
    }
    console.log(
      `Run cap enabled: sending ${MAX_MESSAGES_PER_RUN} of ${allCandidates.length} events this run.`,
    );
  }

  try {
    for (let i = 0; i < eventsToSend.length; i += 1) {
      const event = eventsToSend[i];
      if (!event) continue;
      if (await shouldPauseFromFailureRate()) {
        for (let j = i; j < eventsToSend.length; j += 1) {
          const pendingEvent = eventsToSend[j];
          if (!pendingEvent) continue;
          await enqueuePending(pendingEvent, "failure_rate_pause");
        }
        console.warn(
          `Pausing sends: failure ratio too high in last ${FAILURE_WINDOW_SIZE} attempts.`,
        );
        break;
      }

      if (await wasRecentlySent(event.dedupKey)) {
        await removePending(event.dedupKey);
        await recordAttempt(event, "skipped", "dedup_window");
        continue;
      }

      const messageText = createSummaryMessage(event);
      if (!messageText) {
        await enqueuePending(event, "empty_message");
        await recordAttempt(event, "skipped", "empty_message");
        continue;
      }

      try {
        // appear as "typing"
        await sock.sendPresenceUpdate("composing", GROUP_JID);

        await randomDelay(4000, 9000);

        // stop typing
        await sock.sendPresenceUpdate("paused", GROUP_JID);

        await sock.sendMessage(GROUP_JID, { text: messageText });
        await markAsSent(event);
        await removePending(event.dedupKey);
        await recordAttempt(event, "sent");
        sent += 1;

        // if there is more events, wait a few second before sending
        if (eventsToSend.indexOf(event) < eventsToSend.length - 1) {
          await randomDelay(8000, 20000);
        }
      } catch (error) {
        await enqueuePending(event, "send_failed");
        failed += 1;
        await recordAttempt(event, "failed", (error as Error)?.message || "send_error");
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
