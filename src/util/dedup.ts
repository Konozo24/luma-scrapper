import { ApifyLumaEvent } from "../type";

export function normalizeEventUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().toLowerCase();
  } catch {
    return String(url).trim().toLowerCase().replace(/\/+$/, "");
  }
}

export function buildLumaDedupKey(id: string): string {
  return `luma:${id}`;
}

export function buildGdgDedupKey(params: { eventUrl?: string | null; id: string | number }): string {
  const normalizedUrl = normalizeEventUrl(params.eventUrl);
  if (normalizedUrl) {
    return `gdg:${normalizedUrl}`;
  }
  return `gdg-id:${String(params.id)}`;
}

export function getDedupKeyFromEvent(event: Pick<ApifyLumaEvent, "id" | "eventType" | "eventUrl">): string {
  if (event.eventType === "gdg_event" || String(event.id).startsWith("gdg-")) {
    return buildGdgDedupKey({ eventUrl: event.eventUrl, id: event.id });
  }
  return buildLumaDedupKey(event.id);
}
