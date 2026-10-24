# Algorithm — Source List

**Last verified:** 30 August 2026
**Coverage:** ~115 publications across 7 categories and 6 continents.

> The authoritative copy is `sources.md` in the repo — that is the file the
> workflow actually reads. This is the annotated mirror.

## Rules

1. **English only.** The piece must be published in English by the outlet itself. Never translate. A non-English publication with a genuine English edition qualifies; an English homepage wrapping local-language articles does not.
2. **Every entry below was confirmed active** by fetching the site and seeing a 2026-dated piece. Entries marked `UNVERIFIED` are promising leads that blocked automated fetching — do not cite them without a manual check.
3. **This list is the spine, not a cage.** Check these feeds first — they guarantee quality and spread. But if an exceptional piece surfaces elsewhere, it can be used, subject to the verification discipline below.
4. **Rotate.** (Added 30 Aug 2026.) A publication may hold a category in at most **2 of any 4 consecutive issues**. Enforced by `scripts/validate.js`; `scripts/recent-sources.js` hands the composing prompt the list of outlets to rest. This rule exists because issues 1-3 drew 4 of 6 menswear slots from Highsnobiety and 2 of 6 music slots from Bandcamp Daily while every existing rule passed — nothing in the system could see the previous issue.
5. **Aim for regional balance within each issue**, not within each category. Some categories are structurally Western-heavy (design, menswear); others are strong in the Global South (music, literary). Balance across the whole issue.

## Verification discipline — non-negotiable

- **Fetch every article before writing about it.** The 25 Aug draft contained a summary written from a headline alone. That must never recur.
- **Every hyperlink must come from an actual fetch or search result.** Never construct a URL from a site's naming pattern.
- **Dedupe against `assets/search-index.json`**, which holds every previously-featured piece.
- Feeds marked **FILTER** mix criticism with commercial content — never ingest wholesale.

---

## 1. Fine Art

**Americas** — Hyperallergic (US) · e-flux Criticism (US/DE, e-flux.com/criticism) · Artforum (US, PAYWALLED) · Momus (CA, momus.ca) · Border Crossings (CA) · Artishock (CL, artishockrevista.com/category/english/ — English category only)

**UK & Europe** — ArtReview (UK) · Burlington Contemporary (UK) · Frieze (UK) · Studio International (UK) · Flash Art International (IT, flash---art.com/category/reviews) · Mousse (IT) · Spike (AT/DE) · Kunstkritikk (Nordic, English-primary)

**Africa, Asia, Oceania** — ART AFRICA (ZA) · Contemporary And (Africa/diaspora) · Bidoun (SWANA) · ArtAsiaPacific (HK, /shows) · TAKE on Art (IN) · Ocula (SG/HK, FILTER — gallery-platform model) · Artlink (AU)

*Rejected: Randian (dormant since 2022), ARC Magazine (domain hijacked), Artalk.cz (Czech-only), BLOK (stalled 2024), Terremoto (long-form archive ended 2022), C& América Latina (Spanish-first).*

## 2. Film Criticism

**Americas** — Reverse Shot (US) · Film Comment (US) · Film Quarterly (US, PAYWALLED) · Philosophy in Film (US) · POV Magazine (CA) · desistfilm (PE, /eng) · Cinema Scope (CA) `UNVERIFIED` — JS-gated, no issue past Winter 2024 found; worth a manual check

**UK & Europe** — Sight and Sound (UK, BFI) · Little White Lies (UK) · Another Gaze (UK) · Sabzian (BE — trilingual, confirm each piece has an EN version) · Cineuropa (pan-EU, skews capsule-length) · East European Film Bulletin (CEE, eefb.org)

**Africa, Asia, Oceania** — Senses of Cinema (AU) · MUBI Notebook (intl) · Silhouette (IN) · Afrocritik (NG) · Egyptian Streets (EG, FILTER) · Rough Cut (AU)

*Rejected: Asian Movie Pulse (star ratings), Cinema Poetica (stale 2024), Pantograph Punch (stale 2023).*

## 3. Tech & AI

**Americas** — Noema (US) · The Baffler (US) · 404 Media (US, FILTER — mostly investigative) · The Walrus (CA) · Rest of World (Global South focus) · LatamList (LatAm) `CAUTION` — flagged on review as closer to a funding wire than analysis; use sparingly

**UK & Europe** — New Statesman (UK) · Prospect (UK) · Berlin Review (DE, blnreview.de/en — parallel English edition)

**Africa, Asia, Oceania** — East Asia Forum (AU/Asia) · IT-Online (ZA) · MediaNama (IN) · TechCabal (NG) · AGBI (Gulf) · e27 (SG, anti-bot measures) · The Mandarin (AU)

⚠️ **This category attracts the worst SEO spam** ("best AI tools 2026"). Never accept a generic search result here.

*Rejected: Wamda, Contxto, KrASIA, Tech in Asia (all deal-flow wires), Nikkei Asia (paywalled).*

## 4. Literary Reviews (SFF-leaning)

**Americas** — Los Angeles Review of Books (US) · Bookforum (US) · n+1 (US) · Locus (US) · Strange Horizons (US) · Ancillary Review of Books (US, SFF) · Literary Review of Canada (CA) · Latin American Literature Today (bilingual, genuine EN) · PREE (JM/Caribbean) · sx salon (Caribbean) · Brick (CA) `UNVERIFIED`

**UK & Europe** — SFBook.com (UK) · London Review of Books (UK, PAYWALLED) · Dublin Review of Books (IE) · Vector/BSFA (UK, membership-gated) · Eurozine (pan-EU) · European Review of Books (pan-EU) · B O D Y (CZ) · Literalab (CEE)

**Africa, Asia, Oceania** — Brittle Paper (NG) · Afrocritik books (NG) · ArabLit (EG, reviews written in English) · Aotearoa NZ Review of Books (NZ, tags SF/speculative) · Kete Books (NZ)

*Rejected: Mithila Review (dead 2022), Kitaab (stale 2020), Johannesburg Review of Books (nothing 2026), Caribbean Review of Books (defunct ~2013), Moko (domain lapsed).*

**Remaining gap:** South/Southeast Asia. Next candidates: Usawa Literary Review, The Bangalore Review, Cha (HK).

⚠️ Strange Horizons took 3 of the first 6 lit slots. Same pattern as menswear; the rotation rule now catches it.

## 5. Music Criticism

**Americas** — Aquarium Drunkard (US) · Bandcamp Daily (US, FILTER — **the easiest music result to find, which is why it took 2 of the first 6 slots; reach past it before using it**) · Musicworks (CA, experimental/sound art) · Sounds and Colours (LatAm focus, English) · Pitchfork (US) `UNVERIFIED` — blocked fetch · Exclaim! (CA) `UNVERIFIED`

**UK & Europe** — The Quietus (UK) · The Wire (UK) · The Skinny (UK) · VAN Magazine (DE, classical, English-native) · 032c (DE, profile/criticism hybrid)

**Africa, Asia, Oceania** — Music In Africa (ZA) · The NATIVE (NG) · Unorthodox Reviews (GH) · SceneNoise (EG) · Rolling Stone MENA (AE) · Rolling Stone India (IN) · The AU Review (AU) · Elsewhere (NZ)

*Rejected: Bandwagon (reviews page dead), IZM (Korean-only), Groove (German-only), Electronic Beats (defunct).*

**Note:** the music pool was always wide enough — 19 outlets. Bandcamp Daily's recurrence was a rotation failure, not a shortage, so no sources were added here.

## 6. Design

**Americas** — Places Journal (US) · Metropolis (US) · Azure (CA) · Canadian Architect (CA)

**UK & Europe** — Design Week (UK) · The Architectural Review (UK, /essays) · Dezeen Opinion (UK, opinion vertical only) · Disegno (UK) · Eye Magazine (UK) · Domus (IT, domusweb.it/en/opinion.html) · 032c (DE) · Norwegian Crafts / The Vessel (NO, craft-theory leaning)

**Asia, Oceania** — STIRworld (IN, /think-opinions) · ArchitectureAU Discussion (AU) · thinkMATTER (IN, CAVEAT — uneven, spot-check)

*Confirmed empty rather than unsearched: identity.ae and Middle East Architect have no opinion vertical. Cobo Social and Design Anthology publish listicles. Design Indaba (ZA) shows no 2026 activity. WhiteMAD (PL) is news/showcase. No Latin American English-language design criticism outlet found — FOCUS Latin America stalled July 2024.*

## 7. Men's Fashion ⚠️ STRUCTURALLY THIN

**Verified (original six)** — Permanent Style (UK) · Blackbird Spyplane (US) · Highsnobiety (DE, FILTER — hybrid essay/shopping) · 032c (DE, literary/philosophical framing) · Open Magazine (IN, openthemagazine.com/art-culture, FILTER — fashion appears irregularly) · Esquire India (IN, FILTER — ~70-80% shopping content)

**Added 30 August 2026**, after the section drew 4 of its first 6 slots from Highsnobiety and the other 2 from Blackbird Spyplane. Each was fetched and confirmed carrying 2026-dated criticism:

- **Vestoj** (vestoj.com) — fashion theory and long-form criticism, zero commercial content. The strongest addition. Publishes roughly monthly, so treat it as a quality reserve rather than a weekly feed. Confirmed: pieces dated 14 Aug, 2 Aug, 14 Jul 2026.
- **SSENSE Editorial** (CA, ssense.com/en-us/editorial, FILTER) — a retailer's editorial arm, but the writing is genuine cultural criticism and it publishes weekly. Skip anything that reads as product placement. Confirmed active 27 Aug 2026.
- **Diary of a Wimpy Critic** (Ashley Ogawa Clarke, Substack, FILTER) — sharp menswear criticism written from Tokyo, and one of the very few non-Western-based voices in the field publishing in English. Mixes in shopping guides ("Where to Shop for Clothes in Kyoto"); skip those. Confirmed active 6 Aug 2026.
- **Dazed Fashion** (UK, dazeddigital.com/fashion, FILTER) — mostly trend coverage, but carries real critical features. Never take a piece unchecked. Confirmed active 2026.

*Checked and not added: The Bengal Stripe (Substack) — increasingly commercial, giveaways and brand spotlights, last post 8 Jun 2026. 1 Granary and Document Journal fashion verticals both 404'd on the expected paths.*

**Leads blocked by technology, not quality — worth a manual browser check:**
- **Die Workwear** (US, Derek Guy) — consistently blocks automated fetching. Almost certainly the best menswear criticism in English.
- **Business of Fashion** — menswear opinion strand. Returns 403; needs subscription login.
- **Bubblegum Club** (ZA) — bubblegumclub.co.za/fashion — real cultural/philosophical fashion criticism; JS-gated. Best African lead.

**Honest finding, confirmed across three research passes:** dedicated menswear-criticism outlets barely exist anywhere. What exists sits inside general-culture magazines or industry-analysis outlets rather than dedicated verticals. East Asia has strong tailoring *culture* but almost no local English-language *criticism*. Expect to lean on filtered general-culture feeds here. Ten usable outlets is what makes the rotation rule survivable in this category — it would have failed the build over six.

---

## Known limitations

1. **The Pulse was retired on 30 August 2026.** It never had a real data source — live social platform trends aren't reachable from the research tools — so it was inference presented as observation. Removed from the prompt, the builder, the validator and the archive.
2. **Design and Men's Fashion are Western-weighted** after three passes, mitigated but not solved by the 30 Aug additions. This reflects the media landscape, not a search failure.
3. **Never source from generic web search alone.** The first attempt did, and produced two articles duplicated from the sample template plus one fabricated summary.
