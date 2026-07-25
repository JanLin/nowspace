# Test vault fixture

A tiny Obsidian-style vault for the loopback e2e loop, so the backend has realistic data
without touching your real vault.

Seeds (matches what `dnd.spec.ts` expects):
- **Monday:** 3 ungrouped tasks (one linked) + an `iGrant` group with 2 tasks (one linked) →
  covers within-day reorder, group-integrity, and link cases.
- **Tuesday:** 1 task → cross-day move has a destination with known count.
- **Bucket:** grouped tasks incl. ones with `[[links]]` → Bucket→Plan + link preservation.
- Empty Wed–Sun.

## Point the backend at this fixture (do NOT use your real vault)

In a throwaway `config.yaml` (or via env), set the vault path to this folder, then run:

```bash
uvicorn backend.main:app --reload --port 8000
```

Carry-forward tasks come from the *previous* week, so if the carry-forward test needs data,
also seed a `Plan Week.md` for wk24 with an unfinished task, or relax that test.
