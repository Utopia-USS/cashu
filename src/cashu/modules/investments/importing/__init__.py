"""Broker import framework (pure: parsing, instrument resolution, dedup, ordering, reconciliation; no
database, no file system except :func:`validate_import_file`).

- Contract (stable names, contract note in :mod:`.contract`): ``ImportFile``, ``BrokerImporter``,
  ``ParsedTxn``, ``ParsedPosition``, ``ParsedCorporateAction`` / ``ParsedRename`` / ``ParsedDelisting``,
  ``ImportWarning``, ``ImportParseResult``.
- Importers: :class:`CanonicalImporter` (the ``cashu-import`` format, spec in ``docs/import-format.md``)
  and :class:`GenericCsvImporter` driven by a YAML :class:`CsvMapping`; :class:`ImporterRegistry`.
- Pipeline pieces: :class:`InstrumentResolver` (R10), :mod:`.dedup` (R8), :mod:`.ordering` (R9),
  :mod:`.cash` (R5), :func:`plan_import` (pure preview), :func:`reconcile`, :func:`validate_import_file`.
"""

from .canonical import (
    CANONICAL_BROKER_ID,
    CANONICAL_FORMAT,
    CANONICAL_FORMAT_VERSION,
    CanonicalImporter,
    RecordKind,
    parse_canonical_csv,
    parse_canonical_json,
)
from .cash import AmountError, DerivedAmounts, derive_amounts
from .contract import (
    BrokerImporter,
    ImportFile,
    ImportParseResult,
    ImportWarning,
    ImportWarningKind,
    ParsedCorporateAction,
    ParsedDelisting,
    ParsedPosition,
    ParsedRename,
    ParsedTxn,
    effective_broker_id,
)
from .csv_mapping import (
    GENERIC_CSV_BROKER_ID,
    AmountSign,
    CsvField,
    CsvMapping,
    CsvMappingError,
    CsvMappingIssue,
    RowErrorPolicy,
    example_mapping_yaml,
)
from .csv_values import DatePattern, DecimalFormat
from .dedup import DedupInput, dedup_hash, dedup_hashes
from .exchanges import (
    CRYPTO,
    MARKETS,
    US_LISTING,
    ExchangeInfo,
    SplitSymbol,
    crypto_base,
    exchange_for_hint,
    exchange_for_mic,
    is_crypto_symbol,
    split_broker_symbol,
)
from .generic_csv import GenericCsvImporter
from .ordering import chronological_ranks, created_at_stamps, is_newest_first
from .plan import (
    ImportPlan,
    PlannedPosition,
    PlannedRename,
    PlannedRow,
    PlannedStatusChange,
    plan_import,
    semantic_issues,
)
from .reconciler import (
    BrokerPosition,
    PositionDiff,
    PositionDiffKind,
    ProposedCorrection,
    ReconciliationReport,
    reconcile,
)
from .registry import DuplicateImporterError, ImporterRegistry
from .resolver import (
    CurrencyEvidence,
    InMemoryInstrumentLookup,
    InstrumentHint,
    InstrumentLookup,
    InstrumentMatch,
    InstrumentResolver,
    ResolvedInstrument,
)
from .text import ImportTextEncoding, decode_import_text
from .validation import ValidationReport, validate_import, validate_import_file


def default_registry(*mappings: CsvMapping) -> ImporterRegistry:
    """A registry with the canonical importer first, then one generic CSV importer per mapping."""
    return ImporterRegistry([CanonicalImporter(), *(GenericCsvImporter(m) for m in mappings)])


__all__ = [
    "CANONICAL_BROKER_ID",
    "CANONICAL_FORMAT",
    "CANONICAL_FORMAT_VERSION",
    "CRYPTO",
    "GENERIC_CSV_BROKER_ID",
    "MARKETS",
    "US_LISTING",
    "AmountError",
    "AmountSign",
    "BrokerImporter",
    "BrokerPosition",
    "CanonicalImporter",
    "CsvField",
    "CsvMapping",
    "CsvMappingError",
    "CsvMappingIssue",
    "CurrencyEvidence",
    "DatePattern",
    "DecimalFormat",
    "DedupInput",
    "DerivedAmounts",
    "DuplicateImporterError",
    "ExchangeInfo",
    "GenericCsvImporter",
    "ImportFile",
    "ImportParseResult",
    "ImportPlan",
    "ImportTextEncoding",
    "ImportWarning",
    "ImportWarningKind",
    "ImporterRegistry",
    "InMemoryInstrumentLookup",
    "InstrumentHint",
    "InstrumentLookup",
    "InstrumentMatch",
    "InstrumentResolver",
    "ParsedCorporateAction",
    "ParsedDelisting",
    "ParsedPosition",
    "ParsedRename",
    "ParsedTxn",
    "PlannedPosition",
    "PlannedRename",
    "PlannedRow",
    "PlannedStatusChange",
    "PositionDiff",
    "PositionDiffKind",
    "ProposedCorrection",
    "ReconciliationReport",
    "RecordKind",
    "ResolvedInstrument",
    "RowErrorPolicy",
    "SplitSymbol",
    "ValidationReport",
    "chronological_ranks",
    "created_at_stamps",
    "crypto_base",
    "decode_import_text",
    "dedup_hash",
    "dedup_hashes",
    "default_registry",
    "derive_amounts",
    "effective_broker_id",
    "example_mapping_yaml",
    "exchange_for_hint",
    "exchange_for_mic",
    "is_crypto_symbol",
    "is_newest_first",
    "parse_canonical_csv",
    "parse_canonical_json",
    "plan_import",
    "reconcile",
    "semantic_issues",
    "split_broker_symbol",
    "validate_import",
    "validate_import_file",
]
