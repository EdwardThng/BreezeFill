/**
 * Redaction, in the browser.
 *
 * This is the module that makes the product's central claim literally true.
 * The patient's name, NRIC, date of birth, phone, address and policy number
 * are removed from the note HERE, in the tab the doctor is looking at, before
 * anything is sent anywhere. The backend receives text that already reads
 * `[PATIENT] presents with…`, and the map from token back to real value never
 * leaves this panel.
 *
 * It is a port of backend/redaction.py passes 1 and 2, and the port is the
 * risk. Two implementations of one rule drift, and a rule fixed in Python and
 * not here is a leak that every Python test still passes. Three things hold
 * them together, and none of them is discipline:
 *
 *   1. The pattern shapes are not written here. They come from
 *      privacy/patterns.json, which backend/redaction.py loads too.
 *   2. tests/fixtures/redaction_corpus.json is run against BOTH — the same
 *      notes, the same assertion that no identifier survives.
 *   3. The server redacts again, on text this module has already redacted. A
 *      miss here is caught there before the model sees it. That backstop is
 *      not a reason to be careless; it is the difference between a bug and a
 *      disclosure.
 *
 * FAIL CLOSED. Every entry point either returns fully redacted text or throws.
 * There is no path that returns the original note, and no default value that
 * could be mistaken for one. A caller that swallows the throw sends nothing,
 * which is the correct outcome: a claim not filled costs the doctor minutes,
 * and a name sent to a model cannot be recalled.
 */

(function () {
  "use strict";

  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  /**
   * The shared shapes, once loaded. Null until then — and null is refused
   * rather than treated as "no patterns to apply", which is the shape this
   * whole module's worst bug would take.
   */
  let spec = null;

  /**
   * Spans the passes must not touch: institution names, whose words are also
   * somebody's surname. Held aside before pass 1 and put back after, so a
   * patient surnamed Tan does not turn Tan Tock Seng Hospital into
   * "[PATIENT] Tock Seng Hospital" and cost the claim the field asking which
   * hospital. Shared with the server for the same reason the patterns are.
   */
  let shields = [];
  const SHIELD = (i) => `\u0000INST${i}\u0000`;

  /**
   * Read privacy/patterns.json out of the packaged extension.
   *
   * Packaged, not fetched from the network: a redaction rule arriving over the
   * wire is a redaction rule an attacker can replace with one that matches
   * nothing. The file ships inside the extension and is only replaced when
   * Chrome updates it.
   */
  async function loadPatterns(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`patterns.json: HTTP ${response.status}`);
    const parsed = await response.json();
    return usePatterns(parsed);
  }

  /** Install an already-parsed spec. Separated so tests can read the file. */
  function usePatterns(parsed) {
    if (!parsed || !Array.isArray(parsed.patterns) || !parsed.patterns.length) {
      throw new Error("patterns.json has no patterns");
    }
    shields = (parsed.shields || []).map(
      (entry) => new RegExp(entry.regex, entry.ignore_case ? "gi" : "g")
    );
    spec = parsed.patterns.map((entry) => ({
      field: entry.field,
      token: entry.token,
      start: entry.start,
      // Global, because every occurrence is replaced. Ignore-case comes from
      // the file so the two languages cannot disagree about it.
      regex: new RegExp(entry.regex, entry.ignore_case ? "gi" : "g"),
    }));
    return spec.length;
  }

  function ready() {
    return spec !== null;
  }

  // -------------------------------------------------------------------------
  // Pass 1 — the identifiers the doctor typed
  // -------------------------------------------------------------------------

  const escapeRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /** An exact value, tolerant of the line breaks a pasted note puts in it. */
  function flexibleExact(value) {
    const parts = value.trim().split(/\s+/).map(escapeRe);
    return `\\b${parts.join("\\s+")}\\b`;
  }

  /**
   * The registered name, and the pieces of it.
   *
   * Whole name first, then the reversal a form asks for, then each part on its
   * own — because "Chua Beng Huat" in the header is "Mr Chua" three lines
   * later, and a rule that only matched the whole thing would leave the
   * surname in the text.
   *
   * Parts under three characters match case-sensitively. A patient surnamed
   * "He" would otherwise take every pronoun in the note with them, and a note
   * that reads "[PATIENT] reports [PATIENT] felt unwell" is a note the model
   * cannot answer questions about.
   */
  function nameRegexes(fullName) {
    const parts = fullName.trim().split(/\s+/).filter(Boolean);
    const out = [{ source: flexibleExact(fullName), caseSensitive: false }];
    if (parts.length > 1) {
      const reversed = parts.slice(1).concat(parts.slice(0, 1)).join(" ");
      out.push({ source: flexibleExact(reversed), caseSensitive: false });
    }
    for (const part of parts) {
      out.push({
        source: `\\b${escapeRe(part)}\\b`,
        caseSensitive: part.length < 3,
      });
    }
    return out;
  }

  /** Every rendering of a date of birth a Singapore note actually uses. */
  function dobRegexes(iso) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso).trim());
    if (!match) return [];
    const [, y, mm, dd] = match;
    const d = Number(dd);
    const m = Number(mm);
    const mon = MONTHS[m - 1];
    if (!mon) return [];
    const pad = (n) => String(n).padStart(2, "0");
    const variants = new Set([
      `${pad(d)}/${pad(m)}/${y}`, `${d}/${m}/${y}`, `${pad(d)}/${pad(m)}/${y.slice(2)}`,
      `${pad(d)}-${pad(m)}-${y}`, `${d}-${m}-${y}`,
      `${pad(d)}.${pad(m)}.${y}`, `${d}.${m}.${y}`,
      `${y}-${pad(m)}-${pad(d)}`,
      `${d} ${mon.slice(0, 3)} ${y}`, `${pad(d)} ${mon.slice(0, 3)} ${y}`,
      `${d} ${mon} ${y}`, `${pad(d)} ${mon} ${y}`,
    ]);
    // Longest first: "14 March 1978" must be taken before "14 Mar 1978" can
    // match its opening and leave "ch 1978" behind.
    return [...variants]
      .sort((a, b) => b.length - a.length)
      .map((v) => `\\b${escapeRe(v)}\\b`);
  }

  /** The patient's own NRIC, however many stray spaces it was typed with. */
  function nricRegex(nric) {
    const chars = nric.replace(/\s/g, "").split("").map(escapeRe);
    return `\\b${chars.join("\\s?")}\\b`;
  }

  /** The patient's own phone, through any separator and a +65 prefix. */
  function phoneRegex(phone) {
    let digits = phone.replace(/\D/g, "");
    if (digits.length === 10 && digits.startsWith("65")) digits = digits.slice(2);
    if (!digits) return null;
    const body = digits.split("").map(escapeRe).join("[ -]?");
    return `(?<!\\d)(?:\\+65[ -]?)?${body}(?!\\d)`;
  }

  function apply(text, source, token, caseSensitive) {
    return text.replace(new RegExp(source, caseSensitive ? "g" : "gi"), token);
  }

  /** Take the shielded spans out, remembering them in order. */
  function shieldSpans(text) {
    const held = [];
    let out = text;
    for (const regex of shields) {
      out = out.replace(regex, (span) => {
        held.push(span);
        return SHIELD(held.length - 1);
      });
    }
    return { text: out, held };
  }

  function restoreSpans(text, held) {
    let out = text;
    for (let i = 0; i < held.length; i += 1) out = out.split(SHIELD(i)).join(held[i]);
    return out;
  }

  // -------------------------------------------------------------------------
  // The entry point
  // -------------------------------------------------------------------------

  /**
   * One note plus what the doctor said about the patient, in; redacted text
   * and the token map, out.
   *
   * `record` is the demographics as the panel holds them. `full_name` and
   * `dob` are required and the absence of either throws, because they are the
   * two identifiers no pattern can find: a name has no shape, and every date
   * in a clinical note looks like every other date. Running without them
   * would produce text that looks redacted and is not.
   */
  function redact(record, text) {
    if (!ready()) throw new Error("Redaction patterns are not loaded.");
    if (typeof text !== "string") throw new Error("Nothing to redact.");
    const fullName = (record && record.full_name ? record.full_name : "").trim();
    const dob = (record && record.dob ? record.dob : "").trim();
    if (!fullName) throw new Error("The patient's name is needed before the note can be redacted.");
    if (!dob) throw new Error("The patient's date of birth is needed before the note can be redacted.");

    const map = Object.create(null);
    // Institutions go behind the shield before anything else runs, and come
    // back at the very end — including after pass 2, so a hospital's name
    // cannot be tokenised by a pattern either.
    const shielded = shieldSpans(text);
    let out = shielded.text;

    const [, , yearMonthDay] = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob) || [];
    const canonicalDob = yearMonthDay
      ? `${dob.slice(8, 10)}/${dob.slice(5, 7)}/${dob.slice(0, 4)}`
      : dob;

    map["[PATIENT]"] = fullName;
    map["[DOB]"] = canonicalDob;

    // Most specific first. An NRIC sitting inside an address line has to be
    // tokenised before the address pattern swallows the whole line.
    const nric = (record.nric || "").trim();
    if (nric) {
      map["[NRIC]"] = nric.replace(/\s/g, "").toUpperCase();
      out = apply(out, nricRegex(nric), "[NRIC]", false);
    }
    const phone = (record.phone || "").trim();
    if (phone) {
      const source = phoneRegex(phone);
      if (source) {
        map["[PHONE]"] = phone;
        out = apply(out, source, "[PHONE]", false);
      }
    }
    const policy = (record.policy_number || "").trim();
    if (policy) {
      map["[POLICY_NO]"] = policy;
      out = apply(out, flexibleExact(policy), "[POLICY_NO]", false);
    }
    for (const source of dobRegexes(dob)) {
      out = apply(out, source, "[DOB]", false);
    }
    const address = (record.address || "").trim();
    if (address) {
      map["[ADDRESS]"] = address;
      out = apply(out, flexibleExact(address), "[ADDRESS]", false);
    }
    for (const { source, caseSensitive } of nameRegexes(fullName)) {
      out = apply(out, source, "[PATIENT]", caseSensitive);
    }

    // "Chua Beng Huat" matched part by part leaves three tokens in a row.
    out = out.replace(/\[PATIENT\](?:\s+\[PATIENT\])+/g, "[PATIENT]");

    // Pass 2: identifiers nobody typed — a husband's NRIC, a referring
    // clinic's number. Numbered from the shared file so the server's tokens
    // and these agree.
    for (const entry of spec) {
      const seen = new Map();
      let counter = entry.start;
      out = out.replace(entry.regex, (value) => {
        if (!seen.has(value)) {
          const token = `[${entry.token}_${counter}]`;
          counter += 1;
          seen.set(value, token);
          map[token] = value;
        }
        return seen.get(value);
      });
    }

    out = restoreSpans(out, shielded.held);
    return { redacted_text: out, redaction_map: map };
  }

  /**
   * Put the real values back, in the panel, after the model has answered.
   *
   * The server never does this and never can: it was not given the map. An
   * answer comes back reading "[PATIENT] was admitted on [DOB]" and becomes
   * the patient's name and date here, one step before it is shown for review.
   *
   * A token with no entry is left exactly as it is rather than blanked. It
   * means the model invented one, and showing `[NRIC_7]` in the review screen
   * is a doctor noticing something is wrong; showing an empty box is a doctor
   * filling it in by hand and never knowing.
   */
  function remerge(text, map) {
    if (typeof text !== "string") return text;
    return text.replace(/\[[A-Z][A-Z0-9_]*\]/g, (token) =>
      Object.prototype.hasOwnProperty.call(map, token) ? map[token] : token
    );
  }

  globalThis.breezefillRedact = {
    loadPatterns,
    usePatterns,
    ready,
    redact,
    remerge,
    // Exported for the tests that check the two languages agree.
    nameRegexes,
    dobRegexes,
  };
})();
