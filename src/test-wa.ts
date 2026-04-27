import makeWASocket, {
  useMultiFileAuthState,
  BaileysEventMap,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  CacheStore,
} from "@whiskeysockets/baileys";

import NodeCache from "@cacheable/node-cache";

import P from "pino";

import { Boom } from "@hapi/boom";

import QRCode from "qrcode";

export async function initWhatsApp(): Promise<ReturnType<typeof makeWASocket>> {
  // Set logger to 'debug' for testing, or 'silent' to keep it clean

  const logger = P({ level: "silent" });

  // Auth state persistence logic

  const { state, saveCreds } = await useMultiFileAuthState("auth/wa_session");

  // Fetch latest WA Web version to prevent connection issues

  const { version } = await fetchLatestBaileysVersion();

  // Setup retry cache as seen in official example

  const msgRetryCounterCache = new NodeCache() as CacheStore;

  const sock = makeWASocket({
    version,

    logger,

    auth: {
      creds: state.creds,

      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },

    msgRetryCounterCache,

    // generateHighQualityLinkPreview: true // Useful for Luma event links
  });

  // Batch event processing

  sock.ev.process(async (events: Partial<BaileysEventMap>) => {
    // Handle Connection Updates

    if (events["connection.update"]) {
      const { connection, lastDisconnect, qr } = events["connection.update"];

      // Manually handle QR code generation to fix deprecation warning

      if (qr) {
        console.log("📷 Scan the QR code below to connect to WhatsApp:");

        console.log(
          await QRCode.toString(qr, { type: "terminal", small: true }),
        );
      }

      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `Connection closed (Reason: ${statusCode}). Reconnecting: ${shouldReconnect}`,
        );

        if (shouldReconnect) {
          initWhatsApp();
        }
      } else if (connection === "open") {
        console.log("✅ WhatsApp Bridge is now Online!");
      }
    }

    // Save Credentials whenever updated

    if (events["creds.update"]) {
      await saveCreds();
    }

    // Listen for New Messages (Upsert)

    if (events["messages.upsert"]) {
      const upsert = events["messages.upsert"];

      for (const msg of upsert.messages) {
        if (!msg.key.fromMe) {
          const userMessage =
            msg.message?.conversation || msg.message?.extendedTextMessage?.text;

          if (userMessage) {
            console.log(`🧠 AI is thinking about: ${userMessage}`);

            // 2. This is where you "Link" the Nanobot logic

            // For now, let's simulate the Nano Bot response:

            const botResponse = `NanoBot AI: I received your message "${userMessage}". I can help you scrape Luma events!`;

            await sock.sendMessage(msg.key.remoteJid!, { text: botResponse });
          }
        }
      }
    }
  });

  return sock;
}

// Run the initialization

console.log("🚀 Starting WhatsApp test...");

initWhatsApp();
