CREATE TABLE alembic_version (
	version_num VARCHAR(32) NOT NULL, 
	CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);
CREATE TABLE balances (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	date DATE NOT NULL, 
	amount VARCHAR NOT NULL, 
	currency VARCHAR NOT NULL, 
	source VARCHAR(12) NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_balance_day UNIQUE (account_id, date, source), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX ix_balances_account_id ON balances (account_id);
CREATE INDEX ix_balances_date ON balances (date);
CREATE TABLE depreciations (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	purchase_price VARCHAR NOT NULL, 
	purchase_date DATE NOT NULL, 
	annual_rate VARCHAR NOT NULL, 
	floor VARCHAR, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_depreciation_account UNIQUE (account_id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX ix_depreciations_account_id ON depreciations (account_id);
CREATE TABLE transactions (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	booking_date DATE NOT NULL, 
	value_date DATE, 
	amount VARCHAR NOT NULL, 
	currency VARCHAR NOT NULL, 
	counterparty_name VARCHAR, 
	counterparty_iban VARCHAR, 
	description VARCHAR, 
	reference VARCHAR, 
	bank_transaction_id VARCHAR, 
	source VARCHAR(12) NOT NULL, 
	dedup_hash VARCHAR NOT NULL, 
	occurrence INTEGER NOT NULL, 
	transfer_group_id VARCHAR, 
	is_internal_transfer BOOLEAN NOT NULL, 
	category VARCHAR, 
	category_source VARCHAR, 
	raw JSON, 
	import_batch_id INTEGER, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_txn_dedup UNIQUE (account_id, dedup_hash, occurrence), 
	FOREIGN KEY(account_id) REFERENCES accounts (id), 
	FOREIGN KEY(import_batch_id) REFERENCES import_batches (id)
);
CREATE INDEX ix_transactions_account_id ON transactions (account_id);
CREATE INDEX ix_transactions_bank_transaction_id ON transactions (bank_transaction_id);
CREATE INDEX ix_transactions_booking_date ON transactions (booking_date);
CREATE INDEX ix_transactions_category ON transactions (category);
CREATE INDEX ix_transactions_counterparty_iban ON transactions (counterparty_iban);
CREATE INDEX ix_transactions_dedup_hash ON transactions (dedup_hash);
CREATE INDEX ix_transactions_transfer_group_id ON transactions (transfer_group_id);
CREATE TABLE profiles (
	id INTEGER NOT NULL, 
	slug VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	base_currency VARCHAR NOT NULL, 
	mcp_privacy VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE UNIQUE INDEX ix_profiles_slug ON profiles (slug);
CREATE TABLE profile_modules (
	profile_id INTEGER NOT NULL, 
	module_id VARCHAR NOT NULL, 
	enabled BOOLEAN NOT NULL, 
	enabled_at DATETIME NOT NULL, 
	PRIMARY KEY (profile_id, module_id), 
	FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE TABLE IF NOT EXISTS "category_rules" (
	id INTEGER NOT NULL, 
	merchant_key VARCHAR NOT NULL, 
	category VARCHAR NOT NULL, 
	source VARCHAR NOT NULL, 
	locked BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	profile_id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_rule_profile_merchant UNIQUE (profile_id, merchant_key), 
	CONSTRAINT fk_category_rules_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_category_rules_merchant_key ON category_rules (merchant_key);
CREATE INDEX ix_category_rules_profile_id ON category_rules (profile_id);
CREATE TABLE IF NOT EXISTS "accounts" (
	id INTEGER NOT NULL, 
	bank VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	iban VARCHAR, 
	external_id VARCHAR, 
	currency VARCHAR NOT NULL, 
	type VARCHAR NOT NULL, 
	active BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	profile_id INTEGER NOT NULL, removed_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_account_profile_bank_external UNIQUE (profile_id, bank, external_id), 
	CONSTRAINT fk_accounts_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_accounts_profile_id ON accounts (profile_id);
CREATE INDEX ix_accounts_external_id ON accounts (external_id);
CREATE INDEX ix_accounts_iban ON accounts (iban);
CREATE TABLE IF NOT EXISTS "import_batches" (
	id INTEGER NOT NULL, 
	source VARCHAR(12) NOT NULL, 
	bank VARCHAR, 
	account_id INTEGER, 
	filename VARCHAR, 
	started_at DATETIME NOT NULL, 
	finished_at DATETIME, 
	num_seen INTEGER NOT NULL, 
	num_inserted INTEGER NOT NULL, 
	num_duplicates INTEGER NOT NULL, 
	notes VARCHAR, 
	profile_id INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_import_batches_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_import_batches_profile_id ON import_batches (profile_id);
CREATE TABLE IF NOT EXISTS "loans" (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	principal VARCHAR NOT NULL, 
	annual_rate VARCHAR NOT NULL, 
	term_months INTEGER NOT NULL, 
	start_date DATE NOT NULL, 
	origination_date DATE, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	payment_iban VARCHAR, 
	payment_text VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_loan_account UNIQUE (account_id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX ix_loans_account_id ON loans (account_id);
CREATE TABLE inv_instruments (
	id INTEGER NOT NULL, 
	name VARCHAR NOT NULL, 
	currency VARCHAR NOT NULL, 
	asset_class VARCHAR NOT NULL, 
	symbol VARCHAR, 
	isin VARCHAR, 
	mic VARCHAR, 
	region VARCHAR, 
	sector VARCHAR, 
	tags JSON NOT NULL, 
	needs_classification BOOLEAN NOT NULL, 
	valuation_mode VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_inv_instruments_isin ON inv_instruments (isin);
CREATE INDEX ix_inv_instruments_symbol ON inv_instruments (symbol);
CREATE TABLE inv_instrument_aliases (
	id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	namespace VARCHAR NOT NULL, 
	value VARCHAR NOT NULL, 
	guessed BOOLEAN NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	CONSTRAINT uq_inv_alias_namespace_value UNIQUE (namespace, value)
);
CREATE INDEX ix_inv_instrument_aliases_instrument_id ON inv_instrument_aliases (instrument_id);
CREATE TABLE inv_price_bars (
	id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	date DATE NOT NULL, 
	close VARCHAR NOT NULL, 
	open VARCHAR, 
	high VARCHAR, 
	low VARCHAR, 
	volume INTEGER, 
	currency VARCHAR, 
	source VARCHAR NOT NULL, 
	fetched_at DATETIME, 
	PRIMARY KEY (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	CONSTRAINT uq_inv_price_bar UNIQUE (instrument_id, date)
);
CREATE TABLE inv_fx_rates (
	id INTEGER NOT NULL, 
	base VARCHAR NOT NULL, 
	quote VARCHAR NOT NULL, 
	date DATE NOT NULL, 
	rate VARCHAR NOT NULL, 
	source VARCHAR NOT NULL, 
	fetched_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_inv_fx_rate UNIQUE (base, quote, date)
);
CREATE TABLE inv_account_settings (
	account_id INTEGER NOT NULL, 
	wrapper VARCHAR NOT NULL, 
	importer VARCHAR, 
	mapping_yaml VARCHAR, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (account_id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE TABLE inv_import_batches (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	importer VARCHAR NOT NULL, 
	broker VARCHAR NOT NULL, 
	file_name VARCHAR NOT NULL, 
	file_sha256 VARCHAR NOT NULL, 
	archive_path VARCHAR, 
	txn_count INTEGER NOT NULL, 
	duplicate_count INTEGER NOT NULL, 
	position_count INTEGER NOT NULL, 
	rename_count INTEGER NOT NULL, 
	status_change_count INTEGER NOT NULL, 
	instrument_count INTEGER NOT NULL, 
	correction_count INTEGER NOT NULL, 
	warnings JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_import_batches_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX ix_inv_import_batches_account_id ON inv_import_batches (account_id);
CREATE INDEX ix_inv_import_batches_file_sha256 ON inv_import_batches (file_sha256);
CREATE INDEX ix_inv_import_batches_profile_id ON inv_import_batches (profile_id);
CREATE TABLE inv_transactions (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	type VARCHAR NOT NULL, 
	trade_date DATE NOT NULL, 
	settle_date DATE, 
	instrument_id INTEGER, 
	quantity VARCHAR, 
	price VARCHAR, 
	currency VARCHAR NOT NULL, 
	gross_amount VARCHAR NOT NULL, 
	fee VARCHAR NOT NULL, 
	tax VARCHAR NOT NULL, 
	cash_amount VARCHAR NOT NULL, 
	cash_currency VARCHAR NOT NULL, 
	fx_rate VARCHAR, 
	split_ratio VARCHAR, 
	note VARCHAR, 
	source VARCHAR NOT NULL, 
	import_batch_id INTEGER, 
	external_ref VARCHAR, 
	dedup_hash VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(import_batch_id) REFERENCES inv_import_batches (id), 
	CONSTRAINT uq_inv_txn_account_hash UNIQUE (account_id, dedup_hash)
);
CREATE INDEX ix_inv_transactions_account_id ON inv_transactions (account_id);
CREATE INDEX ix_inv_transactions_import_batch_id ON inv_transactions (import_batch_id);
CREATE INDEX ix_inv_transactions_instrument_id ON inv_transactions (instrument_id);
CREATE INDEX ix_inv_transactions_trade_date ON inv_transactions (trade_date);
CREATE TABLE inv_position_snapshots (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	as_of DATE NOT NULL, 
	quantity VARCHAR NOT NULL, 
	currency VARCHAR NOT NULL, 
	avg_price VARCHAR, 
	market_value VARCHAR, 
	import_batch_id INTEGER, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(import_batch_id) REFERENCES inv_import_batches (id), 
	CONSTRAINT uq_inv_position_snapshot UNIQUE (account_id, instrument_id, as_of)
);
CREATE INDEX ix_inv_position_snapshots_account_id ON inv_position_snapshots (account_id);
CREATE TABLE inv_instrument_renames (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	date DATE NOT NULL, 
	old_instrument_id INTEGER NOT NULL, 
	new_instrument_id INTEGER NOT NULL, 
	note VARCHAR, 
	import_batch_id INTEGER, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_instrument_renames_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(old_instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(new_instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(import_batch_id) REFERENCES inv_import_batches (id), 
	CONSTRAINT uq_inv_rename UNIQUE (profile_id, date, old_instrument_id, new_instrument_id)
);
CREATE INDEX ix_inv_instrument_renames_profile_id ON inv_instrument_renames (profile_id);
CREATE TABLE inv_manual_valuations (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	as_of DATE NOT NULL, 
	unit_value VARCHAR NOT NULL, 
	currency VARCHAR NOT NULL, 
	note VARCHAR, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_manual_valuations_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	CONSTRAINT uq_inv_manual_valuation UNIQUE (profile_id, instrument_id, as_of)
);
CREATE INDEX ix_inv_manual_valuations_instrument_id ON inv_manual_valuations (instrument_id);
CREATE INDEX ix_inv_manual_valuations_profile_id ON inv_manual_valuations (profile_id);
CREATE TABLE inv_strategy_versions (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	sha256 VARCHAR NOT NULL, 
	yaml_text VARCHAR NOT NULL, 
	md_text VARCHAR, 
	state VARCHAR NOT NULL, 
	issues JSON NOT NULL, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_strategy_versions_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	CONSTRAINT uq_inv_strategy_version UNIQUE (profile_id, version)
);
CREATE INDEX ix_inv_strategy_versions_profile_id ON inv_strategy_versions (profile_id);
CREATE TABLE inv_rule_runs (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	"trigger" VARCHAR NOT NULL, 
	as_of DATE NOT NULL, 
	status VARCHAR NOT NULL, 
	strategy_version_id INTEGER, 
	stats JSON NOT NULL, 
	errors JSON NOT NULL, 
	report JSON NOT NULL, 
	started_at DATETIME NOT NULL, 
	finished_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_rule_runs_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(strategy_version_id) REFERENCES inv_strategy_versions (id)
);
CREATE INDEX ix_inv_rule_runs_profile_id ON inv_rule_runs (profile_id);
CREATE TABLE inv_signals (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	rule_id VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	dedup_key VARCHAR NOT NULL, 
	severity VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	message VARCHAR NOT NULL, 
	instrument_id INTEGER, 
	account_id INTEGER, 
	payload JSON NOT NULL, 
	first_seen_at DATETIME NOT NULL, 
	last_seen_at DATETIME NOT NULL, 
	created_run_id INTEGER, 
	last_run_id INTEGER, 
	acknowledged_at DATETIME, 
	closed_at DATETIME, polarity VARCHAR DEFAULT 'neutral' NOT NULL, snoozed_until DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_signals_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id), 
	FOREIGN KEY(created_run_id) REFERENCES inv_rule_runs (id), 
	FOREIGN KEY(last_run_id) REFERENCES inv_rule_runs (id)
);
CREATE INDEX ix_inv_signals_profile_id ON inv_signals (profile_id);
CREATE UNIQUE INDEX uq_inv_signals_open_key ON inv_signals (profile_id, dedup_key) WHERE status IN ('active', 'acknowledged');
CREATE TABLE inv_notification_log (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	signal_id INTEGER NOT NULL, 
	severity VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	sent_at DATETIME, 
	channel VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_notification_log_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(signal_id) REFERENCES inv_signals (id), 
	CONSTRAINT uq_inv_notification_signal_severity UNIQUE (signal_id, severity)
);
CREATE INDEX ix_inv_notification_log_profile_id ON inv_notification_log (profile_id);
CREATE TABLE inv_decisions (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	signal_id INTEGER, 
	instrument_id INTEGER, 
	account_id INTEGER, 
	action VARCHAR NOT NULL, 
	quantity VARCHAR, 
	price VARCHAR, 
	currency VARCHAR, 
	reason VARCHAR, 
	created_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_decisions_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(signal_id) REFERENCES inv_signals (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE INDEX ix_inv_decisions_profile_id ON inv_decisions (profile_id);
CREATE INDEX ix_inv_decisions_signal_id ON inv_decisions (signal_id);
CREATE TABLE inv_theses (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	entry_type VARCHAR NOT NULL, 
	thesis VARCHAR NOT NULL, 
	invalidation VARCHAR, 
	exit_plan VARCHAR, 
	size_plan VARCHAR, 
	reviewed_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, core_changed_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_theses_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id)
);
CREATE INDEX ix_inv_theses_instrument_id ON inv_theses (instrument_id);
CREATE INDEX ix_inv_theses_profile_id ON inv_theses (profile_id);
CREATE TABLE proposals (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	kind VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	summary VARCHAR NOT NULL, 
	reason VARCHAR, 
	payload JSON NOT NULL, 
	result JSON NOT NULL, 
	source VARCHAR NOT NULL, 
	created_at DATETIME NOT NULL, 
	reviewed_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_proposals_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_proposals_profile_id ON proposals (profile_id);
CREATE TABLE mcp_calls (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	tool VARCHAR NOT NULL, 
	privacy VARCHAR NOT NULL, 
	called_at DATETIME NOT NULL, 
	args JSON NOT NULL, 
	outcome VARCHAR NOT NULL, 
	error_kind VARCHAR, 
	duration_ms INTEGER NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_mcp_calls_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_mcp_calls_profile_id ON mcp_calls (profile_id);
CREATE TABLE reviews (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	module VARCHAR NOT NULL, 
	done_at DATETIME NOT NULL, 
	notes VARCHAR, 
	stats JSON NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_reviews_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_reviews_profile_id ON reviews (profile_id);
CREATE TABLE inv_profile_instruments (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	name VARCHAR, 
	asset_class VARCHAR, 
	tags JSON, 
	region VARCHAR, 
	sector VARCHAR, 
	valuation_mode VARCHAR, 
	status VARCHAR, 
	needs_classification BOOLEAN, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, "plan" VARCHAR, plan_at DATETIME, plan_reason VARCHAR, segment VARCHAR, segment_by VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_profile_instruments_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	CONSTRAINT uq_inv_profile_instrument UNIQUE (profile_id, instrument_id)
);
CREATE INDEX ix_inv_profile_instruments_instrument_id ON inv_profile_instruments (instrument_id);
CREATE INDEX ix_inv_profile_instruments_profile_id ON inv_profile_instruments (profile_id);
CREATE TABLE alerts (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	instrument_id INTEGER, 
	scope VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	params JSON NOT NULL, 
	polarity VARCHAR NOT NULL, 
	severity VARCHAR NOT NULL, 
	title VARCHAR NOT NULL, 
	note VARCHAR, 
	source VARCHAR NOT NULL, 
	created_by VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	cooldown_days INTEGER, 
	expires_at DATETIME, 
	snoozed_until DATETIME, 
	last_triggered_at DATETIME, 
	last_checked_at DATETIME, 
	last_value VARCHAR, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, deleted_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_alerts_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id)
);
CREATE INDEX ix_alerts_instrument_id ON alerts (instrument_id);
CREATE INDEX ix_alerts_profile_id ON alerts (profile_id);
CREATE TABLE watchlist_items (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	instrument_id INTEGER NOT NULL, 
	note VARCHAR, 
	tags JSON NOT NULL, 
	source VARCHAR NOT NULL, 
	added_at DATETIME NOT NULL, removed_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_watchlist_items_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	CONSTRAINT uq_watchlist_profile_instrument UNIQUE (profile_id, instrument_id)
);
CREATE INDEX ix_watchlist_items_instrument_id ON watchlist_items (instrument_id);
CREATE INDEX ix_watchlist_items_profile_id ON watchlist_items (profile_id);
CREATE TABLE inv_planned_deposits (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	account_id INTEGER, 
	amount VARCHAR NOT NULL, 
	currency VARCHAR NOT NULL, 
	planned_date DATE NOT NULL, 
	note VARCHAR, 
	status VARCHAR NOT NULL, 
	booked_txn_id INTEGER, 
	booked_at DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_planned_deposits_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id), 
	FOREIGN KEY(booked_txn_id) REFERENCES inv_transactions (id)
);
CREATE INDEX ix_inv_planned_deposits_account_id ON inv_planned_deposits (account_id);
CREATE INDEX ix_inv_planned_deposits_profile_id ON inv_planned_deposits (profile_id);
CREATE TABLE research_runs (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	started_at DATETIME NOT NULL, 
	finished_at DATETIME, 
	status VARCHAR NOT NULL, 
	scope JSON NOT NULL, 
	counts JSON NOT NULL, 
	created_by VARCHAR NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_research_runs_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_research_runs_profile_id ON research_runs (profile_id);
CREATE TABLE research_notes (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	run_id INTEGER, 
	instrument_id INTEGER, 
	theme VARCHAR, 
	kind VARCHAR NOT NULL, 
	polarity VARCHAR NOT NULL, 
	strength INTEGER NOT NULL, 
	thesis_relation VARCHAR NOT NULL, 
	thesis_field VARCHAR, 
	title VARCHAR NOT NULL, 
	summary VARCHAR NOT NULL, 
	sources JSON NOT NULL, 
	details JSON, 
	candidate_key VARCHAR, 
	signal_id INTEGER, 
	observed_at DATETIME NOT NULL, 
	expires_at DATETIME NOT NULL, 
	created_by VARCHAR NOT NULL, 
	dismissed_at DATETIME, 
	cooldown_until DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, read_at DATETIME, segment VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_research_notes_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(run_id) REFERENCES research_runs (id), 
	FOREIGN KEY(instrument_id) REFERENCES inv_instruments (id), 
	FOREIGN KEY(signal_id) REFERENCES inv_signals (id)
);
CREATE INDEX ix_research_notes_candidate_key ON research_notes (candidate_key);
CREATE INDEX ix_research_notes_instrument_id ON research_notes (instrument_id);
CREATE INDEX ix_research_notes_profile_id ON research_notes (profile_id);
CREATE INDEX ix_research_notes_run_id ON research_notes (run_id);
CREATE TABLE asset_details (
	id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	note VARCHAR, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id)
);
CREATE UNIQUE INDEX ix_asset_details_account_id ON asset_details (account_id);
CREATE INDEX ix_research_notes_unread ON research_notes (profile_id, instrument_id, read_at);
CREATE TABLE inv_decision_signals (
	decision_id INTEGER NOT NULL, 
	signal_id INTEGER NOT NULL, 
	PRIMARY KEY (decision_id, signal_id), 
	FOREIGN KEY(decision_id) REFERENCES inv_decisions (id) ON DELETE CASCADE, 
	FOREIGN KEY(signal_id) REFERENCES inv_signals (id)
);
CREATE INDEX ix_inv_decision_signals_signal_id ON inv_decision_signals (signal_id);
CREATE TABLE connectors (
	id VARCHAR NOT NULL, 
	name VARCHAR NOT NULL, 
	version VARCHAR NOT NULL, 
	module VARCHAR NOT NULL, 
	kind VARCHAR NOT NULL, 
	manifest_json JSON NOT NULL, 
	content_sha256 VARCHAR NOT NULL, 
	interpreter_path VARCHAR NOT NULL, 
	status VARCHAR NOT NULL, 
	approved_sha256 VARCHAR, 
	approved_interpreter VARCHAR, 
	approved_files_json JSON, 
	approved_at DATETIME, 
	installed_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	source VARCHAR NOT NULL, 
	PRIMARY KEY (id)
);
CREATE TABLE connector_bindings (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	account_id INTEGER NOT NULL, 
	connector_id VARCHAR NOT NULL, 
	params_json JSON NOT NULL, 
	auto_commit BOOLEAN NOT NULL, 
	cursor VARCHAR, 
	last_run_at DATETIME, 
	last_status VARCHAR, 
	last_ok_at DATETIME, 
	backoff_until DATETIME, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_connector_bindings_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	FOREIGN KEY(account_id) REFERENCES accounts (id), 
	FOREIGN KEY(connector_id) REFERENCES connectors (id), 
	CONSTRAINT uq_connector_binding_account UNIQUE (account_id, connector_id)
);
CREATE INDEX ix_connector_bindings_profile_id ON connector_bindings (profile_id);
CREATE INDEX ix_connector_bindings_account_id ON connector_bindings (account_id);
CREATE INDEX ix_connector_bindings_connector_id ON connector_bindings (connector_id);
CREATE TABLE connector_runs (
	id INTEGER NOT NULL, 
	connector_id VARCHAR NOT NULL, 
	profile_id INTEGER, 
	binding_id INTEGER, 
	command VARCHAR NOT NULL, 
	started_at DATETIME NOT NULL, 
	duration_ms INTEGER NOT NULL, 
	outcome VARCHAR NOT NULL, 
	error_kind VARCHAR, 
	exit_code INTEGER, 
	records INTEGER NOT NULL, 
	bytes_in INTEGER NOT NULL, 
	bytes_out INTEGER NOT NULL, 
	denied_hosts_json JSON NOT NULL, 
	stderr_tail VARCHAR, 
	proposal_id INTEGER, 
	batch_ref VARCHAR, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_connector_runs_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id)
);
CREATE INDEX ix_connector_runs_connector_id ON connector_runs (connector_id);
CREATE INDEX ix_connector_runs_profile_id ON connector_runs (profile_id);
CREATE TABLE inv_macro_bars (
	id INTEGER NOT NULL, 
	series VARCHAR NOT NULL, 
	date DATE NOT NULL, 
	close VARCHAR NOT NULL, 
	source VARCHAR NOT NULL, 
	fetched_at DATETIME, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_inv_macro_bar UNIQUE (series, date)
);
CREATE TABLE inv_topic_theses (
	id INTEGER NOT NULL, 
	profile_id INTEGER NOT NULL, 
	segment VARCHAR NOT NULL, 
	thesis VARCHAR NOT NULL, 
	invalidation VARCHAR, 
	draft BOOLEAN NOT NULL, 
	created_by VARCHAR NOT NULL, 
	core_changed_at DATETIME NOT NULL, 
	created_at DATETIME NOT NULL, 
	updated_at DATETIME NOT NULL, rejected_at DATETIME, assessment VARCHAR, outlook VARCHAR, view_updated_at DATETIME, view_sources JSON, 
	PRIMARY KEY (id), 
	CONSTRAINT fk_inv_topic_theses_profile_id FOREIGN KEY(profile_id) REFERENCES profiles (id), 
	CONSTRAINT uq_inv_topic_thesis UNIQUE (profile_id, segment)
);
CREATE INDEX ix_inv_topic_theses_profile_id ON inv_topic_theses (profile_id);
CREATE TABLE change_events (
	id INTEGER NOT NULL, 
	ts DATETIME NOT NULL, 
	profile_id INTEGER, 
	entity VARCHAR NOT NULL, 
	op VARCHAR NOT NULL, 
	ref VARCHAR, 
	payload JSON, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_change_events_ts ON change_events (ts);
CREATE INDEX ix_change_events_profile_id ON change_events (profile_id);
