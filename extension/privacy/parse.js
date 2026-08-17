/**
 * Demographics parsing, in the browser.
 *
 * A port of backend/demographics.py, and the reason it exists is not
 * convenience. `POST /parse` took the WHOLE pasted note, un-redacted, because
 * finding the name is what has to happen before the name can be removed. So
 * redacting in the browser and leaving the parser on the server would have
 * left the raw note going out one request earlier — the same disclosure, in a
 * different envelope. Both modules move or neither does.
 *
 * Everything the Python refuses to do, this refuses to do, for the same
 * reasons and in the same order:
 *
 *   - a labelled line is believed;
 *   - a shape in unlabelled prose is believed only if it occurs exactly once
 *     in the whole paste;
 *   - a date of birth is never taken from unlabelled text, because a clinical
 *     note is nothing but dates;
 *   - a name is never guessed from prose;
 *   - a value the note attributes to somebody else — a clinic's number, a
 *     husband's NRIC — is dropped before any of that runs.
 *
 * WHAT DRIFT LOOKS LIKE HERE, and why it is a different risk from the
 * redactor's. A parser that misses a value does not leak it: the field stays
 * blank and the doctor types it. What it does instead is take that value out
 * of the redaction dictionary — so a name this fails to find is a name
 * redact.js is never told to remove. The failure is one step removed and that
 * makes it easier to miss, which is why the same corpus runs against both
 * languages rather than only the redactor's half.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------- vocabulary

  const LABELS = {
    full_name: ["name", "patient", "patientname", "fullname", "ptname", "pt"],
    nric: ["nric", "fin", "nricfin", "nricno", "ic", "icno", "idno", "identitycard"],
    dob: ["dob", "dateofbirth", "birthdate", "born"],
    phone: ["phone", "tel", "telephone", "mobile", "hp", "handphone", "contact", "contactno"],
    address: ["address", "addr", "residentialaddress"],
    policy_number: ["policy", "policyno", "policynumber", "policy#", "memberno", "certificateno"],
    insurer: ["insurer", "insurance", "insurancecompany"],
  };

  const LABEL_LOOKUP = new Map();
  for (const [field, aliases] of Object.entries(LABELS)) {
    for (const alias of aliases) LABEL_LOOKUP.set(alias, field);
  }

  const MONTHS = {};
  [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
  ].forEach((name, i) => {
    MONTHS[name] = i + 1;
    MONTHS[name.slice(0, 3)] = i + 1;
  });

  // ------------------------------------------------------------------ shapes
  //
  // NRIC, phone and email come from the shared file by way of redact.js, so
  // the two languages cannot disagree about what an identifier looks like.
  // The shapes below are this module's own — they decide which FIELD a value
  // belongs to rather than whether it is an identifier at all, and nothing in
  // the redactor needs them.

  const LABELLED_LINE = /^\s*([A-Za-z][A-Za-z .#/]{0,23})\s*[:\-–]\s*(.+?)\s*$/;
  const SEGMENT_SPLIT = /\s*[·|;]\s*|\s{2,}|\s+—\s+/;
  const HARD_SEP = /\s*[·|;]\s*|\s{2,}|\s+—\s+/;
  const DATE_IN_TEXT =
    /\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b|\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\s+[A-Za-z]{3,9}\.?\s+\d{4}\b/g;
  const POLICY_PATTERN = /\b[A-Z]{2,5}[-/]?\d{4,}\b/g;
  const POSTAL_PATTERN = /\bSingapore\s*\d{6}\b|\bS\d{6}\b|(?<!\d)\d{6}(?!\d)/g;
  const TOKEN_CHAR = "[A-Za-z0-9\\-/#]";

  const DATE_PATTERNS = [
    /^(?<d>\d{1,2})[/.\-](?<m>\d{1,2})[/.\-](?<y>\d{4})$/,
    /^(?<y>\d{4})-(?<m>\d{1,2})-(?<d>\d{1,2})$/,
    /^(?<d>\d{1,2})\s+(?<mon>[A-Za-z]{3,9})\.?\s+(?<y>\d{4})$/,
  ];

  /**
   * Who a value belongs to, read off the words in front of it.
   *
   * Uniqueness is what the unlabelled rule believes, and a unique value can
   * still be the clinic's — a note carries the practice's own number under the
   * signature about as often as it carries the patient's.
   */
  const OTHER_OWNER =
    /\b(?:clinic|polyclinic|hospital|medical\s+cent(?:re|er)|practice|pharmacy|employer|company|workplace|next\s+of\s+kin|nok|kin|caregiver|carer|guardian|spouse|husband|wife|father|mother|son|daughter|brother|sister|sibling|emergency|doctor|physician|referring)\b/i;

  const INSURERS = [
    ["AIA", ["AIA", "AIA Singapore"]],
    ["Great Eastern", ["Great Eastern", "Great Eastern Life", "Great Eastern Life Assurance"]],
    ["HSBC Life", ["HSBC Life", "HSBC Insurance", "HSBC Life Singapore"]],
    ["Income", ["Income Insurance", "NTUC Income"]],
    ["Prudential", ["Prudential", "Prudential Assurance", "Prudential Singapore"]],
    ["Raffles Health Insurance", ["Raffles Health Insurance"]],
    ["Singlife", ["Singlife", "Singapore Life", "Singlife with Aviva"]],
    ["Aviva", ["Aviva", "Aviva Singapore"]],
    ["AXA", ["AXA", "AXA Insurance", "AXA Singapore"]],
    ["Aetna", ["Aetna", "Aetna International"]],
    ["Allianz", ["Allianz", "Allianz Partners"]],
    ["Bupa", ["Bupa", "Bupa Global"]],
    ["China Life", ["China Life"]],
    ["China Taiping", ["China Taiping"]],
    ["Chubb", ["Chubb", "Chubb Insurance"]],
    ["Cigna", ["Cigna", "Cigna Healthcare"]],
    ["Etiqa", ["Etiqa", "Etiqa Insurance"]],
    ["FWD", ["FWD Insurance", "FWD Singapore"]],
    ["Henner", ["Henner", "Henner Group"]],
    ["Liberty", ["Liberty Insurance"]],
    ["Manulife", ["Manulife", "Manulife Singapore"]],
    ["MSIG", ["MSIG", "MSIG Insurance"]],
    ["QBE", ["QBE", "QBE Insurance"]],
    ["Sompo", ["Sompo", "Sompo Insurance"]],
    ["Tokio Marine", ["Tokio Marine", "Tokio Marine Life"]],
  ];

  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const squash = (text) => text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

  const INSURER_BY_VARIATION = new Map();
  for (const [canonical, variations] of INSURERS) {
    for (const variation of variations) INSURER_BY_VARIATION.set(squash(variation), canonical);
  }

  const INSURER_PATTERN = new RegExp(
    "\\b(?:" +
      [...INSURER_BY_VARIATION.keys()]
        .sort((a, b) => b.length - a.length)
        .map((v) => v.split(" ").map(escapeRe).join("\\s+"))
        .join("|") +
      ")\\b",
    "gi"
  );

  const ADDRESS_LABEL_PREFIX = new RegExp(
    `^(?:${LABELS.address.join("|")})\\s*[:.\\-]?\\s+`,
    "i"
  );

  const MAX_LABEL_WORDS = 3;
  const MAX_NAME_WORDS = 6;
  const MIN_NAME_WORDS = 2;
  const MIN_HEADER_FIELDS = 2;
  const CLINICAL_WINDOW_YEARS = 2;

  const NAME_PARTICLES = new Set([
    "bin", "binte", "bte", "b", "s/o", "d/o", "a/l", "a/p",
    "van", "von", "de", "del", "der", "di", "da", "la", "le",
  ]);

  const NAME_LABEL_PREFIX = /^[A-Za-z]{1,12}\s*[:.\-]\s+/;
  const POLICY_PARTS = /^([A-Z]{2,5})[-/]?(\d{4,})$/;

  // The identifier shapes, borrowed from the redactor so there is one
  // definition of an NRIC in this language, not two.
  let NRIC_PATTERN = null;
  let PHONE_BARE = null;
  let PHONE_IN_TEXT = null;
  let EMAIL_PATTERN = null;
  let SHAPED_FIELDS = null;
  let SHAPE_FINDERS = null;

  /**
   * Take the identifier shapes from the shared file.
   *
   * Called with the same parsed patterns.json redact.js is given. Nothing here
   * runs until it has been: a parser with no idea what an NRIC looks like
   * returns an empty record, which reads exactly like a note that mentioned
   * nothing — and an empty record is an empty redaction dictionary.
   */
  function usePatterns(parsed) {
    if (!parsed || !Array.isArray(parsed.patterns)) throw new Error("patterns.json has no patterns");
    const by = new Map(parsed.patterns.map((p) => [p.field, p]));
    for (const field of ["nric", "phone", "email"]) {
      if (!by.has(field)) throw new Error(`patterns.json is missing ${field}`);
    }
    const src = (field) => by.get(field).regex;
    const flags = (field) => (by.get(field).ignore_case ? "gi" : "g");

    NRIC_PATTERN = new RegExp(src("nric"), flags("nric"));
    PHONE_BARE = new RegExp(src("phone"), flags("phone"));
    EMAIL_PATTERN = new RegExp(src("email"), flags("email"));
    // A phone must be a number in its own right rather than the tail of a
    // longer reference — `Policy GHS-88213004` ends in eight digits opening
    // with an 8, which is a valid mobile by shape.
    PHONE_IN_TEXT = new RegExp(
      `(?<!${TOKEN_CHAR})(?:${src("phone")})(?!${TOKEN_CHAR})`,
      flags("phone")
    );

    SHAPED_FIELDS = {
      nric: NRIC_PATTERN,
      phone: PHONE_IN_TEXT,
      policy_number: POLICY_PATTERN,
      dob: DATE_IN_TEXT,
      insurer: INSURER_PATTERN,
    };
    // Order matters: the most specific shape claims a span first, and a span
    // once claimed is not offered to anything else.
    SHAPE_FINDERS = [
      ["nric", NRIC_PATTERN],
      ["dob", DATE_IN_TEXT],
      ["phone", PHONE_IN_TEXT],
      ["policy_number", POLICY_PATTERN],
      ["address", POSTAL_PATTERN],
      ["insurer", INSURER_PATTERN],
    ];
    return true;
  }

  const ready = () => SHAPED_FIELDS !== null;

  // ------------------------------------------------------------------ helpers

  const all = (regex, text) => [...text.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : regex.flags + "g"))];
  const fullMatch = (regex, text) => {
    const m = new RegExp(`^(?:${regex.source})$`, regex.flags.replace(/g/g, "")).exec(text);
    return Boolean(m);
  };
  const stripChars = (text, chars) => {
    let out = text;
    while (out && chars.includes(out[0])) out = out.slice(1);
    while (out && chars.includes(out[out.length - 1])) out = out.slice(0, -1);
    return out;
  };
  const normaliseLabel = (raw) => raw.toLowerCase().replace(/[^a-z]/g, "");

  function parseDate(text) {
    const value = stripChars(String(text).trim(), ".,");
    for (const pattern of DATE_PATTERNS) {
      const match = pattern.exec(value);
      if (!match) continue;
      const parts = match.groups;
      const month = parts.mon ? MONTHS[parts.mon.toLowerCase()] : Number(parts.m);
      if (!month) return null;
      const year = Number(parts.y);
      const day = Number(parts.d);
      const parsed = new Date(Date.UTC(year, month - 1, day));
      // Round-trip: JS rolls 31 April over to 1 May rather than refusing it.
      if (
        parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 ||
        parsed.getUTCDate() !== day
      ) {
        return null;
      }
      const today = new Date();
      const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
      if (parsed.getTime() < Date.UTC(1900, 0, 1) || parsed.getTime() > todayUtc) return null;
      return parsed.toISOString().slice(0, 10);
    }
    return null;
  }

  function canonicalInsurer(text) {
    const exact = INSURER_BY_VARIATION.get(squash(text));
    if (exact) return exact;
    const found = shapedCandidates("insurer", INSURER_PATTERN, text);
    return found.length === 1 ? found[0] : null;
  }

  function normalised(field, raw) {
    if (field === "insurer") return INSURER_BY_VARIATION.get(squash(raw)) || null;
    if (field === "nric") {
      const cleaned = raw.replace(/\s/g, "").toUpperCase();
      return fullMatch(NRIC_PATTERN, cleaned) ? cleaned : null;
    }
    if (field === "dob") return parseDate(raw);
    return raw;
  }

  function dedupeKey(field, value) {
    if (field !== "phone") return value;
    let digits = value.replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("65")) digits = digits.slice(2);
    return digits;
  }

  function samePolicy(a, b) {
    const left = POLICY_PARTS.exec(a);
    const right = POLICY_PARTS.exec(b);
    if (!left || !right || left[2] !== right[2]) return false;
    return left[1].startsWith(right[1]) || right[1].startsWith(left[1]);
  }

  function duplicateIndex(field, value, kept) {
    const key = dedupeKey(field, value);
    for (let i = 0; i < kept.length; i += 1) {
      if (dedupeKey(field, kept[i]) === key) return i;
      if (field === "policy_number" && samePolicy(kept[i], value)) return i;
    }
    return null;
  }

  function shapedCandidates(field, pattern, text) {
    const out = [];
    const seen = [];
    for (const match of all(pattern, text)) {
      const raw = match[0].trim();
      if (!raw || seen.includes(raw)) continue;
      seen.push(raw);
      const value = normalised(field, raw);
      if (!value) continue;
      const at = duplicateIndex(field, value, out);
      if (at === null) out.push(value);
      else if (field === "policy_number" && value.length > out[at].length) out[at] = value;
    }
    return out;
  }

  /** Rejoin a header block that wrapped mid-line. */
  function logicalLines(text) {
    const lines = [];
    for (const line of String(text).split("\n")) {
      if (lines.length && /[·|;,—-]\s*$/.test(lines[lines.length - 1])) {
        lines[lines.length - 1] = `${lines[lines.length - 1].trimEnd()} ${line.trim()}`;
        continue;
      }
      lines.push(line);
    }
    return lines;
  }

  const ownedBySomeoneElse = (line, at) => OTHER_OWNER.test(line.slice(0, at));

  /** Blank out values the note says belong to somebody else. */
  function withoutOtherOwners(pattern, text) {
    const out = [];
    for (let line of logicalLines(text)) {
      const matches = all(pattern, line).reverse();
      for (const match of matches) {
        if (!ownedBySomeoneElse(line, match.index)) continue;
        const span = match[0].length;
        line = line.slice(0, match.index) + " ".repeat(span) + line.slice(match.index + span);
      }
      out.push(line);
    }
    return out.join("\n");
  }

  // ------------------------------------------------------------- header lines

  function sameName(piece, known) {
    const key = (text) => text.toLowerCase().replace(/,/g, " ").split(/\s+/).filter(Boolean).join(" ");
    const wanted = key(known);
    const got = key(piece);
    if (!wanted || !got) return false;
    if (got === wanted) return true;
    const parts = wanted.split(" ");
    if (parts.length < 2) return false;
    return (
      got === parts.slice(1).concat(parts.slice(0, 1)).join(" ") ||
      got === parts.slice(-1).concat(parts.slice(0, -1)).join(" ")
    );
  }

  function looksLikeAName(text) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > MAX_NAME_WORDS) return false;
    return words.every(
      (word) => NAME_PARTICLES.has(stripChars(word.toLowerCase(), ".")) || /^[A-Z]/.test(word)
    );
  }

  function candidateFrom(text) {
    return stripChars(text.trim(), " \t,.;:·|/-").replace(NAME_LABEL_PREFIX, "").trim();
  }

  function proseWords(text) {
    for (const word of text.split(/\s+/)) {
      const stripped = stripChars(word, ".,;:()[]#/-");
      if (!stripped || !/[A-Za-z]/.test(stripped[0])) continue;
      if (NAME_PARTICLES.has(stripped.toLowerCase())) continue;
      if (stripped[0] === stripped[0].toLowerCase()) return true;
    }
    return false;
  }

  function nameRuns(gap) {
    return gap
      .split(HARD_SEP)
      .map((run) => candidateFrom(run || ""))
      .filter(Boolean);
  }

  function knownNameIn(gap, known) {
    const words = gap.split(/\s+/).filter(Boolean);
    for (let start = 0; start < words.length; start += 1) {
      for (let end = Math.min(start + MAX_NAME_WORDS, words.length); end > start; end -= 1) {
        const run = words.slice(start, end).join(" ");
        if (sameName(run, known)) return candidateFrom(run);
      }
    }
    return null;
  }

  function shapedSpans(line) {
    const taken = [];
    for (const [field, pattern] of SHAPE_FINDERS) {
      for (const match of all(pattern, line)) {
        if (ownedBySomeoneElse(line, match.index)) continue;
        const start = match.index;
        const end = match.index + match[0].length;
        if (taken.some(([s, e]) => s < end && start < e)) continue;
        const value = normalised(field, match[0].trim());
        if (!value) continue;
        taken.push([start, end, field, value]);
      }
    }
    return taken.sort((a, b) => a[0] - b[0]);
  }

  /** One line -> the fields it carries, or null if it is not a header line. */
  function headerPieces(line, knownName = "") {
    const spans = shapedSpans(line);
    const found = new Map();
    for (const [, , field, value] of spans) if (!found.has(field)) found.set(field, value);
    if (found.size < MIN_HEADER_FIELDS) return null;

    let gaps = [];
    let cursor = 0;
    for (const [start, end] of spans) {
      if (start > cursor) gaps.push([cursor, start]);
      cursor = end;
    }
    if (cursor < line.length) gaps.push([cursor, line.length]);

    for (let index = 0; index < spans.length; index += 1) {
      const [start, end, field] = spans[index];
      if (field !== "address") continue;
      const previousEnd = index ? spans[index - 1][1] : 0;
      const gap = line.slice(previousEnd, start);
      if (/\d/.test(gap)) {
        let addressStart = previousEnd + (gap.length - gap.replace(/^[ \t,.;·|]+/, "").length);
        const trimmed = line.slice(addressStart, start).trim();
        const words = trimmed.split(/\s+/).filter(Boolean);
        for (let length = words.length; length > 0; length -= 1) {
          const head = words.slice(0, length).join(" ");
          if (knownName && sameName(head, knownName)) {
            addressStart += head.length;
            break;
          }
        }
        found.set("address", stripChars(line.slice(addressStart, end).trim(), " \t,.;·|"));
        gaps = gaps.filter(([s, e]) => !(s <= previousEnd && e >= start));
      }
      break;
    }

    if (gaps.some(([s, e]) => s > 0 && proseWords(line.slice(s, e)))) return null;

    const fields = Object.fromEntries(found);
    if (knownName) {
      const hits = [];
      for (const [s, e] of gaps) {
        const hit = knownNameIn(line.slice(s, e), knownName);
        if (hit) hits.push(hit);
      }
      return [fields, hits.slice(0, 1)];
    }
    const names = [];
    for (const [s, e] of gaps) {
      for (const candidate of nameRuns(line.slice(s, e))) {
        if (/\d/.test(candidate)) continue;
        if (!looksLikeAName(candidate)) continue;
        if (candidate.split(/\s+/).filter(Boolean).length < MIN_NAME_WORDS) continue;
        names.push(candidate);
      }
    }
    return [fields, names];
  }

  /** A header written one value per line, which no single line can prove. */
  function headerBlock(lines, knownName = "") {
    const perLine = [];
    const found = new Map();

    for (const line of lines) {
      const spans = shapedSpans(line);
      let leftover = line;
      for (let i = spans.length - 1; i >= 0; i -= 1) {
        leftover = leftover.slice(0, spans[i][0]) + leftover.slice(spans[i][1]);
      }
      leftover = candidateFrom(leftover);
      if (spans.length && leftover) return null;
      if (!spans.length && !looksLikeAName(leftover)) return null;
      perLine.push([spans, leftover]);
      for (const [, , field, value] of spans) if (!found.has(field)) found.set(field, value);
    }

    if (found.size < MIN_HEADER_FIELDS) return null;

    const names = perLine.filter(([spans, leftover]) => !spans.length && leftover).map(([, l]) => l);
    const fields = Object.fromEntries(found);
    if (knownName) return [fields, names.filter((n) => sameName(n, knownName))];
    return [fields, names.filter((n) => n.split(/\s+/).filter(Boolean).length >= MIN_NAME_WORDS)];
  }

  function blocks(text) {
    const out = [];
    let current = [];
    for (const line of logicalLines(text)) {
      if (line.trim()) current.push(line);
      else if (current.length) {
        out.push(current);
        current = [];
      }
    }
    if (current.length) out.push(current);
    return out;
  }

  function classifySegment(segment) {
    const text = stripChars(segment.trim(), ",.");
    if (!text) return null;
    if (fullMatch(NRIC_PATTERN, text)) return ["nric", text.replace(/\s/g, "").toUpperCase()];
    const iso = parseDate(text);
    if (iso) return ["dob", iso];
    if (fullMatch(PHONE_BARE, text)) return ["phone", text];
    if (fullMatch(EMAIL_PATTERN, text)) return null; // nothing on the form asks for it

    const stripped = text
      .replace(/^(policy|member|certificate)\s*(no\.?|number|#)?\s*[:.]?\s*/i, "")
      .trim();
    if (fullMatch(POLICY_PATTERN, stripped)) return ["policy_number", stripped];

    if (new RegExp(POSTAL_PATTERN.source).test(text)) return ["address", text];

    const insurer = canonicalInsurer(text);
    if (insurer) return ["insurer", insurer];

    if (!/\d/.test(text)) return ["full_name", text];
    return null;
  }

  function parsePatientLine(value, knownName = "") {
    const header = headerPieces(value, knownName);
    if (header !== null) {
      const [fields, names] = header;
      const found = {};
      for (const [field, v] of Object.entries(fields)) found[field] = [v, "patient-line"];
      if (names.length === 1 && !found.full_name) found.full_name = [names[0], "patient-line"];
      return found;
    }

    const segments = value.split(SEGMENT_SPLIT).filter((s) => s && s.trim());
    if (segments.length <= 1) return { full_name: [value.trim(), "labelled"] };

    const found = {};
    for (const segment of segments) {
      const classified = classifySegment(segment);
      if (!classified) continue;
      const [field, parsed] = classified;
      if (!(field in found)) found[field] = [parsed, "patient-line"];
    }
    return found;
  }

  function labelPositions(line) {
    const words = [...line.matchAll(/[A-Za-z]+/g)].map((m) => [m.index, m.index + m[0].length, m[0]]);
    const found = [];
    let usedUntil = -1;

    for (let i = 0; i < words.length; i += 1) {
      if (words[i][0] < usedUntil) continue;
      // A label has to START a field, not sit mid-phrase: "Clinic tel
      // 62551234" is the clinic's number, and the qualifying word in front is
      // exactly what says so.
      const before = line.slice(0, words[i][0]);
      if (before && !/(?:[,;·|(\[\t]|\s{2,}|^)\s*$/.test(before)) continue;
      for (let take = Math.min(MAX_LABEL_WORDS, words.length - i); take > 0; take -= 1) {
        const window = words.slice(i, i + take);
        const field = LABEL_LOOKUP.get(normaliseLabel(window.map((w) => w[2]).join("")));
        if (field && field in SHAPED_FIELDS) {
          found.push([window[0][0], window[window.length - 1][1], field]);
          usedUntil = window[window.length - 1][1];
          break;
        }
      }
    }
    return found;
  }

  function labelledAnywhere(line) {
    const labels = labelPositions(line);
    const found = {};
    const choices = {};
    for (let index = 0; index < labels.length; index += 1) {
      const [, end, field] = labels[index];
      const stop = index + 1 < labels.length ? labels[index + 1][0] : line.length;
      const region = line.slice(end, stop);
      const candidates = shapedCandidates(field, SHAPED_FIELDS[field], region);
      if (candidates.length === 1) {
        if (!(field in found)) found[field] = candidates[0];
      } else if (candidates.length > 1) {
        if (!(field in choices)) choices[field] = candidates;
      }
    }
    return [found, choices];
  }

  function addressLines(text) {
    const lines = [];
    for (const line of logicalLines(text)) {
      const postal = new RegExp(POSTAL_PATTERN.source).exec(line);
      if (!postal) continue;
      if (ownedBySomeoneElse(line, postal.index)) continue;
      if (headerPieces(line) !== null) continue;
      const cleaned = line.trim().replace(ADDRESS_LABEL_PREFIX, "").trim();
      if (cleaned && !lines.includes(cleaned)) lines.push(cleaned);
    }
    return lines;
  }

  function birthDateCandidates(text) {
    const today = new Date();
    const cutoff = Date.UTC(
      today.getFullYear() - CLINICAL_WINDOW_YEARS,
      today.getMonth(),
      today.getDate()
    );
    return shapedCandidates("dob", DATE_IN_TEXT, text).filter((iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      return Date.UTC(y, m - 1, d) <= cutoff;
    });
  }

  // ------------------------------------------------------------------- entry

  /**
   * The whole pasted block -> a draft record.
   *
   * Never throws on content: an unparseable paste is an empty result, which
   * the doctor fills in by hand exactly as they do today. It DOES throw when
   * the shapes have not been loaded, because a parser that quietly finds
   * nothing is indistinguishable from a note that mentioned nothing — and the
   * result of this call is the dictionary the note is redacted against.
   */
  function parseDemographics(text, knownName = "") {
    if (!ready()) throw new Error("Identifier patterns are not loaded.");
    const source = String(text || "");
    const values = {};
    const sources = {};
    const choices = {};

    const record = (field, value, origin) => {
      if (!(field in values) && value) {
        values[field] = value;
        sources[field] = origin;
      }
    };
    const offer = (field, candidates, minimum = 2) => {
      if (!(field in choices) && candidates.length >= minimum) choices[field] = candidates;
    };

    for (const line of logicalLines(source)) {
      const match = LABELLED_LINE.exec(line);
      if (!match) continue;
      const field = LABEL_LOOKUP.get(normaliseLabel(match[1]));
      if (!field) continue;
      const value = match[2].trim();

      if (field === "full_name") {
        for (const [name, [parsed, origin]] of Object.entries(parsePatientLine(value, knownName))) {
          record(name, parsed, origin);
        }
        continue;
      }
      if (field === "dob") {
        const iso = parseDate(value);
        if (iso) record("dob", iso, "labelled");
        continue;
      }
      if (field === "nric") {
        const cleaned = value.replace(/\s/g, "").toUpperCase();
        if (fullMatch(NRIC_PATTERN, cleaned)) record("nric", cleaned, "labelled");
        continue;
      }
      if (field === "insurer") {
        record("insurer", canonicalInsurer(value) || value, "labelled");
        continue;
      }
      record(field, value, "labelled");
    }

    for (const line of logicalLines(source)) {
      const header = headerPieces(line, knownName);
      if (header === null) continue;
      const [fields, names] = header;
      for (const [field, value] of Object.entries(fields)) record(field, value, "header-line");
      if (names.length === 1) record("full_name", names[0], "header-line");
    }

    for (const block of blocks(source)) {
      if (block.length < 2) continue;
      const header = headerBlock(block, knownName);
      if (header === null) continue;
      const [fields, names] = header;
      for (const [field, value] of Object.entries(fields)) record(field, value, "header-block");
      if (names.length === 1) record("full_name", names[0], "header-block");
    }

    for (const line of logicalLines(source)) {
      const [lineFound, lineChoices] = labelledAnywhere(line);
      for (const [field, value] of Object.entries(lineFound)) record(field, value, "labelled-inline");
      for (const [field, candidates] of Object.entries(lineChoices)) offer(field, candidates);
    }

    for (const [field, pattern] of [
      ["nric", NRIC_PATTERN],
      ["phone", PHONE_IN_TEXT],
      ["insurer", INSURER_PATTERN],
    ]) {
      if (field in values) continue;
      const candidates = shapedCandidates(field, pattern, withoutOtherOwners(pattern, source));
      if (candidates.length === 1) record(field, candidates[0], "sole-match");
      else offer(field, candidates);
    }

    if (!("dob" in values)) offer("dob", birthDateCandidates(source), 1);

    if (!("address" in values)) {
      const candidates = addressLines(source);
      if (candidates.length === 1) record("address", candidates[0], "sole-match");
      else offer("address", candidates);
    }

    for (const field of Object.keys(choices)) {
      if (field in values) delete choices[field];
    }

    return {
      full_name: values.full_name || null,
      nric: values.nric || null,
      dob: values.dob || null,
      phone: values.phone || null,
      address: values.address || null,
      policy_number: values.policy_number || null,
      insurer: values.insurer || null,
      sources,
      choices,
    };
  }

  globalThis.breezefillParse = {
    usePatterns,
    ready,
    parseDemographics,
    parseDate,
    canonicalInsurer,
  };
})();
