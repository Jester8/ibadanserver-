/**
 * Basic chat hygiene, shared by client and server. This is a first line of defence only.
 * Extend BLOCKED with Yoruba / Pidgin terms from a native speaker before a public launch.
 */

const BLOCKED = [
  "fuck",
  "fucking",
  "shit",
  "bitch",
  "asshole",
  "bastard",
  "cunt",
  "dick",
  "pussy",
  "whore",
  "slut",
  "motherfucker",
  "ashawo",
  "oloshi",
  "oloriburuku",
];

/** Patterns for slurs and obfuscated forms (leetspeak, repeated letters). */
const PATTERNS: RegExp[] = [/\bn+[i1!]+g+[ae3]+r?s?\b/gi, /\bf+[u*]+c+k+\w*/gi, /\bs+h+[i1!]+t+\w*/gi];

const WORDS = new RegExp(`\\b(${BLOCKED.join("|")})\\b`, "gi");
const URLS = /(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|ng|io|xyz|ly|me)\b\S*/gi;

const mask = (m: string) => "*".repeat(m.length);

export function cleanChat(text: string): string {
  let t = String(text ?? "").replace(/[\u0000-\u001f<>]/g, " ");
  t = t.replace(URLS, "[link]");
  t = t.replace(WORDS, mask);
  for (const p of PATTERNS) t = t.replace(p, mask);
  t = t.replace(/(.)\1{5,}/g, "$1$1$1"); // aaaaaaaa -> aaa
  return t.replace(/\s+/g, " ").trim().slice(0, 200);
}
