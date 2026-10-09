// Text contrast of the site's own colour pairs (WCAG 2.2 AA: 4.5:1 for normal text).
// The production accessibility audit (axe, 10 October 2026) found white on the
// button blue at 4.49:1; this keeps it, and the other text pairs, above the line.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const css = env.TEST_SITE_CSS;

function token(name: string): string {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`--${name} not found`);
  return m[1]!;
}
function lum(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
function ratio(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe("colour contrast", () => {
  it("white on the button blue, and the text colours on the page and card backgrounds, are at least 4.5:1", () => {
    expect(ratio("#ffffff", token("accent-2"))).toBeGreaterThanOrEqual(4.5);
    for (const fg of ["text", "muted", "accent"]) {
      for (const bg of ["bg", "surface"]) expect(ratio(token(fg), token(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
