# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Singapore private-practice GPs who fill insurer claim forms (portal and PDF)
between patients. Where a practice has staff, the doctor often delegates the
form-filling to them, so the person at the keyboard may be a clinic assistant
working from the doctor's notes. The doctor decides, pays, and signs.

## Product Purpose

BreezeFill turns a consultation note into a filled insurance claim form. It
proposes an answer for every question on the form, shows each answer beside the
sentence it came from, and leaves the doctor to confirm, correct and submit.
Success is a claim the doctor can sign without retyping the clinical story, with
no wrong answer slipped in.

## Positioning

Precision over coverage. A wrong autofill is worse than an empty field: the
product leaves a field blank rather than guess, never submits, never overwrites
an existing answer, and never keeps anything about a patient. The patient's
identifiers are redacted in the doctor's browser before the note is sent (the
Chrome extension path). The model that answers the form never sees them. Do not
claim that identifiers never reach the Claude API: the third redaction pass is
itself a Claude call.

## Operating Context

Two ways a claim arrives, and the work is a mix: an insurer web portal (filled
through the Chrome side-panel extension) and a PDF the insurer emailed (filled at
`breezefill.com/#/app`, then printed and signed). Doctors work in short gaps
between consultations, so speed matters as much as correctness.

## Capabilities and Constraints

- Chrome MV3 extension + FastAPI backend + this React/Vite website.
- Price: SGD 200/month, one user per subscription. The seat limit is a licence
  term; it is **not enforced** yet. Enforcing it would need per-subscription
  server state, which is an open decision for the owner.
- The landing page's primary action goes to the `#/get` funnel (subscribe →
  licence key → install). The store listing currently serves an outdated build,
  so `#/get` hands out a direct download until the new version is approved.
- The landing page is static: no API calls, so it renders while the backend is
  asleep.

## Brand Commitments

- Name: BreezeFill (formerly FormFill, ClaimFill: neither may appear).
- Logo: white wind-stroke mark on a sky-blue gradient tile (`#3aa0dc` family),
  `assets/logo/source-master.svg`. The owner asked that the site follow the
  logo's colours.
- Voice: plain, exact and honest about limits. Copy must never promise
  fully-automatic form filling.

## Evidence on Hand

None public yet. No testimonials, quotes, usage numbers, customer logos or demo
video may appear, and none may be invented. The page proves itself with the
product: the mechanism, an interactive demo built on synthetic data, and the
privacy model.

## Product Principles

1. A blank field costs seconds; a wrong one gets signed. Design for trust in
   every answer, not fill rate.
2. The doctor stays in control: review before write, never submit.
3. Patient data is never kept, and that promise is stated exactly, never
   overstated.
4. Fit the gaps between patients. Every step has to be fast.
