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
