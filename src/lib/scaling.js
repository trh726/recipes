const VULGAR_FRACTIONS = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4,
  "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8,
};

const FRACTION_GLYPHS = Object.entries(VULGAR_FRACTIONS).map(([glyph, value]) => ({ glyph, value }));

const VULGAR_CLASS = `[${Object.keys(VULGAR_FRACTIONS).join("")}]`;

// One quantity: "1 1/2", "1½", "1 ½", "1/2", "½", "1.5", "2". Mixed forms come
// first so "1 1/2" doesn't stop at "1".
const QUANTITY_RE = new RegExp(
  "^(?:" +
    "(\\d+)[ ]+(\\d+)\\s*\\/\\s*(\\d+)" +      // 1 1/2
    `|(\\d+)[ ]?(${VULGAR_CLASS})` +           // 1½ or 1 ½
    "|(\\d+)\\s*\\/\\s*(\\d+)" +               // 1/2
    `|(${VULGAR_CLASS})` +                     // ½
    "|(\\d+(?:\\.\\d+)?)" +                    // 1.5 or 2
  ")"
);

/** Parse a quantity at the start of `text`; returns { value, length } or null. */
function matchQuantity(text) {
  const m = QUANTITY_RE.exec(text);
  if (!m) return null;
  let value;
  if (m[1] !== undefined) value = Number(m[1]) + Number(m[2]) / Number(m[3]);
  else if (m[4] !== undefined) value = Number(m[4]) + VULGAR_FRACTIONS[m[5]];
  else if (m[6] !== undefined) value = Number(m[6]) / Number(m[7]);
  else if (m[8] !== undefined) value = VULGAR_FRACTIONS[m[8]];
  else value = Number(m[9]);
  if (!Number.isFinite(value)) return null;
  return { value, length: m[0].length };
}

/**
 * Parse the leading quantity (or range like "2-3" / "1 to 2") of an ingredient
 * line. Returns { values, sep, rest } or null. Numbers later in the line
 * (e.g. "1 can (400g) tomatoes") are deliberately left alone.
 */
function parseLeadingQuantity(line) {
  const lead = line.match(/^\s*/)[0];
  const first = matchQuantity(line.slice(lead.length));
  if (!first) return null;
  let end = lead.length + first.length;
  let values = [first.value];
  let sep = null;
  const sepMatch = line.slice(end).match(/^\s*(-|–|—|to)\s*/i);
  if (sepMatch) {
    const second = matchQuantity(line.slice(end + sepMatch[0].length));
    if (second) {
      values = [first.value, second.value];
      sep = sepMatch[1].toLowerCase() === "to" ? " to " : sepMatch[1];
      end += sepMatch[0].length + second.length;
    }
  }
  return { values, sep, rest: line.slice(end) };
}

/** Format a number cook-style: 1.5 → "1½", 0.25 → "¼"; decimals only as a last resort. */
function formatQuantity(value) {
  const whole = Math.floor(value + 1e-9);
  const frac = value - whole;
  if (frac < 0.02) return String(whole);
  if (frac > 0.98) return String(whole + 1);
  let best = null;
  for (const { glyph, value: fv } of FRACTION_GLYPHS) {
    const err = Math.abs(frac - fv);
    if (err <= 0.02 && (!best || err < best.err)) best = { glyph, err };
  }
  if (best) return whole ? `${whole}${best.glyph}` : best.glyph;
  return String(Math.round(value * 100) / 100);
}

/** Rewrite one ingredient line at the given scale factor. */
export function scaleLine(line, factor) {
  if (factor === 1) return line;
  const parsed = parseLeadingQuantity(line);
  if (!parsed) return line;
  const nums = parsed.values.map((v) => formatQuantity(v * factor)).join(parsed.sep ?? "");
  const rest = parsed.rest.replace(/^\s+/, "");
  return rest ? `${nums} ${rest}` : nums;
}

/** First number in a servings string ("4-6 servings" → 4), or null. */
export function parseServings(text) {
  const m = /\d+(?:\.\d+)?/.exec(text ?? "");
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

