import { spawnSync } from "child_process";
import { MongoClient } from "mongodb";

type LinkedInRawPost = Record<string, any>;

function normalizeEnv(value: string | undefined): string {
  const trimmed = (value || "").trim();
  return trimmed.replace(/^['"]|['"]$/g, "").trim();
}

const MONGO_URI = normalizeEnv(process.env.MONGODB_URI);
const LINKEDIN_DB_NAME =
  normalizeEnv(process.env.LINKEDIN_DB_NAME) || "linkedin_post";
const LINKEDIN_COLLECTION =
  normalizeEnv(process.env.LINKEDIN_POSTS_COLLECTION) || "linkedin_posts";
const LINKEDIN_USERNAME = normalizeEnv(process.env.LINKEDIN_USERNAME);
const LINKEDIN_PASSWORD = normalizeEnv(process.env.LINKEDIN_PASSWORD);
const LINKEDIN_PUBLIC_ID =
  normalizeEnv(process.env.LINKEDIN_PUBLIC_ID) || "nyalalabs";
const LINKEDIN_POST_COUNT = 10;

export interface LinkedInPostDocument {
  dedupKey: string;
  profileId: string;
  source: "linkedin";
  postId: string | null;
  postUrn: string | null;
  text: string | null;
  url: string | null;
  firstImageUrl: string | null;
  imageUrls: string[];
  publishedAt: string | null;
  raw: LinkedInRawPost;
  scrapedAt: string;
}

export interface LinkedInScrapeSummary {
  attempted: number;
  inserted: number;
  existing: number;
  profileId: string;
  collection: string;
  saved: LinkedInPostDocument[];
}

function getPythonBinary(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function getPostId(post: LinkedInRawPost): string | null {
  const candidate =
    post?.id ||
    post?.urn ||
    post?.entityUrn ||
    post?.updateMetadata?.urn ||
    post?.updateMetadata?.updateKey ||
    post?.activityUrn ||
    post?.objectUrn ||
    post?.postUrn ||
    null;

  return candidate ? String(candidate) : null;
}

function getPostText(post: LinkedInRawPost): string | null {
  const update = post?.value?.["com.linkedin.voyager.feed.render.UpdateV2"];
  const textCandidates = [
    update?.commentary?.text?.text,
    post?.commentary,
    post?.commentary?.text,
    post?.description,
    post?.text,
    post?.content?.text,
    post?.content?.title,
    post?.summary,
    post?.shareContent?.text,
    post?.shareContent?.shareCommentary?.text,
    post?.shareContent?.shareCommentary,
    post?.shareContent?.commentary,
    post?.specificContent?.["com.linkedin.ugc.ShareContent"]?.shareCommentary
      ?.text,
  ];

  for (const candidate of textCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function getPostUrl(post: LinkedInRawPost): string | null {
  const urlCandidates = [
    post?.url,
    post?.permalink,
    post?.content?.url,
    post?.content?.shareUrl,
    post?.shareContent?.shareUrl,
    post?.object?.url,
    post?.navigationUrl,
  ];

  for (const candidate of urlCandidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function getActivityId(post: LinkedInRawPost): string | null {
  const candidates = [
    post?.urn,
    post?.id,
    post?.updateMetadata?.urn,
    post?.activityUrn,
  ];

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const match = candidate.match(/urn:li:activity:(\d+)/);
    if (match?.[1]) return match[1];
  }

  return null;
}

function getPublishedAtFromActivityId(post: LinkedInRawPost): string | null {
  const activityId = getActivityId(post);
  if (!activityId) return null;

  try {
    const milliseconds = BigInt(activityId) >> 22n;
    const date = new Date(Number(milliseconds));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  } catch {
    return null;
  }
}

function getPostImageUrls(post: LinkedInRawPost): string[] {
  const update = post?.value?.["com.linkedin.voyager.feed.render.UpdateV2"];
  const imageComponent =
    update?.content?.["com.linkedin.voyager.feed.render.ImageComponent"];
  const images = Array.isArray(imageComponent?.images)
    ? imageComponent.images
    : [];
  const urls: string[] = [];

  for (const image of images) {
    const vectorImage = image?.attributes?.find(
      (attribute: LinkedInRawPost) => attribute?.vectorImage,
    )?.vectorImage;
    const artifacts = Array.isArray(vectorImage?.artifacts)
      ? vectorImage.artifacts
      : [];
    const bestArtifact = artifacts
      .filter(
        (artifact: LinkedInRawPost) =>
          typeof artifact?.fileIdentifyingUrlPathSegment === "string" &&
          typeof vectorImage?.rootUrl === "string",
      )
      .sort(
        (a: LinkedInRawPost, b: LinkedInRawPost) =>
          Number(b?.width || 0) * Number(b?.height || 0) -
          Number(a?.width || 0) * Number(a?.height || 0),
      )[0];

    const rootUrl = vectorImage?.rootUrl;
    const path = bestArtifact?.fileIdentifyingUrlPathSegment;
    if (typeof rootUrl !== "string" || typeof path !== "string") continue;

    const imageUrl = `${rootUrl}${path}`;
    if (!urls.includes(imageUrl)) urls.push(imageUrl);
  }

  return urls;
}

function getPublishedAt(post: LinkedInRawPost): string | null {
  const candidate =
    post?.publishedAt ||
    post?.createdAt ||
    post?.created ||
    post?.time ||
    post?.timestamp ||
    post?.lastModifiedAt ||
    post?.updateMetadata?.publishedAt ||
    post?.updateMetadata?.time ||
    null;

  if (!candidate) return getPublishedAtFromActivityId(post);

  const date = toDate(candidate);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function toDate(value: unknown): Date {
  if (typeof value === "object" && value !== null) {
    const nestedValue =
      (value as Record<string, unknown>).time ||
      (value as Record<string, unknown>).timestamp ||
      (value as Record<string, unknown>).value;
    return toDate(nestedValue);
  }

  if (typeof value === "number") {
    return new Date(value < 1_000_000_000_000 ? value * 1000 : value);
  }

  return new Date(String(value));
}

function buildDedupKey(post: LinkedInRawPost, fallbackId?: string): string {
  const postId = getPostId(post) || fallbackId || "unknown";
  return `linkedin:${String(postId)}`;
}

function normalizeLinkedInPost(
  post: LinkedInRawPost,
  profileId: string,
): LinkedInPostDocument {
  const postId = getPostId(post);
  const dedupKey = buildDedupKey(post, postId || `${profileId}-${Date.now()}`);
  const imageUrls = getPostImageUrls(post);

  return {
    dedupKey,
    profileId,
    source: "linkedin",
    postId: postId || null,
    postUrn: post?.urn || post?.entityUrn || post?.objectUrn || post?.updateMetadata?.urn || null,
    text: getPostText(post),
    url: getPostUrl(post),
    firstImageUrl: imageUrls[0] || null,
    imageUrls,
    publishedAt: getPublishedAt(post),
    raw: post,
    scrapedAt: new Date().toISOString(),
  };
}

async function getLinkedInPostsFromPython(): Promise<LinkedInRawPost[]> {
  if (!LINKEDIN_USERNAME || !LINKEDIN_PASSWORD) {
    throw new Error("Missing LINKEDIN_USERNAME or LINKEDIN_PASSWORD in environment.");
  }

  if (!MONGO_URI) {
    throw new Error("Missing MONGODB_URI in environment.");
  }

  const script = `
from linkedin_api import Linkedin
import json
import os

api = Linkedin(os.environ['LINKEDIN_USERNAME'], os.environ['LINKEDIN_PASSWORD'], authenticate=True)
posts = api.get_company_updates(
    public_id=os.environ.get('LINKEDIN_PUBLIC_ID', 'nyalalabs'),
    max_results=${LINKEDIN_POST_COUNT},
)
print(json.dumps(posts))
`;

  const result = spawnSync(getPythonBinary(), ["-c", script], {
    env: {
      ...process.env,
      LINKEDIN_USERNAME,
      LINKEDIN_PASSWORD,
      LINKEDIN_PUBLIC_ID,
    },
    encoding: "utf-8",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    if (stderr.includes("KeyError: 'message'")) {
      throw new Error(
        "LinkedIn returned an unexpected response while loading the profile. " +
          "Verify the credentials, complete any LinkedIn verification challenge, " +
          "and confirm LINKEDIN_PUBLIC_ID is the profile slug.",
      );
    }
    throw new Error(stderr || stdout || "LinkedIn scraper failed without output.");
  }

  const output = (result.stdout || "").trim();
  if (!output) {
    return [];
  }

  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected LinkedIn payload shape: ${typeof parsed}`);
  }

  return parsed.filter((post): post is LinkedInRawPost => Boolean(post && typeof post === "object"));
}

export async function scrapeNyalaLinkedInPosts(): Promise<LinkedInScrapeSummary> {
  const posts = await getLinkedInPostsFromPython();
  const normalizedPosts = posts.map((post) => normalizeLinkedInPost(post, LINKEDIN_PUBLIC_ID));
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    const collection = client
      .db(LINKEDIN_DB_NAME)
      .collection<LinkedInPostDocument>(LINKEDIN_COLLECTION);
    await collection.createIndex({ dedupKey: 1 }, { unique: true, sparse: true, name: "uniq_linkedin_dedup_key" });

    const ops = normalizedPosts.map((post) => ({
      updateOne: {
        filter: { dedupKey: post.dedupKey },
        update: { $set: post },
        upsert: true,
      },
    }));

    let inserted = 0;
    let existing = 0;
    if (ops.length > 0) {
      const result = await collection.bulkWrite(ops, { ordered: false });
      inserted = result.upsertedCount ?? 0;
      existing = Math.max(0, normalizedPosts.length - inserted);
    }

    return {
      attempted: normalizedPosts.length,
      inserted,
      existing,
      profileId: LINKEDIN_PUBLIC_ID,
      collection: LINKEDIN_COLLECTION,
      saved: normalizedPosts,
    };
  } finally {
    await client.close();
  }
}

if (require.main === module) {
  scrapeNyalaLinkedInPosts()
    .then((summary) => {
      console.log(
        `LinkedIn scrape complete: profile=${summary.profileId} collection=${summary.collection} attempted=${summary.attempted} inserted=${summary.inserted} existing=${summary.existing}`,
      );
    })
    .catch((error) => {
      console.error("LinkedIn scrape failed:", error);
      process.exitCode = 1;
    });
}
