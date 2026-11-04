"""Worker endpoints under ``/api/system/worker`` (platform routes, not profile-scoped).

- ``POST /api/system/worker/install`` ``{time?: "HH:MM"}`` -> ``{worker: <status>}`` (the
  ``worker`` object of ``GET /api/system``); without ``time`` an installed job keeps its time,
  else 07:30. 422 invalid time, 501 platform without a scheduler, 500 launchctl failed.
- ``POST /api/system/worker/uninstall`` -> ``{worker: <status>}``.
- ``POST /api/system/worker/run`` ``{offline?: bool}`` -> ``{run: <report>, worker: <status>}``;
  runs synchronously, like the scheduled job (same notifications); 409 while a run is going.

The program the job runs is never taken from a request: it is the setting / the running
install (``scheduler.entry_point``).
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import runner, service
from .schedule import Schedule, ScheduleError
from .scheduler import WorkerSchedulerError, WorkerUnsupported

router = APIRouter(prefix="/system/worker")


class InstallBody(BaseModel):
    time: str | None = None  # "HH:MM", local time


class RunBody(BaseModel):
    offline: bool = False


@router.post("/install")
def install(body: InstallBody | None = None) -> dict:
    try:
        schedule = Schedule.parse(body.time) if body and body.time else None
    except ScheduleError as e:
        raise HTTPException(status_code=422, detail=str(e)) from None
    try:
        return {"worker": service.install(schedule)}
    except WorkerUnsupported as e:
        raise HTTPException(status_code=501, detail=str(e)) from None
    except WorkerSchedulerError as e:
        raise HTTPException(status_code=500, detail=str(e)) from None


@router.post("/uninstall")
def uninstall() -> dict:
    try:
        return {"worker": service.uninstall()}
    except WorkerUnsupported as e:
        raise HTTPException(status_code=501, detail=str(e)) from None
    except WorkerSchedulerError as e:
        raise HTTPException(status_code=500, detail=str(e)) from None


@router.post("/run")
def run(body: RunBody | None = None) -> dict:
    offline = bool(body and body.offline)
    try:
        report = runner.run_worker(
            notifier=service.get_notifier("auto"), offline=offline, budget=not offline
        )
    except runner.WorkerBusy as e:
        raise HTTPException(status_code=409, detail=str(e)) from None
    return {"run": report.to_dict(), "worker": service.status()}
