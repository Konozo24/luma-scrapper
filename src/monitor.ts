import { scrapeCalendarAPI, getCalendarIdFromUrl } from './service/lumaScraper';
import { getKnownEvents, insertNewEvents } from './service/storage';
import { ApifyLumaEvent } from './type';
// import { sendWhatsAppAlert } from './services/whatsapp'; // Import this when you add the WhatsApp logic

const CALENDAR_NAMES: Record<string, string> = {
    'cal-DqBTiRhIzzmBhcU': 'AI.SEA',
    'cal-DjCdUOevQOyB5OS': 'AI Hackerdom',
    'cal-HRPtK7hDvVSLaNu': 'Nyala Labs',
    'cal-AQNeOLktkou1BBv': 'Testing'
};

export async function checkForNewEvents() {

    const TARGET_CALENDARS = process.env.TARGET_CALENDARS!.split(',');

    let allLiveEvents: ApifyLumaEvent[] = [];

    for (const target of TARGET_CALENDARS) {
        // Automatically find the cal_id from the URL
        const calId = await getCalendarIdFromUrl(target.trim());


        if (calId) {
            const events = await scrapeCalendarAPI(calId);

            const friendlyName = CALENDAR_NAMES[calId] || calId;

            const labeledEvents = events.map(evt => {
                // This pulls out the wrong "Personal" name the API gave us
                const { id, lumaUrl, target_profile, ...rest } = evt as any;

                return {
                    id: id,
                    target_profile: friendlyName,
                    lumaUrl: lumaUrl,     
                    ...rest                
                };
            });

            allLiveEvents.push(...labeledEvents);
        }

        await new Promise(res => setTimeout(res, 1000)); // Polite delay
    }

    if (allLiveEvents.length === 0) return;

    const knownEvents = await getKnownEvents();
    const knownIds = knownEvents.map(evt => evt.id);
    const newEvents = allLiveEvents.filter(evt => !knownIds.includes(evt.id));

    if (newEvents.length > 0) {
        console.log(`\nFOUND ${newEvents.length} NEW EVENTS!`);

        // update database only when there are new events
        await insertNewEvents(newEvents);
    } else {
        console.log(`\n✅ No new events found today.`);
    }
}