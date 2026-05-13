import { ApifyLumaEvent } from "../type";
import { mapGdgDataToApify } from "../util/mapper";

// Hardcoded mapping for reliability
const CHAPTER_ID_MAP: Record<string, string> = {
  "https://gdg.community.dev/gdg-on-campus-universiti-teknologi-malaysia-johor-bahru-malaysia/":
    "2871",
};

export function extractGdgEventSlugFromUrl(
  url: string | null | undefined,
): string | null {
  if (!url) return null;
  const match = url.match(/\/events\/details\/([^/?#]+)\/?$/i);
  return match?.[1] || null;
}

export async function scrapeGdgAPI(
  gdgUrl: string,
  friendlyName: string,
): Promise<ApifyLumaEvent[]> {
  console.log(`Fetching GDG events for: ${friendlyName}...`);

  try {
    // Use hardcoded ID if available, otherwise try to extract it
    let chapterId = CHAPTER_ID_MAP[gdgUrl];

    if (!chapterId) {
      const response = await fetch(gdgUrl);
      const html = await response.text();
      const match =
        html.match(/"chapter":\s*\{\s*"id":\s*(\d+)/) ||
        html.match(/for_chapter\/(\d+)/);
      chapterId = match ? match[1] : undefined;
    }

    if (!chapterId) {
      console.error("❌ Could not determine Chapter ID for:", gdgUrl);
      return [];
    }

    const apiUrl = `https://gdg.community.dev/api/event_slim/for_chapter/${chapterId}/?status=Live&order=start_date`;
    const apiRes = await fetch(apiUrl, {
      headers: { Accept: "application/json" },
    });

    if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);

    const apiData = await apiRes.json();
    const results = apiData.results || [];
    const enrichedResults = await Promise.all(
      results.map(async (entry: any) => {
        const slug = extractGdgEventSlugFromUrl(entry?.url);
        if (!slug) return entry;
        const detailUrl = `https://gdg.community.dev/api/event_slim/${slug}/`;
        try {
          const detailRes = await fetch(detailUrl, {
            headers: { Accept: "application/json" },
          });
          if (!detailRes.ok) return entry;
          const detail = await detailRes.json();
          return { ...entry, ...detail };
        } catch {
          return entry;
        }
      }),
    );

    return enrichedResults.map((entry: any) =>
      mapGdgDataToApify(entry, friendlyName),
    );
  } catch (error) {
    console.error(`❌ Failed to scrape GDG ${friendlyName}:`, error);
    return [];
  }
}
