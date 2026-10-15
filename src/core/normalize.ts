import { parse } from "tldts";

/**
 * Normalize anything that looks like a website or email into a registrable domain
 * ("https://www.Shop.acme.co.uk/about" -> "acme.co.uk"). Returns null when no domain can be found.
 */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  const at = s.lastIndexOf("@");
  if (at >= 0) s = s.slice(at + 1);
  const r = parse(s.includes("://") ? s : `http://${s}`);
  if (!r.domain || r.isIp) return null;
  return r.domain;
}

/**
 * Canonical LinkedIn profile/company URL: "https://www.linkedin.com/in/<slug>" (lowercased, no query,
 * no trailing slash, locale subdomains collapsed). Returns null for non-LinkedIn URLs.
 */
export function normalizeLinkedIn(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  const kind = parts[0]?.toLowerCase();
  const slug = parts[1];
  if (!kind || !slug || !["in", "company", "pub"].includes(kind)) return null;
  return `https://www.linkedin.com/${kind}/${decodeURIComponent(slug).toLowerCase()}`;
}

/** Filesystem-safe slug: "Jane Doe-Müller" -> "jane-doe-muller". */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Person id derived from their LinkedIn URL, falling back to name + company. */
export function personId(linkedinUrl: string | null | undefined, name?: string, company?: string): string {
  const li = normalizeLinkedIn(linkedinUrl);
  if (li) {
    const slug = li.split("/").pop();
    if (slug) return slugify(slug);
  }
  return slugify([name, company].filter(Boolean).join(" "));
}

const FREEMAIL = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de",
  "gmx.net", "web.de", "mail.com", "yandex.com", "yandex.ru", "zoho.com", "hey.com", "fastmail.com",
  "telenet.be", "skynet.be", "ziggo.nl", "kpnmail.nl", "orange.fr", "free.fr", "laposte.net", "t-online.de",
  "qq.com", "163.com",
]);

/** True for consumer mailbox providers — those addresses are personal, not business, data. */
export function isPersonalEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  return FREEMAIL.has(email.slice(at + 1).trim().toLowerCase());
}
