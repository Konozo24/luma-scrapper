export interface SocialHandles {
    linkedin: string | null;
    instagram: string | null;
    twitter: string | null;
    youtube: string | null;
    tiktok: string | null;
}

export interface Organizer {
    id: string;
    name: string;
    description: string | null;
    isVerified: boolean;
    isLumaPlus: boolean;
    avatarUrl: string | null;
    coverUrl: string | null;
    websiteUrl: string | null;
    socialHandles: SocialHandles | null;
}

export interface Host {
    id: string;
    name: string;
    bio: string | null;
    isVerified: boolean;
    avatarUrl: string | null;
    websiteUrl: string | null;
    socialHandles: SocialHandles | null;
}

export interface ApifyLumaEvent {
    id: string;
    target_profile: string;
    lumaUrl: string;
    category: string | null;
    name: string;
    description: string | null;
    eventType: string;
    visibility: string;
    startAt: string | null;
    endAt: string | null;
    timezone: string | null;
    location: {
        locationType: string;
        fullAddress: string | null;
        address: string | null;
        city: string | null;
        region: string | null;
        country: string | null;
        latitude: number | null;
        longitude: number | null;
        placeId: string | null;
        virtualUrl: string | null;
        meetingPlatform: string | null;
    };
    organizer: Organizer | null;
    hosts: Host[];
    featuredGuests: Host[];
    ticketing: {
        isFree: boolean;
        priceCents: number | null;
        currency: string | null;
        isSoldOut: boolean;
        soldOutAt: string | null;
        requiresApproval: boolean;
    };
    attendance: {
        guestCount: number;
        ticketCount: number | null;
        spotsRemaining: number | null;
        capacityWarning: boolean | null;
        hasWaitlist: boolean;
        waitlistCount: number | null;
        isGuestListPublic: boolean;
    };
    coverImageUrl: string | null;
    dominantColors: string[];
    popularityScore: number | null;
    scrapedAt: string;
}