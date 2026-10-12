/**
 * Converts text to a URL slug.
 * - lowercase
 * - every run of characters that are not a-z or 0-9 becomes a single "-"
 * - no leading or trailing "-"
 * Example: slugify("  Hello, World!  ") === "hello-world"
 */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
