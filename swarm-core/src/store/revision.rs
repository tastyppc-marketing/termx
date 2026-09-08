//! Durable owner state revisions, advanced inside the transaction whose
//! visible state they describe. See `StateRevisions` for the dimensions.

use rusqlite::{Connection, Transaction};

use crate::error::StoreError;
use crate::model::{Revision, StateRevisions};

use super::policy::revision_from_sql;

pub(super) fn bump_inventory(transaction: &Transaction<'_>) -> Result<Revision, StoreError> {
    let next: i64 = transaction.query_row(
        "UPDATE owner_state SET inventory_revision=inventory_revision+1 WHERE singleton=1 RETURNING inventory_revision",
        [],
        |row| row.get(0),
    )?;
    revision_from_sql(next)
}

pub(super) fn bump_delivery(transaction: &Transaction<'_>) -> Result<Revision, StoreError> {
    let next: i64 = transaction.query_row(
        "UPDATE owner_state SET delivery_revision=delivery_revision+1 WHERE singleton=1 RETURNING delivery_revision",
        [],
        |row| row.get(0),
    )?;
    revision_from_sql(next)
}

pub(super) fn read_revisions(connection: &Connection) -> Result<StateRevisions, StoreError> {
    let (inventory, delivery) = connection.query_row(
        "SELECT inventory_revision, delivery_revision FROM owner_state WHERE singleton=1",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let run: Option<i64> =
        connection.query_row("SELECT MAX(run_revision) FROM broker_runs", [], |row| {
            row.get(0)
        })?;
    Ok(StateRevisions {
        inventory_revision: revision_from_sql(inventory)?,
        delivery_revision: revision_from_sql(delivery)?,
        run_revision: run.map(revision_from_sql).transpose()?,
    })
}
