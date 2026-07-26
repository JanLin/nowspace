"""Handoff surface API — dispatch records, conformance, lanes, return path.

Enforced invariants (handoff brief §4):
1. Paths, never content: records carry vault-relative paths only.
2. `captured` items cannot be dispatched, by any route.
3. `rehearse` items cannot be dispatched at all.
4. Conformance failures cannot be overridden.
5. In-flight dispatches are WIP-limited (default 3, configurable).
6. Agent output enters the funnel as `captured` — never ready, never binding,
   never modifying an existing item.
7. Dispatch never mutates the source item.
8. Transcripts and records live inside the area.
9. The Returned lane is emptyable.
"""

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import handoff
from backend.config import config
from backend.models import BucketTask
from backend.routers import plan as plan_router

router = APIRouter(prefix="/api/handoff", tags=["handoff"])


class AreaUpdate(BaseModel):
    areas: List[dict]


class DispatchCreate(BaseModel):
    source_text: str            # the bucket item's text (identity key)
    area: str
    attached_notes: List[str] = []
    expected_artifact: str


class DispatchUpdate(BaseModel):
    state: Optional[str] = None
    exchange_count: Optional[int] = None
    transcript_path: Optional[str] = None


class ReturnResolve(BaseModel):
    area: str
    path: str
    action: str                      # "discard" | "capture"
    capture_texts: List[str] = []    # for capture: the items to create


def _find_source_item(source_text: str) -> Optional[BucketTask]:
    bucket = plan_router._bucket_path()
    if not bucket.exists():
        return None
    tasks, _ = plan_router._parse_bucket_file(bucket.read_text(encoding="utf-8"))
    key = plan_router._funnel_key(source_text)
    for t in tasks:
        if plan_router._funnel_key(t.text) == key:
            return t
    return None


def _dispatchable(item: BucketTask) -> Optional[str]:
    """Why an item may not be dispatched, or None if it may."""
    if item.mode == "rehearse":
        # In any area, for any reason: the value of retrieval practice is
        # the effort of retrieval.
        return "Rehearse items are never dispatched — recall them yourself"
    if item.stage in ("ready", "binding"):
        return None
    if item.stage == "captured":
        return "Captured items can't be dispatched — they're unscoped by definition"
    return f"Items in stage '{item.stage}' can't be dispatched"


@router.get("/areas")
async def get_areas():
    return {"areas": handoff.configured_areas(), "dispatch_limit": config.dispatch_limit}


@router.put("/areas")
async def put_areas(body: AreaUpdate):
    handoff.save_areas(body.areas)
    return {"status": "saved", "areas": handoff.configured_areas()}


@router.get("/area-for-group")
async def get_area_for_group(group: str):
    """Which configured area (if any) an item's group maps into."""
    area = handoff.area_for_group(group)
    return {"area": area["name"] if area and area.get("agent_binding") else None}


@router.post("/check")
async def check(body: DispatchCreate):
    """Run the conformance check without creating anything."""
    area = handoff.area_by_name(body.area)
    if area is None:
        raise HTTPException(status_code=404, detail=f"Unknown area '{body.area}'")
    ok, failures = handoff.check_conformance(area, body.source_text, body.attached_notes)
    return {"conformance": "pass" if ok else "fail", "failures": failures}


@router.post("/dispatches")
async def create_dispatch(body: DispatchCreate):
    area = handoff.area_by_name(body.area)
    if area is None or not area.get("valid", True):
        raise HTTPException(status_code=404, detail=f"Unknown or misconfigured area '{body.area}'")
    if not area.get("agent_binding"):
        raise HTTPException(status_code=400, detail=f"Area '{body.area}' has no agent binding — it cannot dispatch")
    if body.expected_artifact not in handoff.EXPECTED_ARTIFACTS:
        raise HTTPException(status_code=400, detail="expected_artifact must name the end state: "
                            + " / ".join(handoff.EXPECTED_ARTIFACTS))

    item = _find_source_item(body.source_text)
    if item is None:
        raise HTTPException(status_code=404, detail="Source item not found in the bucket")
    reason = _dispatchable(item)
    if reason:
        raise HTTPException(status_code=400, detail=reason)

    # The item's own area must match the dispatch area (no cross-area dispatch)
    group, _ = plan_router._parse_group(item.text)
    derived = handoff.area_for_group(group)
    if derived is None or derived["name"] != area["name"]:
        raise HTTPException(
            status_code=400,
            detail="The item's group does not map into this area — the area is "
                   "derived from the item, not chosen on this surface",
        )

    ok, failures = handoff.check_conformance(area, item.text, body.attached_notes)
    if not ok:
        # Not a warning, not an override checkbox: unavailable.
        raise HTTPException(status_code=422, detail="Conformance failed: " + " · ".join(failures))

    record = {
        "id": handoff.new_dispatch_id(),
        "source_item": plan_router._funnel_key(item.text),
        "source_label": plan_router._strip_bucket_meta(item.text),
        "attached_notes": list(body.attached_notes),
        "expected_artifact": body.expected_artifact,
        "state": "drafting",
        "opened_at": datetime.now().isoformat(timespec="seconds"),
        "closed_at": "",
        "exchange_count": 0,
        "transcript_path": "",
        "conformance": "pass",
    }
    handoff.write_dispatch(area, record)
    record["area"] = area["name"]
    return record


@router.get("/dispatches")
async def get_dispatches(area: str = ""):
    areas = handoff.configured_areas()
    if area:
        areas = [a for a in areas if a["name"] == area.strip().lower()]
    records = []
    for a in areas:
        records.extend(handoff.list_dispatches(a))
    open_records = [r for r in records if r.get("state") != "closed"]
    return {
        "dispatches": open_records,
        "closed_count": len(records) - len(open_records),
        "in_flight": sum(1 for r in records if r.get("state") == "in_flight"),
        "limit": config.dispatch_limit,
    }


@router.patch("/dispatches/{area_name}/{dispatch_id}")
async def update_dispatch(area_name: str, dispatch_id: str, body: DispatchUpdate):
    area = handoff.area_by_name(area_name)
    if area is None:
        raise HTTPException(status_code=404, detail="Unknown area")
    path = handoff.dispatch_path(area, dispatch_id)
    record = handoff.read_dispatch(path)
    if record is None:
        raise HTTPException(status_code=404, detail="Dispatch not found")

    if body.state is not None:
        if body.state not in handoff.DISPATCH_STATES:
            raise HTTPException(status_code=400, detail="Unknown state")
        if body.state == "in_flight" and record.get("state") != "in_flight":
            # WIP limit — same posture as the fifth Binding item
            in_flight = sum(
                1 for r in handoff.list_dispatches(area) if r.get("state") == "in_flight"
            )
            if in_flight >= config.dispatch_limit:
                raise HTTPException(
                    status_code=422,
                    detail=f"{config.dispatch_limit} dispatches already in flight — close one first",
                )
            # Files change: re-run the check immediately before dispatch
            ok, failures = handoff.check_conformance(
                area, record.get("source_label", ""), record.get("attached_notes", []) or []
            )
            if not ok:
                record["conformance"] = "fail"
                handoff.write_dispatch(area, record)
                raise HTTPException(status_code=422, detail="Conformance failed: " + " · ".join(failures))
            record["conformance"] = "pass"
        record["state"] = body.state
        if body.state == "closed":
            record["closed_at"] = datetime.now().isoformat(timespec="seconds")
    if body.exchange_count is not None:
        record["exchange_count"] = max(0, int(body.exchange_count))
    if body.transcript_path is not None:
        # Transcripts inherit the area boundary — refuse anything outside it
        t = (config.vault_root / body.transcript_path)
        if body.transcript_path and not handoff._is_within(t, config.vault_root / area["root"]):
            raise HTTPException(status_code=400, detail="Transcript must live inside the area")
        record["transcript_path"] = body.transcript_path

    handoff.write_dispatch(area, record)
    record["area"] = area["name"]
    return record


@router.get("/returns")
async def get_returns(area: str = ""):
    areas = handoff.configured_areas()
    if area:
        areas = [a for a in areas if a["name"] == area.strip().lower()]
    out = []
    for a in areas:
        for r in handoff.list_returns(a):
            r["area"] = a["name"]
            out.append(r)
    return {"returns": out}


@router.post("/returns/resolve")
async def resolve_return(body: ReturnResolve):
    """Reading a return offers exactly two outcomes: discard, or capture —
    which creates `captured` items linked to the proposal note. Agent output
    never edits an existing item and never enters as ready or binding."""
    area = handoff.area_by_name(body.area)
    if area is None:
        raise HTTPException(status_code=404, detail="Unknown area")
    if body.action not in ("discard", "capture"):
        raise HTTPException(status_code=400, detail="action must be 'discard' or 'capture'")

    if body.action == "capture":
        texts = [t.strip() for t in body.capture_texts if t.strip()]
        if not texts:
            raise HTTPException(status_code=400, detail="Nothing to capture")
        note_name = (config.vault_root / body.path).stem
        bucket = plan_router._bucket_path()
        tasks: list[BucketTask] = []
        pinned: list[str] = []
        if bucket.exists():
            tasks, pinned = plan_router._parse_bucket_file(bucket.read_text(encoding="utf-8"))
        for text in texts:
            tasks.append(BucketTask(
                text=plan_router._stamp_bucket_tokens(f"{text} [[{note_name}]]"),
                stage="captured",
            ))
        bucket.parent.mkdir(parents=True, exist_ok=True)
        bucket.write_text(plan_router._format_bucket_tasks(tasks, pinned), encoding="utf-8")

    try:
        handoff.archive_return(area, body.path)
    except (ValueError, OSError) as e:
        raise HTTPException(status_code=400, detail=str(e))

    # If the file names a dispatch, mark it returned (closing stays a user act)
    did = handoff._dispatch_id_from_name(body.path)
    if did:
        p = handoff.dispatch_path(area, did)
        rec = handoff.read_dispatch(p)
        if rec and rec.get("state") == "in_flight":
            rec["state"] = "returned"
            handoff.write_dispatch(area, rec)

    return {"status": body.action}


@router.get("/stats")
async def handoff_stats():
    """Stage E diagnostics — dispatches per area, exchange counts, time to
    close. System metrics only; specifically NO count of how much the user
    relies on agents."""
    per_area = {}
    for a in handoff.configured_areas():
        records = handoff.list_dispatches(a)
        closed = [r for r in records if r.get("state") == "closed" and r.get("opened_at") and r.get("closed_at")]
        hours = []
        for r in closed:
            try:
                dt = (datetime.fromisoformat(r["closed_at"]) - datetime.fromisoformat(r["opened_at"]))
                hours.append(dt.total_seconds() / 3600)
            except ValueError:
                pass
        per_area[a["name"]] = {
            "open": sum(1 for r in records if r.get("state") != "closed"),
            "closed": len(closed),
            "avg_exchanges": round(
                sum(int(r.get("exchange_count") or 0) for r in records) / len(records), 1
            ) if records else None,
            "avg_hours_to_close": round(sum(hours) / len(hours), 1) if hours else None,
        }
    return {"areas": per_area}
