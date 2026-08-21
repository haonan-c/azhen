# Preserve Charge Snapshots and reverse ledger errors

Each Usage Record keeps the Charge Snapshot that applied when its Metered Use began, and every
Usage Charge remains an append-only Credit Ledger Entry. Provider rates come from the released
model catalog rather than live documentation scraping, while administrator rate changes affect only
later use; mistakes are corrected with linked Credit Reversals instead of changing or deleting
history. This keeps past charges reproducible even when provider rates, deployment multipliers, or
Credit Conversion Rates change.
