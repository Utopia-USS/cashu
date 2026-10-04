"""The importers the app knows, keyed by broker id."""

from __future__ import annotations

from collections.abc import Iterable

from .contract import BrokerImporter, ImportFile


class DuplicateImporterError(ValueError):
    """An importer with the same broker id is already registered."""


class ImporterRegistry:
    """Importers in registration order, keyed by :attr:`BrokerImporter.broker_id`."""

    def __init__(self, importers: Iterable[BrokerImporter] = ()) -> None:
        self._importers: dict[str, BrokerImporter] = {}
        for importer in importers:
            self.register(importer)

    @property
    def importers(self) -> tuple[BrokerImporter, ...]:
        """All importers in registration order."""
        return tuple(self._importers.values())

    def register(self, importer: BrokerImporter) -> None:
        """Add ``importer``; raises :class:`DuplicateImporterError` when its broker id is taken."""
        broker_id = importer.broker_id
        if broker_id in self._importers:
            raise DuplicateImporterError(
                f"An importer with broker id {broker_id!r} is already registered"
            )
        self._importers[broker_id] = importer

    def get(self, broker_id: str) -> BrokerImporter | None:
        """The importer with ``broker_id``, or None."""
        return self._importers.get(broker_id)

    def detect(self, file: ImportFile) -> tuple[BrokerImporter, ...]:
        """Importers whose ``can_parse`` accepts ``file``, in registration order. An importer whose
        sniff raises is treated as not matching."""
        return tuple(
            importer for importer in self._importers.values() if _safe_can_parse(importer, file)
        )

    def __contains__(self, broker_id: object) -> bool:
        return broker_id in self._importers

    def __len__(self) -> int:
        return len(self._importers)


def _safe_can_parse(importer: BrokerImporter, file: ImportFile) -> bool:
    try:
        return bool(importer.can_parse(file))
    except Exception:  # noqa: BLE001 - a foreign file must never break detection
        return False


__all__ = ["DuplicateImporterError", "ImporterRegistry"]
