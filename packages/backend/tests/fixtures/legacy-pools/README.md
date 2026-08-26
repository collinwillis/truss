# Legacy pool files — matcher calibration data

Verbatim copies of the four JSON files the MCP Estimator shipped, taken from
`mcp_estimator/src/data/{v1,v2}/`. They are here as **test fixtures, not as a data source** —
nothing in the application reads them.

They exist because they contain the real corruption the rate-book matcher was built to prevent, and
a matcher calibrated on synthetic data proves nothing. Measured across the one real version bump
these files represent:

**`labor_v1.json` → `labor_v2.json`** (5,897 → 5,968 rows) 1,064 rows carry their payload at a
different id than in v1, in three contiguous bands:

| v2 ids      | offset | rows |
| ----------- | ------ | ---- |
| 4725 – 5430 | −4     | 706  |
| 5431 – 5442 | −455   | 12   |
| 5443 – 5788 | +8     | 346  |

A further 206 rows match nothing at any offset. Ids 1–4724 are correctly aligned, which is why the
problem went unnoticed: the catalog looks fine until you reach the specialty items.

**`equipment_v1.json` → `equipment_v2.json`** (129 → 133 rows) Only **3 of 129** descriptions
survive at their own id. 60 rows carry the previous row's description verbatim. Exhibit A: v2 id 6
`BREAKERS - AIR 30 LBS` carries v1 id 5's rates of 7/56/224/672 — shifted _and_ renamed in the same
pass, so no description-comparison test can catch it. Note also that ids 129–132 look like additions
when you diff id sets, but v2 id 132 `MISC - DUMPSTER SERVICE` is byte-identical to v1 id 128: it
was renumbered, not added.

**The cause was positional ids.** The ids were row numbers in a spreadsheet, so inserting a row
re-pointed every id below it at a different item — while estimates stored those ids. Nothing ever
detected it, because an id pointing at the wrong item still resolves.

Neither v2 file was ever adopted: all 736 live proposals are on v1 and labor v2 was never loaded
into Convex at all. So no estimate was ever mispriced by this. It is a loaded gun that did not go
off, kept here so the same shape of mistake cannot be made again silently.

See `packages/backend/tests/rateBookMatch.test.ts`.
