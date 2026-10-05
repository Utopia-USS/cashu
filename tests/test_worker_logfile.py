"""worker.log rotation (F6 NT): copytruncate at the start of `finanse worker run` (launchd keeps
the file open in append mode), 0600 copies, a few backups, and the worker's logging setup."""

from __future__ import annotations

import contextlib
import io
import logging
import os
import stat

from typer.testing import CliRunner

from finanse import cli as cli_mod
from finanse.core import paths
from finanse.core.worker import logfile
from finanse.core.worker import scheduler as sched


def mode(path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_small_or_missing_logs_are_left_alone(tmp_path):
    log = tmp_path / "worker.log"
    assert logfile.rotate(log, max_bytes=10) is False
    log.write_text("short\n")
    assert logfile.rotate(log, max_bytes=10) is False
    assert log.read_text() == "short\n" and not logfile.backup_path(log, 1).exists()


def test_rotation_shifts_copies_and_keeps_a_few(tmp_path):
    log = tmp_path / "worker.log"
    for run in range(1, 6):
        log.write_text(f"run {run}\n" * 10)
        assert logfile.rotate(log, max_bytes=20, backups=3) is True
        assert log.read_text() == "" and mode(log) == 0o600
    copies = [logfile.backup_path(log, n) for n in (1, 2, 3)]
    assert [c.read_text().splitlines()[0] for c in copies] == ["run 5", "run 4", "run 3"]
    assert all(mode(c) == 0o600 for c in copies)
    assert not logfile.backup_path(log, 4).exists()
    assert sorted(p.name for p in tmp_path.iterdir()) == [
        "worker.log",
        "worker.log.1",
        "worker.log.2",
        "worker.log.3",
    ]  # no temp file left behind


def test_an_appending_writer_continues_in_the_same_file(tmp_path):
    """launchd opened worker.log with O_APPEND before the run; after the rotation the run's own
    lines must land at the start of the emptied file, with no hole or lost line."""
    log = tmp_path / "worker.log"
    log.write_bytes(b"old line\n" * 100)
    fd = os.open(log, os.O_WRONLY | os.O_APPEND)
    try:
        assert logfile.rotate(log, max_bytes=100) is True
        os.write(fd, b"new run\n")
    finally:
        os.close(fd)
    assert log.read_bytes() == b"new run\n"
    assert logfile.backup_path(log, 1).read_bytes() == b"old line\n" * 100


def test_symlinks_are_never_followed(tmp_path):
    target = tmp_path / "elsewhere.txt"
    target.write_text("x" * 100)
    log = tmp_path / "worker.log"
    log.symlink_to(target)
    assert logfile.rotate(log, max_bytes=10) is False
    assert target.read_text() == "x" * 100


def test_a_failed_rotation_does_not_stop_the_run(tmp_path, capsys):
    log = tmp_path / "worker.log"
    log.write_text("x" * 100)
    os.chmod(tmp_path, 0o500)  # cannot create the copy
    try:
        assert logfile.rotate(log, max_bytes=10) is False
    finally:
        os.chmod(tmp_path, 0o700)
    assert log.read_text() == "x" * 100
    assert "rotation failed" in capsys.readouterr().err


@contextlib.contextmanager
def bare_root_logger():
    """The root logger as in a fresh `finanse worker run` process (pytest adds its own handlers
    for every test phase, so this runs inside the test body)."""
    root = logging.getLogger()
    worker = logging.getLogger("finanse.worker")
    saved = (root.handlers[:], root.level, worker.level)
    root.handlers.clear()
    try:
        yield root
    finally:
        root.handlers[:] = saved[0]
        root.setLevel(saved[1])
        worker.setLevel(saved[2])


def test_logging_goes_to_stderr_with_timestamps():
    stream = io.StringIO()
    with bare_root_logger() as root:
        handler = logfile.configure_logging(stream)
        assert handler is not None and root.handlers == [handler]
        logging.getLogger("finanse.worker").info("pruned staged import files: 2")
        logging.getLogger("finanse.other").info("chatty")  # only warnings from elsewhere
        assert logfile.configure_logging(io.StringIO()) is None  # configured once
    line = stream.getvalue().strip()
    assert line.endswith("INFO finanse.worker: pruned staged import files: 2")
    assert line[:4].isdigit() and "chatty" not in stream.getvalue()


def test_worker_run_rotates_the_log_first(db_engine, monkeypatch):
    log = sched.log_path()
    paths.ensure_private_dir(log.parent)
    log.write_text("x" * 50)
    monkeypatch.setattr(logfile, "rotate", _rotate_with(logfile.rotate, max_bytes=10))
    res = CliRunner().invoke(cli_mod.app, ["worker", "run", "--offline", "--notifier", "none"])
    assert res.exit_code == 0, res.output
    assert "nothing to do" in res.output
    assert logfile.backup_path(log, 1).read_text() == "x" * 50
    assert log.read_text() == ""


def _rotate_with(real, **kwargs):
    def rotate(path=None):
        return real(path, **kwargs)

    return rotate
