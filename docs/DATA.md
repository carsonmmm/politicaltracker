# Shared data format

## ResultRecord (results feeds, research file, manual entries)

```jsonc
{
  "raceId": "S-GA",            // S-XX Senate, G-XX Governor, H-XX-NN House (H-XX-00 = at-large)
  "source": "Georgia Secretary of State",
  "source_url": "https://...",
  "fetched_at": "2026-11-03T23:10:00Z",
  "kind": "unofficial",         // or "certified"
  "status": "counting",         // not_reporting | counting | too_early | too_close | called | recount | runoff
  "pctExpected": 42,            // share of expected vote counted, as estimated by the source; null if not given
  "call": null,                 // or { "winner": "Name", "party": "D", "calledBy": "AP", "calledAt": "...", "source_url": "..." }
  "candidates": [ { "name": "Name", "party": "D", "votes": 123456, "incumbent": false } ],
  "counties": [ { "fips": "13121", "name": "Fulton", "pctExpected": 50, "candidates": [ { "name": "Name", "party": "D", "votes": 1 } ] } ],
  "rcvRounds": [ { "round": 1, "candidates": [ { "name": "Name", "votes": 1 } ] } ],
  "outstanding_note": "Mail ballots from X County are counted Thursday (per county clerk)."
}
```

Rules enforced on load and in the admin API:

* `source`, `source_url` and `fetched_at` are required.
* `status: "called"` needs `call.calledBy`, naming an outlet (AP, Decision Desk HQ, or a network decision desk). Being ahead is never a call.
* Unknown statuses are rejected. Bad entries are skipped and listed on the Sources page.

## OddsRecord (market adapters)

```jsonc
{
  "raceId": "S-GA",             // or CONTROL-S / CONTROL-H
  "source": "Kalshi",           // or "Polymarket"
  "market_id": "SENATEGA-26",
  "title": "…", "source_url": "https://kalshi.com/markets/…", "fetched_at": "…",
  "volume": 2100000, "volume_unit": "contracts",   // Polymarket: "USD"
  "outcomes": [ { "label": "Democratic party", "party": "D", "price": 0.52, "volume": 1200000, "market_id": "SENATEGA-26-D" } ]
}
```

`price` is the market-implied chance (0–1): the bid/ask midpoint when the spread is 10¢ or less, otherwise the last trade.

## Candidate profiles (`data/candidates-research.json`)

Every candidate is shown with the same template. A field that nobody has researched shows "Not yet researched". "No stated position found" appears only when an entry says someone looked.

```jsonc
{
  "entries": [{
    "raceId": "S-GA", "name": "Full Name", "party": "D", "incumbent": false,
    "fec_id": "S6GA00123",                 // optional: overrides FEC name matching
    "researched_at": "2026-11-02",
    "bio": { "birth_date": "1980-05-01", "hometown": "…", "education": ["…"], "career": ["…"], "source_url": "https://…" },
    "offices":   [{ "title": "…", "from": "2019", "to": "2023", "source_url": "https://…" }],
    "elections": [{ "year": 2020, "office": "U.S. Senate", "result": "Won", "pct": 50.6, "source_url": "https://…" }],
    "roles":     [{ "title": "Armed Services Committee", "source_url": "https://…" }],
    "endorsements": [{ "name": "…", "type": "Union", "date": "2026-09-01", "source_url": "https://…" }],
    "positions": {
      // keys: economy, health, immigration, abortion, energy, guns, education, foreign, crime, democracy
      "economy": { "summary": "Neutral summary of the candidate's own statement.", "source_url": "https://candidate-site/…", "date": "2026-08-01" },
      "guns": { "none": true, "checked_at": "2026-11-01" }
    }
  }],
  "moments": [{ "raceId": "S-GA", "date": "2026-10-16", "type": "debate", "text": "…", "source_url": "https://…" }]
}
```

`type` is one of `debate`, `ad`, `endorsement`, `controversy`, `event` or `other`. Every moment needs a `source_url`, criticism included. Entries that fail validation are skipped and listed on the Sources page. Admin edits override the research file field by field.

## Campaign finance (OpenFEC)

Fetched for Tier 1 Senate and House races and refreshed when a race's data is a day old. Stored in `data/runtime/finance.json`.

| Shown | FEC field |
|---|---|
| Total raised / spent / cash on hand | `receipts`, `disbursements`, `last_cash_on_hand_end_period` |
| Burn rate | disbursements ÷ receipts (computed) |
| Small donors (under $200) | `individual_unitemized_contributions` |
| Large individual donors | `individual_itemized_contributions` |
| PACs / party committees | `other_political_committee_contributions` / `political_party_committee_contributions` |
| Self-funding | `candidate_contribution` + `loans_made_by_candidate` |
| In-state vs. out-of-state | Schedule A by state (itemized only) |
| Outside spending | Schedule E by candidate, support/oppose |
| Fundraising over time | committee reports, latest filing per period |

Without `FEC_API_KEY` only race summaries are fetched, because `DEMO_KEY` allows very few requests per hour. No score or grade is computed.
