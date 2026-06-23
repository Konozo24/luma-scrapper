import { scrapeCalendarAPI, getCalendarIdFromUrl } from './service/lumaScraper';
import { scrapeDiscoverAPI } from './service/lumaDiscoverScraper';
import { scrapeGdgAPI } from './service/gdgScraper';
import { upsertEvents } from './service/storage';
import { sendEventSummaries } from './notifier';
import { ApifyLumaEvent } from './type';
import { getDedupKeyFromEvent } from './util/dedup';
import { isEventFromTargetCountry, isTechRelatedEvent } from './util/filter';

const CALENDAR_NAMES: Record<string, string> = {
  'cal-DqBTiRhIzzmBhcU': 'AI.SEA',
  'cal-DjCdUOevQOyB5OS': 'AI Hackerdom',
  'cal-HRPtK7hDvVSLaNu': 'Nyala Labs',
  'cal-AQNeOLktkou1BBv': 'Testing',
  'https://gdg.community.dev/gdg-on-campus-universiti-teknologi-malaysia-johor-bahru-malaysia/': 'GDG UTM',
};

const DISCOVER_PLACE_NAMES: Record<string, string> = {
  'discplace-O15L1VZiYe0GYGm': 'Kuala Lumpur',
};

const KL_SOURCE_NAMES = new Set(['Kuala Lumpur']);

const LUMA_COOLDOWN_MINUTES = Number(process.env.LUMA_COOLDOWN_MINUTES ?? 45);
const LUMA_RATE_LIMIT_THRESHOLD = Number(process.env.LUMA_RATE_LIMIT_THRESHOLD ?? 1);

let isScrapeRunning = false;

interface CalendarRateLimitState {
  consecutive429: number;
  cooldownUntil: number;
  lastSuccessAt: number | null;
}

const lumaRateLimitState = new Map<string, CalendarRateLimitState>();
const discoverRateLimitState = new Map<string, CalendarRateLimitState>();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrCreateCalendarState(calendarId: string): CalendarRateLimitState {
  const existing = lumaRateLimitState.get(calendarId);
  if (existing) return existing;

  const created: CalendarRateLimitState = {
    consecutive429: 0,
    cooldownUntil: 0,
    lastSuccessAt: null,
  };
  lumaRateLimitState.set(calendarId, created);
  return created;
}

function getOrCreateDiscoverState(placeId: string): CalendarRateLimitState {
  const existing = discoverRateLimitState.get(placeId);
  if (existing) return existing;

  const created: CalendarRateLimitState = {
    consecutive429: 0,
    cooldownUntil: 0,
    lastSuccessAt: null,
  };
  discoverRateLimitState.set(placeId, created);
  return created;
}

function isInCooldown(state: CalendarRateLimitState, nowMs: number) {
  return state.cooldownUntil > nowMs;
}

function getCooldownRemainingMinutes(state: CalendarRateLimitState, nowMs: number) {
  return Math.max(1, Math.ceil((state.cooldownUntil - nowMs) / 60000));
}

export async function checkForNewEvents() {
  if (isScrapeRunning) {
    console.log('Scrape already in progress. Skipping overlapping trigger.');
    return;
  }
  isScrapeRunning = true;

  const TARGET_CALENDARS = process.env.TARGET_CALENDARS!.split(',');
  const TARGET_DISCOVER_PLACES = (process.env.DISCOVER_PLACES ?? '').split(',').filter(x => x.trim());

  const allLiveEvents: ApifyLumaEvent[] = [];
  let gdgFetchedCount = 0;
  let lumaFetchedCount = 0;
  let discoverFetchedCount = 0;
  let cooldownSkippedCount = 0;

  try {
    for (const target of TARGET_CALENDARS) {
      const targetUrl = target.trim();
      const friendlyName = CALENDAR_NAMES[targetUrl] || targetUrl;

      if (targetUrl.includes('gdg.community.dev')) {
        const events = await scrapeGdgAPI(targetUrl, friendlyName);
        gdgFetchedCount += events.length;
        allLiveEvents.push(...events);
        continue;
      }

      const calId = await getCalendarIdFromUrl(targetUrl);
      if (!calId) {
        console.log(`calendar=${targetUrl} source=api status=failed events=0 reason=calendar_id_not_found`);
        await sleep(1000);
        continue;
      }

      const now = Date.now();
      const state = getOrCreateCalendarState(calId);
      const mappedFriendlyName = CALENDAR_NAMES[calId] || calId;

      if (isInCooldown(state, now)) {
        cooldownSkippedCount += 1;
        const remainingMinutes = getCooldownRemainingMinutes(state, now);
        console.log(
          `calendar=${calId} profile="${mappedFriendlyName}" source=api status=cooldown_skip events=0 cooldown_remaining_minutes=${remainingMinutes}`,
        );
        await sleep(1000);
        continue;
      }

      const scrapeResult = await scrapeCalendarAPI(calId);

      if (scrapeResult.status === 'rate_limited') {
        state.consecutive429 += 1;

        if (state.consecutive429 >= LUMA_RATE_LIMIT_THRESHOLD) {
          state.cooldownUntil = now + LUMA_COOLDOWN_MINUTES * 60_000;
          console.log(
            `calendar=${calId} profile="${mappedFriendlyName}" source=api status=rate_limited events=0 cooldown_set_minutes=${LUMA_COOLDOWN_MINUTES} consecutive_429=${state.consecutive429}`,
          );
        } else {
          console.log(
            `calendar=${calId} profile="${mappedFriendlyName}" source=api status=rate_limited events=0 consecutive_429=${state.consecutive429}`,
          );
        }

        await sleep(1000);
        continue;
      }

      if (scrapeResult.status === 'failed') {
        console.log(
          `calendar=${calId} profile="${mappedFriendlyName}" source=api status=failed events=0 reason=${scrapeResult.reason ?? 'unknown'}`,
        );
        await sleep(1000);
        continue;
      }

      state.consecutive429 = 0;
      state.cooldownUntil = 0;
      state.lastSuccessAt = Date.now();

      const labeledEvents = scrapeResult.events.map((evt) => {
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

      console.log(
        `calendar=${calId} profile="${mappedFriendlyName}" source=api status=success events=${labeledEvents.length}`,
      );

      await sleep(1000);
    }

    // Discover Places Loop
    for (const placeId of TARGET_DISCOVER_PLACES) {
      const placeName = DISCOVER_PLACE_NAMES[placeId] || placeId;

      const now = Date.now();
      const state = getOrCreateDiscoverState(placeId);

      if (isInCooldown(state, now)) {
        cooldownSkippedCount += 1;
        const remainingMinutes = getCooldownRemainingMinutes(state, now);
        console.log(
          `discover_place=${placeId} place_name="${placeName}" source=discover status=cooldown_skip events=0 cooldown_remaining_minutes=${remainingMinutes}`,
        );
        await sleep(1000);
        continue;
      }

      const scrapeResult = await scrapeDiscoverAPI(placeId);

      if (scrapeResult.status === 'rate_limited') {
        state.consecutive429 += 1;

        if (state.consecutive429 >= LUMA_RATE_LIMIT_THRESHOLD) {
          state.cooldownUntil = now + LUMA_COOLDOWN_MINUTES * 60_000;
          console.log(
            `discover_place=${placeId} place_name="${placeName}" source=discover status=rate_limited events=0 cooldown_set_minutes=${LUMA_COOLDOWN_MINUTES} consecutive_429=${state.consecutive429}`,
          );
        } else {
          console.log(
            `discover_place=${placeId} place_name="${placeName}" source=discover status=rate_limited events=0 consecutive_429=${state.consecutive429}`,
          );
        }

        await sleep(1000);
        continue;
      }

      if (scrapeResult.status === 'failed') {
        console.log(
          `discover_place=${placeId} place_name="${placeName}" source=discover status=failed events=0 reason=${scrapeResult.reason ?? 'unknown'}`,
        );
        await sleep(1000);
        continue;
      }

      state.consecutive429 = 0;
      state.cooldownUntil = 0;
      state.lastSuccessAt = Date.now();

      const labeledEvents = scrapeResult.events.map((evt) => {
        const { id, dedupKey, eventUrl, target_profile, ...rest } = evt as any;
        return {
          id,
          dedupKey,
          target_profile: placeName,
          eventUrl,
          ...rest,
        } as ApifyLumaEvent;
      });

      discoverFetchedCount += labeledEvents.length;
      allLiveEvents.push(...labeledEvents);

      await sleep(1000);
    }

    const coolingDownCalendars = [...lumaRateLimitState.entries()].filter(([, value]) => value.cooldownUntil > Date.now())
      .length;
    const coolingDownPlaces = [...discoverRateLimitState.entries()].filter(([, value]) => value.cooldownUntil > Date.now())
      .length;

    // Filter events by country (Malaysia/Singapore only)
    const countryFilteredEvents = allLiveEvents.filter((event) => {
      const isTargetCountry = isEventFromTargetCountry(event);
      if (!isTargetCountry) {
        console.log(
          `Country filter: Excluding event "${event.name}" from ${event.location?.country || 'unknown'} (${event.target_profile})`,
        );
      }
      return isTargetCountry;
    });
    const techFilteredEvents = countryFilteredEvents.filter((event) => {
      if (!KL_SOURCE_NAMES.has(event.target_profile)) return true;

      const isTechEvent = isTechRelatedEvent(event);
      if (!isTechEvent) {
        const categories = [event.category, ...(event.categories ?? [])]
          .filter((value): value is string => Boolean(value))
          .join(', ') || 'none';

        console.log(
          `Tech filter: Excluding event "${event.name}" categories=${categories} (${event.target_profile})`,
        );
      }

      return isTechEvent;
    });
    const countryFilteredCount = allLiveEvents.length - countryFilteredEvents.length;
    const techFilteredCount = countryFilteredEvents.length - techFilteredEvents.length;

    // Deduplicate events by event ID
    const dedupMap = new Map<string, ApifyLumaEvent>();
    for (const event of techFilteredEvents) {
      const dedupKey = getDedupKeyFromEvent(event);
      if (!dedupMap.has(dedupKey)) {
        dedupMap.set(dedupKey, event);
      } else {
        console.log(`Duplicate event filtered: ${event.id}`);
      }
    }
    const dedupedEvents = Array.from(dedupMap.values());
    const duplicatesFiltered = techFilteredEvents.length - dedupedEvents.length;

    console.log(
      `Run summary: total_fetched=${dedupedEvents.length} (country_filtered=${countryFilteredCount} tech_filtered=${techFilteredCount} dedup_removed=${duplicatesFiltered}) luma_fetched=${lumaFetchedCount} discover_fetched=${discoverFetchedCount} gdg_fetched=${gdgFetchedCount} cooldown_skipped=${cooldownSkippedCount} cooling_down_calendars=${coolingDownCalendars} cooling_down_places=${coolingDownPlaces}`,
    );

    if (dedupedEvents.length === 0) {
      console.log('No events fetched in this run.');
      return;
    }

    const summary = await upsertEvents(dedupedEvents);

    if (summary.insertedEvents.length > 0) {
      console.log(`FOUND ${summary.inserted} NEW EVENTS! Sending WhatsApp summaries...`);
      const notificationResult = await sendEventSummaries(summary.insertedEvents);
      console.log(
        `WhatsApp notifications completed. sent=${notificationResult.sent}, failed=${notificationResult.failed}`,
      );
    } else {
      console.log('No new events found today.');
    }
  } finally {
    isScrapeRunning = false;
  }
}
