export type Tags = Record<string, string>;

export const TAG_PREFIX = "cloudgear:";
const VALUE_CHARS = /[^\p{L}\p{N} +\-=._:/@]/gu;
const KEY = /^[\p{L}\p{N} +\-=._:/@]{1,128}$/u;
const MAX_TAGS = 50;

export const tagValue = (value: string): string => Array.from(value.replace(VALUE_CHARS, "_")).slice(0, 256).join("");

// Tags every created resource carries; extra tags never override the `cloudgear:` ones.
export function baseTags(input: { project: string; version: string; env?: string; author?: string; extra?: Tags }): Tags {
  const tags: Tags = {};
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (key.toLowerCase().startsWith(TAG_PREFIX) || key.toLowerCase().startsWith("aws:")) throw new Error(`Tag "${key}" is reserved; "${TAG_PREFIX}" and "aws:" tags are set by cloudgear and AWS`);
    if (!KEY.test(key)) throw new Error(`Tag key "${key}" is invalid: use up to 128 letters, digits, spaces and + - = . _ : / @`);
    tags[key] = tagValue(value);
  }
  tags[`${TAG_PREFIX}managed-by`] = "cloudgear";
  tags[`${TAG_PREFIX}version`] = tagValue(input.version);
  tags[`${TAG_PREFIX}project`] = tagValue(input.project);
  if (input.env) tags[`${TAG_PREFIX}env`] = tagValue(input.env);
  if (input.author) tags[`${TAG_PREFIX}author`] = tagValue(input.author);
  if (Object.keys(tags).length + 1 > MAX_TAGS) throw new Error(`Too many tags: AWS allows ${MAX_TAGS} per resource, cloudgear adds 6`);
  return tags;
}

export type Tagger = (resource: string) => Tags;

export const taggerFor = (base: Tags | undefined): Tagger => (resource) => ({ ...(base ?? {}), ...(base ? { [`${TAG_PREFIX}resource`]: tagValue(resource) } : {}) });

export const tagList = (tags: Tags): { Key: string; Value: string }[] => Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
