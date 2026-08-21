import { ApifyLumaEvent } from '../type';

const TARGET_COUNTRIES = ['Malaysia', 'Singapore'];

// Luma discovery categories that are explicitly not tech. Checked before the
// allowlist so a "Fitness" event can never sneak through on a keyword match.
const NON_TECH_CATEGORIES = [
  'fitness',
  'wellness',
  'health',
  'sports',
  'running',
  'yoga',
  'arts & culture',
  'arts-culture',
  'arts',
  'culture',
  'music',
  'food',
  'food & drink',
  'nightlife',
  'fashion',
  'travel',
  'social',
  'dating',
  'parenting',
  'pets',
  'religion',
  'wine',
  'film',
  'photography',
  'comedy',
  'games',
];

const TECH_CATEGORIES = [
  'ai',
  'ai & tech',
  'tech',
  'technology',
  'developer',
  'developers',
  'software',
  'engineering',
  'programming',
  'coding',
  'data',
  'cloud',
  'startup',
  'startups',
  'hackathon',
  'web3',
  'crypto',
  'blockchain',
  'cybersecurity',
  'product',
];

// Keywords safe to match inside free text. Short/ambiguous terms ("ai", "data",
// "product") are excluded here because substring matching turned "Training",
// "Chairman" and friends into false tech hits.
const TEXT_KEYWORDS = [
  'ai',
  'artificial intelligence',
  'machine learning',
  'llm',
  'tech',
  'developer',
  'developers',
  'software',
  'engineering',
  'programming',
  'coding',
  'data science',
  'cloud',
  'startup',
  'startups',
  'hackathon',
  'web3',
  'blockchain',
  'cybersecurity',
  'devops',
  'open source',
];

// Whole-word match so "ai" no longer matches "Training" / "Chairman" / "Thai".
// Non-alphanumerics collapse to spaces, then we look for the padded keyword.
function normalizeForMatch(value: string): string {
  return ` ${value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

function containsKeyword(normalizedHaystack: string, keyword: string): boolean {
  return normalizedHaystack.includes(normalizeForMatch(keyword));
}

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
    // An explicit non-tech category is decisive.
    if (categories.some((category) => NON_TECH_CATEGORIES.includes(category))) {
      return false;
    }
    return categories.some((category) => TECH_CATEGORIES.includes(category));
  }

  // No categories (Luma detail fetch failed) - fall back to text, conservatively.
  const haystack = [
    event.name,
    event.description,
    event.organizer?.name,
    event.hosts?.map((host) => host.name).join(' '),
    event.featuredGuests?.map((guest) => guest.name).join(' '),
  ]
    .filter(Boolean)
    .join(' ');

  const normalized = normalizeForMatch(haystack);

  return TEXT_KEYWORDS.some((keyword) => containsKeyword(normalized, keyword));
}
