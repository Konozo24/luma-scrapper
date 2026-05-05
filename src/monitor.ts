import { scrapeCalendarAPI, getCalendarIdFromUrl } from "./service/lumaScraper";
import { scrapeGdgAPI } from "./service/gdgScraper";
import { upsertEvents } from "./service/storage";
import { sendEventSummaries } from "./notifier";
import { ApifyLumaEvent } from "./type";

const CALENDAR_NAMES: Record<string, string> = {
  "cal-DqBTiRhIzzmBhcU": "AI.SEA",
  "cal-DjCdUOevQOyB5OS": "AI Hackerdom",
  "cal-HRPtK7hDvVSLaNu": "Nyala Labs",
  "cal-AQNeOLktkou1BBv": "Testing",
  "https://gdg.community.dev/gdg-on-campus-universiti-teknologi-malaysia-johor-bahru-malaysia/":
    "GDG UTM",
};

export async function checkForNewEvents() {
  const TARGET_CALENDARS = process.env.TARGET_CALENDARS!.split(",");

  let allLiveEvents: ApifyLumaEvent[] = [];
  let gdgFetchedCount = 0;
  let lumaFetchedCount = 0;

  for (const target of TARGET_CALENDARS) {
    const targetUrl = target.trim();
    const friendlyName = CALENDAR_NAMES[targetUrl] || targetUrl;

    if (targetUrl.includes("gdg.community.dev")) {
      const events = await scrapeGdgAPI(targetUrl, friendlyName);
      gdgFetchedCount += events.length;
      allLiveEvents.push(...events);
    } else {
      const calId = await getCalendarIdFromUrl(targetUrl);

      if (calId) {
        const events = await scrapeCalendarAPI(calId);
        const mappedFriendlyName = CALENDAR_NAMES[calId] || calId;

        const labeledEvents = events.map((evt) => {
          const { id, dedupKey, eventUrl, target_profile, ...rest } = evt as any;
          return {
            id,
            dedupKey,
            target_profile: mappedFriendlyName,
            eventUrl,
            ...rest,
          } as ApifyLumaEvent;
        });

        lumaFetchedCount += labeledEvents.length;
        allLiveEvents.push(...labeledEvents);
      }
    }

    await new Promise((res) => setTimeout(res, 1000)); // Polite delay
  }

  if (allLiveEvents.length === 0) return;

  console.log(
    `Fetched events - total: ${allLiveEvents.length}, luma: ${lumaFetchedCount}, gdg: ${gdgFetchedCount}`,
  );

  const summary = await upsertEvents(allLiveEvents);

  if (summary.insertedEvents.length > 0) {
    console.log(`\nFOUND ${summary.inserted} NEW EVENTS! Sending WhatsApp summaries...`);
    const notificationResult = await sendEventSummaries(summary.insertedEvents);
    console.log(
      `WhatsApp notifications completed. sent=${notificationResult.sent}, failed=${notificationResult.failed}`,
    );
  } else {
    console.log("\nNo new events found today.");
  }
}
