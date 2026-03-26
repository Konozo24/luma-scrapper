import fs from 'fs/promises';
import path from 'path';
import { ApifyLumaEvent } from './type';

const STATE_FILE = path.resolve('./state.json');

// --- 1. HELPERS ---

function formatLumaUrl(urlPath: string): string {
    if (!urlPath) return "";
    if (urlPath.startsWith('http://') || urlPath.startsWith('https://')) {
        return urlPath;
    }
    return `https://lu.ma/${urlPath}`;
}

function formatSocialHandles(obj: any) {
    if (!obj) return null;
    return {
        linkedin: obj.linkedin_handle ? `https://www.linkedin.com${obj.linkedin_handle}` : null,
        instagram: obj.instagram_handle ? `https://www.instagram.com/${obj.instagram_handle}` : null,
        twitter: obj.twitter_handle ? `https://twitter.com/${obj.twitter_handle}` : null,
        youtube: obj.youtube_handle ? `https://www.youtube.com/@${obj.youtube_handle}` : null,
        tiktok: obj.tiktok_handle ? `https://www.tiktok.com/@${obj.tiktok_handle}` : null
    };
}

function mapLumaDataToApify(entry: any): ApifyLumaEvent {
    const evt = entry.event;
    const tix = entry.ticket_info;
    const cal = entry.calendar;
    
    return {
        id: evt.api_id,
        lumaUrl: formatLumaUrl(evt.url),
        category: null, 
        name: evt.name,
        description: null, 
        eventType: evt.event_type || "independent",
        visibility: evt.visibility || "public",
        startAt: evt.start_at || null,
        endAt: evt.end_at || null,
        timezone: evt.timezone || null,
        
        location: {
            locationType: evt.location_type || "offline",
            fullAddress: evt.geo_address_info?.full_address || null,
            address: evt.geo_address_info?.address || null,
            city: evt.geo_address_info?.city || null,
            region: evt.geo_address_info?.region || null,
            country: evt.geo_address_info?.country || null,
            latitude: evt.coordinate?.latitude || null,
            longitude: evt.coordinate?.longitude || null,
            placeId: evt.geo_address_info?.place_id || null,
            virtualUrl: evt.virtual_info?.virtual_url || null,
            meetingPlatform: evt.virtual_info?.meeting_platform || null
        },
        
        organizer: cal ? {
            id: cal.api_id,
            name: cal.name,
            description: cal.description_short || null,
            isVerified: !!cal.verified_at,
            isLumaPlus: cal.luma_plus_active || false,
            avatarUrl: cal.avatar_url || null,
            coverUrl: cal.cover_image_url || null,
            websiteUrl: cal.website || null,
            socialHandles: formatSocialHandles(cal)
        } : null,
        
        hosts: (entry.hosts || []).map((host: any) => ({
            id: host.api_id,
            name: host.name,
            bio: host.bio_short || null,
            isVerified: host.is_verified || false,
            avatarUrl: host.avatar_url || null,
            websiteUrl: host.website || null,
            socialHandles: formatSocialHandles(host)
        })),
        
        featuredGuests: (entry.featured_guests || []).map((guest: any) => ({
            id: guest.api_id,
            name: guest.name,
            bio: guest.bio_short || null,
            isVerified: guest.is_verified || false,
            avatarUrl: guest.avatar_url || null,
            websiteUrl: guest.website || null,
            socialHandles: formatSocialHandles(guest)
        })),
        
        ticketing: {
            isFree: tix?.is_free ?? true,
            priceCents: tix?.price?.cents || null,
            currency: tix?.currency_info?.currency || null,
            isSoldOut: tix?.is_sold_out || false,
            soldOutAt: null, 
            requiresApproval: tix?.require_approval || false
        },
        
        attendance: {
            guestCount: entry.guest_count || 0,
            ticketCount: entry.ticket_count || null,
            spotsRemaining: tix?.spots_remaining || null,
            capacityWarning: tix?.is_near_capacity || null,
            hasWaitlist: evt.waitlist_enabled || false,
            waitlistCount: null, 
            isGuestListPublic: evt.show_guest_list || false
        },
        
        coverImageUrl: evt.cover_url || null,
        dominantColors: entry.cover_image?.colors || [],
        popularityScore: entry.score || null,
        scrapedAt: new Date().toISOString()
    };
}

// --- 2. API LOGIC ---

async function scrapeCalendarAPI(calendarId: string): Promise<ApifyLumaEvent[]> {
    console.log(`📡 Fetching API for calendar: ${calendarId}...`);
    
    let allRawEntries: any[] = [];
    let hasMore = true;
    let cursor = "";

    try {
        while (hasMore) {
            const baseUrl = `https://api2.luma.com/calendar/get-items?calendar_api_id=${calendarId}&pagination_limit=50&period=future`;
            const apiUrl = cursor ? `${baseUrl}&pagination_cursor=${cursor}` : baseUrl;
            
            const response = await fetch(apiUrl, {
                headers: { 
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                    "Accept": "application/json"
                }
            });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();
            if (data.entries && data.entries.length > 0) {
                allRawEntries.push(...data.entries);
            }

            hasMore = data.has_more;
            cursor = data.next_cursor;

            if (hasMore) {
                console.log(`⏳ Fetching next page...`);
                await new Promise(res => setTimeout(res, 500)); 
            }
        }

        return allRawEntries.map(entry => mapLumaDataToApify(entry));

    } catch (error) {
        console.error(`❌ Failed to scrape ${calendarId}:`, error);
        return [];
    }
}

// --- 3. STATE & MAIN ---

async function getKnownEvents(): Promise<ApifyLumaEvent[]> {
    try {
        const data = await fs.readFile(STATE_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        return [];
    }
}

async function saveKnownEvents(events: ApifyLumaEvent[]) {
    await fs.writeFile(STATE_FILE, JSON.stringify(events, null, 2));
}

async function checkForNewEvents() {
    const TARGET_CALENDARS = [
        'cal-DqBTiRhIzzmBhcU',  // AI.SEA
        'cal-DjCdUOevQOyB5OS',  // AI Hackerdom
        'cal-HRPtK7hDvVSLaNu'   // Nyalalabs
    ];
    
    let allLiveEvents: ApifyLumaEvent[] = [];

    for (const calId of TARGET_CALENDARS) {
        const events = await scrapeCalendarAPI(calId);
        allLiveEvents.push(...events);
        await new Promise(res => setTimeout(res, 1000)); // Polite delay between targets
    }
    
    if (allLiveEvents.length === 0) return;

    const knownEvents = await getKnownEvents();
    const knownIds = knownEvents.map(evt => evt.id);
    const newEvents = allLiveEvents.filter(evt => !knownIds.includes(evt.id));

    if (newEvents.length > 0) {
        console.log(`\n🚨 FOUND ${newEvents.length} NEW EVENTS!`);
        console.log(JSON.stringify(newEvents, null, 2));

        const updatedEvents = [...knownEvents, ...newEvents];
        await saveKnownEvents(updatedEvents);
        console.log(`\n💾 state.json updated with new records.`);
    } else {
        console.log(`\n✅ No new events found today.`);
    }
}

checkForNewEvents();