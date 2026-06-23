import { LumaScrapeResult } from '../type';
import { mapLumaDataToApify } from '../util/mapper';

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1500;
const PAGE_DELAY_MS = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) return seconds * 1000;
  }

  // Exponential backoff + jitter to avoid synchronized retry storms.
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  const jitter = Math.floor(Math.random() * 500);
  return exponential + jitter;
}

async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url, init);
    if (response.ok) return response;

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const delay = getRetryDelayMs(response, attempt);
      console.warn(`Rate limited (429). Retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      continue;
    }

    throw new Error(`HTTP ${response.status}`);
  }

  throw new Error('HTTP 429');
}

export async function scrapeDiscoverAPI(placeId: string): Promise<LumaScrapeResult> {
  console.log(`Fetching Discover API for place: ${placeId}...`);

  const allRawEntries: any[] = [];
  let hasMore = true;
  let cursor = '';

  try {
    while (hasMore) {
      const baseUrl = `https://api.luma.com/discover/get-paginated-events?discover_place_api_id=${placeId}&pagination_limit=25`;
      const apiUrl = cursor ? `${baseUrl}&pagination_cursor=${cursor}` : baseUrl;

      const response = await fetchWithRetry(apiUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'application/json',
        },
      });

      const data = await response.json();
      if (data.entries && data.entries.length > 0) {
        allRawEntries.push(...data.entries);
      }

      hasMore = data.has_more;
      cursor = data.next_cursor;

      if (hasMore) {
        console.log(`Fetching next page for discover place ${placeId}...`);
        await sleep(PAGE_DELAY_MS);
      }
    }

    return {
      status: 'success',
      source: 'discover',
      events: allRawEntries.map((entry) => mapLumaDataToApify(entry)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isRateLimited = message.includes('HTTP 429');
    console.error(`Failed to scrape discover place ${placeId}:`, error);

    return {
      status: isRateLimited ? 'rate_limited' : 'failed',
      source: 'discover',
      events: [],
      reason: message,
    };
  }
}
