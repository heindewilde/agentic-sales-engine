import { describe, expect, test } from "bun:test";
import { isPersonalEmail, normalizeDomain, normalizeLinkedIn, personId, slugify } from "../../src/core/normalize.ts";

describe("normalizeDomain", () => {
  test.each([
    ["https://www.Acme.com/about?x=1", "acme.com"],
    ["shop.acme.co.uk", "acme.co.uk"],
    ["jane@sales.acme.de", "acme.de"],
    ["ACME.BE", "acme.be"],
    ["http://192.168.1.1", null],
    ["", null],
    ["not a domain", null],
  ])("%p -> %p", (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });
});

describe("normalizeLinkedIn", () => {
  test("canonicalizes profile URLs", () => {
    expect(normalizeLinkedIn("https://nl.linkedin.com/in/Jane-Doe-123/?utm=x")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(normalizeLinkedIn("linkedin.com/in/jane-doe-123")).toBe("https://www.linkedin.com/in/jane-doe-123");
    expect(normalizeLinkedIn("https://www.linkedin.com/company/acme/")).toBe("https://www.linkedin.com/company/acme");
  });
  test("rejects non-LinkedIn or non-profile URLs", () => {
    expect(normalizeLinkedIn("https://twitter.com/in/jane")).toBeNull();
    expect(normalizeLinkedIn("https://www.linkedin.com/feed/")).toBeNull();
  });
});

test("slugify and personId", () => {
  expect(slugify("Jane Doe-Müller")).toBe("jane-doe-muller");
  expect(personId("https://www.linkedin.com/in/Jane-Doe-123")).toBe("jane-doe-123");
  expect(personId(null, "Jane Doe", "acme.com")).toBe("jane-doe-acme-com");
});

test("isPersonalEmail", () => {
  expect(isPersonalEmail("jane@gmail.com")).toBe(true);
  expect(isPersonalEmail("jane@acme.com")).toBe(false);
});
