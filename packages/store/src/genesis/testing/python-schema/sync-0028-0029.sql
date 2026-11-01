CREATE TABLE sync_outbox (
	id INTEGER NOT NULL, 
	ts DATETIME NOT NULL, 
	txn VARCHAR NOT NULL, 
	profile_id INTEGER, 
	table_name VARCHAR NOT NULL, 
	op VARCHAR NOT NULL, 
	local_id VARCHAR NOT NULL, 
	gid VARCHAR, 
	fields JSON NOT NULL, 
	prev JSON, 
	"key" JSON, 
	origin VARCHAR NOT NULL, 
	acked_at DATETIME, 
	PRIMARY KEY (id)
);
CREATE INDEX ix_sync_outbox_profile_id ON sync_outbox (profile_id);
CREATE INDEX ix_sync_outbox_acked_at ON sync_outbox (acked_at);
CREATE INDEX ix_sync_outbox_row ON sync_outbox (table_name, local_id);
CREATE TABLE sync_ids (
	profile_id INTEGER NOT NULL, 
	table_name VARCHAR NOT NULL, 
	local_id VARCHAR NOT NULL, 
	gid VARCHAR NOT NULL, 
	source VARCHAR NOT NULL, 
	PRIMARY KEY (profile_id, table_name, local_id), 
	CONSTRAINT uq_sync_ids_gid UNIQUE (profile_id, table_name, gid)
);
CREATE TABLE sync_vaults (
	profile_id INTEGER NOT NULL, 
	vault_id VARCHAR NOT NULL, 
	linked_at DATETIME NOT NULL, 
	PRIMARY KEY (profile_id), 
	UNIQUE (vault_id)
);
CREATE TABLE sync_inbound (
	eid VARCHAR NOT NULL, 
	profile_id INTEGER, 
	type VARCHAR NOT NULL, 
	hlc VARCHAR NOT NULL, 
	gid VARCHAR, 
	status VARCHAR NOT NULL, 
	reason VARCHAR, 
	digest VARCHAR NOT NULL, 
	body JSON, 
	received_at DATETIME NOT NULL, 
	settled_at DATETIME, 
	PRIMARY KEY (eid)
);
CREATE INDEX ix_sync_inbound_status ON sync_inbound (status);
CREATE TABLE sync_clock (
	profile_id INTEGER NOT NULL, 
	table_name VARCHAR NOT NULL, 
	local_id VARCHAR NOT NULL, 
	field VARCHAR NOT NULL, 
	hlc VARCHAR NOT NULL, 
	eid VARCHAR NOT NULL, 
	PRIMARY KEY (profile_id, table_name, local_id, field)
);
