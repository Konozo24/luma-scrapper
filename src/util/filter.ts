import { ApifyLumaEvent } from '../type';

const TARGET_COUNTRIES = ['Malaysia', 'Singapore'];
const TECH_CATEGORIES = [
  'ai',
  'tech',
  'developer',
  'developers',
  'software',
  'engineering',
  'programming',
  'coding',
  'data',
  'cloud',
  'startup',
  'hackathon',
  'web3',
  'blockchain',
  'cybersecurity',
  'product',
];

export function isEventFromTargetCountry(event: ApifyLumaEvent): boolean {
  const country = event.location?.country;

  // Virtual events (no country) are excluded
  if (!country) return false;

  return TARGET_COUNTRIES.includes(country);
}

export function isTechRelatedEvent(event: ApifyLumaEvent): boolean {
  const categories = [event.category, ...(event.categories ?? [])]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase().trim());

  if (categories.length > 0) {
    return categories.some((category) => TECH_CATEGORIES.includes(category));
  }

  const haystack = [
    event.name,
    event.description,
    event.organizer?.name,
    event.hosts?.map((host) => host.name).join(' '),
    event.featuredGuests?.map((guest) => guest.name).join(' '),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return TECH_CATEGORIES.some((keyword) => haystack.includes(keyword));
}
