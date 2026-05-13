import { ApifyLumaEvent } from "../type";
import { buildGdgDedupKey, buildLumaDedupKey } from "./dedup";

export function formatLumaUrl(urlPath: string): string {
  if (!urlPath) return "";
  if (urlPath.startsWith("http://") || urlPath.startsWith("https://")) {
    return urlPath;
  }
  return `https://lu.ma/${urlPath}`;
}

export function formatSocialHandles(obj: any) {
  if (!obj) return null;
  return {
    linkedin: obj.linkedin_handle
      ? `https://www.linkedin.com${obj.linkedin_handle}`
      : null,
    instagram: obj.instagram_handle
      ? `https://www.instagram.com/${obj.instagram_handle}`
      : null,
    twitter: obj.twitter_handle
      ? `https://twitter.com/${obj.twitter_handle}`
      : null,
    youtube: obj.youtube_handle
      ? `https://www.youtube.com/@${obj.youtube_handle}`
      : null,
    tiktok: obj.tiktok_handle
      ? `https://www.tiktok.com/@${obj.tiktok_handle}`
      : null,
  };
}

function normalizeLumaLocationType(locationType: unknown): string {
  const value = String(locationType || "").toLowerCase();
  if (value === "meet" || value === "online" || value === "virtual") {
    return "online";
  }
  if (value === "hybrid") {
    return "hybrid";
  }
  if (value === "offline" || value === "venue" || value === "in_person") {
    return "offline";
  }
  return "unknown";
}

export function mapLumaDataToApify(entry: any): ApifyLumaEvent {
  const evt = entry.event;
  const tix = entry.ticket_info;
  const cal = entry.calendar;

  return {
    id: evt.api_id,
    dedupKey: buildLumaDedupKey(evt.api_id),
    target_profile: cal?.name,
    eventUrl: formatLumaUrl(evt.url),
    category: null,
    name: evt.name,
    description: null,
    eventType: evt.event_type || "independent",
    visibility: evt.visibility || "public",
    startAt: evt.start_at || null,
    endAt: evt.end_at || null,
    timezone: evt.timezone || null,

    location: {
      locationType: normalizeLumaLocationType(evt.location_type),
      fullAddress: evt.geo_address_info?.full_address || null,
      address: evt.geo_address_info?.address || null,
      city: evt.geo_address_info?.city || null,
      region: evt.geo_address_info?.region || null,
      country: evt.geo_address_info?.country || null,
      latitude: evt.coordinate?.latitude || null,
      longitude: evt.coordinate?.longitude || null,
      placeId: evt.geo_address_info?.place_id || null,
      virtualUrl: evt.virtual_info?.virtual_url || null,
      meetingPlatform: evt.virtual_info?.meeting_platform || null,
    },

    organizer: cal
      ? {
          id: cal.api_id,
          name: cal.name,
          description: cal.description_short || null,
          isVerified: !!cal.verified_at,
          isLumaPlus: cal.luma_plus_active || false,
          avatarUrl: cal.avatar_url || null,
          coverUrl: cal.cover_image_url || null,
          websiteUrl: cal.website || null,
          socialHandles: formatSocialHandles(cal),
        }
      : null,

    hosts: (entry.hosts || []).map((host: any) => ({
      id: host.api_id,
      name: host.name,
      bio: host.bio_short || null,
      isVerified: host.is_verified || false,
      avatarUrl: host.avatar_url || null,
      websiteUrl: host.website || null,
      socialHandles: formatSocialHandles(host),
    })),

    featuredGuests: (entry.featured_guests || []).map((guest: any) => ({
      id: guest.api_id,
      name: guest.name,
      bio: guest.bio_short || null,
      isVerified: guest.is_verified || false,
      avatarUrl: guest.avatar_url || null,
      websiteUrl: guest.website || null,
      socialHandles: formatSocialHandles(guest),
    })),

    ticketing: {
      isFree: tix?.is_free ?? true,
      priceCents: tix?.price?.cents || null,
      currency: tix?.currency_info?.currency || null,
      isSoldOut: tix?.is_sold_out || false,
      soldOutAt: null,
      requiresApproval: tix?.require_approval || false,
    },

    attendance: {
      guestCount: entry.guest_count || 0,
      ticketCount: entry.ticket_count || null,
      spotsRemaining: tix?.spots_remaining || null,
      capacityWarning: tix?.is_near_capacity || null,
      hasWaitlist: evt.waitlist_enabled || false,
      waitlistCount: null,
      isGuestListPublic: evt.show_guest_list || false,
    },

    coverImageUrl: evt.cover_url || null,
    dominantColors: entry.cover_image?.colors || [],
    popularityScore: entry.score || null,
    scrapedAt: new Date().toISOString(),
  };
}

export function mapGdgDataToApify(
  entry: any,
  friendlyName: string,
): ApifyLumaEvent {
  const audienceType = String(entry.audience_type || "").toUpperCase();
  const gdgLocationType =
    audienceType === "VIRTUAL"
      ? "online"
      : audienceType === "HYBRID"
        ? "hybrid"
        : "offline";

  return {
    id: `gdg-${entry.id}`,
    dedupKey: buildGdgDedupKey({
      eventUrl: entry.static_url || entry.url || null,
      id: entry.id,
    }),
    target_profile: friendlyName,
    eventUrl: entry.static_url || entry.url || null,

    category: entry.audience_type || null, // E.g., 'HYBRID' or 'VIRTUAL'
    name: entry.title,
    description: entry.description_short || null,
    eventType: "gdg_event",
    visibility: entry.is_hidden ? "private" : "public",
    startAt: entry.start_date || null,

    // 💡 NEW: We can now map the end date!
    endAt: entry.end_date || null,
    timezone: entry.event_timezone || "UTC",

    location: {
      locationType: gdgLocationType,
      fullAddress: null,
      address: null,
      city: null,
      region: null,
      country: "Malaysia",
      latitude: null,
      longitude: null,
      placeId: null,
      virtualUrl:
        entry.join_virtual_event_url || entry.custom_tickets_url || null,
      meetingPlatform: entry.is_virtual_event ? "Online" : null,
    },

    organizer: {
      id: "2871",
      name: "GDG on Campus UTM",
      description:
        "Google Developer Groups on Campus Universiti Teknologi Malaysia",
      isVerified: true,
      isLumaPlus: false,
      avatarUrl: null,
      coverUrl: entry.cropped_banner_url || entry.banner || null,
      websiteUrl:
        "https://gdg.community.dev/gdg-on-campus-universiti-teknologi-malaysia-johor-bahru-malaysia/",
      socialHandles: {
        linkedin: "https://www.linkedin.com/company/gdgutm/",
        instagram: "https://www.instagram.com/gdg.utm",
        twitter: "https://x.com/gdgutm",
        youtube: null,
        tiktok: null,
      },
    },

    hosts: [],
    featuredGuests: [],

    ticketing: {
      isFree: true,
      priceCents: null,
      currency: null,
      isSoldOut: false,
      soldOutAt: null,
      requiresApproval: entry.registration_required || false,
    },

    attendance: {
      guestCount: 0,
      ticketCount: null,
      spotsRemaining: null,
      capacityWarning: null,
      hasWaitlist: false,
      waitlistCount: null,
      isGuestListPublic: true,
    },

    coverImageUrl: entry.cropped_picture_url || entry.picture || null,
    dominantColors: [],
    popularityScore: null,
    scrapedAt: new Date().toISOString(),
  };
}
